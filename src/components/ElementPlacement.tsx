"use client";

import { elements } from "@/lib/chemistry";

type ElementPlacementProps = {
  symbol: string;
};

export default function ElementPlacement({ symbol }: ElementPlacementProps) {
  const data = elements[symbol];
  const mainPosition = periodicMain.flatMap((row, periodIndex) =>
    row
      .filter(([candidate]) => candidate === symbol)
      .map(([, group]) => ({
        period: periodIndex + 1,
        group,
      })),
  )[0];
  const fRow = periodicFBlock.findIndex((row) => row.includes(symbol));
  const period = mainPosition?.period ?? (fRow === 0 ? 6 : 7);
  const group = mainPosition?.group ?? 3;
  const last = data.subshells.at(-1);
  const block = last?.kind ?? "s";
  const mainGroup = data.z <= 20;
  const groupReason = mainGroup
    ? group <= 2
      ? `${data.valence} outer-shell electron${data.valence === 1 ? "" : "s"} place it in group ${group}.`
      : `${data.valence} valence electrons map to main-group ${group} (group number = valence + 10).`
    : block === "d"
      ? `Its differentiating electron enters a d subshell. For transition metals, the group follows the combined outer s and incomplete (n−1)d electrons, not outer-shell electrons alone.`
      : block === "f"
        ? `Its differentiating electron enters an f subshell, placing it in the inner-transition ${period === 6 ? "lanthanide" : "actinide"} series conventionally associated with group 3.`
        : `Its last-filled ${last?.label} subshell places it in the ${block}-block; the occupied outer ${block} subshell determines its main-group column.`;

  return (
    <section className="element-placement">
      <h2>
        Why period {period}, group {group}
      </h2>
      <p>
        <b>Period {period}</b> comes from the highest occupied principal shell, n = {period}.{" "}
        {groupReason}
      </p>
      <div className="placement-tags">
        <span>{block}-block</span>
        <span>last filled: {last?.label}</span>
      </div>
    </section>
  );
}

const periodicMain: Array<Array<[string, number]>> = [
  [
    ["H", 1],
    ["He", 18],
  ],
  [
    ["Li", 1],
    ["Be", 2],
    ["B", 13],
    ["C", 14],
    ["N", 15],
    ["O", 16],
    ["F", 17],
    ["Ne", 18],
  ],
  [
    ["Na", 1],
    ["Mg", 2],
    ["Al", 13],
    ["Si", 14],
    ["P", 15],
    ["S", 16],
    ["Cl", 17],
    ["Ar", 18],
  ],
  "K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr"
    .split(" ")
    .map((symbol, index) => [symbol, index + 1] as [string, number]),
  "Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe"
    .split(" ")
    .map((symbol, index) => [symbol, index + 1] as [string, number]),
  [
    ["Cs", 1],
    ["Ba", 2],
    ["La", 3],
    ["Hf", 4],
    ["Ta", 5],
    ["W", 6],
    ["Re", 7],
    ["Os", 8],
    ["Ir", 9],
    ["Pt", 10],
    ["Au", 11],
    ["Hg", 12],
    ["Tl", 13],
    ["Pb", 14],
    ["Bi", 15],
    ["Po", 16],
    ["At", 17],
    ["Rn", 18],
  ],
  [
    ["Fr", 1],
    ["Ra", 2],
    ["Ac", 3],
    ["Rf", 4],
    ["Db", 5],
    ["Sg", 6],
    ["Bh", 7],
    ["Hs", 8],
    ["Mt", 9],
    ["Ds", 10],
    ["Rg", 11],
    ["Cn", 12],
    ["Nh", 13],
    ["Fl", 14],
    ["Mc", 15],
    ["Lv", 16],
    ["Ts", 17],
    ["Og", 18],
  ],
];
const periodicFBlock = [
  "Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu".split(" "),
  "Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr".split(" "),
];
