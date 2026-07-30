type ReportedReaction = {
  status: "reported";
  source: "ord" | "rhea" | "cantera" | "phreeqc";
  sourceId: string;
  confidence: number;
  reactants: Array<{
    inchiKey?: string;
    smiles?: string;
    formula?: string;
    query?: string;
    coefficient?: number;
  }>;
  products: Array<{
    inchiKey?: string;
    smiles?: string;
    formula?: string;
    query?: string;
    coefficient?: number;
  }>;
  condition?: string;
};

function hex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function lookupKey(key: string) {
  const digest = hex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))),
  );
  const shard = (Number.parseInt(digest.slice(0, 3), 16) % 1024).toString(16).padStart(3, "0");
  const response = await fetch(`./reactions/${shard}.json.gz`);
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Reaction index returned ${response.status}.`);
  if (!response.body) return [];
  const decompressed = new Response(response.body.pipeThrough(new DecompressionStream("gzip")));
  const reactions = (await decompressed.json()) as Record<string, ReportedReaction[]>;
  return reactions[key] ?? [];
}

export async function lookupReportedReactions(inchiKeys: string[], formulas: string[]) {
  const keys = [
    [...new Set(inchiKeys)].sort().join("|"),
    `formula:${[...new Set(formulas)].sort().join("|")}`,
  ].filter(Boolean);
  const matches = (await Promise.all([...new Set(keys)].map(lookupKey))).flat();
  return [
    ...new Map(
      matches.map((reaction) => [`${reaction.source}:${reaction.sourceId}`, reaction]),
    ).values(),
  ];
}
