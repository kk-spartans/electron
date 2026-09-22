"use client";

import type { AtomNode, BondEdge } from "@/lib/types";
import { subshellsForAtom, pauling, elements } from "@/lib/chemistry";

type AtomLearningProps = {
  atom: AtomNode;
  atoms: AtomNode[];
  bonds: BondEdge[];
};

export default function AtomLearning({ atom, atoms, bonds }: AtomLearningProps) {
  const data = elements[atom.element];
  const connected = bonds.filter((bond) => bond.from === atom.id || bond.to === atom.id);
  const covalent = connected.filter((bond) => bond.type === "covalent");
  const bondOrder = covalent.reduce((sum, bond) => sum + bond.order, 0);
  const ownedValence = Math.max(0, data.valence - atom.charge);
  const nonbonding = Math.max(0, ownedValence - bondOrder);
  const lonePairs = Math.floor(nonbonding / 2),
    unpaired = nonbonding % 2;
  const formalCharge = atom.charge || data.valence - nonbonding - bondOrder;
  const neighborCount = new Set(
    covalent.map((bond) => (bond.from === atom.id ? bond.to : bond.from)),
  ).size;
  const domains = neighborCount + lonePairs;
  let geometry = "No molecular geometry",
    angle = "—";
  if (neighborCount === 1) {
    geometry = "Linear around this bond";
    angle = "180° axis";
  } else if (domains === 2) {
    geometry = "Linear";
    angle = "180°";
  } else if (domains === 3) {
    geometry = lonePairs ? "Bent" : "Trigonal planar";
    angle = lonePairs ? "less than 120°" : "120°";
  } else if (domains === 4) {
    geometry = lonePairs === 0 ? "Tetrahedral" : lonePairs === 1 ? "Trigonal pyramidal" : "Bent";
    angle = lonePairs === 0 ? "109.5°" : lonePairs === 1 ? "about 107°" : "about 104.5°";
  } else if (domains === 5) {
    geometry = "Trigonal bipyramidal electron geometry";
    angle = "90° and 120°";
  } else if (domains >= 6) {
    geometry = "Octahedral electron geometry";
    angle = "90°";
  }
  const ionicShells = subshellsForAtom(atom);
  const outerShell = ionicShells.at(-1)?.shell ?? 1;
  const ionicOuterCount = ionicShells
    .filter((subshell) => subshell.shell === outerShell)
    .reduce((sum, subshell) => sum + subshell.count, 0);
  const isIonic = atom.charge !== 0 && connected.some((bond) => bond.type === "ionic");
  const shellCount = isIonic ? ionicOuterCount : ownedValence + bondOrder;
  const shellTarget =
    isIonic && outerShell === 1 ? 2 : atom.element === "H" || atom.element === "He" ? 2 : 8;
  const exception =
    atom.element === "H" || atom.element === "He"
      ? "First-shell duet rule"
      : atom.element === "Be" || atom.element === "B"
        ? "Stable electron-deficient structures are possible"
        : shellCount > 8 && elements[atom.element].subshells.some((item) => item.shell >= 3)
          ? "Expanded valence shell is possible for some period-3-and-beyond compounds"
          : unpaired
            ? "An unpaired electron makes this a radical-like arrangement"
            : null;
  const permitsNonOctet = Boolean(exception) && unpaired === 0;
  const stable =
    connected.length === 0
      ? {
          tone: "neutral",
          title: "Unbonded",
          text: "Move the atom near compatible partners to test a structure.",
        }
      : shellCount === shellTarget || permitsNonOctet
        ? {
            tone: "good",
            title: "Locally satisfied",
            text: isIonic
              ? `After electron transfer, shell ${outerShell} is the ion's outer occupied shell and contains ${shellCount} of ${shellTarget} electrons.`
              : `The displayed valence shell has ${shellCount} electrons when shared electrons are counted.`,
          }
        : shellCount < shellTarget
          ? {
              tone: "warn",
              title: unpaired ? "Radical with incomplete shell" : "Incomplete valence shell",
              text: `The actual outer occupied shell ${isIonic ? `(shell ${outerShell}) ` : ""}contains ${shellCount} of ${shellTarget} electrons.`,
            }
          : {
              tone: "warn",
              title: "Check this structure",
              text: `The actual outer occupied shell contains ${shellCount} electrons, above its usual capacity of ${shellTarget}.`,
            };
  const polarBonds = covalent
    .map((bond) => {
      const partner = atoms.find(
        (item) => item.id === (bond.from === atom.id ? bond.to : bond.from),
      )!;
      const difference = Math.abs(pauling(atom.element) - pauling(partner.element));
      return {
        partner,
        difference,
        toward: pauling(atom.element) > pauling(partner.element) ? atom.element : partner.element,
      };
    })
    .filter((item) => item.difference >= 0.4);

  return (
    <>
      <section>
        <h2>Lewis accounting</h2>
        <div className="learning-metrics">
          <div>
            <b>{lonePairs}</b>
            <span>lone pair{lonePairs === 1 ? "" : "s"}</span>
          </div>
          <div>
            <b>{unpaired}</b>
            <span>unpaired</span>
          </div>
          <div>
            <b>{formalCharge > 0 ? `+${formalCharge}` : formalCharge}</b>
            <span>formal charge</span>
          </div>
        </div>
        <p>
          Bonding uses {bondOrder} electron{bondOrder === 1 ? "" : "s"} contributed by this atom;{" "}
          {nonbonding} valence electron{nonbonding === 1 ? " remains" : "s remain"} nonbonding.
        </p>
      </section>
      <section>
        <h2>Molecular geometry</h2>
        <div className="geometry-readout">
          <b>{geometry}</b>
          <span>{angle}</span>
        </div>
        <p>
          VSEPR estimate from {neighborCount} bonded region{neighborCount === 1 ? "" : "s"} and{" "}
          {lonePairs} lone pair{lonePairs === 1 ? "" : "s"}. Multiple bonds count as one electron
          region.
        </p>
      </section>
      <section>
        <h2>Polarity</h2>
        {polarBonds.length ? (
          <div className="polarity-list">
            {polarBonds.map(({ partner, difference, toward }) => (
              <div key={partner.id}>
                <b>
                  {atom.element}—{partner.element}
                </b>
                <span>
                  ΔEN {difference.toFixed(2)} · toward {toward} δ−
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p>
            {covalent.length
              ? "No strongly polar covalent bond is shown around this atom."
              : "Create a covalent bond to compare electronegativity."}
          </p>
        )}
      </section>
      <section>
        <h2>Stability check</h2>
        <div className={`stability ${stable.tone}`}>
          <b>{stable.title}</b>
          <span>{stable.text}</span>
        </div>
      </section>
    </>
  );
}
