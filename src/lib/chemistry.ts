import periodicTable from "@exabyte-io/periodic-table.js/periodic-table.json";
import type { Subshell } from "@/components/AtomScene";
import { subshellsForElectronCount } from "./subshells";

const allSymbols =
  "H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og".split(
    " ",
  );

const filling: Array<[string, number, number, "s" | "p" | "d" | "f"]> = [
  ["1s", 1, 2, "s"],
  ["2s", 2, 2, "s"],
  ["2p", 2, 6, "p"],
  ["3s", 3, 2, "s"],
  ["3p", 3, 6, "p"],
  ["4s", 4, 2, "s"],
  ["3d", 3, 10, "d"],
  ["4p", 4, 6, "p"],
  ["5s", 5, 2, "s"],
  ["4d", 4, 10, "d"],
  ["5p", 5, 6, "p"],
  ["6s", 6, 2, "s"],
  ["4f", 4, 14, "f"],
  ["5d", 5, 10, "d"],
  ["6p", 6, 6, "p"],
  ["7s", 7, 2, "s"],
  ["5f", 5, 14, "f"],
  ["6d", 6, 10, "d"],
  ["7p", 7, 6, "p"],
];

export type ElementData = {
  name: string;
  z: number;
  shells: number[];
  config: string;
  valence: number;
  subshells: Subshell[];
  note: string;
};

function generatedElement(symbol: string, z: number): ElementData {
  let remaining = z;
  const subshells: Subshell[] = [];
  for (const [label, shell, capacity, kind] of filling) {
    if (!remaining) break;
    const count = Math.min(capacity, remaining);
    subshells.push({ label, shell, count, kind });
    remaining -= count;
  }
  const highest = Math.max(...subshells.map((item) => item.shell));
  const shells = Array.from({ length: highest }, (_, index) =>
    subshells.filter((item) => item.shell === index + 1).reduce((sum, item) => sum + item.count, 0),
  );
  const valence = shells.at(-1) ?? 0;
  const reference = (
    periodicTable as Record<string, { name: string; electronic_configuration: string }>
  )[symbol];
  return {
    name: reference.name,
    z,
    shells,
    valence,
    subshells,
    config: reference.electronic_configuration,
    note:
      reference.name +
      " is shown using its ground-state filling order. Bonding behavior depends on its outer electrons.",
  };
}

export const elements: Record<string, ElementData> = Object.fromEntries(
  allSymbols.map((symbol, index) => [symbol, generatedElement(symbol, index + 1)]),
);

export const metals = new Set(
  "Li Be Na Mg Al K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv".split(
    " ",
  ),
);

export const nobleGases = new Set(["He", "Ne", "Ar", "Kr", "Xe", "Rn", "Og"]);

export function subshellsForAtom(atom: { element: string; charge: number; electronOffset: number }) {
  const data = elements[atom.element];
  return subshellsForElectronCount(data.z - atom.charge + atom.electronOffset);
}

export function pauling(symbol: string) {
  return (
    Number(
      (periodicTable as unknown as Record<string, { pauling_negativity?: number | string }>)[
        symbol
      ]?.pauling_negativity,
    ) || 0
  );
}
