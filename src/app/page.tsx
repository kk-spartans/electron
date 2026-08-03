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
import { lookupStructure, type StructureCandidate, type StructureRecord } from "@/lib/pubchem";
import { lookupReportedReactions } from "@/lib/reactions";

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
  isCompound: boolean;
  cid?: number;
  name?: string;
};

type RecognizedCompound = {
  signature: string;
  atomIds: number[];
  formula: string;
  name: string;
  cid?: number;
};

type PreparedReaction = {
  key: string;
  recipe: ReactionRecipe;
  atomIds: number[];
  originalAtomIds: number[];
  spawnedAtomIds: number[];
  center: { x: number; y: number };
};

type HistorySnapshot = {
  atoms: AtomNode[];
  bonds: BondEdge[];
  formulaGroups: FormulaGroup[];
  compressedGroupIds: number[];
};

type CanvasClipboard = HistorySnapshot;

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
const structureRecognitionCache = new Map<string, Promise<StructureRecord | undefined>>();
const aiReactionCache = new Map<string, Promise<ReactionRecipe[]>>();
let aiReactionApiAvailable: boolean | null = null;
const aiReactionEndpoint = process.env.NEXT_PUBLIC_REACTION_API ?? "/api/reactions";

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
  allSymbols.map((symbol, index) => [symbol, generatedElement(symbol, index + 1)]),
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
      if (!from || !to) return;
      const halogens = ["F", "Cl", "Br", "I", "At", "Ts"];
      if (
        !metals.has(from.element) &&
        !metals.has(to.element) &&
        (halogens.includes(from.element) || halogens.includes(to.element))
      ) {
        const receiver = halogens.includes(from.element) ? from : to;
        const donor = receiver === from ? to : from;
        charges.set(donor.id, (charges.get(donor.id) ?? 0) + bond.order);
        charges.set(receiver.id, (charges.get(receiver.id) ?? 0) - bond.order);
        return;
      }
      if (metals.has(from.element) === metals.has(to.element)) return;
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
  const [valenceFilters, setValenceFilters] = useState<Set<number>>(() => new Set());
  const [characterFilters, setCharacterFilters] = useState<Set<string>>(() => new Set());
  const [formulaGroups, setFormulaGroups] = useState<FormulaGroup[]>([]);
  const [recognizedCompounds, setRecognizedCompounds] = useState<RecognizedCompound[]>([]);
  const [selectedMolecule, setSelectedMolecule] = useState<number | null>(null);
  const [compressedGroups, setCompressedGroups] = useState<Set<number>>(() => new Set());
  const [reactionChoices, setReactionChoices] = useState<ReactionRecipe[]>([]);
  const [reactionSearching, setReactionSearching] = useState(false);
  const [reactionSearchEmpty, setReactionSearchEmpty] = useState(false);
  const [ionicElectronTransfers, setIonicElectronTransfers] = useState<
    Array<{ id: number; from: AtomNode; to: AtomNode }>
  >([]);
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
  const validationNoticePresence = useAnimatedPresence(Boolean(validationNotice), 400);
  const lastValidationNotice = useRef("");
  useEffect(() => {
    if (validationNotice) lastValidationNotice.current = validationNotice;
  }, [validationNotice]);
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
  const canvasClipboard = useRef<CanvasClipboard | null>(null);
  const pasteCount = useRef(0);
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
      if (!current) return;
      try {
        const saved = await readAutosavedCanvas();
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

  const recognitionSignature = useMemo(() => {
    const claimed = new Set(formulaGroups.flatMap((group) => group.atomIds));
    return JSON.stringify({
      atoms: atoms
        .filter((atom) => !claimed.has(atom.id))
        .map(({ id, element, charge }) => ({ id, element, charge }))
        .sort((first, second) => first.id - second.id),
      bonds: bonds
        .filter(
          (bond) => bond.type === "covalent" && !claimed.has(bond.from) && !claimed.has(bond.to),
        )
        .map(({ from, to, order }) => ({
          from: Math.min(from, to),
          to: Math.max(from, to),
          order,
        }))
        .sort((first, second) => first.from - second.from || first.to - second.to),
    });
  }, [atoms, bonds, formulaGroups]);
  useEffect(() => {
    let current = true;
    const timeout = window.setTimeout(() => {
      const recognize = async () => {
        const claimed = new Set(formulaGroupsRef.current.flatMap((group) => group.atomIds));
        const availableAtoms = atomsRef.current.filter((atom) => !claimed.has(atom.id));
        const availableById = new Map(availableAtoms.map((atom) => [atom.id, atom]));
        const availableBonds = bondsRef.current.filter(
          (bond) =>
            bond.type === "covalent" && availableById.has(bond.from) && availableById.has(bond.to),
        );
        const adjacency = new Map<number, number[]>();
        availableBonds.forEach((bond) => {
          adjacency.set(bond.from, [...(adjacency.get(bond.from) ?? []), bond.to]);
          adjacency.set(bond.to, [...(adjacency.get(bond.to) ?? []), bond.from]);
        });
        const visited = new Set<number>();
        const components: Array<{ atoms: AtomNode[]; bonds: BondEdge[]; signature: string }> = [];
        for (const atom of availableAtoms) {
          if (visited.has(atom.id) || !adjacency.has(atom.id)) continue;
          const ids: number[] = [];
          const stack = [atom.id];
          while (stack.length) {
            const id = stack.pop()!;
            if (visited.has(id)) continue;
            visited.add(id);
            ids.push(id);
            (adjacency.get(id) ?? []).forEach((neighbor) => stack.push(neighbor));
          }
          const idSet = new Set(ids);
          const componentAtoms = ids.map((id) => availableById.get(id)!);
          const componentBonds = availableBonds.filter(
            (bond) => idSet.has(bond.from) && idSet.has(bond.to),
          );
          components.push({
            atoms: componentAtoms,
            bonds: componentBonds,
            signature: `${ids.sort((first, second) => first - second).join(",")}:${componentBonds
              .map(
                (bond) =>
                  `${Math.min(bond.from, bond.to)}-${Math.max(bond.from, bond.to)}-${bond.order}`,
              )
              .sort()
              .join(",")}`,
          });
        }
        const recognized = (
          await Promise.all(
            components.map(async (component): Promise<RecognizedCompound | null> => {
              const validation = await validateStructure(component.atoms, component.bonds);
              if (!validation.valid || !validation.canonicalSmiles) return null;
              let pending = structureRecognitionCache.get(validation.canonicalSmiles);
              if (!pending) {
                pending = lookupStructure(`smiles:${validation.canonicalSmiles}`).then(
                  (result) => result.record,
                );
                structureRecognitionCache.set(validation.canonicalSmiles, pending);
              }
              const record = await pending;
              if (!record?.cid) {
                structureRecognitionCache.delete(validation.canonicalSmiles);
                return null;
              }
              const explicitCounts = component.atoms.reduce<Record<string, number>>(
                (counts, atom) => {
                  counts[atom.element] = (counts[atom.element] ?? 0) + 1;
                  return counts;
                },
                {},
              );
              const reportedCounts = formulaCounts(record.formula);
              const elementsInEither = new Set([
                ...Object.keys(explicitCounts),
                ...Object.keys(reportedCounts),
              ]);
              if (
                [...elementsInEither].some(
                  (element) => (explicitCounts[element] ?? 0) !== (reportedCounts[element] ?? 0),
                )
              )
                return null;
              return {
                signature: component.signature,
                atomIds: component.atoms.map((atom) => atom.id),
                formula: record.formula,
                name: record.name,
                cid: record.cid,
              };
            }),
          )
        ).filter((compound): compound is RecognizedCompound => Boolean(compound));
        if (current) setRecognizedCompounds(recognized);
      };
      void recognize();
    }, 280);
    return () => {
      current = false;
      window.clearTimeout(timeout);
    };
  }, [recognitionSignature]);

  // Spawned and hand-built compound identities both come from PubChem.
  const namedCompounds = useMemo<
    Array<{
      formula: string;
      name: string;
      atomIds: number[];
      x: number;
      y: number;
      cid?: number;
    }>
  >(
    () =>
      recognizedCompounds.flatMap((compound) => {
        const members = compound.atomIds
          .map((id) => atomById.get(id))
          .filter((atom): atom is AtomNode => Boolean(atom));
        if (members.length !== compound.atomIds.length) return [];
        return [
          {
            ...compound,
            x: members.reduce((sum, atom) => sum + atom.x, 0) / members.length,
            y: Math.max(...members.map((atom) => atom.y)) + 125,
          },
        ];
      }),
    [atomById, recognizedCompounds],
  );
  const activeMolecule =
    formulaGroups.find((group) => group.id === selectedMolecule) ??
    namedCompounds
      .filter((compound) => -Math.min(...compound.atomIds) === selectedMolecule)
      .map<FormulaGroup>((compound) => ({
        id: -Math.min(...compound.atomIds),
        atomIds: compound.atomIds,
        formula: compound.formula,
        name: compound.name,
        cid: compound.cid,
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
          isCompound: true,
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
          isCompound: true,
          cid: compound.cid,
          name: compound.name,
        },
      ];
    });
    const singles = atoms
      .filter(
        (atom) =>
          !claimed.has(atom.id) &&
          !bonds.some((bond) => bond.from === atom.id || bond.to === atom.id),
      )
      .map((atom) => ({
        id: -1_000_000 - atom.id,
        formula: atom.element,
        atomIds: [atom.id],
        x: atom.x,
        y: atom.y,
        isCompound: true,
        name: elements[atom.element].name,
      }));
    return [...groups, ...known, ...singles];
  }, [atomById, atoms, bonds, formulaGroups, namedCompounds]);

  const isolatedElementEntities = useMemo(
    () =>
      moleculeEntities.filter((entity) => entity.atomIds.length === 1 && entity.id <= -1_000_000),
    [moleculeEntities],
  );

  const selectedReactants = useMemo(() => {
    const selectedIds = new Set(selected);
    return moleculeEntities.filter(
      (entity) =>
        entity.isCompound &&
        entity.atomIds.length > 0 &&
        entity.atomIds.every((atomId) => selectedIds.has(atomId)),
    );
  }, [moleculeEntities, selected]);

  const selectedReactantPairs = useMemo(() => {
    const pairs: Array<{
      first: MoleculeEntity;
      second: MoleculeEntity;
      distance: number;
    }> = [];
    for (let firstIndex = 0; firstIndex < selectedReactants.length; firstIndex++) {
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < selectedReactants.length;
        secondIndex++
      ) {
        const first = selectedReactants[firstIndex],
          second = selectedReactants[secondIndex],
          distance = Math.hypot(first.x - second.x, first.y - second.y);
        pairs.push({ first, second, distance });
      }
    }
    return pairs.sort((first, second) => first.distance - second.distance);
  }, [selectedReactants]);

  const reactionContextEntities = useMemo(
    () =>
      reactionPairRef.current
        ? [reactionPairRef.current.first, reactionPairRef.current.second]
        : reactionCandidate?.pairs[0]
          ? [reactionCandidate.pairs[0].first, reactionCandidate.pairs[0].second]
          : selectedReactants,
    [reactionCandidate, selectedReactants],
  );

  const reactionMenuPosition = useMemo(() => {
    if (!reactionContextEntities.length) return undefined;
    const x =
      reactionContextEntities.reduce((sum, reactant) => sum + reactant.x, 0) /
      reactionContextEntities.length;
    const y = Math.max(...reactionContextEntities.map((reactant) => reactant.y));
    return {
      left: pan.x + x * scale,
      top: pan.y + (y + 125) * scale + 104,
    };
  }, [pan.x, pan.y, reactionContextEntities, scale]);

  const selectedReactantNames = reactionContextEntities
    .map((reactant) => reactant.name || reactant.formula)
    .join(" + ");

  useEffect(() => {
    if (!selectedReactantPairs.length || preparedReaction) return;
    const key = selectedReactantPairs
      .map((pair) =>
        [pair.first.cid ?? pair.first.formula, pair.second.cid ?? pair.second.formula]
          .map(String)
          .sort()
          .join("|"),
      )
      .join(",");
    setReactionCandidate((current) =>
      current?.key === key ? current : { key, pairs: selectedReactantPairs },
    );
  }, [selectedReactantPairs, preparedReaction]);

  useEffect(() => {
    if (!reactionCandidate || preparedReaction) return;
    const selectedIds = new Set(selected);
    const originalReactantIds = new Set(
      reactionCandidate.pairs.flatMap((pair) => [...pair.first.atomIds, ...pair.second.atomIds]),
    );
    if ([...originalReactantIds].every((atomId) => selectedIds.has(atomId))) return;
    reactionPairRef.current = null;
    setReactionCandidate(null);
    setReactionChoices([]);
    setReactionSearching(false);
    setReactionSearchEmpty(false);
  }, [preparedReaction, reactionCandidate, selected]);

  const reactionSourceAtomIds = new Set(preparedReaction?.atomIds ?? []);

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
        const knownProducts = [
          ...new Set(routes.flatMap((route) => route.products.map((product) => product.formula))),
        ];
        if (!current) return;
        const aiRoutes = await discoverAIAssistedReactions(pair.first, pair.second, knownProducts);
        if (!current) return;
        const merged = mergeReactionRoutes([...aiRoutes, ...routes]);
        if (merged.length) {
          reactionPairRef.current = pair;
          setReactionChoices(merged);
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
      const isIonicSpecies =
        members.some((atom) => atom.charge !== 0) ||
        bonds.some(
          (bond) => bond.type === "ionic" && (memberIds.has(bond.from) || memberIds.has(bond.to)),
        ) ||
        formulaGroups.some(
          (group) =>
            group.atomIds.some((atomId) => memberIds.has(atomId)) &&
            group.atomIds.some((atomId) => !memberIds.has(atomId)),
        );
      if (isIonicSpecies) return [];
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
  }, [atomById, atoms, bonds, formulaGroups]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
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

  function copySelection() {
    const selectedIds = new Set(selected);
    if (!selectedIds.size) return false;
    const copiedAtoms = atomsRef.current.filter((atom) => selectedIds.has(atom.id));
    if (!copiedAtoms.length) return false;
    const copiedGroups = formulaGroupsRef.current.filter(
      (group) =>
        group.atomIds.length > 0 && group.atomIds.every((atomId) => selectedIds.has(atomId)),
    );
    canvasClipboard.current = structuredClone({
      atoms: copiedAtoms,
      bonds: bondsRef.current.filter(
        (bond) => selectedIds.has(bond.from) && selectedIds.has(bond.to),
      ),
      formulaGroups: copiedGroups,
      compressedGroupIds: copiedGroups
        .filter((group) => compressedGroupsRef.current.has(group.id))
        .map((group) => group.id),
    });
    pasteCount.current = 0;
    return true;
  }

  function pasteSelection() {
    const copied = canvasClipboard.current;
    if (!copied?.atoms.length) return;
    flushPendingHistory();
    pasteCount.current += 1;
    const offset = pasteCount.current * 150;
    const atomIdMap = new Map<number, number>();
    const pastedAtoms = copied.atoms.map((atom) => {
      const id = nextId.current++;
      atomIdMap.set(atom.id, id);
      return { ...atom, id, x: atom.x + offset, y: atom.y + offset };
    });
    let nextBondId = Math.max(0, ...bondsRef.current.map((bond) => bond.id)) + 1;
    const pastedBonds = copied.bonds.map((bond) => ({
      ...bond,
      id: nextBondId++,
      from: atomIdMap.get(bond.from)!,
      to: atomIdMap.get(bond.to)!,
    }));
    let nextGroupId = Math.max(0, ...formulaGroupsRef.current.map((group) => group.id)) + 1;
    const groupIdMap = new Map<number, number>();
    const pastedGroups = copied.formulaGroups.map((group) => {
      const id = nextGroupId++;
      groupIdMap.set(group.id, id);
      return {
        ...group,
        id,
        atomIds: group.atomIds.map((atomId) => atomIdMap.get(atomId)!),
        source: "pasted copy",
      };
    });
    atomsRef.current = [...atomsRef.current, ...pastedAtoms];
    bondsRef.current = [...bondsRef.current, ...pastedBonds];
    formulaGroupsRef.current = [...formulaGroupsRef.current, ...pastedGroups];
    const nextCompressed = new Set(compressedGroupsRef.current);
    copied.compressedGroupIds.forEach((groupId) => {
      const pastedGroupId = groupIdMap.get(groupId);
      if (pastedGroupId !== undefined) nextCompressed.add(pastedGroupId);
    });
    compressedGroupsRef.current = nextCompressed;
    setAtoms(atomsRef.current);
    setBonds(bondsRef.current);
    setFormulaGroups(formulaGroupsRef.current);
    setCompressedGroups(nextCompressed);
    setSelected(pastedAtoms.map((atom) => atom.id));
    setSelectedMolecule(pastedGroups.length === 1 ? pastedGroups[0].id : null);
    setSelectedBond(null);
    setSelectedElectron(null);
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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && !isField) {
        if (copySelection()) event.preventDefault();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v" && !isField) {
        if (canvasClipboard.current) {
          event.preventDefault();
          pasteSelection();
        }
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
    reactionPairRef.current = null;
    setPreparedReaction(null);
    setReactionCandidate(null);
    setReactionChoices([]);
    setReactionSearching(false);
    setReactionSearchEmpty(false);
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
    const liveAtomIds = new Set(atomsRef.current.map((atom) => atom.id));
    if (entities.some((entity) => entity.atomIds.some((atomId) => !liveAtomIds.has(atomId)))) {
      reactionPairRef.current = null;
      setReactionCandidate(null);
      setReactionChoices([]);
      setReactionSearching(false);
      setReactionSearchEmpty(false);
      return;
    }
    const originalAtomIds = entities.flatMap((entity) => entity.atomIds);
    const spawnedAtomIds: number[] = [];
    let copyIndex = 1;
    recipe.reactants.forEach((reactant, index) => {
      for (let copy = 1; copy < reactant.coefficient; copy++)
        spawnedAtomIds.push(...cloneEntity(entities[index], copyIndex++));
    });
    const atomIds = [...originalAtomIds, ...spawnedAtomIds];
    const center = {
      x: (reactionPair.first.x + reactionPair.second.x) / 2,
      y: (reactionPair.first.y + reactionPair.second.y) / 2,
    };
    const prepared = {
      key: reactionEquation(recipe),
      recipe,
      atomIds,
      originalAtomIds,
      spawnedAtomIds,
      center,
    };
    setPreparedReaction(prepared);
    setSelected(atomIds);
    return prepared;
  }

  function cancelPreparedReaction() {
    if (!preparedReaction) return;
    const removed = new Set(preparedReaction.spawnedAtomIds);
    if (removed.size) {
      const remainingBonds = bondsRef.current.filter(
        (bond) => !removed.has(bond.from) && !removed.has(bond.to),
      );
      const remainingAtoms = applyIonicCharges(
        atomsRef.current.filter((atom) => !removed.has(atom.id)),
        remainingBonds,
      );
      bondsRef.current = remainingBonds;
      atomsRef.current = remainingAtoms;
      formulaGroupsRef.current = formulaGroupsRef.current.filter(
        (group) => !group.atomIds.some((atomId) => removed.has(atomId)),
      );
      setAtoms(remainingAtoms);
      setBonds(remainingBonds);
      setFormulaGroups(formulaGroupsRef.current);
    }
    setPreparedReaction(null);
    setSelected(preparedReaction.originalAtomIds);
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
    if (!formulaGroupsRef.current.some((group) => group.id === groupId)) {
      const recognized = namedCompounds.find(
        (compound) => -Math.min(...compound.atomIds) === groupId,
      );
      if (!recognized) return;
      const group: FormulaGroup = {
        id: groupId,
        atomIds: recognized.atomIds,
        formula: recognized.formula,
        name: recognized.name,
        cid: recognized.cid,
        source: "canvas structure",
      };
      formulaGroupsRef.current = [...formulaGroupsRef.current, group];
      setFormulaGroups(formulaGroupsRef.current);
    }
    const next = new Set(compressedGroupsRef.current);
    if (next.has(groupId)) next.delete(groupId);
    else next.add(groupId);
    compressedGroupsRef.current = next;
    setCompressedGroups(next);
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
      const hydrohalideBonds = createdBonds.filter((bond) => {
        const from = atomById.get(bond.from),
          to = atomById.get(bond.to);
        return (
          bond.type === "covalent" &&
          ((from?.element === "H" && ["F", "Cl", "Br", "I"].includes(to?.element ?? "")) ||
            (to?.element === "H" && ["F", "Cl", "Br", "I"].includes(from?.element ?? "")))
        );
      });
      for (const acidBond of hydrohalideBonds) {
        const first = atomById.get(acidBond.from)!,
          second = atomById.get(acidBond.to)!,
          hydrogen = first.element === "H" ? first : second,
          halide = hydrogen === first ? second : first;
        const candidates = created
          .filter(
            (atom) =>
              atom.id !== hydrogen.id &&
              atom.id !== halide.id &&
              ["N", "P", "O", "S"].includes(atom.element),
          )
          .map((atom) => {
            const attached = createdBonds.filter(
              (bond) => bond.from === atom.id || bond.to === atom.id,
            );
            const bondOrder = attached.reduce((sum, bond) => sum + bond.order, 0);
            const acylAttached = attached.some((bond) => {
              const neighborId = bond.from === atom.id ? bond.to : bond.from;
              const neighbor = atomById.get(neighborId);
              return (
                neighbor?.element === "C" &&
                createdBonds.some(
                  (candidate) =>
                    candidate.order === 2 &&
                    (candidate.from === neighborId || candidate.to === neighborId) &&
                    atomById.get(candidate.from === neighborId ? candidate.to : candidate.from)
                      ?.element === "O",
                )
              );
            });
            const capacity = atom.element === "N" || atom.element === "P" ? 3 : 2;
            return {
              atom,
              attached,
              score:
                (({ N: 100, P: 80, O: 60, S: 50 } as Record<string, number>)[atom.element] ?? 0) -
                bondOrder * 3 -
                Number(acylAttached) * 60,
              available: bondOrder <= capacity,
            };
          })
          .filter((candidate) => candidate.available)
          .sort((first, second) => second.score - first.score);
        const acceptor = candidates[0];
        if (!acceptor) continue;
        const { atom: acceptorAtom } = acceptor;
        const neighbors = acceptor.attached
          .map((bond) => atomById.get(bond.from === acceptorAtom.id ? bond.to : bond.from))
          .filter((atom): atom is AtomNode => Boolean(atom));
        const neighborCenter = {
          x: neighbors.reduce((sum, atom) => sum + atom.x, 0) / Math.max(1, neighbors.length),
          y: neighbors.reduce((sum, atom) => sum + atom.y, 0) / Math.max(1, neighbors.length),
        };
        const directionLength =
          Math.hypot(acceptorAtom.x - neighborCenter.x, acceptorAtom.y - neighborCenter.y) || 1;
        hydrogen.x = acceptorAtom.x + ((acceptorAtom.x - neighborCenter.x) / directionLength) * 185;
        hydrogen.y = acceptorAtom.y + ((acceptorAtom.y - neighborCenter.y) / directionLength) * 185;
        createdBonds.splice(createdBonds.indexOf(acidBond), 1);
        const nextBondId = Math.max(0, ...createdBonds.map((bond) => bond.id)) + 1;
        createdBonds.push(
          {
            id: nextBondId,
            from: acceptorAtom.id,
            to: hydrogen.id,
            type: "covalent",
            order: 1,
          },
          {
            id: nextBondId + 1,
            from: acceptorAtom.id,
            to: halide.id,
            type: "ionic",
            order: 1,
          },
        );
      }
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
      valenceFilters.size === 0 || valenceFilters.has(elements[symbol].valence);
    const en = pauling(symbol);
    const character =
      en === 0
        ? null
        : en >= 2.5
          ? "electronegative"
          : en > 1.5
            ? "intermediate"
            : "electropositive";
    const characterMatches =
      characterFilters.size === 0 || (character !== null && characterFilters.has(character));
    return valenceMatches && characterMatches;
  }

  function toggleValenceFilter(value: number) {
    setValenceFilters((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  function toggleCharacterFilter(value: string) {
    setCharacterFilters((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
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
    const pendingIonicTransfers: Array<{ id: number; from: AtomNode; to: AtomNode }> = [];
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
      const bondId = now + index;
      nextBonds.push({ id: bondId, from: id, to: atom.id, ...candidate });
      if (candidate.type === "ionic") {
        const donor = metals.has(moved.element) ? moved : atom;
        const receiver = donor === moved ? atom : moved;
        pendingIonicTransfers.push({ id: bondId, from: donor, to: receiver });
      }
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
      pruneDisconnectedFormulaGroups(nextBonds);
      if (pendingIonicTransfers.length) {
        setIonicElectronTransfers(pendingIonicTransfers);
        window.setTimeout(() => setIonicElectronTransfers([]), 900);
      }
      return true;
    } catch {
      return false;
    }
  }

  function pruneDisconnectedFormulaGroups(bondList: BondEdge[]) {
    const connectedGroups = formulaGroupsRef.current.filter((group) => {
      if (group.atomIds.length <= 1) return true;
      const memberIds = new Set(group.atomIds);
      const adjacency = new Map<number, number[]>();
      bondList.forEach((bond) => {
        if (!memberIds.has(bond.from) || !memberIds.has(bond.to)) return;
        adjacency.set(bond.from, [...(adjacency.get(bond.from) ?? []), bond.to]);
        adjacency.set(bond.to, [...(adjacency.get(bond.to) ?? []), bond.from]);
      });
      const visited = new Set<number>();
      const stack = [group.atomIds[0]];
      while (stack.length) {
        const atomId = stack.pop()!;
        if (visited.has(atomId)) continue;
        visited.add(atomId);
        (adjacency.get(atomId) ?? []).forEach((neighbor) => stack.push(neighbor));
      }
      return visited.size === group.atomIds.length;
    });
    if (connectedGroups.length === formulaGroupsRef.current.length) return;
    formulaGroupsRef.current = connectedGroups;
    setFormulaGroups(connectedGroups);
    setSelectedMolecule(null);
  }

  function removeBond(id: number) {
    const nextBonds = bondsRef.current.filter((bond) => bond.id !== id);
    const charged = applyIonicCharges(atomsRef.current, nextBonds);
    bondsRef.current = nextBonds;
    atomsRef.current = charged;
    setBonds(nextBonds);
    setAtoms(charged);
    pruneDisconnectedFormulaGroups(nextBonds);
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
                title="Add molecule · Ctrl + Space"
                onClick={() => {
                  setFormulaOpen(true);
                  setFormulaError("");
                  setFormulaCandidates([]);
                }}
              >
                <MagnifyingGlass /> Add molecule
              </button>
              <button
                type="button"
                className="save-canvas toolbar-action"
                aria-keyshortcuts="Control+Shift+S"
                title="Save canvas · Ctrl + Shift + S"
                onClick={() => setSaveDialogOpen(true)}
              >
                <FloppyDisk /> Save
              </button>
            </div>
            {(reactionSearching || reactionSearchEmpty) && (
              <output className="reaction-status" aria-live="polite">
                {reactionSearching && <i aria-hidden="true" />}
                {reactionSearching ? "Checking reactions" : "No reported reaction"}
              </output>
            )}
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
            {validationNoticePresence.mounted && (
              <output
                className={`validation-notice${
                  validationNoticePresence.closing ? " is-closing" : ""
                }`}
              >
                {lastValidationNotice.current}
              </output>
            )}
            {canvasNavigationHint && (
              <output className="canvas-navigation-toast" aria-live="polite">
                <b>Selection started</b>
                <span>Middle-drag to pan the canvas. Scroll to zoom at the pointer.</span>
              </output>
            )}
            <output className="zoom-percentage" aria-label="Canvas zoom">
              {Math.round(scale * 100)}%
            </output>
            {(preparedReaction || reactionChoices.length > 0) && (
              <div
                className="reaction-prompt"
                style={reactionMenuPosition}
                onPointerDown={(event) => event.stopPropagation()}
              >
                {!preparedReaction && (
                  <header>
                    <small>Possible reactions</small>
                    <strong>Choose a reaction for {selectedReactantNames}.</strong>
                  </header>
                )}
                <div className="reaction-options">
                  {(preparedReaction ? [preparedReaction.recipe] : reactionChoices).map(
                    (recipe) => (
                      <article key={reactionRouteKey(recipe)}>
                        <span>
                          <b>{reactionEquation(recipe)}</b>
                          <em>{recipe.name}</em>
                          <small>{recipe.condition}</small>
                        </span>
                        <div className="reaction-actions">
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
                          {preparedReaction && (
                            <button
                              type="button"
                              className="reaction-cancel"
                              onClick={cancelPreparedReaction}
                            >
                              Cancel
                            </button>
                          )}
                        </div>
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
                {ionicElectronTransfers.map((transfer) => (
                  <circle
                    className="ionic-electron-transfer"
                    key={transfer.id}
                    cx={transfer.from.x * scale}
                    cy={transfer.from.y * scale}
                    r={4 * scale}
                  >
                    <animate
                      attributeName="cx"
                      from={transfer.from.x * scale}
                      to={transfer.to.x * scale}
                      dur="700ms"
                      fill="freeze"
                    />
                    <animate
                      attributeName="cy"
                      from={transfer.from.y * scale}
                      to={transfer.to.y * scale}
                      dur="700ms"
                      fill="freeze"
                    />
                    <animate attributeName="opacity" values="0;1;1;0" dur="850ms" fill="freeze" />
                  </circle>
                ))}
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
                .filter(
                  (compound) =>
                    !compound.atomIds.some((id) => compressedAtomIds.has(id)) &&
                    !formulaGroups.some(
                      (group) =>
                        group.atomIds.length === compound.atomIds.length &&
                        group.atomIds.every((id) => compound.atomIds.includes(id)),
                    ),
                )
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
              {isolatedElementEntities.map((entity) => (
                <button
                  type="button"
                  className="compound-label element-molecule"
                  key={`element-molecule-${entity.atomIds[0]}`}
                  style={{
                    transform: `translate(${entity.x * scale}px, ${(entity.y + 125) * scale}px)`,
                  }}
                  onPointerDown={(event) => beginCompoundDrag(event, entity.id, entity.atomIds)}
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
                    selectCompound(entity.id, entity.atomIds, event.shiftKey);
                  }}
                >
                  <b>{entity.formula}</b>
                  <span>{entity.name}</span>
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
                      className={`compressed-compound${selectedMolecule === group.id ? " selected" : ""}${
                        group.atomIds.some(
                          (atomId) =>
                            reactionSourceAtomIds.has(atomId) && !selectedAtomIds.has(atomId),
                        )
                          ? " reaction-source"
                          : ""
                      }`}
                      key={`compressed-${group.id}`}
                      style={{
                        transform: `translate(${x * scale}px,${y * scale}px) translate(-50%,-50%) scale(${scale})`,
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
                      className={`canvas-atom ${isSelected ? "selected" : ""}${
                        reactionSourceAtomIds.has(atom.id) && !isSelected ? " reaction-source" : ""
                      }`}
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
                          style={{ transform: `scale(${scale})` }}
                        >
                          {atom.charge > 0 ? `+${atom.charge}` : atom.charge}
                        </span>
                      )}
                    </div>
                  );
                })}
              {active && activeElement && selected.length === 1 && bondSummary.length === 0 && (
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
                  <h1>Periodic table</h1>
                </div>
                <div className="periodic-filters">
                  <div className="periodic-filter-group" aria-label="Filter by valence electrons">
                    <span>Valence</span>
                    {Array.from({ length: 8 }, (_, index) => index + 1).map((value) => (
                      <button
                        type="button"
                        key={value}
                        className={valenceFilters.has(value) ? "selected" : ""}
                        aria-pressed={valenceFilters.has(value)}
                        onClick={() => toggleValenceFilter(value)}
                        onPointerUp={(event) => event.currentTarget.blur()}
                      >
                        {value}e⁻
                      </button>
                    ))}
                  </div>
                  <div className="periodic-filter-group" aria-label="Filter by character">
                    <span>Character</span>
                    {[
                      ["electropositive", "Electropositive"],
                      ["intermediate", "Intermediate"],
                      ["electronegative", "Electronegative"],
                    ].map(([value, label]) => (
                      <button
                        type="button"
                        key={value}
                        className={characterFilters.has(value) ? "selected" : ""}
                        aria-pressed={characterFilters.has(value)}
                        onClick={() => toggleCharacterFilter(value)}
                        onPointerUp={(event) => event.currentTarget.blur()}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
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
                      matches = periodicMatch(symbol),
                      filtering = valenceFilters.size > 0 || characterFilters.size > 0;
                    return (
                      <button
                        type="button"
                        key={symbol}
                        className={matches ? (filtering ? "matching" : "") : "filtered"}
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
                      matches = periodicMatch(symbol),
                      filtering = valenceFilters.size > 0 || characterFilters.size > 0;
                    return (
                      <button
                        type="button"
                        key={symbol}
                        className={
                          matches ? `f-block${filtering ? " matching" : ""}` : "f-block filtered"
                        }
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
                  <input
                    autoFocus
                    aria-label="PubChem structure name or formula"
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
                {formulaError && formulaCandidates.length === 0 && <output>{formulaError}</output>}
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
        <h2>Canvas interaction</h2>
        <p>
          Drag anywhere in the outlined molecular area to move every atom and bond together.
          Individual atoms and bonds remain selectable.
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

function usableReactionProduct(record: StructureRecord) {
  if (connectedStructure(record)) return true;
  const symbols = record.atoms.map((atom) => allSymbols[atom.atomicNumber - 1]);
  return symbols.some((first, firstIndex) =>
    symbols.some(
      (second, secondIndex) => secondIndex > firstIndex && metals.has(first) !== metals.has(second),
    ),
  );
}

function greatestCommonDivisor(first: number, second: number): number {
  return second ? greatestCommonDivisor(second, first % second) : Math.abs(first);
}

function leastCommonMultiple(first: number, second: number) {
  return Math.abs(first * second) / greatestCommonDivisor(first, second);
}

function approximateFraction(value: number) {
  for (let denominator = 1; denominator <= 120; denominator++) {
    const numerator = Math.round(value * denominator);
    if (Math.abs(value - numerator / denominator) < 1e-9) return { numerator, denominator };
  }
  return null;
}

function balanceFormulas(
  reactants: string[],
  products: string[],
  reactantCharges = reactants.map(() => 0),
  productCharges = products.map(() => 0),
) {
  const formulas = [...reactants, ...products];
  if (formulas.length < 3 || products.length > 3) return null;
  const counts = formulas.map(formulaCounts);
  const symbols = [...new Set(counts.flatMap((part) => Object.keys(part)))];
  const charges = [...reactantCharges, ...productCharges];
  const dimensions = [
    ...symbols.map((symbol) => counts.map((part) => part[symbol] ?? 0)),
    ...(charges.some(Boolean) ? [charges] : []),
  ];
  const matrix = dimensions.map((dimension) =>
    dimension.map((count, index) => count * (index < reactants.length ? 1 : -1)),
  );
  const pivotColumns: number[] = [];
  let pivotRow = 0;
  for (let column = 0; column < formulas.length && pivotRow < matrix.length; column++) {
    const swapRow = matrix.findIndex(
      (row, rowIndex) => rowIndex >= pivotRow && Math.abs(row[column]) > 1e-10,
    );
    if (swapRow < 0) continue;
    [matrix[pivotRow], matrix[swapRow]] = [matrix[swapRow], matrix[pivotRow]];
    const pivot = matrix[pivotRow][column];
    matrix[pivotRow] = matrix[pivotRow].map((value) => value / pivot);
    matrix.forEach((row, rowIndex) => {
      if (rowIndex === pivotRow || Math.abs(row[column]) <= 1e-10) return;
      const factor = row[column];
      matrix[rowIndex] = row.map((value, index) => value - factor * matrix[pivotRow][index]);
    });
    pivotColumns.push(column);
    pivotRow++;
  }
  const pivotColumnSet = new Set(pivotColumns);
  const freeColumns = formulas
    .map((_, index) => index)
    .filter((column) => !pivotColumnSet.has(column));
  if (freeColumns.length !== 1) return null;
  const coefficients = Array<number>(formulas.length).fill(0);
  coefficients[freeColumns[0]] = 1;
  for (let row = pivotColumns.length - 1; row >= 0; row--) {
    const column = pivotColumns[row];
    coefficients[column] = -matrix[row].reduce(
      (sum, value, index) => sum + (index === column ? 0 : value * coefficients[index]),
      0,
    );
  }
  if (coefficients.every((coefficient) => coefficient < -1e-10)) {
    coefficients.forEach((coefficient, index) => {
      coefficients[index] = -coefficient;
    });
  }
  if (coefficients.some((coefficient) => coefficient <= 1e-10)) return null;
  const fractions = coefficients.map(approximateFraction);
  if (fractions.some((fraction) => !fraction)) return null;
  const commonDenominator = fractions.reduce(
    (multiple, fraction) => leastCommonMultiple(multiple, fraction!.denominator),
    1,
  );
  const integers = fractions.map(
    (fraction) => fraction!.numerator * (commonDenominator / fraction!.denominator),
  );
  const commonDivisor = integers.reduce(greatestCommonDivisor);
  const normalized = integers.map((coefficient) => coefficient / commonDivisor);
  return {
    reactants: normalized.slice(0, reactants.length),
    products: normalized.slice(reactants.length),
  };
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

async function discoverReactionChoices(first: MoleculeEntity, second: MoleculeEntity) {
  const resolve = async (entity: MoleculeEntity) => {
    const result = await lookupStructure(
      entity.cid ? String(entity.cid) : (entity.name ?? entity.formula),
    );
    return result.record;
  };
  const [firstRecord, secondRecord] = await Promise.all([resolve(first), resolve(second)]);
  if (!firstRecord?.inchiKey || !secondRecord?.inchiKey) return [];
  const reported = await lookupReportedReactions(
    [firstRecord.inchiKey, secondRecord.inchiKey],
    [first.formula, second.formula],
  );
  const routes: ReactionRecipe[] = [];
  const seenRoutes = new Set<string>();
  for (const record of reported) {
    const resolved = await mapWithConcurrency(record.products, 2, async (product) => {
      const result = await lookupStructure(
        product.smiles ? `smiles:${product.smiles}` : (product.query ?? product.formula ?? ""),
      );
      return result.record;
    });
    const products = resolved.filter((product): product is StructureRecord =>
      Boolean(product?.cid && usableReactionProduct(product)),
    );
    if (products.length !== record.products.length) continue;
    const balance = balanceFormulas(
      [first.formula, second.formula],
      products.map((product) => product.formula),
      [firstRecord.charge ?? 0, secondRecord.charge ?? 0],
      products.map((product) => product.charge ?? 0),
    );
    if (!balance) continue;
    const recipe: ReactionRecipe = {
      name: products.map((product) => product.name).join(" + "),
      condition:
        record.condition ??
        (record.source === "rhea"
          ? `Curated by Rhea (${record.sourceId}).`
          : `Reported by the Open Reaction Database (${record.sourceId}).`),
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
    const routeKey = reactionRouteKey(recipe);
    if (seenRoutes.has(routeKey)) continue;
    seenRoutes.add(routeKey);
    routes.push(recipe);
    if (routes.length === 8) return routes;
  }
  return routes;
}

async function queryAIReactions(
  first: MoleculeEntity,
  second: MoleculeEntity,
  knownProducts: string[],
): Promise<ReactionRecipe[]> {
  if (aiReactionApiAvailable === false) return [];
  try {
    const response = await fetch(aiReactionEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reactants: [
          { formula: first.formula, name: first.name },
          { formula: second.formula, name: second.name },
        ],
        products: [...new Set(knownProducts)].map((formula) => ({ formula })),
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (response.status >= 400) {
      aiReactionApiAvailable = false;
      return [];
    }
    if (!response.ok) return [];
    const payload = (await response.json()) as {
      source?: string;
      model?: string;
      reactions?: Array<{
        name?: string;
        condition?: string;
        reactants: Array<{ formula: string; coefficient?: number }>;
        products: Array<{ formula: string; coefficient?: number }>;
      }>;
    };
    const routes: ReactionRecipe[] = [];
    for (const candidate of payload.reactions ?? []) {
      if (!Array.isArray(candidate.reactants) || !Array.isArray(candidate.products)) continue;
      if (!candidate.reactants.length || !candidate.products.length) continue;
      const reactantFormulas = candidate.reactants.map((reactant) => reactant.formula);
      const productFormulas = candidate.products.map((product) => product.formula);
      if (productFormulas.length > 3) continue;
      const products: ReactionRecipe["products"] = [];
      let resolvable = true;
      for (const formula of productFormulas) {
        const resolved = await lookupStructure(formula);
        if (!resolved.record?.cid || !usableReactionProduct(resolved.record)) {
          resolvable = false;
          break;
        }
        products.push({ formula, coefficient: 1, cid: resolved.record.cid });
      }
      if (!resolvable) continue;
      const balance = balanceFormulas(reactantFormulas, productFormulas);
      if (!balance) continue;
      routes.push({
        name: candidate.name ?? productFormulas.join(" + "),
        condition:
          candidate.condition ?? `AI prediction${payload.model ? ` (${payload.model})` : ""}`,
        reactants: balance.reactants.map((coefficient, index) => ({
          formula: reactantFormulas[index],
          coefficient,
        })),
        products: products.map((product, index) => ({
          ...product,
          coefficient: balance.products[index],
        })),
      });
    }
    return routes;
  } catch {
    return [];
  }
}

async function discoverAIAssistedReactions(
  first: MoleculeEntity,
  second: MoleculeEntity,
  knownProducts: string[],
) {
  const key = [first.cid ?? first.formula, second.cid ?? second.formula]
    .map(String)
    .sort()
    .join("|");
  let pending = aiReactionCache.get(key);
  if (!pending) {
    pending = queryAIReactions(first, second, knownProducts);
    aiReactionCache.set(key, pending);
  }
  const routes = await pending;
  if (!routes.length) aiReactionCache.delete(key);
  return routes;
}

function mergeReactionRoutes(routes: ReactionRecipe[]) {
  const seen = new Set<string>();
  const merged: ReactionRecipe[] = [];
  for (const route of routes) {
    const routeKey = reactionRouteKey(route);
    if (seen.has(routeKey)) continue;
    seen.add(routeKey);
    merged.push(route);
    if (merged.length === 8) break;
  }
  return merged;
}

function reactionEquation(recipe: ReactionRecipe) {
  const side = (items: ReactionRecipe["reactants"]) =>
    items
      .map((item) => `${item.coefficient > 1 ? item.coefficient : ""}${item.formula}`)
      .join(" + ");
  return `${side(recipe.reactants)} → ${side(recipe.products)}`;
}

function reactionRouteKey(recipe: ReactionRecipe) {
  return recipe.products
    .map((product) => `${product.cid}:${product.coefficient}`)
    .sort()
    .join("|");
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
    </>
  );
}
