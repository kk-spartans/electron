"use client";

import { X, Trash, ArrowsIn, ArrowsOut } from "@phosphor-icons/react";
import type { AtomNode, BondEdge, FormulaGroup } from "@/lib/types";
import { pauling } from "@/lib/chemistry";

type MoleculeInspectorProps = {
  group: FormulaGroup & { cid?: number };
  atoms: AtomNode[];
  bonds: BondEdge[];
  onClose: () => void;
  onDelete: () => void;
  compressed: boolean;
  onToggleCompressed: () => void;
};

export default function MoleculeInspector({
  group,
  atoms,
  bonds,
  onClose,
  onDelete,
  compressed,
  onToggleCompressed,
}: MoleculeInspectorProps) {
  const memberIds = new Set(group.atomIds);
  const members = atoms.filter((atom) => memberIds.has(atom.id));
  const moleculeBonds = bonds.filter((bond) => memberIds.has(bond.from) && memberIds.has(bond.to));
  const counts = members.reduce<Record<string, number>>((result, atom) => {
    result[atom.element] = (result[atom.element] ?? 0) + 1;
    return result;
  }, {});
  const totalCharge = members.reduce((sum, atom) => sum + atom.charge, 0);
  const covalent = moleculeBonds.filter((bond) => bond.type === "covalent");
  const ionic = moleculeBonds.filter((bond) => bond.type === "ionic");
  const polar = covalent.filter((bond) => {
    const from = atoms.find((atom) => atom.id === bond.from),
      to = atoms.find((atom) => atom.id === bond.to);
    return Boolean(from && to && Math.abs(pauling(from.element) - pauling(to.element)) >= 0.4);
  }).length;

  return (
    <div className="molecule-inspector">
      <div className="inspector-title">
        <div>
          <small>Selected molecule</small>
          <h1>{group.name ?? group.formula}</h1>
          <code>
            {group.formula}
            {group.cid ? ` · CID ${group.cid}` : ""}
          </code>
        </div>
        <button type="button" aria-label="Deselect molecule" onClick={onClose}>
          <X />
        </button>
      </div>
      <section>
        <h2>Composition</h2>
        <div className="molecule-composition">
          {Object.entries(counts).map(([symbol, count]) => (
            <span key={symbol}>
              <b>{symbol}</b>
              {count}
            </span>
          ))}
        </div>
        <p>
          {members.length} atoms · net charge {totalCharge > 0 ? `+${totalCharge}` : totalCharge}
        </p>
      </section>
      <section>
        <h2>Structure</h2>
        <div className="learning-metrics">
          <div>
            <b>{moleculeBonds.length}</b>
            <span>bonds</span>
          </div>
          <div>
            <b>{covalent.length}</b>
            <span>covalent</span>
          </div>
          <div>
            <b>{polar}</b>
            <span>polar</span>
          </div>
        </div>
        {ionic.length > 0 && (
          <p>
            {ionic.length} ionic interaction{ionic.length === 1 ? " is" : "s are"} shown.
          </p>
        )}
      </section>
      <section>
        <h2>Interaction</h2>
        <p>
          Drag the outlined area to move all atoms together. Individual atoms and bonds remain
          selectable.
        </p>
      </section>
      <button type="button" className="compress-molecule" onClick={onToggleCompressed}>
        {compressed ? <ArrowsOut /> : <ArrowsIn />}
        {compressed ? "Expand structure" : "Compress"}
      </button>
      <button type="button" className="remove-bond" onClick={onDelete}>
        <Trash /> Delete molecule
      </button>
    </div>
  );
}
