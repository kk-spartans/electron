export type Subshell = { label: string; count: number; shell: number; kind: "s" | "p" | "d" | "f" };

export type AtomNode = {
  id: number;
  element: string;
  x: number;
  y: number;
  charge: number;
  electronOffset: number;
};

export type BondType = "covalent" | "ionic" | "metallic";

export type BondEdge = {
  id: number;
  from: number;
  to: number;
  type: BondType;
  order: 1 | 2 | 3;
};

export type FormulaGroup = {
  id: number;
  formula: string;
  atomIds: number[];
  name?: string;
  source?: string;
  cid?: number;
};
