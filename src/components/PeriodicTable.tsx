"use client";

const symbols = [
  "H",
  "He",
  "Li",
  "Be",
  "B",
  "C",
  "N",
  "O",
  "F",
  "Ne",
  "Na",
  "Mg",
  "Al",
  "Si",
  "P",
  "S",
  "Cl",
  "Ar",
  "K",
  "Ca",
  "Sc",
  "Ti",
  "V",
  "Cr",
  "Mn",
  "Fe",
  "Co",
  "Ni",
  "Cu",
  "Zn",
  "Ga",
  "Ge",
  "As",
  "Se",
  "Br",
  "Kr",
  "Rb",
  "Sr",
  "Y",
  "Zr",
  "Nb",
  "Mo",
  "Tc",
  "Ru",
  "Rh",
  "Pd",
  "Ag",
  "Cd",
  "In",
  "Sn",
  "Sb",
  "Te",
  "I",
  "Xe",
  "Cs",
  "Ba",
  "La",
  "Ce",
  "Pr",
  "Nd",
  "Pm",
  "Sm",
  "Eu",
  "Gd",
  "Tb",
  "Dy",
  "Ho",
  "Er",
  "Tm",
  "Yb",
  "Lu",
  "Hf",
  "Ta",
  "W",
  "Re",
  "Os",
  "Ir",
  "Pt",
  "Au",
  "Hg",
  "Tl",
  "Pb",
  "Bi",
  "Po",
  "At",
  "Rn",
  "Fr",
  "Ra",
  "Ac",
  "Th",
  "Pa",
  "U",
  "Np",
  "Pu",
  "Am",
  "Cm",
  "Bk",
  "Cf",
  "Es",
  "Fm",
  "Md",
  "No",
  "Lr",
  "Rf",
  "Db",
  "Sg",
  "Bh",
  "Hs",
  "Mt",
  "Ds",
  "Rg",
  "Cn",
  "Nh",
  "Fl",
  "Mc",
  "Lv",
  "Ts",
  "Og",
];
const positions: Record<number, [number, number]> = {};
const rows = [
  [1, 18],
  [1, 2, 13, 14, 15, 16, 17, 18],
  [1, 2, 13, 14, 15, 16, 17, 18],
  Array.from({ length: 18 }, (_, i) => i + 1),
  Array.from({ length: 18 }, (_, i) => i + 1),
  [1, 2, ...Array.from({ length: 15 }, (_, i) => i + 4), 18],
  [1, 2, ...Array.from({ length: 15 }, (_, i) => i + 4), 18],
];
let z = 1;
rows.forEach((cols, row) =>
  cols.forEach((col) => {
    positions[z++] = [row + 1, col];
  }),
);

export default function PeriodicTable({ onSelect }: { onSelect: (symbol: string) => void }) {
  return (
    <section className="table-page">
      <header>
        <span className="eyebrow">THE SHAPE IS THE CONFIGURATION</span>
        <h1>
          Periodic table <em>decoded.</em>
        </h1>
        <p>
          Rows reach a new principal shell. Blocks show the subshell being filled. Groups preserve
          recurring valence patterns—not one universal bonding rule.
        </p>
      </header>
      <div className="block-key">
        <span className="s">s block · 2</span>
        <span className="d">d block · 10</span>
        <span className="p">p block · 6</span>
        <span className="f">f block · 14</span>
      </div>
      <div className="periodic-grid">
        {symbols.map((s, i) => {
          const n = i + 1;
          const pos = positions[n];
          const block =
            (n >= 57 && n <= 70) || (n >= 89 && n <= 102)
              ? "f"
              : pos?.[1] <= 2
                ? "s"
                : pos?.[1] >= 13
                  ? "p"
                  : "d";
          return (
            <button
              type="button"
              key={s}
              onClick={() => onSelect(s)}
              className={block}
              style={pos ? { gridRow: pos[0], gridColumn: pos[1] } : undefined}
            >
              <small>{n}</small>
              <strong>{s}</strong>
            </button>
          );
        })}
      </div>
      <div className="f-series">
        <span>f block</span>
        {symbols.slice(56, 70).map((s, i) => (
          <button type="button" key={s} onClick={() => onSelect(s)}>
            <small>{i + 57}</small>
            <b>{s}</b>
          </button>
        ))}
        <span></span>
        {symbols.slice(88, 102).map((s, i) => (
          <button type="button" key={s} onClick={() => onSelect(s)}>
            <small>{i + 89}</small>
            <b>{s}</b>
          </button>
        ))}
      </div>
      <aside className="table-explainer">
        <div>
          <b>Period 4</b>
          <span>4s fills</span>
          <Arrow>→</Arrow>
          <span>3d fills</span>
          <Arrow>→</Arrow>
          <span>4p fills</span>
        </div>
        <p>
          <strong>Why the middle appears:</strong> orbital energies overlap. 4s becomes occupied
          before 3d in K and Ca; once the d orbitals fill, their relative energies shift.
        </p>
      </aside>
    </section>
  );
}
function Arrow({ children }: { children: string }) {
  return <i>{children}</i>;
}
