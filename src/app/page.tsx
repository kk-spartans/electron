"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowCounterClockwise,
  ArrowsIn,
  ArrowsOut,
  Atom,
  FloppyDisk,
  MagnifyingGlass,
  Trash,
  X,
} from "@phosphor-icons/react";
import AtomScene, { Subshell, subshellColors } from "@/components/AtomScene";
import periodicTable from "@exabyte-io/periodic-table.js/periodic-table.json";
import { loadRDKit, validateStructure } from "@/lib/rdkit";
import {
  lookupCompoundFacts,
  lookupStructure,
  type StructureCandidate,
  type StructureRecord,
} from "@/lib/pubchem";

type ElementKey = string;
type AtomNode = {
  id: number;
  element: ElementKey;
  x: number;
  y: number;
  charge: number;
  electronOffset: number;
};
type BondType = "covalent" | "ionic" | "metallic";
type BondEdge = { id: number; from: number; to: number; type: BondType; order: 1 | 2 | 3 };
type FormulaGroup = {
  id: number;
  atomIds: number[];
  formula: string;
  name?: string;
  source?: string;
  cid?: number;
};

type ReactionRecipe = {
  reactants: Array<{ formula: string; coefficient: number }>;
  products: Array<{ formula: string; coefficient: number; cid: number }>;
  name: string;
  condition: string;
};

type MoleculeEntity = {
  id: number;
  formula: string;
  atomIds: number[];
  x: number;
  y: number;
  cid?: number;
  name?: string;
};

type PreparedReaction = {
  key: string;
  recipe: ReactionRecipe;
  atomIds: number[];
  center: { x: number; y: number };
};

type HistorySnapshot = {
  atoms: AtomNode[];
  bonds: BondEdge[];
  formulaGroups: FormulaGroup[];
  compressedGroupIds: number[];
};

type CanvasDocument = {
  version: 1;
  savedAt: string;
  atoms: AtomNode[];
  bonds: BondEdge[];
  formulaGroups: FormulaGroup[];
  compressedGroupIds?: number[];
  view: { pan: { x: number; y: number }; scale: number };
};
type CanvasFileHandle = {
  createWritable: () => Promise<{
    write: (contents: string) => Promise<void>;
    close: () => Promise<void>;
  }>;
};

const canvasFileExtension = ".electron";
const localCanvasKey = "electron:canvas";
const opfsCanvasFileName = "electron-autosave.electron";
const canvasNavigationHintKey = "electron:canvas-navigation-hint-seen";
const reactionChoiceCache = new Map<string, Promise<ReactionRecipe[]>>();

function sameHistorySnapshot(first: HistorySnapshot, second: HistorySnapshot) {
  return JSON.stringify(first) === JSON.stringify(second);
}

function useAnimatedPresence(open: boolean, exitDuration = 150) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;

    setClosing(true);
    const timeout = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, exitDuration);
    return () => window.clearTimeout(timeout);
  }, [exitDuration, mounted, open]);

  return { mounted, closing };
}

function parseCanvasDocument(contents: string): CanvasDocument {
  const candidate = JSON.parse(contents) as Partial<CanvasDocument>;
  if (
    candidate.version !== 1 ||
    !Array.isArray(candidate.atoms) ||
    !Array.isArray(candidate.bonds) ||
    !Array.isArray(candidate.formulaGroups) ||
    !candidate.view ||
    !Number.isFinite(candidate.view.pan?.x) ||
    !Number.isFinite(candidate.view.pan?.y) ||
    !Number.isFinite(candidate.view.scale) ||
    candidate.atoms.length > 1000
  )
    throw new Error("This is not a valid Electron canvas file.");
  if (
    candidate.compressedGroupIds &&
    (!Array.isArray(candidate.compressedGroupIds) ||
      candidate.compressedGroupIds.some((id) => !Number.isInteger(id)))
  )
    throw new Error("The canvas file contains invalid compressed molecule data.");

  const atomIds = new Set<number>();
  candidate.atoms.forEach((atom) => {
    if (
      !Number.isInteger(atom.id) ||
      atomIds.has(atom.id) ||
      !(atom.element in elements) ||
      !Number.isFinite(atom.x) ||
      !Number.isFinite(atom.y) ||
      !Number.isFinite(atom.charge) ||
      !Number.isFinite(atom.electronOffset)
    )
      throw new Error("The canvas file contains an invalid atom.");
    atomIds.add(atom.id);
  });
  if (
    candidate.bonds.some(
      (bond) =>
        !Number.isInteger(bond.id) ||
        !atomIds.has(bond.from) ||
        !atomIds.has(bond.to) ||
        !["covalent", "ionic", "metallic"].includes(bond.type) ||
        ![1, 2, 3].includes(bond.order),
    )
  )
    throw new Error("The canvas file contains an invalid bond.");

  return candidate as CanvasDocument;
}

async function readAutosavedCanvas() {
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(opfsCanvasFileName);
    return await (await handle.getFile()).text();
  } catch {
    try {
      return localStorage.getItem(localCanvasKey);
    } catch {
      return null;
    }
  }
}

async function writeAutosavedCanvas(contents: string) {
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(opfsCanvasFileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(contents);
    await writable.close();
    try {
      localStorage.removeItem(localCanvasKey);
    } catch {}
  } catch {
    try {
      localStorage.setItem(localCanvasKey, contents);
    } catch {}
  }
}

type ElementData = {
  name: string;
  z: number;
  shells: number[];
  config: string;
  valence: number;
  subshells: Subshell[];
  note: string;
};

const coreElements: Record<string, ElementData> = {
  H: {
    name: "Hydrogen",
    z: 1,
    shells: [1],
    config: "1s¹",
    valence: 1,
    subshells: [{ label: "1s", count: 1, shell: 1, kind: "s" }],
    note: "One 1s electron can be shared or transferred.",
  },
  C: {
    name: "Carbon",
    z: 6,
    shells: [2, 4],
    config: "1s² 2s² 2p²",
    valence: 4,
    subshells: [
      { label: "1s", count: 2, shell: 1, kind: "s" },
      { label: "2s", count: 2, shell: 2, kind: "s" },
      { label: "2p", count: 2, shell: 2, kind: "p" },
    ],
    note: "Four valence electrons let carbon form varied covalent structures.",
  },
  N: {
    name: "Nitrogen",
    z: 7,
    shells: [2, 5],
    config: "1s² 2s² 2p³",
    valence: 5,
    subshells: [
      { label: "1s", count: 2, shell: 1, kind: "s" },
      { label: "2s", count: 2, shell: 2, kind: "s" },
      { label: "2p", count: 3, shell: 2, kind: "p" },
    ],
    note: "Three unpaired 2p electrons commonly produce three covalent bonds.",
  },
  O: {
    name: "Oxygen",
    z: 8,
    shells: [2, 6],
    config: "1s² 2s² 2p⁴",
    valence: 6,
    subshells: [
      { label: "1s", count: 2, shell: 1, kind: "s" },
      { label: "2s", count: 2, shell: 2, kind: "s" },
      { label: "2p", count: 4, shell: 2, kind: "p" },
    ],
    note: "Two vacancies in the valence shell favor two covalent bonds.",
  },
  Na: {
    name: "Sodium",
    z: 11,
    shells: [2, 8, 1],
    config: "[Ne] 3s¹",
    valence: 1,
    subshells: [
      { label: "1s", count: 2, shell: 1, kind: "s" },
      { label: "2s", count: 2, shell: 2, kind: "s" },
      { label: "2p", count: 6, shell: 2, kind: "p" },
      { label: "3s", count: 1, shell: 3, kind: "s" },
    ],
    note: "The lone 3s electron is readily transferred to form Na⁺.",
  },
  Cl: {
    name: "Chlorine",
    z: 17,
    shells: [2, 8, 7],
    config: "[Ne] 3s² 3p⁵",
    valence: 7,
    subshells: [
      { label: "1s", count: 2, shell: 1, kind: "s" },
      { label: "2s", count: 2, shell: 2, kind: "s" },
      { label: "2p", count: 6, shell: 2, kind: "p" },
      { label: "3s", count: 2, shell: 3, kind: "s" },
      { label: "3p", count: 5, shell: 3, kind: "p" },
    ],
    note: "One 3p vacancy makes electron gain or one shared pair favorable.",
  },
  Fe: {
    name: "Iron",
    z: 26,
    shells: [2, 8, 14, 2],
    config: "[Ar] 3d⁶ 4s²",
    valence: 2,
    subshells: [
      { label: "1s", count: 2, shell: 1, kind: "s" },
      { label: "2s", count: 2, shell: 2, kind: "s" },
      { label: "2p", count: 6, shell: 2, kind: "p" },
      { label: "3s", count: 2, shell: 3, kind: "s" },
      { label: "3p", count: 6, shell: 3, kind: "p" },
      { label: "3d", count: 6, shell: 3, kind: "d" },
      { label: "4s", count: 2, shell: 4, kind: "s" },
    ],
    note: "4s electrons are typically removed before 3d electrons in iron ions.",
  },
};

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
const elements: Record<string, ElementData> = Object.fromEntries(
  allSymbols.map((symbol, index) => [
    symbol,
    coreElements[symbol] ?? generatedElement(symbol, index + 1),
  ]),
);
const metals = new Set(
  "Li Be Na Mg Al K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv".split(
    " ",
  ),
);
const nobleGases = new Set(["He", "Ne", "Ar", "Kr", "Xe", "Rn", "Og"]);

function ionicDonationLimit(symbol: string) {
  if (["Li", "Na", "K", "Rb", "Cs", "Fr"].includes(symbol)) return 1;
  if (["Be", "Mg", "Ca", "Sr", "Ba", "Ra"].includes(symbol)) return 2;
  if (["Al", "Ga", "In"].includes(symbol)) return 3;
  return Math.max(1, Math.min(4, elements[symbol]?.valence ?? 2));
}

function ionicAcceptanceLimit(symbol: string) {
  if (["F", "Cl", "Br", "I", "At", "Ts"].includes(symbol)) return 1;
  if (["O", "S", "Se", "Te", "Po"].includes(symbol)) return 2;
  if (["N", "P", "As", "Sb"].includes(symbol)) return 3;
  return Math.max(1, Math.min(4, 8 - (elements[symbol]?.valence ?? 4)));
}

function applyIonicCharges(atomList: AtomNode[], bondList: BondEdge[]) {
  const charges = new Map(atomList.map((atom) => [atom.id, 0]));
  bondList
    .filter((bond) => bond.type === "ionic")
    .forEach((bond) => {
      const from = atomList.find((atom) => atom.id === bond.from),
        to = atomList.find((atom) => atom.id === bond.to);
      if (!from || !to || metals.has(from.element) === metals.has(to.element)) return;
      const donor = metals.has(from.element) ? from : to,
        receiver = donor === from ? to : from;
      charges.set(donor.id, (charges.get(donor.id) ?? 0) + bond.order);
      charges.set(receiver.id, (charges.get(receiver.id) ?? 0) - bond.order);
    });
  return atomList.map((atom) => ({ ...atom, charge: charges.get(atom.id) ?? 0 }));
}

const electronSubshellCache = new Map<number, Subshell[]>();

function subshellsForElectronCount(count: number) {
  const cached = electronSubshellCache.get(count);
  if (cached) return cached;
  let remaining = Math.max(0, count);
  const result: Subshell[] = [];
  for (const [label, shell, capacity, kind] of filling) {
    if (!remaining) break;
    const occupied = Math.min(capacity, remaining);
    result.push({ label, shell, count: occupied, kind });
    remaining -= occupied;
  }
  electronSubshellCache.set(count, result);
  return result;
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

export default function Home() {
  const [atoms, setAtoms] = useState<AtomNode[]>([]);
  const [bonds, setBonds] = useState<BondEdge[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const [elementQuery, setElementQuery] = useState("");
  const [selectedBond, setSelectedBond] = useState<number | null>(null);
  const [selectedElectron, setSelectedElectron] = useState<{
    atomId: number;
    label: string;
    kind: "s" | "p" | "d" | "f";
    shared: boolean;
    source?: string;
  } | null>(null);
  const [formulaOpen, setFormulaOpen] = useState(false);
  const [formulaInput, setFormulaInput] = useState("");
  const [formulaError, setFormulaError] = useState("");
  const [formulaLoading, setFormulaLoading] = useState(false);
  const [formulaCandidates, setFormulaCandidates] = useState<StructureCandidate[]>([]);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveFileName, setSaveFileName] = useState("electron-canvas");
  const [sidebarWidths, setSidebarWidths] = useState({ left: 228, right: 336 });
  const [periodicOpen, setPeriodicOpen] = useState(false);
  const periodicPresence = useAnimatedPresence(periodicOpen);
  const saveDialogPresence = useAnimatedPresence(saveDialogOpen);
  const formulaPresence = useAnimatedPresence(formulaOpen);
  const [valenceFilter, setValenceFilter] = useState("all");
  const [characterFilter, setCharacterFilter] = useState("all");
  const [formulaGroups, setFormulaGroups] = useState<FormulaGroup[]>([]);
  const [selectedMolecule, setSelectedMolecule] = useState<number | null>(null);
  const [compressedGroups, setCompressedGroups] = useState<Set<number>>(() => new Set());
  const [reactionChoices, setReactionChoices] = useState<ReactionRecipe[]>([]);
  const [reactionSearching, setReactionSearching] = useState(false);
  const [reactionSearchEmpty, setReactionSearchEmpty] = useState(false);
  const [reactionCandidate, setReactionCandidate] = useState<{
    key: string;
    pairs: Array<{ first: MoleculeEntity; second: MoleculeEntity; distance: number }>;
  } | null>(null);
  const reactionPairRef = useRef<{
    first: MoleculeEntity;
    second: MoleculeEntity;
  } | null>(null);
  const [preparedReaction, setPreparedReaction] = useState<PreparedReaction | null>(null);
  const [validationNotice, setValidationNotice] = useState("");
  const [canvasNavigationHint, setCanvasNavigationHint] = useState(false);
  const canvasNavigationHintShown = useRef(false);
  const [selectionBox, setSelectionBox] = useState<{
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null>(null);
  const [boot, setBoot] = useState({ progress: 0, ready: false, error: "" });
  const [localCanvasReady, setLocalCanvasReady] = useState(false);
  const nextId = useRef(1);
  const defaultCompoundLoaded = useRef(false);
  const spawnFormulaRef = useRef<
    (
      formula: string,
      options?: { center?: { x: number; y: number }; preserveView?: boolean; select?: boolean },
    ) => Promise<FormulaGroup | undefined>
  >(async () => undefined);
  const validationSequence = useRef(0);
  const formulaSpawnCount = useRef(0);
  const canvasRef = useRef<HTMLElement>(null);
  const atomsRef = useRef(atoms);
  const bondsRef = useRef(bonds);
  const formulaGroupsRef = useRef(formulaGroups);
  const compressedGroupsRef = useRef(compressedGroups);
  const historyCurrent = useRef<HistorySnapshot | null>(null);
  const undoStack = useRef<HistorySnapshot[]>([]);
  const redoStack = useRef<HistorySnapshot[]>([]);
  const historyTimer = useRef<number | null>(null);
  const applyingHistory = useRef(false);
  const geometryAnimation = useRef<number | null>(null);
  const gesture = useRef<
    | { type: "pan"; sx: number; sy: number; ox: number; oy: number }
    | {
        type: "marquee";
        sx: number;
        sy: number;
        ox: number;
        oy: number;
        additive: boolean;
      }
    | {
        type: "selection";
        sx: number;
        sy: number;
        origins: Map<number, { x: number; y: number }>;
      }
    | null
  >(null);
  const resizing = useRef<{ side: "left" | "right"; startX: number; startWidth: number } | null>(
    null,
  );
  const atomById = useMemo(() => new Map(atoms.map((atom) => [atom.id, atom])), [atoms]);
  const active = atomById.get(selected[selected.length - 1]);
  const activeElement = active ? elements[active.element] : null;
  const activeSubshells =
    active && activeElement
      ? subshellsForElectronCount(activeElement.z - active.charge + active.electronOffset)
      : [];
  const activeBond = bonds.find((bond) => bond.id === selectedBond);
  const selectedAtomIds = new Set(selected);
  const visibleElements = allSymbols.filter(
    (symbol) =>
      symbol.toLowerCase().includes(elementQuery.toLowerCase()) ||
      elements[symbol].name.toLowerCase().includes(elementQuery.toLowerCase()),
  );
  const atomBondVisuals = useMemo(() => {
    const visuals = new Map<
      number,
      {
        sharedElectrons: number;
        sharedFrom: Array<{ color: string; label: string; subshell: string }>;
      }
    >();
    const visualFor = (
      id: number,
    ): {
      sharedElectrons: number;
      sharedFrom: Array<{ color: string; label: string; subshell: string }>;
    } => {
      const existing = visuals.get(id);
      if (existing) return existing;
      const created = { sharedElectrons: 0, sharedFrom: [] };
      visuals.set(id, created);
      return created;
    };

    bonds.forEach((bond) => {
      if (bond.type !== "covalent") return;
      const from = atomById.get(bond.from),
        to = atomById.get(bond.to);
      if (!from || !to) return;
      const addShared = (atom: AtomNode, partner: AtomNode) => {
        const visual = visualFor(atom.id);
        visual.sharedElectrons += bond.order;
        const subshell = subshellsForElectronCount(
          elements[partner.element].z - partner.charge + partner.electronOffset,
        ).at(-1);
        for (let index = 0; index < bond.order; index++)
          visual.sharedFrom.push({
            color: subshellColors[subshell?.kind ?? "s"],
            label: partner.element,
            subshell: subshell?.label ?? "unknown",
          });
      };
      addShared(from, to);
      addShared(to, from);
    });
    return visuals;
  }, [atomById, bonds]);

  const bondSummary = useMemo(() => {
    if (!active) return [];
    return bonds.filter((bond) => bond.from === active.id || bond.to === active.id);
  }, [active, bonds]);

  const bondAngles = useMemo(() => {
    if (!active) return [];
    const neighbors = bonds
      .flatMap((bond) =>
        bond.from === active.id ? [bond.to] : bond.to === active.id ? [bond.from] : [],
      )
      .map((id) => atomById.get(id))
      .filter((atom): atom is AtomNode => Boolean(atom));
    if (neighbors.length < 2) return [];
    const ordered = neighbors
      .map((atom) => ({ atom, angle: Math.atan2(atom.y - active.y, atom.x - active.x) }))
      .sort((a, b) => a.angle - b.angle);
    const pairs =
      ordered.length === 2
        ? [[ordered[0], ordered[1]]]
        : ordered.map((item, index) => [item, ordered[(index + 1) % ordered.length]]);
    return pairs.map(([first, second]) => {
      let delta = second.angle - first.angle;
      if (delta <= 0) delta += Math.PI * 2;
      return { start: first.angle, end: second.angle, angle: (delta * 180) / Math.PI };
    });
  }, [active, atomById, bonds]);

  useEffect(() => {
    atomsRef.current = atoms;
  }, [atoms]);
  useEffect(() => {
    bondsRef.current = bonds;
  }, [bonds]);
  useEffect(() => {
    formulaGroupsRef.current = formulaGroups;
  }, [formulaGroups]);
  useEffect(() => {
    compressedGroupsRef.current = compressedGroups;
  }, [compressedGroups]);
  useEffect(() => {
    if (applyingHistory.current) {
      applyingHistory.current = false;
      return;
    }
    const immediate = captureHistorySnapshot();
    if (!historyCurrent.current) {
      historyCurrent.current = immediate;
      return;
    }
    if (historyTimer.current) window.clearTimeout(historyTimer.current);
    historyTimer.current = window.setTimeout(() => {
      const snapshot = captureHistorySnapshot();
      if (!historyCurrent.current) return;
      if (sameHistorySnapshot(historyCurrent.current, snapshot)) return;
      undoStack.current.push(historyCurrent.current);
      if (undoStack.current.length > 100) undoStack.current.shift();
      historyCurrent.current = snapshot;
      redoStack.current = [];
    }, 220);
    return () => {
      if (historyTimer.current) window.clearTimeout(historyTimer.current);
    };
  }, [atoms, bonds, formulaGroups, compressedGroups]);
  useEffect(() => {
    spawnFormulaRef.current = spawnFormula;
  });
  useEffect(() => {
    let active = true;
    loadRDKit((progress) => {
      if (active) setBoot({ progress, ready: false, error: "" });
    })
      .then(() => {
        if (active) setBoot({ progress: 1, ready: true, error: "" });
      })
      .catch((error) => {
        if (active)
          setBoot({
            progress: 0,
            ready: false,
            error: error instanceof Error ? error.message : "The chemistry engine could not load.",
          });
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!boot.ready || defaultCompoundLoaded.current) return;
    let current = true;
    const restoreCanvas = async () => {
      try {
        const saved = await readAutosavedCanvas();
        if (!current) return;
        if (saved) {
          applyCanvasDocument(parseCanvasDocument(saved));
          defaultCompoundLoaded.current = true;
          setLocalCanvasReady(true);
          return;
        }
      } catch {
        try {
          localStorage.removeItem(localCanvasKey);
        } catch {}
      }
      await spawnFormulaRef.current("fentanyl");
      if (current) {
        defaultCompoundLoaded.current = true;
        setLocalCanvasReady(true);
      }
    };
    void restoreCanvas();
    return () => {
      current = false;
    };
  }, [boot.ready]);
  useEffect(() => {
    if (!localCanvasReady) return;
    const timeout = window.setTimeout(() => {
      void writeAutosavedCanvas(
        JSON.stringify({
          version: 1,
          savedAt: new Date().toISOString(),
          atoms,
          bonds,
          formulaGroups,
          compressedGroupIds: [...compressedGroups],
          view: { pan, scale },
        } satisfies CanvasDocument),
      );
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [atoms, bonds, compressedGroups, formulaGroups, localCanvasReady, pan, scale]);
  useEffect(() => {
    if (!validationNotice) return;
    const timeout = window.setTimeout(() => setValidationNotice(""), 4200);
    return () => window.clearTimeout(timeout);
  }, [validationNotice]);
  useEffect(() => {
    if (!canvasNavigationHint) return;
    const timeout = window.setTimeout(() => setCanvasNavigationHint(false), 6500);
    return () => window.clearTimeout(timeout);
  }, [canvasNavigationHint]);

  // Compound identities and names come from PubChem-backed formula groups.
  const namedCompounds = useMemo<
    Array<{
      formula: string;
      name: string;
      atomIds: number[];
      x: number;
      y: number;
    }>
  >(() => [], []);
  const activeMolecule =
    formulaGroups.find((group) => group.id === selectedMolecule) ??
    namedCompounds
      .filter((compound) => -Math.min(...compound.atomIds) === selectedMolecule)
      .map<FormulaGroup>((compound) => ({
        id: -Math.min(...compound.atomIds),
        atomIds: compound.atomIds,
        formula: compound.formula,
        name: compound.name,
        source: "canvas structure",
      }))[0];

  const moleculeEntities = useMemo(() => {
    const claimed = new Set<number>();
    const groups = formulaGroups.flatMap((group) => {
      const members = group.atomIds
        .map((id) => atomById.get(id))
        .filter((atom): atom is AtomNode => Boolean(atom));
      if (!members.length) return [];
      members.forEach((atom) => claimed.add(atom.id));
      return [
        {
          id: group.id,
          formula: plainFormula(group.formula),
          atomIds: group.atomIds,
          x: members.reduce((sum, atom) => sum + atom.x, 0) / members.length,
          y: members.reduce((sum, atom) => sum + atom.y, 0) / members.length,
          cid: group.cid,
          name: group.name,
        },
      ];
    });
    const known = namedCompounds.flatMap((compound) => {
      if (compound.atomIds.some((id) => claimed.has(id))) return [];
      compound.atomIds.forEach((id) => claimed.add(id));
      return [
        {
          id: -Math.min(...compound.atomIds),
          formula: plainFormula(compound.formula),
          atomIds: compound.atomIds,
          x: compound.x,
          y: compound.y - 125,
        },
      ];
    });
    const singles = atoms
      .filter((atom) => !claimed.has(atom.id))
      .map((atom) => ({
        id: -1_000_000 - atom.id,
        formula: atom.element,
        atomIds: [atom.id],
        x: atom.x,
        y: atom.y,
        name: elements[atom.element].name,
      }));
    return [...groups, ...known, ...singles];
  }, [atomById, atoms, formulaGroups, namedCompounds]);

  const nearbyReactantPairs = useMemo(() => {
    const pairs: Array<{
      first: MoleculeEntity;
      second: MoleculeEntity;
      distance: number;
    }> = [];
    for (let firstIndex = 0; firstIndex < moleculeEntities.length; firstIndex++) {
      for (let secondIndex = firstIndex + 1; secondIndex < moleculeEntities.length; secondIndex++) {
        const first = moleculeEntities[firstIndex],
          second = moleculeEntities[secondIndex],
          distance = Math.hypot(first.x - second.x, first.y - second.y);
        if (distance <= 620) pairs.push({ first, second, distance });
      }
    }
    return pairs.sort((first, second) => first.distance - second.distance);
  }, [moleculeEntities]);

  useEffect(() => {
    if (!nearbyReactantPairs.length || preparedReaction || reactionSearching) return;
    const key = nearbyReactantPairs
      .map((pair) =>
        [pair.first.cid ?? pair.first.formula, pair.second.cid ?? pair.second.formula]
          .map(String)
          .sort()
          .join("|"),
      )
      .join(",");
    setReactionCandidate((current) =>
      current?.key === key || reactionChoices.length
        ? current
        : { key, pairs: nearbyReactantPairs },
    );
  }, [nearbyReactantPairs, preparedReaction, reactionChoices.length, reactionSearching]);

  useEffect(() => {
    let current = true;
    setReactionChoices([]);
    setReactionSearchEmpty(false);
    reactionPairRef.current = null;
    setReactionSearching(Boolean(reactionCandidate) && !preparedReaction);
    if (!reactionCandidate || preparedReaction) return;
    const discover = async () => {
      for (const pair of reactionCandidate.pairs) {
        const key = [pair.first.cid ?? pair.first.formula, pair.second.cid ?? pair.second.formula]
          .map(String)
          .sort()
          .join("|");
        let pending = reactionChoiceCache.get(key);
        if (!pending) {
          pending = discoverReactionChoices(pair.first, pair.second);
          reactionChoiceCache.set(key, pending);
        }
        const routes = await pending;
        if (!routes.length) reactionChoiceCache.delete(key);
        if (!current) return;
        if (routes.length) {
          reactionPairRef.current = pair;
          setReactionChoices(routes);
          setReactionSearching(false);
          return;
        }
      }
      if (current) {
        setReactionSearching(false);
        setReactionSearchEmpty(true);
      }
    };
    void discover();
    return () => {
      current = false;
    };
  }, [reactionCandidate, preparedReaction]);

  const compressedAtomIds = useMemo(
    () =>
      new Set(
        formulaGroups
          .filter((group) => compressedGroups.has(group.id))
          .flatMap((group) => group.atomIds),
      ),
    [compressedGroups, formulaGroups],
  );

  const dipoleAttractions = useMemo(() => {
    const covalent = bonds.filter((bond) => bond.type === "covalent");
    const adjacency = new Map<number, number[]>();
    covalent.forEach((bond) => {
      adjacency.set(bond.from, [...(adjacency.get(bond.from) ?? []), bond.to]);
      adjacency.set(bond.to, [...(adjacency.get(bond.to) ?? []), bond.from]);
    });
    const visited = new Set<number>();
    const polarComponents = atoms.flatMap((start) => {
      if (visited.has(start.id) || !adjacency.has(start.id)) return [];
      const stack = [start.id],
        members: AtomNode[] = [];
      while (stack.length) {
        const id = stack.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const atom = atomById.get(id);
        if (atom) members.push(atom);
        (adjacency.get(id) ?? []).forEach((next) => stack.push(next));
      }
      const memberIds = new Set(members.map((atom) => atom.id));
      const componentBonds = covalent.filter(
        (bond) => memberIds.has(bond.from) && memberIds.has(bond.to),
      );
      const polar = componentBonds.some((bond) => {
        const from = atomById.get(bond.from)!,
          to = atomById.get(bond.to)!;
        return Math.abs(pauling(from.element) - pauling(to.element)) >= 0.4;
      });
      if (!polar) return [];
      const sorted = [...members].sort((a, b) => pauling(a.element) - pauling(b.element));
      return [
        {
          positive: sorted[0],
          negative: sorted.at(-1)!,
          members,
          x: members.reduce((sum, atom) => sum + atom.x, 0) / members.length,
          y: members.reduce((sum, atom) => sum + atom.y, 0) / members.length,
        },
      ];
    });
    const nearestPairs = new Map<
      string,
      {
        id: string;
        first: (typeof polarComponents)[number];
        second: (typeof polarComponents)[number];
      }
    >();
    polarComponents.forEach((first, index) => {
      const nearest = polarComponents
        .map((second, secondIndex) => ({
          second,
          secondIndex,
          distance: Math.hypot(first.x - second.x, first.y - second.y),
        }))
        .filter((candidate) => candidate.secondIndex !== index && candidate.distance <= 900)
        .sort((a, b) => a.distance - b.distance)[0];
      if (!nearest) return;
      const low = Math.min(index, nearest.secondIndex),
        high = Math.max(index, nearest.secondIndex),
        id = `${low}-${high}`;
      nearestPairs.set(id, {
        id,
        first: polarComponents[low],
        second: polarComponents[high],
      });
    });

    return [...nearestPairs.values()].flatMap(({ id, first, second }) => {
      const centerDistance = Math.hypot(first.x - second.x, first.y - second.y);
      if (centerDistance > 900) return [];
      const options = [
        {
          from: first,
          to: second,
          polarityDistance: Math.hypot(
            first.positive.x - second.negative.x,
            first.positive.y - second.negative.y,
          ),
        },
        {
          from: second,
          to: first,
          polarityDistance: Math.hypot(
            second.positive.x - first.negative.x,
            second.positive.y - first.negative.y,
          ),
        },
      ].sort((a, b) => a.polarityDistance - b.polarityDistance);
      const { from, to } = options[0];
      const distance = Math.hypot(to.x - from.x, to.y - from.y);
      if (!distance) return [];
      const dx = (to.x - from.x) / distance,
        dy = (to.y - from.y) / distance,
        atomRadius = 86,
        fromExtent =
          Math.max(...from.members.map((atom) => (atom.x - from.x) * dx + (atom.y - from.y) * dy)) +
          atomRadius,
        toExtent =
          Math.max(...to.members.map((atom) => (to.x - atom.x) * dx + (to.y - atom.y) * dy)) +
          atomRadius;
      if (fromExtent + toExtent >= distance) return [];
      return [
        {
          id,
          from: { x: from.x + dx * fromExtent, y: from.y + dy * fromExtent },
          to: { x: to.x - dx * toExtent, y: to.y - dy * toExtent },
        },
      ];
    });
  }, [atomById, atoms, bonds]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!event.ctrlKey) {
        setPan((current) => ({
          x: current.x - event.deltaX,
          y: current.y - event.deltaY,
        }));
        return;
      }
      const box = canvas.getBoundingClientRect(),
        pointerX = event.clientX - box.left,
        pointerY = event.clientY - box.top;
      const nextScale = Math.min(2.5, Math.max(0.25, scale * Math.exp(-event.deltaY * 0.0015)));
      if (nextScale === scale) return;
      const worldX = (pointerX - pan.x) / scale,
        worldY = (pointerY - pan.y) / scale;
      setPan({ x: pointerX - worldX * nextScale, y: pointerY - worldY * nextScale });
      setScale(nextScale);
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [pan, scale]);

  function captureHistorySnapshot(): HistorySnapshot {
    return structuredClone({
      atoms: atomsRef.current,
      bonds: bondsRef.current,
      formulaGroups: formulaGroupsRef.current,
      compressedGroupIds: [...compressedGroupsRef.current],
    });
  }

  function applyHistorySnapshot(snapshot: HistorySnapshot) {
    const restored = structuredClone(snapshot);
    applyingHistory.current = true;
    atomsRef.current = restored.atoms;
    bondsRef.current = restored.bonds;
    formulaGroupsRef.current = restored.formulaGroups;
    compressedGroupsRef.current = new Set(restored.compressedGroupIds);
    setAtoms(restored.atoms);
    setBonds(restored.bonds);
    setFormulaGroups(restored.formulaGroups);
    setCompressedGroups(compressedGroupsRef.current);
    setSelected([]);
    setSelectedBond(null);
    setSelectedMolecule(null);
    setSelectedElectron(null);
    setPreparedReaction(null);
    setReactionCandidate(null);
    setReactionChoices([]);
    setReactionSearching(false);
    setReactionSearchEmpty(false);
    nextId.current = Math.max(0, ...restored.atoms.map((atom) => atom.id)) + 1;
  }

  function flushPendingHistory() {
    if (historyTimer.current) {
      window.clearTimeout(historyTimer.current);
      historyTimer.current = null;
    }
    const snapshot = captureHistorySnapshot();
    if (!historyCurrent.current) {
      historyCurrent.current = snapshot;
      return snapshot;
    }
    if (!sameHistorySnapshot(historyCurrent.current, snapshot)) {
      undoStack.current.push(historyCurrent.current);
      historyCurrent.current = snapshot;
      redoStack.current = [];
    }
    return snapshot;
  }

  function undo() {
    const current = flushPendingHistory();
    const previous = undoStack.current.pop();
    if (!previous) return;
    redoStack.current.push(current);
    historyCurrent.current = previous;
    applyHistorySnapshot(previous);
  }

  function redo() {
    const current = flushPendingHistory();
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(current);
    historyCurrent.current = next;
    applyHistorySnapshot(next);
  }

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const isField =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !isField) {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (event.ctrlKey && !event.shiftKey && event.code === "Space") {
        event.preventDefault();
        if (formulaOpen) {
          setFormulaOpen(false);
        } else {
          setFormulaOpen(true);
          setFormulaError("");
          setFormulaCandidates([]);
        }
        return;
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        setSaveDialogOpen(true);
        return;
      }
      if (event.key === "Escape" && formulaOpen) {
        setFormulaOpen(false);
        setFormulaInput("");
        setFormulaError("");
        setFormulaCandidates([]);
        return;
      }
      if (event.key === "Escape" && saveDialogOpen) {
        setSaveDialogOpen(false);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && !isField) {
        event.preventDefault();
        setSelected(atoms.map((atom) => atom.id));
        setSelectedBond(null);
        setSelectedElectron(null);
        return;
      }
      if (event.key === "Delete" && !isField && (selected.length || activeMolecule)) {
        event.preventDefault();
        deleteAtoms(activeMolecule?.atomIds ?? selected);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [
    atoms,
    formulaOpen,
    saveDialogOpen,
    selected,
    activeMolecule,
    bonds,
    formulaGroups,
    compressedGroups,
  ]);

  function addAtom(element: ElementKey, x?: number, y?: number) {
    const id = nextId.current++;
    const centerX = ((canvasRef.current?.clientWidth ?? 960) / 2 - pan.x) / scale;
    const centerY = ((canvasRef.current?.clientHeight ?? 620) / 2 - pan.y) / scale;
    setAtoms((items) => [
      ...items,
      { id, element, x: x ?? centerX, y: y ?? centerY, charge: 0, electronOffset: 0 },
    ]);
    setSelected([id]);
  }

  function selectAtom(id: number, additive = false) {
    setSelectedBond(null);
    setSelectedMolecule(null);
    setSelectedElectron((current) => (current?.atomId === id ? current : null));
    setSelected((current) =>
      additive
        ? current.includes(id)
          ? current.filter((item) => item !== id)
          : [...current, id]
        : [id],
    );
  }

  function deleteAtoms(ids: number[]) {
    const removed = new Set(ids);
    const remainingBonds = bondsRef.current.filter(
      (bond) => !removed.has(bond.from) && !removed.has(bond.to),
    );
    const remainingAtoms = applyIonicCharges(
      atomsRef.current.filter((atom) => !removed.has(atom.id)),
      remainingBonds,
    );
    bondsRef.current = remainingBonds;
    atomsRef.current = remainingAtoms;
    setAtoms(remainingAtoms);
    setBonds(remainingBonds);
    setSelected([]);
    setSelectedMolecule(null);
    setSelectedElectron((current) => (current && removed.has(current.atomId) ? null : current));
    setFormulaGroups((groups) =>
      groups.filter((group) => !group.atomIds.some((id) => removed.has(id))),
    );
  }

  function cloneEntity(entity: MoleculeEntity, copyIndex: number) {
    const sourceIds = new Set(entity.atomIds);
    const sourceAtoms = atomsRef.current.filter((atom) => sourceIds.has(atom.id));
    const idMap = new Map<number, number>();
    const angle = copyIndex * 2.4;
    const offset = { x: Math.cos(angle) * 270, y: Math.sin(angle) * 270 };
    const createdAtoms = sourceAtoms.map((atom) => {
      const id = nextId.current++;
      idMap.set(atom.id, id);
      return { ...atom, id, x: atom.x + offset.x, y: atom.y + offset.y };
    });
    const createdBonds = bondsRef.current
      .filter((bond) => sourceIds.has(bond.from) && sourceIds.has(bond.to))
      .map((bond, index) => ({
        ...bond,
        id: Date.now() + copyIndex * 100 + index,
        from: idMap.get(bond.from)!,
        to: idMap.get(bond.to)!,
      }));
    atomsRef.current = [...atomsRef.current, ...createdAtoms];
    bondsRef.current = [...bondsRef.current, ...createdBonds];
    setAtoms(atomsRef.current);
    setBonds(bondsRef.current);
    const sourceGroup = formulaGroups.find((group) => group.id === entity.id);
    if (sourceGroup) {
      const copyGroup: FormulaGroup = {
        ...sourceGroup,
        id: Date.now() + copyIndex * 1000,
        atomIds: createdAtoms.map((atom) => atom.id),
        source: "balanced copy",
      };
      setFormulaGroups((groups) => [...groups, copyGroup]);
    }
    return createdAtoms.map((atom) => atom.id);
  }

  function prepareReaction(recipe: ReactionRecipe) {
    const reactionPair = reactionPairRef.current;
    if (!reactionPair) return;
    const entities = [reactionPair.first, reactionPair.second];
    const atomIds = entities.flatMap((entity) => entity.atomIds);
    let copyIndex = 1;
    recipe.reactants.forEach((reactant, index) => {
      for (let copy = 1; copy < reactant.coefficient; copy++)
        atomIds.push(...cloneEntity(entities[index], copyIndex++));
    });
    const center = {
      x: (reactionPair.first.x + reactionPair.second.x) / 2,
      y: (reactionPair.first.y + reactionPair.second.y) / 2,
    };
    const prepared = {
      key: reactionEquation(recipe),
      recipe,
      atomIds,
      center,
    };
    setPreparedReaction(prepared);
    setSelected(atomIds);
    return prepared;
  }

  async function runReaction(prepared = preparedReaction) {
    if (!prepared) return;
    const { recipe, center, atomIds } = prepared;
    deleteAtoms(atomIds);
    setPreparedReaction(null);
    setReactionCandidate(null);
    setReactionChoices([]);
    setReactionSearching(false);
    setReactionSearchEmpty(false);
    for (const [productIndex, product] of recipe.products.entries())
      for (let index = 0; index < product.coefficient; index++)
        await spawnFormulaRef.current(String(product.cid), {
          center: {
            x: center.x + (productIndex * 220 + index * 150),
            y: center.y + productIndex * 170,
          },
          preserveView: true,
          select: false,
        });
    setValidationNotice(`Reacted: ${reactionEquation(recipe)}`);
  }

  function toggleCompressed(groupId: number) {
    setCompressedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  function currentCanvasDocument(): CanvasDocument {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      atoms,
      bonds,
      formulaGroups,
      compressedGroupIds: [...compressedGroups],
      view: { pan, scale },
    };
  }

  function applyCanvasDocument(document: CanvasDocument) {
    atomsRef.current = document.atoms;
    bondsRef.current = document.bonds;
    formulaGroupsRef.current = document.formulaGroups;
    setAtoms(document.atoms);
    setBonds(document.bonds);
    setFormulaGroups(document.formulaGroups);
    const restoredCompressedGroups = new Set(document.compressedGroupIds ?? []);
    compressedGroupsRef.current = restoredCompressedGroups;
    setCompressedGroups(restoredCompressedGroups);
    setPan(document.view.pan);
    setScale(Math.min(2.5, Math.max(0.25, document.view.scale)));
    setSelected([]);
    setSelectedBond(null);
    setSelectedMolecule(null);
    setSelectedElectron(null);
    nextId.current = Math.max(0, ...document.atoms.map((atom) => atom.id)) + 1;
  }

  async function writeCanvasFile(handle: CanvasFileHandle, contents: string) {
    const writable = await handle.createWritable();
    await writable.write(contents);
    await writable.close();
  }

  async function saveCanvas(fileName: string) {
    const serialized = JSON.stringify(currentCanvasDocument(), null, 2);
    await writeAutosavedCanvas(serialized);
    const safeName =
      fileName
        .trim()
        .split("")
        .map((character) => (character.charCodeAt(0) < 32 ? "-" : character))
        .join("")
        .replace(/[<>:"/\\|?*]/g, "-")
        .replace(/\.electron$/i, "") || "electron-canvas";
    const picker = (
      window as Window & {
        showSaveFilePicker?: (options: {
          suggestedName: string;
          types: Array<{
            description: string;
            accept: Record<string, string[]>;
          }>;
        }) => Promise<CanvasFileHandle>;
      }
    ).showSaveFilePicker;
    try {
      if (picker) {
        const handle = await picker({
          suggestedName: `${safeName}${canvasFileExtension}`,
          types: [
            {
              description: "Electron canvas",
              accept: { "application/json": [canvasFileExtension] },
            },
          ],
        });
        await writeCanvasFile(handle, serialized);
      } else {
        const url = URL.createObjectURL(
          new Blob([serialized], { type: "application/json;charset=utf-8" }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = `${safeName}${canvasFileExtension}`;
        link.click();
        URL.revokeObjectURL(url);
      }
      setSaveFileName(safeName);
      setSaveDialogOpen(false);
      setValidationNotice(
        picker
          ? `Canvas saved to ${safeName}${canvasFileExtension}.`
          : `Downloaded ${safeName}${canvasFileExtension}.`,
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setValidationNotice("The canvas file could not be saved.");
    }
  }

  async function importCanvasFile(file: File) {
    try {
      const document = parseCanvasDocument(await file.text());
      applyCanvasDocument(document);
      defaultCompoundLoaded.current = true;
      setValidationNotice(`${file.name} imported.`);
    } catch (error) {
      setValidationNotice(
        error instanceof Error ? error.message : "The canvas file could not be imported.",
      );
    }
  }

  async function spawnFormula(
    formula: string,
    options: {
      center?: { x: number; y: number };
      preserveView?: boolean;
      select?: boolean;
    } = {},
  ): Promise<FormulaGroup | undefined> {
    const query = formula.normalize("NFKC").trim(),
      compact = query.replace(/\s+/g, ""),
      queryTokens = [...compact.matchAll(/([A-Z][a-z]?)(\d*)/g)],
      isFormula =
        queryTokens.map((match) => match[0]).join("") === compact &&
        queryTokens.every((match) => match[1] in elements);
    if (!query) {
      setFormulaError("Enter a formula, compound name, PubChem CID, or prefixed SMILES.");
      return;
    }
    if (isFormula) {
      const matches = queryTokens;
      const symbols = matches.flatMap((match) => {
        const symbol = match[1];
        const count = match[2] ? Number(match[2]) : 1;
        if (!(symbol in elements) || !Number.isInteger(count) || count < 1 || count > 120)
          return [];
        return Array.from({ length: count }, () => symbol);
      });
      const expected = matches.reduce((sum, match) => sum + (match[2] ? Number(match[2]) : 1), 0);
      if (symbols.length !== expected) {
        setFormulaError("One of those element symbols or subscripts is not supported.");
        return;
      }
      if (symbols.length > 120) {
        setFormulaError(`This formula contains ${symbols.length} atoms; the canvas limit is 120.`);
        return;
      }
    }
    setFormulaError("");
    setFormulaCandidates([]);
    setFormulaLoading(true);
    try {
      const result = await lookupStructure(query);
      if (!result.record) {
        setFormulaError(result.error ?? "The structure could not be loaded.");
        setFormulaCandidates(result.candidates ?? []);
        return;
      }
      const payload: StructureRecord = result.record;
      if (payload.atoms.length > 120) {
        setFormulaError(
          `This database structure contains ${payload.atoms.length} explicit atoms; the canvas limit is 120.`,
        );
        return;
      }
      const spawnIndex = formulaSpawnCount.current++;
      const visibleCenter = {
        x: ((canvasRef.current?.clientWidth ?? 960) / 2 - pan.x) / scale,
        y: ((canvasRef.current?.clientHeight ?? 620) / 2 - pan.y) / scale,
      };
      const centerX =
          visibleCenter.x + (atomsRef.current.length ? ((spawnIndex % 3) - 1) * 260 : 0),
        centerY =
          visibleCenter.y +
          (atomsRef.current.length ? ((Math.floor(spawnIndex / 3) % 3) - 1) * 220 : 0);
      const targetCenter = options.center ?? { x: centerX, y: centerY };
      const sourceX = payload.atoms.map((atom) => atom.x),
        sourceY = payload.atoms.map((atom) => atom.y);
      const sourceCenterX = (Math.min(...sourceX) + Math.max(...sourceX)) / 2,
        sourceCenterY = (Math.min(...sourceY) + Math.max(...sourceY)) / 2;
      const aidToId = new Map<number, number>(),
        ids = payload.atoms.map((atom) => {
          const id = nextId.current++;
          aidToId.set(atom.aid, id);
          return id;
        });
      const created: AtomNode[] = payload.atoms.map((atom, index) => ({
        id: ids[index],
        element: allSymbols[atom.atomicNumber - 1],
        x: targetCenter.x + (atom.x - sourceCenterX) * 190,
        y: targetCenter.y - (atom.y - sourceCenterY) * 190,
        charge: 0,
        electronOffset: 0,
      }));
      const atomById = new Map(created.map((atom) => [atom.id, atom]));
      const createdBonds: BondEdge[] = payload.bonds.flatMap((bond, index) => {
        const from = aidToId.get(bond.from),
          to = aidToId.get(bond.to);
        if (!from || !to) return [];
        const first = atomById.get(from)!,
          second = atomById.get(to)!,
          inferred = stableBond(first.element, second.element),
          order =
            inferred?.type === "ionic" || inferred?.type === "metallic"
              ? 1
              : (Math.max(1, Math.min(3, bond.order)) as 1 | 2 | 3);
        return [
          {
            id: Date.now() + index,
            from,
            to,
            type: inferred?.type ?? "covalent",
            order,
          },
        ];
      });
      const resolvedFormula = payload.formula.normalize("NFKC").replace(/\s+/g, "");
      const displayFormula = resolvedFormula.replace(/\d/g, (digit) => "₀₁₂₃₄₅₆₇₈₉"[Number(digit)]);
      const groupId = Date.now() + 1000;
      if (canvasRef.current && !options.preserveView && atomsRef.current.length === 0) {
        const minX = Math.min(...created.map((atom) => atom.x)) - 125,
          maxX = Math.max(...created.map((atom) => atom.x)) + 125,
          minY = Math.min(...created.map((atom) => atom.y)) - 125,
          maxY = Math.max(...created.map((atom) => atom.y)) + 125;
        const canvasWidth = canvasRef.current.clientWidth,
          canvasHeight = canvasRef.current.clientHeight;
        const fitScale = Math.max(
          0.25,
          Math.min(0.82, (canvasWidth - 36) / (maxX - minX), (canvasHeight - 36) / (maxY - minY)),
        );
        setScale(fitScale);
        setPan({
          x: canvasWidth / 2 - ((minX + maxX) / 2) * fitScale,
          y: canvasHeight / 2 - ((minY + maxY) / 2) * fitScale,
        });
      }
      const chargedCreated = applyIonicCharges(created, createdBonds);
      const createdGroup: FormulaGroup = {
        id: groupId,
        atomIds: ids,
        formula: displayFormula,
        name: payload.name,
        source: payload.source,
        cid: payload.cid,
      };
      atomsRef.current = [...atomsRef.current, ...chargedCreated];
      bondsRef.current = [...bondsRef.current, ...createdBonds];
      setAtoms(atomsRef.current);
      setBonds(bondsRef.current);
      setFormulaGroups((groups) => [...groups, createdGroup]);
      setSelected(options.select === false ? [] : ids);
      setSelectedMolecule(options.select === false ? null : groupId);
      setSelectedBond(null);
      setFormulaOpen(false);
      setFormulaInput("");
      setFormulaError("");
      return createdGroup;
    } catch {
      setFormulaError("The structure database is unavailable. No structure was guessed.");
    } finally {
      setFormulaLoading(false);
    }
  }

  function periodicMatch(symbol: string) {
    const valenceMatches =
      valenceFilter === "all" || elements[symbol].valence === Number(valenceFilter);
    const en = pauling(symbol);
    const characterMatches =
      characterFilter === "all" ||
      (characterFilter === "electronegative" && en >= 2.5) ||
      (characterFilter === "intermediate" && en > 1.5 && en < 2.5) ||
      (characterFilter === "electropositive" && en > 0 && en <= 1.5);
    return valenceMatches && characterMatches;
  }

  function dropPeriodicAtom(event: React.DragEvent, symbol: string) {
    const box = canvasRef.current?.getBoundingClientRect();
    if (
      !box ||
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    )
      return;
    addAtom(
      symbol,
      (event.clientX - box.left - pan.x) / scale,
      (event.clientY - box.top - pan.y) / scale,
    );
    setPeriodicOpen(false);
  }

  function stableBond(
    first: ElementKey,
    second: ElementKey,
  ): { type: BondType; order: 1 | 2 | 3 } | null {
    if (nobleGases.has(first) || nobleGases.has(second)) return null;
    const firstMetal = metals.has(first);
    const secondMetal = metals.has(second);
    if (firstMetal && secondMetal) return { type: "metallic", order: 1 };
    if (firstMetal !== secondMetal) return { type: "ionic", order: 1 };
    const pair = [first, second].sort().join("");
    if (pair === "NN") return { type: "covalent", order: 3 };
    if (pair === "OO" || pair === "CO" || pair === "OS") return { type: "covalent", order: 2 };
    return { type: "covalent", order: 1 };
  }

  async function settleAtom(id: number) {
    const currentAtoms = atomsRef.current;
    const moved = currentAtoms.find((atom) => atom.id === id);
    if (!moved) return false;
    const nearby = currentAtoms
      .filter((atom) => atom.id !== id)
      .map((atom) => ({ atom, distance: Math.hypot(atom.x - moved.x, atom.y - moved.y) }))
      .filter((item) => item.distance <= 225)
      .sort((a, b) => a.distance - b.distance);

    const kept = bondsRef.current.filter((bond) => {
      if (bond.from !== id && bond.to !== id) return true;
      const otherId = bond.from === id ? bond.to : bond.from;
      const other = currentAtoms.find((atom) => atom.id === otherId);
      return Boolean(other && Math.hypot(other.x - moved.x, other.y - moved.y) <= 310);
    });
    const existingPartners = new Set(
      kept.flatMap((bond) => (bond.from === id ? [bond.to] : bond.to === id ? [bond.from] : [])),
    );
    const proposed = nearby
      .filter(({ atom }) => !existingPartners.has(atom.id))
      .map(({ atom, distance }) => ({
        atom,
        distance,
        inferred: stableBond(moved.element, atom.element),
      }))
      .filter(
        (
          item,
        ): item is {
          atom: AtomNode;
          distance: number;
          inferred: { type: BondType; order: 1 | 2 | 3 };
        } => Boolean(item.inferred),
      )
      .sort(
        (a, b) =>
          Number(a.atom.element === moved.element) - Number(b.atom.element === moved.element) ||
          a.distance - b.distance,
      );
    const capacity = (atom: AtomNode) =>
      atom.element === "H" || ["F", "Cl", "Br", "I"].includes(atom.element)
        ? 1
        : atom.element === "Be"
          ? 2
          : atom.element === "B" || atom.element === "N"
            ? 3
            : atom.element === "O"
              ? 2
              : atom.element === "C"
                ? 4
                : atom.element === "P"
                  ? 5
                  : atom.element === "S"
                    ? 6
                    : 8;
    const nextBonds = [...kept];
    const ionicCount = (atomId: number) =>
      nextBonds
        .filter((bond) => bond.type === "ionic" && (bond.from === atomId || bond.to === atomId))
        .reduce((sum, bond) => sum + bond.order, 0);
    const occupied = (atomId: number) =>
      nextBonds
        .filter((bond) => bond.from === atomId || bond.to === atomId)
        .reduce((sum, bond) => {
          if (bond.type === "covalent") return sum + bond.order;
          const atom = currentAtoms.find((item) => item.id === atomId);
          return sum + (atom && !metals.has(atom.element) ? bond.order : 0);
        }, 0);
    const now = Date.now();
    proposed.forEach(({ atom, inferred }, index) => {
      let candidate = inferred;
      if (candidate.type === "ionic") {
        const donor = metals.has(moved.element) ? moved : atom,
          receiver = donor === moved ? atom : moved;
        if (
          ionicCount(donor.id) + candidate.order > ionicDonationLimit(donor.element) ||
          ionicCount(receiver.id) + candidate.order > ionicAcceptanceLimit(receiver.element)
        )
          return;
      } else if (candidate.type === "covalent") {
        if (
          moved.element === "O" &&
          atom.element === "O" &&
          (ionicCount(moved.id) > 0 || ionicCount(atom.id) > 0)
        )
          candidate = { type: "covalent", order: 1 };
        if (
          occupied(moved.id) + candidate.order > capacity(moved) ||
          occupied(atom.id) + candidate.order > capacity(atom)
        )
          return;
      } else if (
        occupied(moved.id) + candidate.order > capacity(moved) ||
        occupied(atom.id) + candidate.order > capacity(atom)
      )
        return;
      nextBonds.push({ id: now + index, from: id, to: atom.id, ...candidate });
    });
    const charged = applyIonicCharges(currentAtoms, nextBonds);
    const sequence = ++validationSequence.current;
    try {
      const result = await validateStructure(charged, nextBonds);
      if (sequence !== validationSequence.current) return false;
      if (!result.valid) return false;
      bondsRef.current = nextBonds;
      atomsRef.current = charged;
      setBonds(nextBonds);
      setAtoms(charged);
      return true;
    } catch {
      return false;
    }
  }

  function removeBond(id: number) {
    const nextBonds = bondsRef.current.filter((bond) => bond.id !== id);
    const charged = applyIonicCharges(atomsRef.current, nextBonds);
    bondsRef.current = nextBonds;
    atomsRef.current = charged;
    setBonds(nextBonds);
    setAtoms(charged);
    setSelectedBond(null);
  }

  function idealAngle(symbol: string, neighborCount: number, bondOrder: number) {
    if (symbol === "O" && neighborCount === 2) return 104.5;
    if (symbol === "N" && neighborCount === 3) return 107;
    if (symbol === "C" && neighborCount === 2 && bondOrder >= 4) return 180;
    if (neighborCount === 2) return 120;
    if (neighborCount === 3) return 120;
    if (neighborCount >= 4) return 109.5;
    return 180;
  }

  function relaxBondGeometry(movedId: number) {
    const currentAtoms = atomsRef.current,
      currentBonds = bondsRef.current,
      moved = currentAtoms.find((atom) => atom.id === movedId);
    if (!moved) return;
    const connected = currentBonds.filter((bond) => bond.from === movedId || bond.to === movedId);
    if (connected.length !== 1) return;
    const joiningBond = connected[0],
      partnerId = joiningBond.from === movedId ? joiningBond.to : joiningBond.from,
      partner = currentAtoms.find((atom) => atom.id === partnerId);
    if (!partner) return;
    const partnerBonds = currentBonds.filter(
      (bond) => bond.from === partnerId || bond.to === partnerId,
    );
    const existingNeighbors = partnerBonds
      .flatMap((bond) => {
        const id = bond.from === partnerId ? bond.to : bond.from;
        return id === movedId ? [] : [currentAtoms.find((atom) => atom.id === id)!];
      })
      .filter(Boolean);
    const targetDistance = joiningBond.type === "ionic" ? 270 : 225;
    let targetAngle = Math.atan2(moved.y - partner.y, moved.x - partner.x);
    if (existingNeighbors.length) {
      const reference = Math.atan2(
        existingNeighbors[0].y - partner.y,
        existingNeighbors[0].x - partner.x,
      );
      const bondOrder = partnerBonds.reduce((sum, bond) => sum + bond.order, 0);
      const separation =
        (idealAngle(partner.element, partnerBonds.length, bondOrder) * Math.PI) / 180;
      const options = [reference + separation, reference - separation];
      targetAngle = options.sort(
        (a, b) =>
          Math.abs(Math.atan2(Math.sin(a - targetAngle), Math.cos(a - targetAngle))) -
          Math.abs(Math.atan2(Math.sin(b - targetAngle), Math.cos(b - targetAngle))),
      )[0];
    }
    const target = {
      x: partner.x + Math.cos(targetAngle) * targetDistance,
      y: partner.y + Math.sin(targetAngle) * targetDistance,
    };
    if (geometryAnimation.current) cancelAnimationFrame(geometryAnimation.current);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setAtoms((items) =>
        items.map((atom) => (atom.id === movedId ? { ...atom, ...target } : atom)),
      );
      return;
    }
    const origin = { x: moved.x, y: moved.y },
      started = performance.now(),
      duration = 520;
    const frame = (now: number) => {
      const progress = Math.min(1, (now - started) / duration),
        eased = 1 - Math.pow(1 - progress, 4);
      const position = {
        x: origin.x + (target.x - origin.x) * eased,
        y: origin.y + (target.y - origin.y) * eased,
      };
      setAtoms((items) =>
        items.map((atom) => (atom.id === movedId ? { ...atom, ...position } : atom)),
      );
      if (progress < 1) geometryAnimation.current = requestAnimationFrame(frame);
      else geometryAnimation.current = null;
    };
    geometryAnimation.current = requestAnimationFrame(frame);
  }

  function pointerMove(event: React.PointerEvent) {
    const current = gesture.current;
    if (!current) return;
    const dx = event.clientX - current.sx;
    const dy = event.clientY - current.sy;
    if (current.type === "pan") setPan({ x: current.ox + dx, y: current.oy + dy });
    else if (current.type === "marquee")
      setSelectionBox({
        startX: current.sx,
        startY: current.sy,
        endX: event.clientX,
        endY: event.clientY,
      });
    else if (current.type === "selection") {
      const origins = current.origins;
      setAtoms((items) =>
        items.map((atom) => {
          const origin = origins.get(atom.id);
          return origin ? { ...atom, x: origin.x + dx / scale, y: origin.y + dy / scale } : atom;
        }),
      );
    }
  }

  function selectCompound(groupId: number, atomIds: number[], additive = false) {
    setSelected((current) => (additive ? [...new Set([...current, ...atomIds])] : atomIds));
    setSelectedMolecule(groupId);
    setSelectedBond(null);
    setSelectedElectron(null);
  }

  function beginCompoundDrag(
    event: React.PointerEvent<HTMLButtonElement>,
    groupId: number,
    atomIds: number[],
  ) {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const moveIds = atomIds.every((id) => selectedAtomIds.has(id))
        ? selected
        : event.shiftKey
          ? [...new Set([...selected, ...atomIds])]
          : atomIds,
      moveSet = new Set(moveIds);
    selectCompound(groupId, moveIds);
    gesture.current = {
      type: "selection",
      sx: event.clientX,
      sy: event.clientY,
      origins: new Map(
        atoms
          .filter((atom) => moveSet.has(atom.id))
          .map((atom) => [atom.id, { x: atom.x, y: atom.y }]),
      ),
    };
  }

  return (
    <>
      {!boot.ready && (
        <output className="boot-screen" aria-live="polite">
          <div className="boot-mark">
            <Atom weight="bold" />
            <b>Electron</b>
          </div>
          <div className="boot-copy">
            <strong>
              {boot.error ? "Chemistry engine unavailable" : "Preparing the chemistry engine"}
            </strong>
            <span>
              {boot.error
                ? "Check the site files and reload."
                : "Downloading RDKit for local structure validation…"}
            </span>
          </div>
          {!boot.error ? (
            <>
              <progress
                className="boot-progress"
                aria-label="Chemistry engine download progress"
                value={boot.progress}
                max={1}
              />
              <output>{Math.round(boot.progress * 100)}%</output>
            </>
          ) : (
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          )}
        </output>
      )}
      <main className="lab-shell">
        <div
          className="lab-layout"
          style={
            {
              "--left-width": `${sidebarWidths.left}px`,
              "--right-width": `${sidebarWidths.right}px`,
            } as React.CSSProperties
          }
        >
          <aside className="element-tray">
            <div className="product-mark">
              <span>
                <Atom weight="bold" />
              </span>
              <b>Electron</b>
            </div>
            <button type="button" className="open-periodic" onClick={() => setPeriodicOpen(true)}>
              <Atom /> Periodic table
            </button>
            <label className="element-search">
              <MagnifyingGlass />
              <input
                value={elementQuery}
                onChange={(event) => setElementQuery(event.target.value)}
                placeholder="Search 118 elements"
                aria-label="Search elements"
              />
            </label>
            <div className="element-palette">
              {visibleElements.map((symbol) => {
                const item = elements[symbol];
                return (
                  <button
                    type="button"
                    key={symbol}
                    draggable
                    onDragStart={(event) => event.dataTransfer.setData("element", symbol)}
                    onClick={() => addAtom(symbol)}
                  >
                    <small>{item.z}</small>
                    <strong>{symbol}</strong>
                    <span>{item.name}</span>
                    <i>{item.valence} valence</i>
                  </button>
                );
              })}
            </div>
          </aside>
          <div
            className="sidebar-resizer left"
            role="slider"
            aria-label="Resize element sidebar"
            aria-orientation="vertical"
            aria-valuenow={sidebarWidths.left}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              resizing.current = {
                side: "left",
                startX: event.clientX,
                startWidth: sidebarWidths.left,
              };
            }}
            onPointerMove={(event) => {
              const current = resizing.current;
              if (!current || current.side !== "left") return;
              setSidebarWidths((widths) => ({
                ...widths,
                left: Math.max(
                  140,
                  Math.min(360, current.startWidth + event.clientX - current.startX),
                ),
              }));
            }}
            onPointerUp={() => {
              resizing.current = null;
            }}
            onPointerCancel={() => {
              resizing.current = null;
            }}
            onLostPointerCapture={() => {
              resizing.current = null;
            }}
          />

          <section
            ref={canvasRef}
            className="chem-canvas"
            aria-label="Interactive atom canvas"
            onPointerDownCapture={(event) => {
              if (
                event.button !== 1 ||
                (event.target as Element).closest(".bond-toolbar, .canvas-atom-controls")
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              gesture.current = {
                type: "pan",
                sx: event.clientX,
                sy: event.clientY,
                ox: pan.x,
                oy: pan.y,
              };
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              const file = event.dataTransfer.files[0];
              if (file) {
                event.preventDefault();
                void importCanvasFile(file);
                return;
              }
              const symbol = event.dataTransfer.getData("element") as ElementKey;
              const box = event.currentTarget.getBoundingClientRect();
              if (symbol in elements)
                addAtom(
                  symbol,
                  (event.clientX - box.left - pan.x) / scale,
                  (event.clientY - box.top - pan.y) / scale,
                );
            }}
            onPointerDown={(event) => {
              const target = event.target as Element;
              if (
                !target.closest(
                  ".canvas-atom, .canvas-atom-controls, .bond-toolbar, .bond-target, .compound-label, .compressed-compound",
                )
              ) {
                event.currentTarget.setPointerCapture(event.pointerId);
                if (event.button === 1) {
                  event.preventDefault();
                  gesture.current = {
                    type: "pan",
                    sx: event.clientX,
                    sy: event.clientY,
                    ox: pan.x,
                    oy: pan.y,
                  };
                } else if (event.button === 0) {
                  if (!canvasNavigationHintShown.current) {
                    canvasNavigationHintShown.current = true;
                    try {
                      if (!localStorage.getItem(canvasNavigationHintKey)) {
                        localStorage.setItem(canvasNavigationHintKey, "1");
                        setCanvasNavigationHint(true);
                      }
                    } catch {
                      setCanvasNavigationHint(true);
                    }
                  }
                  gesture.current = {
                    type: "marquee",
                    sx: event.clientX,
                    sy: event.clientY,
                    ox: pan.x,
                    oy: pan.y,
                    additive: event.shiftKey,
                  };
                  setSelectionBox({
                    startX: event.clientX,
                    startY: event.clientY,
                    endX: event.clientX,
                    endY: event.clientY,
                  });
                }
              }
            }}
            onPointerMove={pointerMove}
            onPointerUp={(event) => {
              const current = gesture.current;
              if (current?.type === "marquee") {
                const box = event.currentTarget.getBoundingClientRect(),
                  minX = Math.min(current.sx, event.clientX) - box.left,
                  maxX = Math.max(current.sx, event.clientX) - box.left,
                  minY = Math.min(current.sy, event.clientY) - box.top,
                  maxY = Math.max(current.sy, event.clientY) - box.top,
                  atomMatches = atoms
                    .filter((atom) => {
                      const x = pan.x + atom.x * scale,
                        y = pan.y + atom.y * scale;
                      return x >= minX && x <= maxX && y >= minY && y <= maxY;
                    })
                    .map((atom) => atom.id),
                  compressedMatches = formulaGroups.filter((group) => {
                    if (!compressedGroups.has(group.id)) return false;
                    const members = group.atomIds
                      .map((id) => atomById.get(id))
                      .filter((atom): atom is AtomNode => Boolean(atom));
                    if (!members.length) return false;
                    const x =
                        pan.x +
                        (members.reduce((sum, atom) => sum + atom.x, 0) / members.length) * scale,
                      y =
                        pan.y +
                        (members.reduce((sum, atom) => sum + atom.y, 0) / members.length) * scale;
                    return x >= minX && x <= maxX && y >= minY && y <= maxY;
                  }),
                  matches = [
                    ...new Set([
                      ...atomMatches,
                      ...compressedMatches.flatMap((group) => group.atomIds),
                    ]),
                  ];
                setSelected((existing) =>
                  current.additive ? [...new Set([...existing, ...matches])] : matches,
                );
                setSelectedBond(null);
                setSelectedMolecule(
                  !current.additive && compressedMatches.length === 1
                    ? compressedMatches[0].id
                    : null,
                );
                setSelectedElectron(null);
              }
              gesture.current = null;
              setSelectionBox(null);
            }}
            onPointerCancel={() => {
              gesture.current = null;
              setSelectionBox(null);
            }}
            onLostPointerCapture={() => {
              gesture.current = null;
              setSelectionBox(null);
            }}
          >
            <div className="bond-toolbar">
              <button
                type="button"
                className="structure-lookup toolbar-action"
                aria-keyshortcuts="Control+Space"
                onClick={() => {
                  setFormulaOpen(true);
                  setFormulaError("");
                  setFormulaCandidates([]);
                }}
              >
                <MagnifyingGlass /> Add molecule
                <span className="shortcut-tooltip" role="tooltip">
                  Shortcut: Ctrl + Space
                </span>
              </button>
              <button
                type="button"
                className="save-canvas toolbar-action"
                aria-keyshortcuts="Control+Shift+S"
                onClick={() => setSaveDialogOpen(true)}
              >
                <FloppyDisk /> Save
                <span className="shortcut-tooltip" role="tooltip">
                  Save As · Ctrl + Shift + S
                </span>
              </button>
            </div>
            {selectionBox && (
              <div
                className="selection-marquee"
                style={{
                  left:
                    Math.min(selectionBox.startX, selectionBox.endX) -
                    (canvasRef.current?.getBoundingClientRect().left ?? 0),
                  top:
                    Math.min(selectionBox.startY, selectionBox.endY) -
                    (canvasRef.current?.getBoundingClientRect().top ?? 0),
                  width: Math.abs(selectionBox.endX - selectionBox.startX),
                  height: Math.abs(selectionBox.endY - selectionBox.startY),
                }}
              />
            )}
            {validationNotice && <output className="validation-notice">{validationNotice}</output>}
            {canvasNavigationHint && (
              <output className="canvas-navigation-toast" aria-live="polite">
                <b>Selection started</b>
                <span>To pan the canvas, middle-drag or drag with two fingers on a trackpad.</span>
              </output>
            )}
            {(preparedReaction ||
              reactionChoices.length > 0 ||
              reactionSearching ||
              reactionSearchEmpty) && (
              <div
                className={`reaction-prompt${reactionSearchEmpty ? " is-empty" : ""}`}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <header>
                  <small>
                    {preparedReaction
                      ? "Balanced on canvas"
                      : reactionSearching
                        ? "Checking PubChem"
                        : reactionSearchEmpty
                          ? "No reported reaction found"
                          : "Possible reactions"}
                  </small>
                  <strong>
                    {preparedReaction
                      ? "The required reactants are now present."
                      : reactionSearching
                        ? "Looking for reported products and balancing the equation…"
                        : reactionSearchEmpty
                          ? "Try bringing a different pair of chemicals together."
                          : "Choose the route and conditions."}
                  </strong>
                </header>
                <div className="reaction-options">
                  {(preparedReaction ? [preparedReaction.recipe] : reactionChoices).map(
                    (recipe) => (
                      <article key={reactionEquation(recipe)}>
                        <span>
                          <b>{reactionEquation(recipe)}</b>
                          <em>{recipe.name}</em>
                          <small>{recipe.condition}</small>
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            if (preparedReaction) {
                              void runReaction();
                              return;
                            }
                            const prepared = prepareReaction(recipe);
                            if (
                              prepared &&
                              recipe.reactants.every((reactant) => reactant.coefficient === 1)
                            )
                              void runReaction(prepared);
                          }}
                        >
                          {preparedReaction ||
                          recipe.reactants.every((reactant) => reactant.coefficient === 1)
                            ? "React"
                            : "Balance"}
                        </button>
                      </article>
                    ),
                  )}
                </div>
              </div>
            )}
            <div
              className="canvas-world"
              style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0)` }}
            >
              <svg className="bond-layer" width="1600" height="1000">
                {bonds
                  .filter(
                    (bond) => !compressedAtomIds.has(bond.from) && !compressedAtomIds.has(bond.to),
                  )
                  .map((bond) => {
                    const from = atomById.get(bond.from);
                    const to = atomById.get(bond.to);
                    if (!from || !to) return null;
                    const x1 = from.x * scale,
                      y1 = from.y * scale,
                      x2 = to.x * scale,
                      y2 = to.y * scale,
                      mx = (x1 + x2) / 2,
                      my = (y1 + y2) / 2;
                    const fromSubshells = subshellsForElectronCount(
                        elements[from.element].z - from.charge + from.electronOffset,
                      ),
                      toSubshells = subshellsForElectronCount(
                        elements[to.element].z - to.charge + to.electronOffset,
                      );
                    const fromColor = subshellColors[fromSubshells.at(-1)?.kind ?? "s"],
                      toColor = subshellColors[toSubshells.at(-1)?.kind ?? "s"];
                    const superoxide =
                      bond.type === "covalent" &&
                      bond.order === 1 &&
                      from.element === "O" &&
                      to.element === "O" &&
                      bonds.some(
                        (item) =>
                          item.type === "ionic" &&
                          [item.from, item.to].some(
                            (atomId) => atomId === from.id || atomId === to.id,
                          ) &&
                          [item.from, item.to].some(
                            (atomId) => atomById.get(atomId)?.element === "Li",
                          ),
                      );
                    return (
                      <g
                        key={bond.id}
                        className={`bond-line ${bond.type} ${selectedBond === bond.id ? "selected" : ""}`}
                      >
                        <line x1={x1} y1={y1} x2={x2} y2={y2} />
                        {bond.order > 1 && (
                          <line x1={x1} y1={y1 + 8 * scale} x2={x2} y2={y2 + 8 * scale} />
                        )}
                        {bond.type === "covalent" &&
                          Array.from({ length: bond.order }, (_, i) => (
                            <g key={i}>
                              <circle
                                className="shared-electron"
                                style={{ fill: fromColor }}
                                cx={mx - 5 * scale}
                                cy={my + (i - (bond.order - 1) / 2) * 10 * scale}
                                r={3 * scale}
                              />
                              <circle
                                className="shared-electron"
                                style={{ fill: toColor }}
                                cx={mx + 5 * scale}
                                cy={my + (i - (bond.order - 1) / 2) * 10 * scale}
                                r={3 * scale}
                              />
                            </g>
                          ))}
                        {superoxide && (
                          <text className="delocalized-charge" x={mx} y={my - 18 * scale}>
                            −1 over O₂
                          </text>
                        )}
                      </g>
                    );
                  })}
                {dipoleAttractions.map((attraction) => {
                  const x1 = attraction.from.x * scale,
                    y1 = attraction.from.y * scale,
                    x2 = attraction.to.x * scale,
                    y2 = attraction.to.y * scale,
                    mx = (x1 + x2) / 2,
                    my = (y1 + y2) / 2;
                  return (
                    <g className="dipole-attraction" key={attraction.id}>
                      <line x1={x1} y1={y1} x2={x2} y2={y2} />
                      <text x={x1} y={y1 - 9}>
                        δ+
                      </text>
                      <text x={x2} y={y2 - 9}>
                        δ−
                      </text>
                      <text className="dipole-label" x={mx} y={my - 7}>
                        dipole–dipole
                      </text>
                    </g>
                  );
                })}
                {active &&
                  bondAngles.map((guide, index) => {
                    const cx = active.x * scale,
                      cy = active.y * scale,
                      r = 58 * scale,
                      startX = cx + Math.cos(guide.start) * r,
                      startY = cy + Math.sin(guide.start) * r,
                      endX = cx + Math.cos(guide.end) * r,
                      endY = cy + Math.sin(guide.end) * r;
                    let middle = guide.start + (guide.end - guide.start) / 2;
                    if (guide.end < guide.start) middle += Math.PI;
                    return (
                      <g className="angle-guide" key={`${active.id}-${index}`}>
                        <path
                          d={`M ${startX} ${startY} A ${r} ${r} 0 ${guide.angle > 180 ? 1 : 0} 1 ${endX} ${endY}`}
                        />
                        <text
                          x={cx + Math.cos(middle) * (r + 17)}
                          y={cy + Math.sin(middle) * (r + 17)}
                        >
                          {guide.angle.toFixed(1)}°
                        </text>
                      </g>
                    );
                  })}
              </svg>
              {bonds
                .filter(
                  (bond) => !compressedAtomIds.has(bond.from) && !compressedAtomIds.has(bond.to),
                )
                .map((bond) => {
                  const from = atomById.get(bond.from),
                    to = atomById.get(bond.to);
                  if (!from || !to) return null;
                  const mx = ((from.x + to.x) * scale) / 2,
                    my = ((from.y + to.y) * scale) / 2;
                  return (
                    <button
                      type="button"
                      key={`target-${bond.id}`}
                      className="bond-target"
                      style={{ transform: `translate(${mx - 42}px,${my - 30}px)` }}
                      aria-label={`Inspect ${bond.type} bond`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedBond(bond.id);
                        setSelectedMolecule(null);
                        setSelected([]);
                      }}
                    >
                      {scale >= 0.45 ? bond.type : ""}
                    </button>
                  );
                })}
              {namedCompounds
                .filter((compound) => !compound.atomIds.some((id) => compressedAtomIds.has(id)))
                .map((compound) => (
                  <button
                    type="button"
                    className="compound-label"
                    key={`${compound.formula}-${compound.x}-${compound.y}`}
                    style={{
                      transform: `translate(${compound.x * scale}px, ${compound.y * scale}px)`,
                    }}
                    onPointerDown={(event) => {
                      const group = formulaGroups.find(
                        (candidate) =>
                          candidate.atomIds.length === compound.atomIds.length &&
                          candidate.atomIds.every((id) => compound.atomIds.includes(id)),
                      );
                      beginCompoundDrag(
                        event,
                        group?.id ?? -Math.min(...compound.atomIds),
                        compound.atomIds,
                      );
                    }}
                    onPointerMove={pointerMove}
                    onPointerUp={() => {
                      gesture.current = null;
                    }}
                    onPointerCancel={() => {
                      gesture.current = null;
                    }}
                    onLostPointerCapture={() => {
                      gesture.current = null;
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      const group = formulaGroups.find(
                        (candidate) =>
                          candidate.atomIds.length === compound.atomIds.length &&
                          candidate.atomIds.every((id) => compound.atomIds.includes(id)),
                      );
                      selectCompound(
                        group?.id ?? -Math.min(...compound.atomIds),
                        compound.atomIds,
                        event.shiftKey,
                      );
                    }}
                  >
                    <b>{compound.formula}</b>
                    <span>{compound.name}</span>
                  </button>
                ))}
              {formulaGroups
                .filter((group) => !compressedGroups.has(group.id))
                .flatMap((group) => {
                  const members = group.atomIds
                    .map((id) => atomById.get(id))
                    .filter((atom): atom is AtomNode => Boolean(atom));
                  if (members.length !== group.atomIds.length) return [];
                  const x = members.reduce((sum, atom) => sum + atom.x, 0) / members.length,
                    y = Math.max(...members.map((atom) => atom.y)) + 125;
                  return (
                    <button
                      type="button"
                      className="compound-label imported"
                      key={group.id}
                      style={{
                        transform: `translate(${x * scale}px,${y * scale}px)`,
                      }}
                      onPointerDown={(event) => {
                        beginCompoundDrag(event, group.id, group.atomIds);
                      }}
                      onPointerMove={pointerMove}
                      onPointerUp={() => {
                        gesture.current = null;
                      }}
                      onPointerCancel={() => {
                        gesture.current = null;
                      }}
                      onLostPointerCapture={() => {
                        gesture.current = null;
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        selectCompound(group.id, group.atomIds, event.shiftKey);
                      }}
                    >
                      <b>{group.formula}</b>
                      <span>{group.name ?? group.source ?? "database structure"}</span>
                    </button>
                  );
                })}
              {formulaGroups
                .filter((group) => compressedGroups.has(group.id))
                .flatMap((group) => {
                  const members = group.atomIds
                    .map((id) => atomById.get(id))
                    .filter((atom): atom is AtomNode => Boolean(atom));
                  if (!members.length) return [];
                  const x = members.reduce((sum, atom) => sum + atom.x, 0) / members.length;
                  const y = members.reduce((sum, atom) => sum + atom.y, 0) / members.length;
                  return (
                    <button
                      type="button"
                      className={`compressed-compound${selectedMolecule === group.id ? " selected" : ""}`}
                      key={`compressed-${group.id}`}
                      style={{ transform: `translate(${x * scale - 46}px,${y * scale - 46}px)` }}
                      onPointerDown={(event) => {
                        beginCompoundDrag(event, group.id, group.atomIds);
                      }}
                      onPointerMove={pointerMove}
                      onPointerUp={() => {
                        gesture.current = null;
                      }}
                      onPointerCancel={() => {
                        gesture.current = null;
                      }}
                      onLostPointerCapture={() => {
                        gesture.current = null;
                      }}
                      onDoubleClick={(event) => {
                        event.stopPropagation();
                        toggleCompressed(group.id);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          selectCompound(group.id, group.atomIds, event.shiftKey);
                        }
                      }}
                      aria-label={`Select ${group.formula}; double click to expand`}
                    >
                      <b>{group.formula}</b>
                      <span>{group.name ?? "compound"}</span>
                    </button>
                  );
                })}
              {atoms
                .filter((atom) => !compressedAtomIds.has(atom.id))
                .map((atom) => {
                  const item = elements[atom.element];
                  const isSelected = selectedAtomIds.has(atom.id);
                  const bondVisual = atomBondVisuals.get(atom.id);
                  const sharedElectrons = bondVisual?.sharedElectrons ?? 0;
                  const sharedFrom = bondVisual?.sharedFrom ?? [];
                  const atomSize = 200 * scale;
                  return (
                    <div
                      role="button"
                      tabIndex={0}
                      className={`canvas-atom ${isSelected ? "selected" : ""}`}
                      style={{
                        width: atomSize,
                        height: atomSize,
                        transform: `translate(${atom.x * scale - atomSize / 2}px, ${atom.y * scale - atomSize / 2}px)`,
                      }}
                      key={atom.id}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          selectAtom(atom.id, event.shiftKey);
                        }
                      }}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        if ((event.target as Element).closest(".diagram-electron")) return;
                        event.currentTarget.setPointerCapture(event.pointerId);
                        const moveIds = isSelected
                          ? selected
                          : event.shiftKey
                            ? [...selected, atom.id]
                            : [atom.id];
                        const moveSet = new Set(moveIds);
                        setSelected(moveIds);
                        setSelectedMolecule(null);
                        setSelectedBond(null);
                        gesture.current = {
                          type: "selection",
                          sx: event.clientX,
                          sy: event.clientY,
                          origins: new Map(
                            atoms
                              .filter((item) => moveSet.has(item.id))
                              .map((item) => [item.id, { x: item.x, y: item.y }]),
                          ),
                        };
                      }}
                      onPointerMove={pointerMove}
                      onPointerUp={() => {
                        const current = gesture.current;
                        const movedIds =
                          current?.type === "selection" ? [...current.origins.keys()] : [];
                        gesture.current = null;
                        if (movedIds.length === 1)
                          void settleAtom(movedIds[0])
                            .then((valid) => {
                              if (valid) relaxBondGeometry(movedIds[0]);
                            })
                            .catch(() => {});
                      }}
                      onPointerCancel={() => {
                        gesture.current = null;
                      }}
                      onLostPointerCapture={() => {
                        gesture.current = null;
                      }}
                      aria-label={`${item.name} atom`}
                    >
                      <AtomScene
                        symbol={atom.element}
                        atomicNumber={item.z}
                        subshells={subshellsForElectronCount(
                          item.z - atom.charge + atom.electronOffset,
                        )}
                        sharedElectrons={sharedElectrons}
                        sharedFrom={sharedFrom}
                        onElectronSelect={(electron) => {
                          setSelected([atom.id]);
                          setSelectedBond(null);
                          setSelectedElectron({ atomId: atom.id, ...electron });
                        }}
                      />
                      {atom.charge !== 0 && (
                        <span
                          className={`atom-charge ${atom.charge > 0 ? "positive" : "negative"}`}
                        >
                          {atom.charge > 0 ? `+${atom.charge}` : atom.charge}
                        </span>
                      )}
                    </div>
                  );
                })}
              {active && activeElement && (
                <div
                  className="canvas-atom-controls"
                  style={{
                    transform: `translate(${active.x * scale - 135}px,${active.y * scale - 100 * scale - 48}px)`,
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  role="presentation"
                  onKeyDown={(event) => {
                    if (event.key === "Escape") event.stopPropagation();
                  }}
                  onClick={(event) => event.stopPropagation()}
                >
                  <button
                    type="button"
                    aria-label="Remove electron"
                    title={
                      bondSummary.length
                        ? "Remove bonds before changing electrons"
                        : "Remove electron"
                    }
                    disabled={
                      selected.length > 1 ||
                      bondSummary.length > 0 ||
                      activeElement.z - active.charge + active.electronOffset <= 0
                    }
                    onClick={() =>
                      setAtoms((items) =>
                        items.map((atom) =>
                          atom.id === active.id
                            ? {
                                ...atom,
                                electronOffset: Math.max(
                                  -(activeElement.z - active.charge),
                                  atom.electronOffset - 1,
                                ),
                              }
                            : atom,
                        ),
                      )
                    }
                  >
                    −
                  </button>
                  <label>
                    <span>e⁻</span>
                    <input
                      aria-label="Electron count"
                      type="number"
                      min="0"
                      max="118"
                      value={activeElement.z - active.charge + active.electronOffset}
                      disabled={selected.length > 1 || bondSummary.length > 0}
                      onChange={(event) => {
                        const count = Math.max(0, Math.min(118, Number(event.target.value) || 0));
                        setAtoms((items) =>
                          items.map((atom) =>
                            atom.id === active.id
                              ? {
                                  ...atom,
                                  electronOffset: count - (activeElement.z - active.charge),
                                }
                              : atom,
                          ),
                        );
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    aria-label="Add electron"
                    title={
                      bondSummary.length ? "Remove bonds before changing electrons" : "Add electron"
                    }
                    disabled={
                      selected.length > 1 ||
                      bondSummary.length > 0 ||
                      activeElement.z - active.charge + active.electronOffset >= 118
                    }
                    onClick={() =>
                      setAtoms((items) =>
                        items.map((atom) =>
                          atom.id === active.id
                            ? {
                                ...atom,
                                electronOffset: Math.min(
                                  118 - (activeElement.z - active.charge),
                                  atom.electronOffset + 1,
                                ),
                              }
                            : atom,
                        ),
                      )
                    }
                  >
                    +
                  </button>
                  <button
                    type="button"
                    aria-label="Reset electrons"
                    title="Reset electrons"
                    disabled={
                      selected.length > 1 || bondSummary.length > 0 || active.electronOffset === 0
                    }
                    onClick={() =>
                      setAtoms((items) =>
                        items.map((atom) =>
                          atom.id === active.id ? { ...atom, electronOffset: 0 } : atom,
                        ),
                      )
                    }
                  >
                    <ArrowCounterClockwise />
                  </button>
                  <button
                    type="button"
                    className="canvas-delete"
                    aria-label={
                      selected.length > 1
                        ? `Delete ${selected.length} selected atoms`
                        : "Delete atom"
                    }
                    onClick={() => deleteAtoms(selected)}
                  >
                    <Trash />
                  </button>
                </div>
              )}
            </div>
            {atoms.length === 0 && (
              <div className="canvas-empty">
                <Atom />
                <b>Place your first atom</b>
                <span>Choose an element from the tray or drag it here.</span>
              </div>
            )}
          </section>

          <aside className="atom-inspector">
            {activeBond ? (
              <BondInspector
                bond={activeBond}
                atoms={atoms}
                onClose={() => setSelectedBond(null)}
                onRemove={() => removeBond(activeBond.id)}
              />
            ) : activeMolecule ? (
              <MoleculeInspector
                group={activeMolecule}
                atoms={atoms}
                bonds={bonds}
                onClose={() => setSelectedMolecule(null)}
                onDelete={() => deleteAtoms(activeMolecule.atomIds)}
                compressed={compressedGroups.has(activeMolecule.id)}
                onToggleCompressed={() => toggleCompressed(activeMolecule.id)}
              />
            ) : active && activeElement ? (
              <>
                <div className="inspector-title">
                  <div>
                    <small>Selected atom</small>
                    <h1>{activeElement.name}</h1>
                    <code>{activeElement.config}</code>
                  </div>
                  <button type="button" aria-label="Deselect atom" onClick={() => setSelected([])}>
                    <X />
                  </button>
                </div>
                {selectedElectron?.atomId === active.id && (
                  <section className="selected-electron">
                    <h2>Selected electron</h2>
                    <div>
                      <i style={{ background: subshellColors[selectedElectron.kind] }} />
                      <b>{selectedElectron.label}</b>
                      <span>{selectedElectron.kind} subshell</span>
                    </div>
                    <p>
                      {selectedElectron.source
                        ? `Shared onto ${active.element} from ${selectedElectron.source}.`
                        : selectedElectron.shared
                          ? "This valence electron is contributed to a covalent bond."
                          : "This electron remains owned by the atom."}
                    </p>
                  </section>
                )}
                <section>
                  <div className="shell-groups">
                    {[...new Set(activeSubshells.map((subshell) => subshell.shell))].map(
                      (shell) => {
                        const shellSubshells = activeSubshells.filter(
                          (subshell) => subshell.shell === shell,
                        );
                        const total = shellSubshells.reduce(
                          (sum, subshell) => sum + subshell.count,
                          0,
                        );
                        const shared =
                          shell === Math.max(...activeSubshells.map((subshell) => subshell.shell))
                            ? bondSummary
                                .filter((bond) => bond.type === "covalent")
                                .reduce((sum, bond) => sum + bond.order, 0)
                            : 0;
                        return (
                          <div className="shell-group" key={shell}>
                            <div className="shell-total">
                              <b>Shell {shell}</b>
                              <span>
                                {total} owned electron{total === 1 ? "" : "s"}
                                {shared > 0 && <em> + {shared} shared</em>}
                              </span>
                            </div>
                            <div className="subshell-list">
                              {shellSubshells.map((subshell) => (
                                <div
                                  key={subshell.label}
                                  className={
                                    subshell.label === activeSubshells.at(-1)?.label
                                      ? "last-filled"
                                      : ""
                                  }
                                >
                                  <i style={{ background: subshellColors[subshell.kind] }} />
                                  <b>{subshell.label}</b>
                                  <span>{subshell.count} electrons</span>
                                  {subshell.label === activeSubshells.at(-1)?.label && (
                                    <em>last filled</em>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      },
                    )}
                  </div>
                </section>
                <AtomLearning atom={active} atoms={atoms} bonds={bonds} />
                <ElementPlacement symbol={active.element} />
                <section>
                  <h2>pH</h2>
                  <p>
                    An isolated {activeElement.name.toLowerCase()} atom has no pH. pH applies when a
                    substance is dissolved in water, and depends on concentration and temperature.
                  </p>
                </section>
                <section>
                  <h2>Why it changes</h2>
                  <p>{activeElement.note}</p>
                  {active.charge !== 0 && (
                    <p className="change-note">
                      This atom is shown as{" "}
                      {active.charge > 0
                        ? `a ${active.charge}+ cation after losing outer electrons`
                        : `a ${Math.abs(active.charge)}− anion after gaining electrons`}
                      .
                    </p>
                  )}
                </section>
                <section>
                  <h2>Connected bonds</h2>
                  {bondSummary.length ? (
                    <div className="bond-summary">
                      {bondSummary.map((bond) => (
                        <div key={bond.id}>
                          <span>
                            <i className={bond.type} />
                            {bond.type} bond
                          </span>
                          <button
                            type="button"
                            aria-label={`Remove ${bond.type} bond`}
                            onClick={() => removeBond(bond.id)}
                          >
                            <X />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p>No bond. Move this atom close to a compatible atom.</p>
                  )}
                </section>
              </>
            ) : (
              <div className="inspector-empty">
                <Atom />
                <b>Select an atom</b>
                <span>Its configuration, subshells, charge, and bonds will appear here.</span>
              </div>
            )}
          </aside>
          <div
            className="sidebar-resizer right"
            role="slider"
            aria-label="Resize information sidebar"
            aria-orientation="vertical"
            aria-valuenow={sidebarWidths.right}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              resizing.current = {
                side: "right",
                startX: event.clientX,
                startWidth: sidebarWidths.right,
              };
            }}
            onPointerMove={(event) => {
              const current = resizing.current;
              if (!current || current.side !== "right") return;
              setSidebarWidths((widths) => ({
                ...widths,
                right: Math.max(
                  220,
                  Math.min(460, current.startWidth - event.clientX + current.startX),
                ),
              }));
            }}
            onPointerUp={() => {
              resizing.current = null;
            }}
            onPointerCancel={() => {
              resizing.current = null;
            }}
            onLostPointerCapture={() => {
              resizing.current = null;
            }}
          />
        </div>
        {periodicPresence.mounted && (
          <div
            className={`periodic-backdrop ${periodicPresence.closing ? "is-closing" : ""}`}
            onPointerDown={() => setPeriodicOpen(false)}
          >
            <dialog
              className="periodic-panel"
              open
              aria-modal="true"
              aria-label="Periodic table"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <header>
                <div>
                  <small>Element library</small>
                  <h1>Periodic table</h1>
                </div>
                <div className="periodic-filters">
                  <label>
                    Valence
                    <select
                      value={valenceFilter}
                      onChange={(event) => setValenceFilter(event.target.value)}
                    >
                      <option value="all">All</option>
                      {Array.from({ length: 8 }, (_, index) => (
                        <option key={index + 1} value={index + 1}>
                          {index + 1} electron{index === 0 ? "" : "s"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Character
                    <select
                      value={characterFilter}
                      onChange={(event) => setCharacterFilter(event.target.value)}
                    >
                      <option value="all">All</option>
                      <option value="electronegative">Electronegative</option>
                      <option value="intermediate">Intermediate</option>
                      <option value="electropositive">Electropositive</option>
                    </select>
                  </label>
                </div>
                <button
                  type="button"
                  aria-label="Close periodic table"
                  onClick={() => setPeriodicOpen(false)}
                >
                  <X />
                </button>
              </header>
              <div className="periodic-grid">
                {periodicMain.flatMap((row, rowIndex) =>
                  row.map(([symbol, column]) => {
                    const item = elements[symbol],
                      matches = periodicMatch(symbol);
                    return (
                      <button
                        type="button"
                        key={symbol}
                        className={matches ? "" : "filtered"}
                        disabled={!matches}
                        draggable={matches}
                        style={{ gridColumn: column, gridRow: rowIndex + 1 }}
                        onDragStart={(event) => {
                          event.dataTransfer.setData("element", symbol);
                          event.dataTransfer.effectAllowed = "copy";
                        }}
                        onDragEnd={(event) => dropPeriodicAtom(event, symbol)}
                        onClick={() => {
                          addAtom(symbol);
                          setPeriodicOpen(false);
                        }}
                      >
                        <small>{item.z}</small>
                        <b>{symbol}</b>
                        <span>{item.name}</span>
                        <i>
                          {item.valence}v · {pauling(symbol) || "—"} EN
                        </i>
                      </button>
                    );
                  }),
                )}
                {periodicFBlock.flatMap((row, rowIndex) =>
                  row.map((symbol, index) => {
                    const item = elements[symbol],
                      matches = periodicMatch(symbol);
                    return (
                      <button
                        type="button"
                        key={symbol}
                        className={matches ? "f-block" : "f-block filtered"}
                        disabled={!matches}
                        draggable={matches}
                        style={{ gridColumn: index + 4, gridRow: rowIndex + 8 }}
                        onDragStart={(event) => event.dataTransfer.setData("element", symbol)}
                        onDragEnd={(event) => dropPeriodicAtom(event, symbol)}
                        onClick={() => {
                          addAtom(symbol);
                          setPeriodicOpen(false);
                        }}
                      >
                        <small>{item.z}</small>
                        <b>{symbol}</b>
                        <span>{item.name}</span>
                        <i>
                          {item.valence}v · {pauling(symbol) || "—"} EN
                        </i>
                      </button>
                    );
                  }),
                )}
              </div>
            </dialog>
          </div>
        )}
        {saveDialogPresence.mounted && (
          <div
            className={`formula-command-backdrop ${saveDialogPresence.closing ? "is-closing" : ""}`}
            onPointerDown={() => setSaveDialogOpen(false)}
          >
            <dialog
              className="save-dialog"
              open
              aria-modal="true"
              aria-label="Save canvas"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveCanvas(saveFileName);
                }}
              >
                <label htmlFor="canvas-file-name">File name</label>
                <div className="save-name-field">
                  <input
                    id="canvas-file-name"
                    autoFocus
                    value={saveFileName}
                    onChange={(event) => setSaveFileName(event.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <span>.electron</span>
                </div>
                <p>
                  This canvas keeps autosaving in your browser. You can also save a portable
                  .electron copy to import elsewhere.
                </p>
                <div className="save-dialog-actions">
                  <button type="button" onClick={() => setSaveDialogOpen(false)}>
                    Cancel
                  </button>
                  <button type="submit">Save canvas</button>
                </div>
              </form>
            </dialog>
          </div>
        )}
        {formulaPresence.mounted && (
          <div
            className={`formula-command-backdrop ${formulaPresence.closing ? "is-closing" : ""}`}
            onPointerDown={() => {
              if (!formulaLoading) setFormulaOpen(false);
            }}
          >
            <dialog
              className={`formula-command ${formulaCandidates.length ? "has-results" : ""}`}
              open
              aria-modal="true"
              aria-label="Add a PubChem structure"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <form
                aria-busy={formulaLoading}
                onSubmit={(event) => {
                  event.preventDefault();
                  void spawnFormula(formulaInput);
                }}
              >
                <label>
                  <span>Structure lookup</span>
                  <input
                    autoFocus
                    value={formulaInput}
                    onChange={(event) => {
                      setFormulaInput(event.target.value);
                      setFormulaError("");
                      setFormulaCandidates([]);
                    }}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={formulaLoading}
                    placeholder="Formula, name, CID, or smiles:…"
                  />
                </label>
                {formulaError && <output>{formulaError}</output>}
                {formulaCandidates.length > 0 && (
                  <div className="structure-candidates" aria-label="Matching PubChem structures">
                    <header>
                      <b>Select a structure</b>
                      <span>Showing the first {formulaCandidates.length} PubChem matches</span>
                    </header>
                    {formulaCandidates.map((candidate) => (
                      <button
                        type="button"
                        key={candidate.cid}
                        onClick={() => spawnFormula(String(candidate.cid))}
                        disabled={formulaLoading}
                      >
                        <span>
                          <b>{candidate.name}</b>
                          <small>
                            {candidate.formula.replace(
                              /\d/g,
                              (digit) => "₀₁₂₃₄₅₆₇₈₉"[Number(digit)],
                            )}
                          </small>
                        </span>
                        <code>CID {candidate.cid}</code>
                      </button>
                    ))}
                  </div>
                )}
              </form>
            </dialog>
          </div>
        )}
      </main>
    </>
  );
}

function MoleculeInspector({
  group,
  atoms,
  bonds,
  onClose,
  onDelete,
  compressed,
  onToggleCompressed,
}: {
  group: FormulaGroup;
  atoms: AtomNode[];
  bonds: BondEdge[];
  onClose: () => void;
  onDelete: () => void;
  compressed: boolean;
  onToggleCompressed: () => void;
}) {
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
            {group.cid ? ` · PubChem CID ${group.cid}` : ""}
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
        <h2>pH</h2>
        <MoleculePh cid={group.cid} />
      </section>
      <section>
        <h2>Canvas interaction</h2>
        <p>
          Drag anywhere in the outlined molecular area to move every atom and bond together.
          Individual atoms and bonds remain selectable.
        </p>
      </section>
      <button type="button" className="compress-molecule" onClick={onToggleCompressed}>
        {compressed ? <ArrowsOut /> : <ArrowsIn />}
        {compressed ? "Expand structure" : "Compress to one circle"}
      </button>
      <button type="button" className="remove-bond" onClick={onDelete}>
        <Trash /> Delete molecule
      </button>
    </div>
  );
}

function BondInspector({
  bond,
  atoms,
  onClose,
  onRemove,
}: {
  bond: BondEdge;
  atoms: AtomNode[];
  onClose: () => void;
  onRemove: () => void;
}) {
  const from = atoms.find((atom) => atom.id === bond.from)!;
  const to = atoms.find((atom) => atom.id === bond.to)!;
  const fromSubshell = subshellsForElectronCount(
    elements[from.element].z - from.charge + from.electronOffset,
  ).at(-1);
  const toSubshell = subshellsForElectronCount(
    elements[to.element].z - to.charge + to.electronOffset,
  ).at(-1);
  const fromEn = pauling(from.element),
    toEn = pauling(to.element),
    difference = Math.abs(fromEn - toEn),
    moreNegative = fromEn > toEn ? from : to;
  const donor = metals.has(from.element) ? from : to;
  const receiver = donor === from ? to : from;
  const polarity =
    bond.type === "ionic" ? "ionic" : difference < 0.4 ? "mostly nonpolar" : "polar covalent";
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
            <b>{donor.element}</b> donates an outer electron to <b>{receiver.element}</b>. They
            become oppositely charged ions held by electrostatic attraction.
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
                <i style={{ background: subshellColors[fromSubshell?.kind ?? "s"] }} />
                {from.element}: {fromSubshell?.label}
              </span>
              <span>
                <i style={{ background: subshellColors[toSubshell?.kind ?? "s"] }} />
                {to.element}: {toSubshell?.label}
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
              Electron density is pulled toward <b>{moreNegative.element} δ−</b>; the other end is
              δ+.
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

function pauling(symbol: string) {
  return (
    Number(
      (periodicTable as unknown as Record<string, { pauling_negativity?: number | string }>)[symbol]
        ?.pauling_negativity,
    ) || 0
  );
}

function ElementPlacement({ symbol }: { symbol: string }) {
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

function plainFormula(formula: string) {
  return formula
    .normalize("NFKC")
    .replace(/[₀-₉]/g, (digit) => String("₀₁₂₃₄₅₆₇₈₉".indexOf(digit)));
}

function formulaCounts(formula: string) {
  return [...plainFormula(formula).matchAll(/([A-Z][a-z]?)(\d*)/g)].reduce<Record<string, number>>(
    (counts, match) => {
      counts[match[1]] = (counts[match[1]] ?? 0) + (Number(match[2]) || 1);
      return counts;
    },
    {},
  );
}

function validFormula(formula: string) {
  const tokens = [...plainFormula(formula).matchAll(/([A-Z][a-z]?)(\d*)/g)];
  return (
    tokens.length > 0 &&
    tokens.map((match) => match[0]).join("") === plainFormula(formula) &&
    tokens.every((match) => match[1] in elements) &&
    tokens.reduce((total, match) => total + (Number(match[2]) || 1), 0) <= 30
  );
}

function connectedStructure(record: StructureRecord) {
  if (record.atoms.length <= 1) return true;
  const adjacency = new Map<number, number[]>();
  record.bonds.forEach((bond) => {
    adjacency.set(bond.from, [...(adjacency.get(bond.from) ?? []), bond.to]);
    adjacency.set(bond.to, [...(adjacency.get(bond.to) ?? []), bond.from]);
  });
  const visited = new Set<number>();
  const stack = [record.atoms[0].aid];
  while (stack.length) {
    const aid = stack.pop()!;
    if (visited.has(aid)) continue;
    visited.add(aid);
    (adjacency.get(aid) ?? []).forEach((next) => stack.push(next));
  }
  return visited.size === record.atoms.length;
}

function scaledCounts(formula: string, coefficient: number) {
  return Object.fromEntries(
    Object.entries(formulaCounts(formula)).map(([symbol, count]) => [symbol, count * coefficient]),
  );
}

function addCounts(...parts: Array<Record<string, number>>) {
  const result: Record<string, number> = {};
  parts.forEach((part) =>
    Object.entries(part).forEach(([symbol, count]) => {
      result[symbol] = (result[symbol] ?? 0) + count;
    }),
  );
  return result;
}

function sameCounts(first: Record<string, number>, second: Record<string, number>) {
  const symbols = new Set([...Object.keys(first), ...Object.keys(second)]);
  return [...symbols].every((symbol) => (first[symbol] ?? 0) === (second[symbol] ?? 0));
}

function balanceFormulas(
  reactants: string[],
  products: string[],
  reactantCharges = reactants.map(() => 0),
  productCharges = products.map(() => 0),
) {
  const formulas = [...reactants, ...products];
  if (formulas.length < 3 || products.length > 3) return null;
  for (let limit = 1; limit <= 12; limit++) {
    const coefficients = Array<number>(formulas.length).fill(1);
    const search = (index: number): number[] | null => {
      if (index === coefficients.length) {
        if (!coefficients.includes(limit)) return null;
        const left = addCounts(
          ...reactants.map((formula, formulaIndex) =>
            scaledCounts(formula, coefficients[formulaIndex]),
          ),
        );
        const right = addCounts(
          ...products.map((formula, formulaIndex) =>
            scaledCounts(formula, coefficients[reactants.length + formulaIndex]),
          ),
        );
        const leftCharge = reactantCharges.reduce(
          (sum, charge, chargeIndex) => sum + charge * coefficients[chargeIndex],
          0,
        );
        const rightCharge = productCharges.reduce(
          (sum, charge, chargeIndex) => sum + charge * coefficients[reactants.length + chargeIndex],
          0,
        );
        return sameCounts(left, right) && leftCharge === rightCharge ? [...coefficients] : null;
      }
      for (let coefficient = 1; coefficient <= limit; coefficient++) {
        coefficients[index] = coefficient;
        const result = search(index + 1);
        if (result) return result;
      }
      return null;
    };
    const result = search(0);
    if (result)
      return {
        reactants: result.slice(0, reactants.length),
        products: result.slice(reactants.length),
      };
  }
  return null;
}

const genericProductWords = new Set([
  "air",
  "combustion",
  "explosion",
  "fire",
  "flame",
  "fume",
  "fumes",
  "gas",
  "gases",
  "heat",
  "mixture",
  "product",
  "products",
  "solution",
  "solutions",
  "vapor",
  "vapors",
]);

function reactionProductQueries(text: string, reactants: [StructureRecord, StructureRecord]) {
  const queries = new Set<string>();
  const clauses = text
    .replace(/\[[^\]]*]/g, " ")
    .split(/(?<=[.;])\s+|;\s*/)
    .filter((clause) =>
      /form|produc|yield|generat|release|evolv|liberat|decompos|give off/i.test(clause),
    );
  const productTails: string[] = [];
  for (const clause of clauses) {
    for (const match of clause.matchAll(
      /(?:to\s+form|forming|forms?|produces?|yields?|generates?|releases?|evolves?|liberates?|gives?\s+off|decomposes?\s+(?:to|into))\s+([^.;]+)/gi,
    ))
      productTails.push(match[1]);
    const passive = clause.match(
      /([^.;]+?)\s+(?:is|are)\s+(?:formed|produced|generated|released)\b/i,
    );
    if (passive) productTails.push(passive[1].split(",").at(-1) ?? passive[1]);
  }

  for (const tail of productTails) {
    for (const match of tail.matchAll(/\b(?:[A-Z][a-z]?\d*){1,8}\b/g))
      if (validFormula(match[0])) queries.add(match[0]);
    const withoutConditions = tail.split(
      /\b(?:when|while|under|upon|during|at\s+\d|in\s+the\s+presence|on\s+contact)\b/i,
    )[0];
    const segments = withoutConditions.split(
      /\s*(?:,|\band\b|\bplus\b|\balong with\b|\bas well as\b)\s*/i,
    );
    for (const rawSegment of segments) {
      const segment = rawSegment
        .replace(/\([^)]*\)/g, " ")
        .replace(
          /^(?:(?:an?|the|strong|highly|hot|cold|aqueous|dilute|concentrated|caustic|corrosive|flammable|gaseous|toxic|irritating|explosive|solid|liquid)\s+)+/i,
          "",
        )
        .replace(/^(?:a\s+)?solutions?\s+of\s+/i, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!segment) continue;
      const words = segment.match(/[a-z][a-z0-9-]*/gi) ?? [];
      for (let length = 1; length <= Math.min(5, words.length); length++) {
        const phrase = words.slice(-length).join(" ");
        if (length === 1 && genericProductWords.has(phrase.toLowerCase())) continue;
        queries.add(phrase);
      }
      const inferred = segment.match(/^(?:the\s+)?([a-z]+(?:ide|ate|ite))$/i)?.[1];
      if (inferred) reactants.forEach((reactant) => queries.add(`${reactant.name} ${inferred}`));
    }
  }
  reactants.forEach((reactant) => {
    queries.delete(reactant.name);
    queries.delete(reactant.formula);
  });
  return [...queries];
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
) {
  const results = Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function productCombinations(records: StructureRecord[]) {
  const combinations: StructureRecord[][] = [];
  const collect = (start: number, selected: StructureRecord[]) => {
    if (selected.length) combinations.push(selected);
    if (selected.length === 3) return;
    for (let index = start; index < records.length; index++)
      collect(index + 1, [...selected, records[index]]);
  };
  collect(0, []);
  return combinations;
}

function relevantReactionCondition(
  text: string,
  reactants: [StructureRecord, StructureRecord],
  products: StructureRecord[],
) {
  const statements = text
    .split(/(?<=[.;])\s+|;\s*/)
    .map((statement) => statement.trim())
    .filter(Boolean);
  return statements
    .map((statement) => {
      const lower = statement.toLowerCase();
      const productMentions = products.filter(
        (product) =>
          lower.includes(product.name.toLowerCase()) ||
          lower.includes(product.formula.toLowerCase()),
      ).length;
      const reactantMentions = reactants.filter(
        (reactant) =>
          lower.includes(reactant.name.toLowerCase()) ||
          lower.includes(reactant.formula.toLowerCase()),
      ).length;
      return {
        statement,
        score:
          productMentions * 4 +
          reactantMentions * 2 +
          Number(/react|form|produc|yield|generat|release|evolv|decompos/i.test(statement)),
      };
    })
    .sort((a, b) => b.score - a.score || a.statement.length - b.statement.length)[0]?.statement;
}

async function discoverReactionChoices(first: MoleculeEntity, second: MoleculeEntity) {
  const resolve = async (entity: MoleculeEntity) => {
    const result = await lookupStructure(
      entity.cid ? String(entity.cid) : (entity.name ?? entity.formula),
    );
    return result.record;
  };
  const [firstRecord, secondRecord] = await Promise.all([resolve(first), resolve(second)]);
  if (!firstRecord?.cid || !secondRecord?.cid) return [];
  const [firstFacts, secondFacts] = await Promise.all([
    lookupCompoundFacts(firstRecord.cid),
    lookupCompoundFacts(secondRecord.cid),
  ]);
  const mentions = (text: string, record: StructureRecord) => {
    const lower = text.toLowerCase();
    return (
      lower.includes(record.name.toLowerCase()) || lower.includes(record.formula.toLowerCase())
    );
  };
  const facts = [
    ...firstFacts.reactivity.filter((text) => mentions(text, secondRecord)),
    ...secondFacts.reactivity.filter((text) => mentions(text, firstRecord)),
  ].filter((text) => /react|form|decompos|ignite|release/i.test(text));
  if (!facts.length) return [];

  const reactantRecords: [StructureRecord, StructureRecord] = [firstRecord, secondRecord];
  const factQueries = facts
    .map((condition) => ({
      condition,
      queries: reactionProductQueries(condition, reactantRecords),
    }))
    .filter((fact) => fact.queries.length)
    .sort((a, b) => b.queries.length - a.queries.length || a.condition.length - b.condition.length);
  const queries = [...new Set(factQueries.flatMap((fact) => fact.queries))]
    .sort(
      (a, b) =>
        Number(/\s/.test(b)) * 4 +
          Number(/(?:ide|ate|ite)$/i.test(b)) * 2 +
          Number(/\d/.test(b)) -
          (Number(/\s/.test(a)) * 4 +
            Number(/(?:ide|ate|ite)$/i.test(a)) * 2 +
            Number(/\d/.test(a))) || a.length - b.length,
    )
    .slice(0, 20);
  const resolvedCandidates = await mapWithConcurrency(queries, 2, async (query) => {
    const result = await lookupStructure(query);
    if (result.record) return { query, record: result.record };
    const alternatives = await Promise.all(
      (result.candidates ?? [])
        .slice(0, 5)
        .map((candidate) => lookupStructure(String(candidate.cid))),
    );
    const record = alternatives.find((alternative) =>
      alternative.record ? connectedStructure(alternative.record) : false,
    )?.record;
    return { query, record };
  });
  const recordByQuery = new Map(
    resolvedCandidates.flatMap(({ query, record }) =>
      record?.cid &&
      connectedStructure(record) &&
      record.cid !== firstRecord.cid &&
      record.cid !== secondRecord.cid
        ? [[query, record] as const]
        : [],
    ),
  );

  const routes: ReactionRecipe[] = [];
  const seenRoutes = new Set<string>();
  for (const fact of factQueries) {
    const candidates = fact.queries
      .map((query) => recordByQuery.get(query))
      .filter((record, index, records): record is StructureRecord =>
        Boolean(
          record?.cid && records.findIndex((candidate) => candidate?.cid === record.cid) === index,
        ),
      );
    for (const products of productCombinations(candidates)) {
      const balance = balanceFormulas(
        [first.formula, second.formula],
        products.map((product) => product.formula),
        [firstRecord.charge ?? 0, secondRecord.charge ?? 0],
        products.map((product) => product.charge ?? 0),
      );
      if (!balance) continue;
      const condition =
        relevantReactionCondition(fact.condition, reactantRecords, products) ?? fact.condition;
      const recipe: ReactionRecipe = {
        name: products.map((product) => product.name).join(" + "),
        condition: condition.length > 240 ? `${condition.slice(0, 237)}…` : condition,
        reactants: [
          { formula: first.formula, coefficient: balance.reactants[0] },
          { formula: second.formula, coefficient: balance.reactants[1] },
        ],
        products: products.map((product, index) => ({
          formula: product.formula,
          coefficient: balance.products[index],
          cid: product.cid!,
        })),
      };
      const routeKey = recipe.products
        .map((product) => `${product.cid}:${product.coefficient}`)
        .sort()
        .join("|");
      if (seenRoutes.has(routeKey)) continue;
      seenRoutes.add(routeKey);
      routes.push(recipe);
      if (routes.length === 8) return routes;
    }
  }
  return routes;
}

function reactionEquation(recipe: ReactionRecipe) {
  const side = (items: ReactionRecipe["reactants"]) =>
    items
      .map((item) => `${item.coefficient > 1 ? item.coefficient : ""}${item.formula}`)
      .join(" + ");
  return `${side(recipe.reactants)} → ${side(recipe.products)}`;
}

function MoleculePh({ cid }: { cid?: number }) {
  const [values, setValues] = useState<string[]>([]);
  useEffect(() => {
    let current = true;
    setValues([]);
    if (cid) void lookupCompoundFacts(cid).then((facts) => current && setValues(facts.ph));
    return () => {
      current = false;
    };
  }, [cid]);
  if (!cid) return <p>Link this structure to a PubChem record to retrieve reported pH data.</p>;
  if (!values.length)
    return (
      <p>
        No pH value is reported by PubChem. pH also requires an aqueous concentration and
        temperature.
      </p>
    );
  return <p>{values.join(" · ")}</p>;
}

function AtomLearning({
  atom,
  atoms,
  bonds,
}: {
  atom: AtomNode;
  atoms: AtomNode[];
  bonds: BondEdge[];
}) {
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
  const ionicShells = subshellsForElectronCount(data.z - atom.charge + atom.electronOffset),
    outerShell = ionicShells.at(-1)?.shell ?? 1;
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
              ? `After electron transfer, shell ${outerShell} is the ion’s outer occupied shell and contains ${shellCount} of ${shellTarget} electrons.`
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
        <h2>Polarity around this atom</h2>
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
      <section>
        <h2>Resonance & octet exceptions</h2>
        {exception ? (
          <p className="resonance-note">
            {exception}. The octet rule is a useful pattern, not a universal law.
          </p>
        ) : (
          <p>
            No local octet exception is detected. Compound-specific resonance claims are not
            inferred from a small formula lookup table.
          </p>
        )}
      </section>
    </>
  );
}
