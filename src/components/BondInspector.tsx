"use client";

import { X, Trash } from "@phosphor-icons/react";
import type { AtomNode, BondEdge } from "@/lib/types";
import { subshellColors as sharedSubshellColors } from "@/lib/subshells";
import { subshellsForAtom, pauling } from "@/lib/chemistry";

type BondInspectorProps = {
  bond: BondEdge;
  atoms: AtomNode[];
  onClose: () => void;
  onRemove: () => void;
};

export default function BondInspector({ bond, atoms, onClose, onRemove }: BondInspectorProps) {
  const from = atoms.find((atom) => atom.id === bond.from)!;
  const to = atoms.find((atom) => atom.id === bond.to)!;
  const fromEn = pauling(from.element),
    toEn = pauling(to.element),
    difference = Math.abs(fromEn - toEn);
  const polarity =
    bond.type === "ionic" ? "ionic" : difference < 0.4 ? "mostly nonpolar" : "polar covalent";
  const fromSubshell = subshellsForAtom(from).at(-1);
  const toSubshell = subshellsForAtom(to).at(-1);

  return (
    <div className="bond-inspector">
      <div className="inspector-title">
        <div>
          <small>Selected bond</small>
          <h1>
            {from.element} {bond.type === "ionic" ? "→" : "—"} {to.element}
          </h1>
          <code>{bond.type} bond</code>
        </div>
        <button type="button" aria-label="Close bond details" onClick={onClose}>
          <X />
        </button>
      </div>
      <section>
        <h2>Electron behavior</h2>
        {bond.type === "ionic" ? (
          <p>
            <b>{from.element}</b> donates an outer electron to <b>{to.element}</b>. They become
            oppositely charged ions held by electrostatic attraction.
          </p>
        ) : bond.type === "covalent" ? (
          <>
            <p>
              <b>{from.element}</b> contributes {bond.order} electron{bond.order > 1 ? "s" : ""} and{" "}
              <b>{to.element}</b> contributes {bond.order}. Together they share{" "}
              <b>{bond.order * 2} electrons</b> in{" "}
              {bond.order === 1 ? "one pair" : `${bond.order} pairs`}.
            </p>
            <div className="bond-contributors">
              <span>
                <i style={{ background: sharedSubshellColors[fromSubshell?.kind ?? "s"] }} />
                {from.element}: {fromSubshell?.label ?? "—"}
              </span>
              <span>
                <i style={{ background: sharedSubshellColors[toSubshell?.kind ?? "s"] }} />
                {to.element}: {toSubshell?.label ?? "—"}
              </span>
            </div>
            <small className="sharing-note">
              The matching ring on each atom marks the electron used here. Every single bond
              contains one two-electron pair.
            </small>
          </>
        ) : (
          <p>
            Valence electrons are delocalized across the metal atoms rather than belonging to one
            pair.
          </p>
        )}
      </section>
      <section>
        <h2>Bond polarity</h2>
        <div className="polarity-scale">
          <span>
            {from.element}
            <small>{fromEn.toFixed(2)}</small>
          </span>
          <i
            style={
              { "--polarity": `${Math.min(100, (difference / 2) * 100)}%` } as React.CSSProperties
            }
          />
          <span>
            {to.element}
            <small>{toEn.toFixed(2)}</small>
          </span>
        </div>
        <p>
          ΔEN = <b>{difference.toFixed(2)}</b>: this bond is {polarity}.
          {difference >= 0.4 && bond.type === "covalent" && (
            <>
              {" "}
              Electron density is pulled toward{" "}
              <b>{moreNegative(from, to, fromEn, toEn).element} δ−</b>; the other end is δ+.
            </>
          )}
        </p>
      </section>
      <button type="button" className="remove-bond" onClick={onRemove}>
        <Trash /> Remove bond
      </button>
    </div>
  );
}

function moreNegative(from: AtomNode, to: AtomNode, fromEn: number, toEn: number): AtomNode {
  return fromEn > toEn ? from : to;
}
