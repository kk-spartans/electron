export type AtomNode = {
  id: number;
  element: string;
  x: number;
  y: number;
  charge: number;
  electronOffset: number;
};

export type BondEdge = {
  id: number;
  from: number;
  to: number;
  type: "covalent" | "ionic" | "metallic";
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
