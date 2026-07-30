import { gunzipSync } from "node:zlib";
import * as RDKitPackage from "@rdkit/rdkit";
import type { JSMol, RDKitLoader } from "@rdkit/rdkit";
import ordSchema from "ord-schema";
import { parse as parseYaml } from "yaml";

type Identifier = { inchiKey: string; smiles: string };
type OrdIdentifier = { getType(): number; getValue(): string };
type ReactionRow = { key: string; sourceId: string; payload: string };
type WorkerTask = {
  kind: "ord" | "rhea" | "cantera" | "phreeqc";
  path: string;
  sourceId?: string;
};

const root = new URL("../", import.meta.url).pathname;
const initRDKitModule =
  (RDKitPackage as unknown as { default?: RDKitLoader }).default ??
  (RDKitPackage as unknown as RDKitLoader);
const rdkitPromise = initRDKitModule({
  locateFile: () => `${root}node_modules/@rdkit/rdkit/dist/RDKit_minimal.wasm`,
});
const cache = new Map<string, Identifier | null>();

async function resolveIdentifier(identifiers: OrdIdentifier[]) {
  const rdkit = await rdkitPromise;
  const inchiKey = identifiers.find((item) => item.getType() === 11)?.getValue();
  const inchi = identifiers.find((item) => item.getType() === 3)?.getValue();
  const raw = identifiers.find((item) => item.getType() === 2 || item.getType() === 10)?.getValue();
  if (!raw) return;
  const cacheKey = `${inchiKey ?? ""}|${inchi ?? ""}|${raw}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? undefined;
  if (inchiKey || inchi) {
    const resolved = {
      inchiKey: inchiKey || rdkit.get_inchikey_for_inchi(inchi!),
      smiles: raw,
    };
    cache.set(cacheKey, resolved);
    return resolved;
  }
  let molecule: JSMol | null | undefined;
  try {
    molecule = rdkit.get_mol(raw);
    if (!molecule) return;
    const resolved = {
      inchiKey: rdkit.get_inchikey_for_inchi(molecule.get_inchi()),
      smiles: molecule.get_smiles(),
    };
    cache.set(cacheKey, resolved);
    return resolved;
  } catch {
    cache.set(cacheKey, null);
    return;
  } finally {
    molecule?.delete();
  }
}

function unique(items: Array<Identifier | undefined>) {
  return [...new Map(items.flatMap((item) => (item ? [[item.inchiKey, item]] : []))).values()].sort(
    (first, second) => first.inchiKey.localeCompare(second.inchiKey),
  );
}

function formulaFromComposition(composition: Record<string, number>) {
  return Object.entries(composition)
    .sort(([first], [second]) => {
      const rank = (element: string) => (element === "C" ? 0 : element === "H" ? 1 : 2);
      return rank(first) - rank(second) || first.localeCompare(second);
    })
    .map(([element, count]) => `${element}${count === 1 ? "" : count}`)
    .join("");
}

function equationSide(side: string) {
  return side
    .replace(/\(\+?M\)|\bM\b/g, "")
    .split(/\s+\+\s+/)
    .map((term) => {
      const match = term.trim().match(/^(?:(\d+(?:\.\d+)?)\s*)?(.+?)$/);
      return match ? { coefficient: Number(match[1] ?? 1), species: match[2].trim() } : undefined;
    })
    .filter((item): item is { coefficient: number; species: string } => Boolean(item?.species));
}

function formulaKey(formulas: string[]) {
  return `formula:${[...new Set(formulas)].sort().join("|")}`;
}

self.onmessage = async (event: MessageEvent<WorkerTask>) => {
  if (event.data.kind === "rhea") {
    const rows: ReactionRow[] = [];
    for (const line of (await Bun.file(event.data.path).text()).split("\n")) {
      if (!line) continue;
      const [id, reactionSmiles] = line.split("\t");
      const [left, right] = reactionSmiles.split(">>");
      if (!id || !left || !right) continue;
      const reactants = unique(
        await Promise.all(
          left
            .split(".")
            .map((smiles) => resolveIdentifier([{ getType: () => 2, getValue: () => smiles }])),
        ),
      );
      const products = unique(
        await Promise.all(
          right
            .split(".")
            .map((smiles) => resolveIdentifier([{ getType: () => 2, getValue: () => smiles }])),
        ),
      );
      if (!reactants.length || !products.length) continue;
      const sourceId = `RHEA:${id}`;
      rows.push({
        key: reactants.map((item) => item.inchiKey).join("|"),
        sourceId,
        payload: JSON.stringify({
          status: "reported",
          source: "rhea",
          sourceId,
          confidence: 1,
          reactants,
          products,
        }),
      });
    }
    self.postMessage(rows);
    return;
  }
  if (event.data.kind === "cantera") {
    const document = parseYaml(await Bun.file(event.data.path).text()) as {
      species?: Array<{ name: string; composition?: Record<string, number> }>;
      reactions?: Array<{ equation?: string; [key: string]: unknown }>;
    };
    const formulas = new Map(
      (document.species ?? []).flatMap((species) =>
        species.composition
          ? [[species.name, formulaFromComposition(species.composition)] as const]
          : [],
      ),
    );
    const rows: ReactionRow[] = [];
    for (const [index, reaction] of (document.reactions ?? []).entries()) {
      if (!reaction.equation) continue;
      const reversible = reaction.equation.includes("<=>");
      const sides = reaction.equation.split(/\s*(?:<=>|=>|=)\s*/);
      if (sides.length !== 2) continue;
      const reactants = equationSide(sides[0]).flatMap((item) => {
        const formula = formulas.get(item.species);
        return formula ? [{ formula, query: item.species, coefficient: item.coefficient }] : [];
      });
      const products = equationSide(sides[1]).flatMap((item) => {
        const formula = formulas.get(item.species);
        return formula ? [{ formula, query: item.species, coefficient: item.coefficient }] : [];
      });
      if (!reactants.length || !products.length) continue;
      for (const [direction, inputs, outputs] of [
        ["forward", reactants, products],
        ...(reversible ? [["reverse", products, reactants] as const] : []),
      ] as const) {
        const sourceId = `cantera:${event.data.sourceId}:${index + 1}:${direction}`;
        rows.push({
          key: formulaKey(inputs.map((item) => item.formula)),
          sourceId,
          payload: JSON.stringify({
            status: "reported",
            source: "cantera",
            sourceId,
            confidence: 1,
            reactants: inputs,
            products: outputs,
            condition:
              "Elementary kinetic mechanism; temperature and pressure applicability depend on the mechanism.",
          }),
        });
      }
    }
    self.postMessage(rows);
    return;
  }
  if (event.data.kind === "phreeqc") {
    const rows: ReactionRow[] = [];
    let section = "";
    let reactionNumber = 0;
    for (const rawLine of (await Bun.file(event.data.path).text()).split("\n")) {
      const line = rawLine.replace(/#.*/, "").trim();
      if (!line) continue;
      if (/^[A-Z][A-Z_]+$/.test(line)) {
        section = line;
        continue;
      }
      if (!["SOLUTION_SPECIES", "PHASES", "EXCHANGE_SPECIES", "SURFACE_SPECIES"].includes(section))
        continue;
      if (!line.includes("=") || line.startsWith("-")) continue;
      const sides = line.split(/\s*=\s*/);
      if (sides.length !== 2) continue;
      const normalize = (species: string) =>
        species
          .replace(/\((?:aq|g|s|l)\)$/i, "")
          .replace(/([+-])(\d+)$/, "")
          .replace(/[+-]$/, "");
      const valid = (formula: string) => /^(?:[A-Z][a-z]?\d*)+$/.test(formula);
      const reactants = equationSide(sides[0]).flatMap((item) => {
        const formula = normalize(item.species);
        return valid(formula)
          ? [{ formula, query: item.species, coefficient: item.coefficient }]
          : [];
      });
      const products = equationSide(sides[1]).flatMap((item) => {
        const formula = normalize(item.species);
        return valid(formula)
          ? [{ formula, query: item.species, coefficient: item.coefficient }]
          : [];
      });
      if (!reactants.length || !products.length) continue;
      reactionNumber++;
      for (const [direction, inputs, outputs] of [
        ["forward", reactants, products],
        ["reverse", products, reactants],
      ] as const) {
        const sourceId = `phreeqc:${event.data.sourceId}:${reactionNumber}:${direction}`;
        rows.push({
          key: formulaKey(inputs.map((item) => item.formula)),
          sourceId,
          payload: JSON.stringify({
            status: "reported",
            source: "phreeqc",
            sourceId,
            confidence: 1,
            reactants: inputs,
            products: outputs,
            condition: `Aqueous equilibrium from the USGS PHREEQC ${section.toLowerCase().replaceAll("_", " ")} dataset.`,
          }),
        });
      }
    }
    self.postMessage(rows);
    return;
  }
  const dataset = ordSchema.Dataset.deserializeBinary(
    gunzipSync(await Bun.file(event.data.path).bytes()),
  );
  const rows: ReactionRow[] = [];
  for (const reaction of dataset.getReactionsList()) {
    const components: Array<{
      getReactionRole(): number;
      getIdentifiersList(): OrdIdentifier[];
    }> = [];
    reaction
      .getInputsMap()
      .forEach((input: { getComponentsList(): typeof components }) =>
        components.push(...input.getComponentsList()),
      );
    const reactants = unique(
      await Promise.all(
        components
          .filter((component) => component.getReactionRole() === 1)
          .map((component) => resolveIdentifier(component.getIdentifiersList())),
      ),
    );
    const products = unique(
      await Promise.all(
        reaction
          .getOutcomesList()
          .flatMap((outcome) => outcome.getProductsList())
          .map((product) => resolveIdentifier(product.getIdentifiersList())),
      ),
    );
    if (!reactants.length || !products.length) continue;
    const sourceId = reaction.getReactionId();
    rows.push({
      key: reactants.map((item) => item.inchiKey).join("|"),
      sourceId,
      payload: JSON.stringify({
        status: "reported",
        source: "ord",
        sourceId,
        confidence: 1,
        reactants,
        products,
      }),
    });
  }
  self.postMessage(rows);
};
