import type { RDKitLoader, RDKitModule } from "@rdkit/rdkit";

type ValidationAtom = { id: number; element: string; x: number; y: number; charge: number };
type ValidationBond = {
  from: number;
  to: number;
  type: "covalent" | "ionic" | "metallic";
  order: 1 | 2 | 3;
};

let modulePromise: Promise<RDKitModule> | undefined;

function loadScript() {
  const rdkitWindow = window as unknown as { initRDKitModule?: RDKitLoader };
  if (rdkitWindow.initRDKitModule) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>("script[data-rdkit]");
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Could not load RDKit.")), {
        once: true,
      });
      return;
    }
    const script = document.createElement("script");
    script.src = "./rdkit/RDKit_minimal.js";
    script.dataset.rdkit = "true";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load RDKit."));
    document.head.append(script);
  });
}

function molBlock(atoms: ValidationAtom[], bonds: ValidationBond[]) {
  const atomIndex = new Map(atoms.map((atom, index) => [atom.id, index + 1]));
  const covalent = bonds.filter((bond) => bond.type === "covalent");
  const atomLines = atoms.map(
    (atom) =>
      `${atom.x.toFixed(4).padStart(10)}${(-atom.y).toFixed(4).padStart(10)}    0.0000 ${atom.element.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`,
  );
  const bondLines = covalent.map(
    (bond) =>
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

export function loadRDKit(onProgress?: (progress: number) => void) {
  modulePromise ??= (async () => {
    onProgress?.(0.04);
    const response = await fetch("./rdkit/RDKit_minimal.wasm");
    if (!response.ok) throw new Error("Could not download the RDKit chemistry engine.");
    const total = Number(response.headers.get("content-length")) || 6_914_823;
    const reader = response.body?.getReader();
    let wasmBinary: Uint8Array;
    if (reader) {
      const chunks: Uint8Array[] = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        onProgress?.(Math.min(0.9, 0.05 + (received / total) * 0.85));
      }
      wasmBinary = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        wasmBinary.set(chunk, offset);
        offset += chunk.length;
      }
    } else {
      wasmBinary = new Uint8Array(await response.arrayBuffer());
      onProgress?.(0.9);
    }
    await loadScript();
    const init = (window as unknown as { initRDKitModule: RDKitLoader }).initRDKitModule;
    const rdkitModule = await (
      init as unknown as (options: { wasmBinary: Uint8Array }) => Promise<RDKitModule>
    )({ wasmBinary });
    onProgress?.(1);
    return rdkitModule;
  })();
  return modulePromise;
}

export async function validateStructure(atoms: ValidationAtom[], bonds: ValidationBond[]) {
  try {
    const rdkitModule = await loadRDKit();
    const molecule = rdkitModule.get_mol(
      molBlock(atoms, bonds),
      JSON.stringify({ sanitize: true, removeHs: false }),
    );
    if (!molecule)
      return { valid: false, reason: "RDKit rejected this atom valence or bond arrangement." };
    const canonicalSmiles = molecule.get_smiles();
    molecule.delete();
    return { valid: true, canonicalSmiles };
  } catch {
    return { valid: false, reason: "RDKit could not sanitize this structure." };
  }
}
