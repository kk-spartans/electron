import { NextResponse } from "next/server";
import type { RDKitLoader, RDKitModule } from "@rdkit/rdkit";

type ValidationAtom = { id: number; element: string; x: number; y: number; charge: number };
type ValidationBond = { from: number; to: number; type: "covalent" | "ionic" | "metallic"; order: 1 | 2 | 3 };

let rdkitPromise: Promise<RDKitModule> | undefined;

async function loadRDKit() {
  const packageModule = await import("@rdkit/rdkit");
  const init = ((packageModule as unknown as { default?: RDKitLoader }).default ?? packageModule) as RDKitLoader;
  return init();
}

function rdkit() {
  rdkitPromise ??= loadRDKit();
  return rdkitPromise;
}

function molBlock(atoms: ValidationAtom[], bonds: ValidationBond[]) {
  const atomIndex = new Map(atoms.map((atom, index) => [atom.id, index + 1]));
  const covalent = bonds.filter((bond) => bond.type === "covalent");
  const atomLines = atoms.map((atom) =>
    `${atom.x.toFixed(4).padStart(10)}${(-atom.y).toFixed(4).padStart(10)}    0.0000 ${atom.element.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`,
  );
  const bondLines = covalent.map((bond) =>
    `${String(atomIndex.get(bond.from)).padStart(3)}${String(atomIndex.get(bond.to)).padStart(3)}${String(bond.order).padStart(3)}  0  0  0  0`,
  );
  const charged = atoms.filter((atom) => atom.charge !== 0);
  const chargeLines = Array.from({ length: Math.ceil(charged.length / 8) }, (_, chunk) => {
    const entries = charged.slice(chunk * 8, chunk * 8 + 8);
    return `M  CHG${String(entries.length).padStart(3)}${entries.map((atom) => `${String(atomIndex.get(atom.id)).padStart(4)}${String(atom.charge).padStart(4)}`).join("")}`;
  });
  return [
    "Electron canvas",
    "  RDKit validation",
    "",
    `${String(atoms.length).padStart(3)}${String(covalent.length).padStart(3)}  0  0  0  0            999 V2000`,
    ...atomLines,
    ...bondLines,
    ...chargeLines,
    "M  END",
  ].join("\n");
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { atoms?: ValidationAtom[]; bonds?: ValidationBond[] };
    if (!Array.isArray(body.atoms) || !Array.isArray(body.bonds) || body.atoms.length > 120) {
      return NextResponse.json({ valid: false, reason: "Invalid structure payload." }, { status: 400 });
    }
    const module = await rdkit();
    const molecule = module.get_mol(molBlock(body.atoms, body.bonds), JSON.stringify({ sanitize: true, removeHs: false }));
    if (!molecule) {
      return NextResponse.json({ valid: false, reason: "RDKit rejected this atom valence or bond arrangement." });
    }
    const canonicalSmiles = molecule.get_smiles();
    molecule.delete();
    return NextResponse.json({ valid: true, canonicalSmiles });
  } catch (error) {
    console.error("RDKit validation failed", error);
    return NextResponse.json(
      { valid: false, reason: "RDKit could not sanitize this structure." },
      { status: 422 },
    );
  }
}
