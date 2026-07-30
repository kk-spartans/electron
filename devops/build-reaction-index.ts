import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const root = new URL("../", import.meta.url).pathname;
const cache = `${root}.cache/ord`;
const source = `${cache}/source`;
const databasePath = `${cache}/index.sqlite3`;
const output = `${root}public/reactions`;
const snapshot = (await readFile(`${root}devops/ord-snapshot.txt`, "utf8")).trim();
const canteraSnapshot = (await readFile(`${root}devops/cantera-snapshot.txt`, "utf8")).trim();
const phreeqcSnapshot = (await readFile(`${root}devops/phreeqc-snapshot.txt`, "utf8")).trim();
const rheaSnapshot = (await readFile(`${root}devops/rhea-snapshot.txt`, "utf8")).trim();
const sourceRevision = [snapshot, rheaSnapshot, canteraSnapshot, phreeqcSnapshot].join(":");
const schemaVersion = 1;
const indexVersion = 5;
const shardCount = 1024;

type TreeEntry = { type: "file" | "directory"; path: string; size?: number };
type Identifier = {
  inchiKey?: string;
  smiles?: string;
  formula?: string;
  query?: string;
};
type ReactionRow = { key: string; sourceId: string; payload: string };
type IndexedReaction = {
  status: "reported";
  source: "ord";
  sourceId: string;
  confidence: number;
  reactants: Identifier[];
  products: Identifier[];
};

async function sourceFiles() {
  await mkdir(source, { recursive: true });
  const treeResponse = await fetch(
    `https://huggingface.co/api/datasets/Open-Reaction-Database/ORD-data/tree/${snapshot}/data?recursive=true&expand=false&limit=1000`,
  );
  if (!treeResponse.ok) throw new Error(`ORD file listing failed (${treeResponse.status}).`);
  const entries = (await treeResponse.json()) as TreeEntry[];
  const files = entries.filter((entry) => entry.type === "file" && entry.path.endsWith(".pb.gz"));
  for (const [index, file] of files.entries()) {
    const localPath = `${source}/${file.path}`;
    if (existsSync(localPath) && (await Bun.file(localPath).size) === file.size) continue;
    console.log(`Downloading ORD ${index + 1}/${files.length}: ${file.path}`);
    const response = await fetch(
      `https://huggingface.co/datasets/Open-Reaction-Database/ORD-data/resolve/${snapshot}/${file.path}`,
    );
    if (!response.ok) throw new Error(`ORD download failed for ${file.path} (${response.status}).`);
    await mkdir(localPath.slice(0, localPath.lastIndexOf("/")), { recursive: true });
    await Bun.write(localPath, response);
  }
  return files;
}

function runWorker(
  worker: Worker,
  task: { kind: "ord" | "rhea" | "cantera" | "phreeqc"; path: string; sourceId?: string },
) {
  return new Promise<ReactionRow[]>((resolve, reject) => {
    const receive = (event: MessageEvent<ReactionRow[]>) => {
      cleanup();
      resolve(event.data);
    };
    const fail = (event: ErrorEvent) => {
      cleanup();
      reject(event.error ?? new Error(event.message));
    };
    const cleanup = () => {
      worker.removeEventListener("message", receive);
      worker.removeEventListener("error", fail);
    };
    worker.addEventListener("message", receive);
    worker.addEventListener("error", fail);
    worker.postMessage(task);
  });
}

async function buildDatabase(files: TreeEntry[]) {
  const database = new Database(databasePath, { create: true });
  database.run("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const currentVersion = database.query("SELECT value FROM meta WHERE key = 'schema'").get() as {
    value: string;
  } | null;
  if (currentVersion && Number(currentVersion.value) !== schemaVersion) {
    database.close();
    await rm(databasePath, { force: true });
    return buildDatabase(files);
  }
  database.run("INSERT OR REPLACE INTO meta VALUES ('schema', ?)", [String(schemaVersion)]);
  database.run("CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, size INTEGER NOT NULL)");
  database.run(
    "CREATE TABLE IF NOT EXISTS reactions(reactant_key TEXT NOT NULL, source_id TEXT PRIMARY KEY, payload TEXT NOT NULL, source_file TEXT NOT NULL)",
  );
  const completed = new Map(
    database
      .query("SELECT path, size FROM files")
      .all()
      .map((row) => {
        const file = row as { path: string; size: number };
        return [file.path, file.size];
      }),
  );
  const remove = database.query("DELETE FROM reactions WHERE source_file = ?");
  const insert = database.query("INSERT OR REPLACE INTO reactions VALUES (?, ?, ?, ?)");
  const mark = database.query("INSERT OR REPLACE INTO files VALUES (?, ?)");
  const remaining = files.filter((file) => completed.get(file.path) !== file.size);
  let next = 0;
  let finished = files.length - remaining.length;
  const requestedWorkers = Number(process.env.ORD_INDEX_WORKERS);
  const workerCount = remaining.length
    ? Math.max(
        1,
        Math.min(
          remaining.length,
          Number.isFinite(requestedWorkers) && requestedWorkers > 0
            ? requestedWorkers
            : Math.min(8, navigator.hardwareConcurrency || 4),
        ),
      )
    : 0;
  if (workerCount) {
    console.log(`Indexing ORD with ${workerCount} workers (${finished}/${files.length} cached).`);
    const workers = Array.from(
      { length: workerCount },
      () => new Worker(new URL("./ord-index-worker.ts", import.meta.url), { type: "module" }),
    );
    await Promise.all(
      workers.map(async (worker) => {
        while (next < remaining.length) {
          const file = remaining[next++];
          const rows = await runWorker(worker, { kind: "ord", path: `${source}/${file.path}` });
          const transaction = database.transaction(() => {
            remove.run(file.path);
            for (const row of rows) insert.run(row.key, row.sourceId, row.payload, file.path);
            mark.run(file.path, file.size ?? 0);
          });
          transaction();
          finished++;
          console.log(`Indexed ORD ${finished}/${files.length}: ${file.path}`);
        }
        worker.terminate();
      }),
    );
  } else {
    console.log(`ORD source index is cached (${finished}/${files.length}).`);
  }
  return database;
}

async function addRhea(database: Database) {
  const remote = "https://ftp.expasy.org/databases/rhea/tsv/rhea-reaction-smiles.tsv";
  const relative = "rhea/rhea-reaction-smiles.tsv";
  const path = `${source}/${relative}`;
  const response = await fetch(remote);
  if (!response.ok) throw new Error(`Rhea download failed (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!existsSync(path) || (await Bun.file(path).size) !== bytes.length) {
    await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Bun.write(path, bytes);
  }
  const completed = database.query("SELECT size FROM files WHERE path = ?").get(relative) as {
    size: number;
  } | null;
  if (completed?.size === bytes.length) {
    console.log("Rhea reaction index is cached.");
    return;
  }
  console.log("Indexing Rhea biochemical reactions.");
  const worker = new Worker(new URL("./ord-index-worker.ts", import.meta.url), { type: "module" });
  const rows = await runWorker(worker, { kind: "rhea", path });
  worker.terminate();
  const remove = database.query("DELETE FROM reactions WHERE source_file = ?");
  const insert = database.query("INSERT OR REPLACE INTO reactions VALUES (?, ?, ?, ?)");
  const mark = database.query("INSERT OR REPLACE INTO files VALUES (?, ?)");
  database.transaction(() => {
    remove.run(relative);
    for (const row of rows) insert.run(row.key, row.sourceId, row.payload, relative);
    mark.run(relative, bytes.length);
  })();
  console.log(`Indexed ${rows.length.toLocaleString()} Rhea reactions.`);
}

async function addGithubSources(
  database: Database,
  options: {
    repository: string;
    revision: string;
    prefix: string;
    kind: "cantera" | "phreeqc";
    include: (path: string) => boolean;
  },
) {
  const treeResponse = await fetch(
    `https://api.github.com/repos/${options.repository}/git/trees/${options.revision}?recursive=1`,
    { headers: { Accept: "application/vnd.github+json" } },
  );
  if (!treeResponse.ok)
    throw new Error(`${options.prefix} source listing failed (${treeResponse.status}).`);
  const tree = (await treeResponse.json()) as {
    tree: Array<{ path: string; type: string; size?: number }>;
  };
  const files = tree.tree.filter((entry) => entry.type === "blob" && options.include(entry.path));
  const completed = new Map(
    database
      .query("SELECT path, size FROM files WHERE path LIKE ?")
      .all(`${options.prefix}/%`)
      .map((row) => {
        const file = row as { path: string; size: number };
        return [file.path, file.size];
      }),
  );
  const worker = new Worker(new URL("./ord-index-worker.ts", import.meta.url), { type: "module" });
  const remove = database.query("DELETE FROM reactions WHERE source_file = ?");
  const insert = database.query("INSERT OR REPLACE INTO reactions VALUES (?, ?, ?, ?)");
  const mark = database.query("INSERT OR REPLACE INTO files VALUES (?, ?)");
  let indexed = 0;
  for (const file of files) {
    const relative = `${options.prefix}/${file.path}`;
    if (completed.get(relative) === file.size) continue;
    const localPath = `${source}/${relative}`;
    console.log(`Downloading ${options.prefix}: ${file.path}`);
    const response = await fetch(
      `https://raw.githubusercontent.com/${options.repository}/${options.revision}/${file.path}`,
    );
    if (!response.ok)
      throw new Error(`${options.prefix} download failed for ${file.path} (${response.status}).`);
    await mkdir(localPath.slice(0, localPath.lastIndexOf("/")), { recursive: true });
    await Bun.write(localPath, response);
    const rows = await runWorker(worker, {
      kind: options.kind,
      path: localPath,
      sourceId: file.path.split("/").at(-1),
    });
    database.transaction(() => {
      remove.run(relative);
      for (const row of rows) insert.run(row.key, row.sourceId, row.payload, relative);
      mark.run(relative, file.size ?? 0);
    })();
    indexed += rows.length;
  }
  worker.terminate();
  console.log(
    indexed
      ? `Indexed ${indexed.toLocaleString()} ${options.prefix} reactions.`
      : `${options.prefix} reaction index is cached.`,
  );
}

async function writeIndex(database: Database) {
  const temporary = `${root}public/reactions.next`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  const handles = new Map<string, FileHandle>();
  const nonempty = new Set<string>();
  let currentKey = "";
  let current: IndexedReaction[] = [];
  let count = 0;
  let reactantSets = 0;
  const flush = async () => {
    if (!current.length) return;
    if (!currentKey) return;
    const deduplicated = [
      ...new Map(
        current.map((reaction) => [
          `${reaction.source}:${reaction.products
            .map(
              (product) =>
                product.inchiKey ?? product.smiles ?? product.formula ?? product.query ?? "",
            )
            .sort()
            .join("|")}`,
          reaction,
        ]),
      ).values(),
    ].slice(0, 128);
    const digest = createHash("sha256").update(currentKey).digest("hex");
    const shard = (Number.parseInt(digest.slice(0, 3), 16) % shardCount)
      .toString(16)
      .padStart(3, "0");
    let handle = handles.get(shard);
    if (!handle) {
      console.log(
        `Creating reaction shard ${handles.size + 1}/${shardCount}: public/reactions/${shard}.json`,
      );
      handle = await open(`${temporary}/${shard}.json`, "w");
      handles.set(shard, handle);
      await handle.write("{");
    }
    await handle.write(
      `${nonempty.has(shard) ? "," : ""}${JSON.stringify(currentKey)}:${JSON.stringify(deduplicated)}`,
    );
    nonempty.add(shard);
    count += deduplicated.length;
    reactantSets++;
    if (reactantSets % 10_000 === 0)
      console.log(`Exported ${reactantSets.toLocaleString()} reactant sets.`);
  };
  console.log("Exporting the static reaction shards.");
  const rows = database
    .query("SELECT reactant_key, payload FROM reactions ORDER BY reactant_key, source_id")
    .iterate() as IterableIterator<{ reactant_key: string; payload: string }>;
  for (const row of rows) {
    if (currentKey && row.reactant_key !== currentKey) {
      await flush();
      current = [];
    }
    currentKey = row.reactant_key;
    current.push(JSON.parse(row.payload));
  }
  await flush();
  await Promise.all(
    [...handles.values()].map(async (handle) => {
      await handle.write("}");
      await handle.close();
    }),
  );
  console.log("Compressing reaction shards.");
  await Promise.all(
    [...nonempty].map(async (shard) => {
      const path = `${temporary}/${shard}.json`;
      const compressed = gzipSync(await readFile(path), { level: 9 });
      await writeFile(`${path}.gz`, compressed);
      await rm(path);
    }),
  );
  await writeFile(
    `${temporary}/manifest.json`,
    JSON.stringify({
      version: indexVersion,
      snapshot,
      sourceRevision,
      reactions: count,
      reactantSets,
      shards: nonempty.size,
      shardCount,
    }),
  );
  await rm(output, { recursive: true, force: true });
  await rename(temporary, output);
}

const manifest = await Bun.file(`${output}/manifest.json`)
  .json()
  .catch(() => undefined);
if (manifest?.sourceRevision === sourceRevision && manifest?.version === indexVersion) {
  console.log(`Reaction index is current (${snapshot.slice(0, 12)}).`);
} else {
  await mkdir(cache, { recursive: true });
  const database = await buildDatabase(await sourceFiles());
  await addRhea(database);
  await addGithubSources(database, {
    repository: "Cantera/cantera",
    revision: canteraSnapshot,
    prefix: "cantera",
    kind: "cantera",
    include: (path) => /^data\/[^/]+\.yaml$/.test(path),
  });
  await addGithubSources(database, {
    repository: "usgs-coupled/phreeqc3",
    revision: phreeqcSnapshot,
    prefix: "phreeqc",
    kind: "phreeqc",
    include: (path) => /^database\/[^/]+\.dat$/.test(path),
  });
  await writeIndex(database);
  database.close();
  console.log("Wrote the static reaction index to public/reactions.");
}
