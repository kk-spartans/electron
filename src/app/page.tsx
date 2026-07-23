"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowCounterClockwise,
  Atom,
  MagnifyingGlass,
  Trash,
  X,
} from "@phosphor-icons/react";
import AtomScene, { Subshell, subshellColors } from "@/components/AtomScene";
import periodicTable from "@exabyte-io/periodic-table.js/periodic-table.json";

type ElementKey = string;
type AtomNode = { id: number; element: ElementKey; x: number; y: number; charge: number; electronOffset: number };
type BondType = "covalent" | "ionic" | "metallic";
type BondEdge = { id: number; from: number; to: number; type: BondType; order: 1 | 2 | 3 };
type FormulaGroup = { id: number; atomIds: number[]; formula: string; name?: string; source?: string; cid?: number };
type StructureRecord = { cid?:number;name:string;formula:string;source:string;atoms:Array<{aid:number;atomicNumber:number;x:number;y:number}>;bonds:Array<{from:number;to:number;order:number}> };
type StructureCandidate={cid:number;name:string;formula:string};

type ElementData = {
  name: string; z: number; shells: number[]; config: string; valence: number;
  subshells: Subshell[]; note: string;
};

const coreElements: Record<string, ElementData> = {
  H: { name: "Hydrogen", z: 1, shells: [1], config: "1s¹", valence: 1, subshells: [{ label: "1s", count: 1, shell: 1, kind: "s" }], note: "One 1s electron can be shared or transferred." },
  C: { name: "Carbon", z: 6, shells: [2, 4], config: "1s² 2s² 2p²", valence: 4, subshells: [{ label: "1s", count: 2, shell: 1, kind: "s" }, { label: "2s", count: 2, shell: 2, kind: "s" }, { label: "2p", count: 2, shell: 2, kind: "p" }], note: "Four valence electrons let carbon form varied covalent structures." },
  N: { name: "Nitrogen", z: 7, shells: [2, 5], config: "1s² 2s² 2p³", valence: 5, subshells: [{ label: "1s", count: 2, shell: 1, kind: "s" }, { label: "2s", count: 2, shell: 2, kind: "s" }, { label: "2p", count: 3, shell: 2, kind: "p" }], note: "Three unpaired 2p electrons commonly produce three covalent bonds." },
  O: { name: "Oxygen", z: 8, shells: [2, 6], config: "1s² 2s² 2p⁴", valence: 6, subshells: [{ label: "1s", count: 2, shell: 1, kind: "s" }, { label: "2s", count: 2, shell: 2, kind: "s" }, { label: "2p", count: 4, shell: 2, kind: "p" }], note: "Two vacancies in the valence shell favor two covalent bonds." },
  Na: { name: "Sodium", z: 11, shells: [2, 8, 1], config: "[Ne] 3s¹", valence: 1, subshells: [{ label: "1s", count: 2, shell: 1, kind: "s" }, { label: "2s", count: 2, shell: 2, kind: "s" }, { label: "2p", count: 6, shell: 2, kind: "p" }, { label: "3s", count: 1, shell: 3, kind: "s" }], note: "The lone 3s electron is readily transferred to form Na⁺." },
  Cl: { name: "Chlorine", z: 17, shells: [2, 8, 7], config: "[Ne] 3s² 3p⁵", valence: 7, subshells: [{ label: "1s", count: 2, shell: 1, kind: "s" }, { label: "2s", count: 2, shell: 2, kind: "s" }, { label: "2p", count: 6, shell: 2, kind: "p" }, { label: "3s", count: 2, shell: 3, kind: "s" }, { label: "3p", count: 5, shell: 3, kind: "p" }], note: "One 3p vacancy makes electron gain or one shared pair favorable." },
  Fe: { name: "Iron", z: 26, shells: [2, 8, 14, 2], config: "[Ar] 3d⁶ 4s²", valence: 2, subshells: [{ label: "1s", count: 2, shell: 1, kind: "s" }, { label: "2s", count: 2, shell: 2, kind: "s" }, { label: "2p", count: 6, shell: 2, kind: "p" }, { label: "3s", count: 2, shell: 3, kind: "s" }, { label: "3p", count: 6, shell: 3, kind: "p" }, { label: "3d", count: 6, shell: 3, kind: "d" }, { label: "4s", count: 2, shell: 4, kind: "s" }], note: "4s electrons are typically removed before 3d electrons in iron ions." },
};

const allSymbols = "H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og".split(" ");
const filling: Array<[string, number, number, "s" | "p" | "d" | "f"]> = [
  ["1s",1,2,"s"],["2s",2,2,"s"],["2p",2,6,"p"],["3s",3,2,"s"],["3p",3,6,"p"],["4s",4,2,"s"],["3d",3,10,"d"],["4p",4,6,"p"],["5s",5,2,"s"],["4d",4,10,"d"],["5p",5,6,"p"],["6s",6,2,"s"],["4f",4,14,"f"],["5d",5,10,"d"],["6p",6,6,"p"],["7s",7,2,"s"],["5f",5,14,"f"],["6d",6,10,"d"],["7p",7,6,"p"],
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
  const shells = Array.from({ length: highest }, (_, index) => subshells.filter((item) => item.shell === index + 1).reduce((sum, item) => sum + item.count, 0));
  const valence = shells.at(-1) ?? 0;
  const reference = (periodicTable as Record<string, { name: string; electronic_configuration: string }>)[symbol];
  return { name: reference.name, z, shells, valence, subshells, config: reference.electronic_configuration, note: reference.name + " is shown using its ground-state filling order. Bonding behavior depends on its outer electrons." };
}
const elements: Record<string, ElementData> = Object.fromEntries(allSymbols.map((symbol, index) => [symbol, coreElements[symbol] ?? generatedElement(symbol, index + 1)]));
const metals = new Set("Li Be Na Mg Al K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv".split(" "));
const nobleGases = new Set(["He","Ne","Ar","Kr","Xe","Rn","Og"]);

function ionicDonationLimit(symbol: string) {
  if (["Li","Na","K","Rb","Cs","Fr"].includes(symbol)) return 1;
  if (["Be","Mg","Ca","Sr","Ba","Ra"].includes(symbol)) return 2;
  if (["Al","Ga","In"].includes(symbol)) return 3;
  return Math.max(1, Math.min(4, elements[symbol]?.valence ?? 2));
}

function ionicAcceptanceLimit(symbol: string) {
  if (["F","Cl","Br","I","At","Ts"].includes(symbol)) return 1;
  if (["O","S","Se","Te","Po"].includes(symbol)) return 2;
  if (["N","P","As","Sb"].includes(symbol)) return 3;
  return Math.max(1, Math.min(4, 8 - (elements[symbol]?.valence ?? 4)));
}

function applyIonicCharges(atomList: AtomNode[], bondList: BondEdge[]) {
  const charges = new Map(atomList.map((atom) => [atom.id, 0]));
  bondList.filter((bond) => bond.type === "ionic").forEach((bond) => {
    const from = atomList.find((atom) => atom.id === bond.from), to = atomList.find((atom) => atom.id === bond.to);
    if (!from || !to || metals.has(from.element) === metals.has(to.element)) return;
    const donor = metals.has(from.element) ? from : to, receiver = donor === from ? to : from;
    charges.set(donor.id, (charges.get(donor.id) ?? 0) + bond.order);
    charges.set(receiver.id, (charges.get(receiver.id) ?? 0) - bond.order);
  });
  return atomList.map((atom) => ({ ...atom, charge: charges.get(atom.id) ?? 0 }));
}

function subshellsForElectronCount(count: number) {
  let remaining = Math.max(0, count);
  const result: Subshell[] = [];
  for (const [label, shell, capacity, kind] of filling) {
    if (!remaining) break;
    const occupied = Math.min(capacity, remaining);
    result.push({ label, shell, count: occupied, kind });
    remaining -= occupied;
  }
  return result;
}

const initialAtoms: AtomNode[] = [
  { id: 1, element: "Na", x: 220, y: 310, charge: 1, electronOffset: 0 },
  { id: 2, element: "Cl", x: 490, y: 310, charge: -1, electronOffset: 0 },
];

const compoundNames: Record<string, { formula: string; name: string; bondUnits: number }> = {
  ClNa: { formula: "NaCl", name: "sodium chloride", bondUnits: 1 }, CO2: { formula: "CO₂", name: "carbon dioxide", bondUnits: 4 },
  H2O: { formula: "H₂O", name: "water", bondUnits: 2 }, CH4: { formula: "CH₄", name: "methane", bondUnits: 4 },
  H3N: { formula: "NH₃", name: "ammonia", bondUnits: 3 }, ClH: { formula: "HCl", name: "hydrogen chloride", bondUnits: 1 },
  CO: { formula: "CO", name: "carbon monoxide", bondUnits: 3 }, O2: { formula: "O₂", name: "oxygen", bondUnits: 2 },
  N2: { formula: "N₂", name: "nitrogen", bondUnits: 3 }, H2: { formula: "H₂", name: "hydrogen", bondUnits: 1 },
  Cl2: { formula: "Cl₂", name: "chlorine", bondUnits: 1 }, C2H6: { formula: "C₂H₆", name: "ethane", bondUnits: 7 },
  C2H4: { formula: "C₂H₄", name: "ethene", bondUnits: 6 }, C2H2: { formula: "C₂H₂", name: "ethyne", bondUnits: 5 },
  H2O2: { formula: "H₂O₂", name: "hydrogen peroxide", bondUnits: 3 }, O3: { formula: "O₃", name: "ozone", bondUnits: 3 },
  O2S: { formula: "SO₂", name: "sulfur dioxide", bondUnits: 4 }, O3S: { formula: "SO₃", name: "sulfur trioxide", bondUnits: 6 },
  CaCl2: { formula: "CaCl₂", name: "calcium chloride", bondUnits: 2 }, Cl2Mg: { formula: "MgCl₂", name: "magnesium chloride", bondUnits: 2 },
  Fe2O3: { formula: "Fe₂O₃", name: "iron(III) oxide", bondUnits: 6 }, Na2O: { formula: "Na₂O", name: "sodium oxide", bondUnits: 2 },
  LiO2: { formula: "LiO₂", name: "lithium superoxide", bondUnits: 2 },
  C6H6: { formula: "C₆H₆", name: "benzene", bondUnits: 12 },
};

const periodicMain: Array<Array<[string,number]>> = [
  [["H",1],["He",18]],
  [["Li",1],["Be",2],["B",13],["C",14],["N",15],["O",16],["F",17],["Ne",18]],
  [["Na",1],["Mg",2],["Al",13],["Si",14],["P",15],["S",16],["Cl",17],["Ar",18]],
  "K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr".split(" ").map((symbol,index)=>[symbol,index+1] as [string,number]),
  "Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe".split(" ").map((symbol,index)=>[symbol,index+1] as [string,number]),
  [["Cs",1],["Ba",2],["La",3],["Hf",4],["Ta",5],["W",6],["Re",7],["Os",8],["Ir",9],["Pt",10],["Au",11],["Hg",12],["Tl",13],["Pb",14],["Bi",15],["Po",16],["At",17],["Rn",18]],
  [["Fr",1],["Ra",2],["Ac",3],["Rf",4],["Db",5],["Sg",6],["Bh",7],["Hs",8],["Mt",9],["Ds",10],["Rg",11],["Cn",12],["Nh",13],["Fl",14],["Mc",15],["Lv",16],["Ts",17],["Og",18]],
];
const periodicFBlock=["Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu".split(" "),"Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr".split(" ")];

export default function Home() {
  const [atoms, setAtoms] = useState<AtomNode[]>(initialAtoms);
  const [bonds, setBonds] = useState<BondEdge[]>([{ id: 1, from: 1, to: 2, type: "ionic", order: 1 }]);
  const [selected, setSelected] = useState<number[]>([1]);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const [elementQuery, setElementQuery] = useState("");
  const [selectedBond, setSelectedBond] = useState<number | null>(null);
  const [selectedElectron, setSelectedElectron] = useState<{ atomId: number; label: string; kind: "s"|"p"|"d"|"f"; shared: boolean; source?: string } | null>(null);
  const [formulaOpen,setFormulaOpen]=useState(false);
  const [formulaInput,setFormulaInput]=useState("");
  const [formulaError,setFormulaError]=useState("");
  const [formulaLoading,setFormulaLoading]=useState(false);
  const [formulaCandidates,setFormulaCandidates]=useState<StructureCandidate[]>([]);
  const [sidebarWidths,setSidebarWidths]=useState({left:196,right:292});
  const [periodicOpen,setPeriodicOpen]=useState(false);
  const [valenceFilter,setValenceFilter]=useState("all");
  const [characterFilter,setCharacterFilter]=useState("all");
  const [formulaGroups,setFormulaGroups]=useState<FormulaGroup[]>([]);
  const [selectedMolecule,setSelectedMolecule]=useState<number|null>(null);
  const [validationNotice,setValidationNotice]=useState("");
  const nextId = useRef(3);
  const validationSequence=useRef(0);
  const formulaSpawnCount=useRef(0);
  const canvasRef = useRef<HTMLElement>(null);
  const atomsRef=useRef(atoms);
  const bondsRef=useRef(bonds);
  const geometryAnimation=useRef<number|null>(null);
  const gesture = useRef<
    | { type:"pan"|"atom"; id?:number; sx:number; sy:number; ox:number; oy:number }
    | { type:"molecule"; groupId:number; sx:number; sy:number; origins:Map<number,{x:number;y:number}> }
    | null
  >(null);
  const resizing=useRef<{side:"left"|"right";startX:number;startWidth:number}|null>(null);
  const active = atoms.find((atom) => atom.id === selected[selected.length - 1]);
  const activeElement = active ? elements[active.element] : null;
  const activeSubshells = active && activeElement ? subshellsForElectronCount(activeElement.z - active.charge + active.electronOffset) : [];
  const activeBond = bonds.find((bond) => bond.id === selectedBond);
  const activeMolecule=formulaGroups.find((group)=>group.id===selectedMolecule);
  const selectedAtomIds=new Set(selected);
  const visibleElements = allSymbols.filter((symbol) => symbol.toLowerCase().includes(elementQuery.toLowerCase()) || elements[symbol].name.toLowerCase().includes(elementQuery.toLowerCase()));

  const bondSummary = useMemo(() => {
    if (!active) return [];
    return bonds.filter((bond) => bond.from === active.id || bond.to === active.id);
  }, [active, bonds]);

  const bondAngles=useMemo(()=>{
    if(!active)return[];
    const neighbors=bonds.flatMap((bond)=>bond.from===active.id?[bond.to]:bond.to===active.id?[bond.from]:[]).map((id)=>atoms.find((atom)=>atom.id===id)).filter((atom):atom is AtomNode=>Boolean(atom));
    if(neighbors.length<2)return[];
    const ordered=neighbors.map((atom)=>({atom,angle:Math.atan2(atom.y-active.y,atom.x-active.x)})).sort((a,b)=>a.angle-b.angle);
    const pairs=ordered.length===2?[[ordered[0],ordered[1]]]:ordered.map((item,index)=>[item,ordered[(index+1)%ordered.length]]);
    return pairs.map(([first,second])=>{let delta=second.angle-first.angle;if(delta<=0)delta+=Math.PI*2;return{start:first.angle,end:second.angle,angle:delta*180/Math.PI};});
  },[active,atoms,bonds]);

  useEffect(()=>{atomsRef.current=atoms;},[atoms]);
  useEffect(()=>{bondsRef.current=bonds;},[bonds]);

  const namedCompounds = useMemo(() => {
    const adjacency = new Map<number, number[]>();
    bonds.forEach((bond) => { adjacency.set(bond.from, [...(adjacency.get(bond.from) ?? []), bond.to]); adjacency.set(bond.to, [...(adjacency.get(bond.to) ?? []), bond.from]); });
    const visited = new Set<number>();
    return atoms.flatMap((start) => {
      if (visited.has(start.id) || !adjacency.has(start.id)) return [];
      const stack = [start.id], ids: number[] = [];
      while (stack.length) { const id = stack.pop()!; if (visited.has(id)) continue; visited.add(id); ids.push(id); (adjacency.get(id) ?? []).forEach((next) => stack.push(next)); }
      const members = ids.map((id) => atoms.find((atom) => atom.id === id)!).filter(Boolean);
      const counts = members.reduce<Record<string, number>>((result, atom) => ({ ...result, [atom.element]: (result[atom.element] ?? 0) + 1 }), {});
      const signature = Object.keys(counts).sort().map((symbol) => symbol + (counts[symbol] > 1 ? counts[symbol] : "")).join("");
      const known = compoundNames[signature];
      if (!known) return [];
      const memberIds = new Set(ids);
      const bondUnits = bonds.filter((bond) => memberIds.has(bond.from) && memberIds.has(bond.to)).reduce((total, bond) => total + bond.order, 0);
      if (bondUnits !== known.bondUnits) return [];
      return [{ ...known, x: members.reduce((sum, atom) => sum + atom.x, 0) / members.length, y: Math.max(...members.map((atom) => atom.y)) + 125 }];
    });
  }, [atoms, bonds]);

  const dipoleAttractions=useMemo(()=>{
    const covalent=bonds.filter((bond)=>bond.type==="covalent");
    const adjacency=new Map<number,number[]>();
    covalent.forEach((bond)=>{adjacency.set(bond.from,[...(adjacency.get(bond.from)??[]),bond.to]);adjacency.set(bond.to,[...(adjacency.get(bond.to)??[]),bond.from]);});
    const visited=new Set<number>();
    const polarComponents=atoms.flatMap((start)=>{
      if(visited.has(start.id)||!adjacency.has(start.id))return[];
      const stack=[start.id],members:AtomNode[]=[];
      while(stack.length){const id=stack.pop()!;if(visited.has(id))continue;visited.add(id);const atom=atoms.find((item)=>item.id===id);if(atom)members.push(atom);(adjacency.get(id)??[]).forEach((next)=>stack.push(next));}
      const memberIds=new Set(members.map((atom)=>atom.id));
      const componentBonds=covalent.filter((bond)=>memberIds.has(bond.from)&&memberIds.has(bond.to));
      const polar=componentBonds.some((bond)=>{const from=atoms.find((atom)=>atom.id===bond.from)!,to=atoms.find((atom)=>atom.id===bond.to)!;return Math.abs(pauling(from.element)-pauling(to.element))>=0.4;});
      const counts=members.reduce<Record<string,number>>((result,atom)=>({...result,[atom.element]:(result[atom.element]??0)+1}),{});
      const signature=Object.keys(counts).sort().map((symbol)=>symbol+(counts[symbol]>1?counts[symbol]:"")).join("");
      if(!polar||["CO2","CH4","O3S"].includes(signature))return[];
      const sorted=[...members].sort((a,b)=>pauling(a.element)-pauling(b.element));
      return[{positive:sorted[0],negative:sorted.at(-1)!,x:members.reduce((sum,atom)=>sum+atom.x,0)/members.length,y:members.reduce((sum,atom)=>sum+atom.y,0)/members.length}];
    });
    return polarComponents.flatMap((first,index)=>polarComponents.slice(index+1).flatMap((second,offset)=>{
      const centerDistance=Math.hypot(first.x-second.x,first.y-second.y);
      if(centerDistance>900)return[];
      const options=[{from:first.positive,to:second.negative},{from:second.positive,to:first.negative}].sort((a,b)=>Math.hypot(a.from.x-a.to.x,a.from.y-a.to.y)-Math.hypot(b.from.x-b.to.x,b.from.y-b.to.y));
      return[{id:`${index}-${index+offset+1}`,...options[0]}];
    }));
  },[atoms,bonds]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheel = (event:WheelEvent)=>{
      event.preventDefault();
      const box=canvas.getBoundingClientRect(),pointerX=event.clientX-box.left,pointerY=event.clientY-box.top;
      const nextScale=Math.min(2.5,Math.max(0.25,scale*Math.exp(-event.deltaY*0.0015)));
      if(nextScale===scale)return;
      const worldX=(pointerX-pan.x)/scale,worldY=(pointerY-pan.y)/scale;
      setPan({x:pointerX-worldX*nextScale,y:pointerY-worldY*nextScale});
      setScale(nextScale);
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [pan, scale]);

  useEffect(()=>{
    const handleKey=(event:KeyboardEvent)=>{
      const target=event.target as HTMLElement;
      const isField=target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement||target.isContentEditable;
      if(event.ctrlKey&&event.shiftKey&&event.key.toLowerCase()==="p"){event.preventDefault();setFormulaOpen(true);setFormulaError("");setFormulaCandidates([]);return;}
      if(event.key==="Escape"&&formulaOpen){setFormulaOpen(false);setFormulaInput("");setFormulaError("");setFormulaCandidates([]);return;}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="a"&&!isField){event.preventDefault();setSelected(atoms.map((atom)=>atom.id));setSelectedBond(null);setSelectedElectron(null);return;}
      if(event.key==="Delete"&&!isField&&(selected.length||activeMolecule)){event.preventDefault();deleteAtoms(activeMolecule?.atomIds??selected);}
    };
    window.addEventListener("keydown",handleKey);
    return()=>window.removeEventListener("keydown",handleKey);
  },[atoms,formulaOpen,selected,activeMolecule]);

  function addAtom(element: ElementKey, x?: number, y?: number) {
    const id = nextId.current++;
    const centerX = ((canvasRef.current?.clientWidth ?? 960) / 2 - pan.x) / scale;
    const centerY = ((canvasRef.current?.clientHeight ?? 620) / 2 - pan.y) / scale;
    setAtoms((items) => [...items, { id, element, x: x ?? centerX, y: y ?? centerY, charge: 0, electronOffset: 0 }]);
    setSelected([id]);
  }

  function selectAtom(id: number,additive=false) {
    setSelectedBond(null);
    setSelectedMolecule(null);
    setSelectedElectron((current)=>current?.atomId===id?current:null);
    setSelected((current)=>additive?(current.includes(id)?current.filter((item)=>item!==id):[...current,id]):[id]);
  }

  function deleteAtoms(ids:number[]){
    const removed=new Set(ids);
    const remainingBonds=bondsRef.current.filter((bond)=>!removed.has(bond.from)&&!removed.has(bond.to));
    const remainingAtoms=applyIonicCharges(atomsRef.current.filter((atom)=>!removed.has(atom.id)),remainingBonds);
    bondsRef.current=remainingBonds;atomsRef.current=remainingAtoms;
    setAtoms(remainingAtoms);
    setBonds(remainingBonds);
    setSelected([]);
    setSelectedMolecule(null);
    setSelectedElectron((current)=>current&&removed.has(current.atomId)?null:current);
    setFormulaGroups((groups)=>groups.filter((group)=>!group.atomIds.some((id)=>removed.has(id))));
  }

  async function spawnFormula(formula:string){
    const query=formula.normalize("NFKC").trim(),compact=query.replace(/\s+/g,""),queryTokens=[...compact.matchAll(/([A-Z][a-z]?)(\d*)/g)],isFormula=queryTokens.map((match)=>match[0]).join("")===compact&&queryTokens.every((match)=>match[1] in elements);
    if(!query){setFormulaError("Enter a formula, compound name, PubChem CID, or prefixed SMILES.");return;}
    if(isFormula){
      const matches=queryTokens;
      const symbols=matches.flatMap((match)=>{const symbol=match[1];const count=match[2]?Number(match[2]):1;if(!(symbol in elements)||!Number.isInteger(count)||count<1||count>120)return[];return Array.from({length:count},()=>symbol);});
      const expected=matches.reduce((sum,match)=>sum+(match[2]?Number(match[2]):1),0);
      if(symbols.length!==expected){setFormulaError("One of those element symbols or subscripts is not supported.");return;}
      if(symbols.length>120){setFormulaError(`This formula contains ${symbols.length} atoms; the canvas limit is 120.`);return;}
    }
    setFormulaError("");
    setFormulaCandidates([]);
    setFormulaLoading(true);
    try{
      const response=await fetch(`/api/structure?query=${encodeURIComponent(query)}`);
      if(!response.ok){const failure=await response.json() as {error?:string;candidates?:StructureCandidate[]};setFormulaError(failure.error??"The structure could not be loaded.");setFormulaCandidates(failure.candidates??[]);return;}
      const payload=await response.json() as StructureRecord&{error?:string};
      if(payload.error){setFormulaError(payload.error);return;}
      if(payload.atoms.length>120){setFormulaError(`This database structure contains ${payload.atoms.length} explicit atoms; the canvas limit is 120.`);return;}
      const spawnIndex=formulaSpawnCount.current++;
      const centerX=((canvasRef.current?.clientWidth??960)/2-pan.x)/scale+1650+(spawnIndex%3)*520,centerY=((canvasRef.current?.clientHeight??620)/2-pan.y)/scale+Math.floor(spawnIndex/3)*520;
      const sourceX=payload.atoms.map((atom)=>atom.x),sourceY=payload.atoms.map((atom)=>atom.y);
      const sourceCenterX=(Math.min(...sourceX)+Math.max(...sourceX))/2,sourceCenterY=(Math.min(...sourceY)+Math.max(...sourceY))/2;
      const aidToId=new Map<number,number>(),ids=payload.atoms.map((atom)=>{const id=nextId.current++;aidToId.set(atom.aid,id);return id;});
      const created:AtomNode[]=payload.atoms.map((atom,index)=>({id:ids[index],element:allSymbols[atom.atomicNumber-1],x:centerX+(atom.x-sourceCenterX)*190,y:centerY-(atom.y-sourceCenterY)*190,charge:0,electronOffset:0}));
      const atomById=new Map(created.map((atom)=>[atom.id,atom]));
      const createdBonds:BondEdge[]=payload.bonds.flatMap((bond,index)=>{
        const from=aidToId.get(bond.from),to=aidToId.get(bond.to);if(!from||!to)return[];
        const first=atomById.get(from)!,second=atomById.get(to)!,inferred=stableBond(first.element,second.element);
        return[{id:Date.now()+index,from,to,type:inferred?.type??"covalent",order:Math.max(1,Math.min(3,bond.order)) as 1|2|3}];
      });
      const resolvedFormula=payload.formula.normalize("NFKC").replace(/\s+/g,"");
      const constrainedAngles:Record<string,number>={H2O:104.5,CO2:180,O3:116.8,O2S:119,SO2:119};
      const constrainedAngle=constrainedAngles[resolvedFormula];
      if(constrainedAngle){
        const center=created.map((atom)=>({atom,bonds:createdBonds.filter((bond)=>bond.from===atom.id||bond.to===atom.id)})).sort((a,b)=>b.bonds.length-a.bonds.length)[0];
        if(center?.bonds.length===2){
          const neighbors=center.bonds.map((bond)=>atomById.get(bond.from===center.atom.id?bond.to:bond.from)!).filter(Boolean);
          const reference=Math.atan2(neighbors[0].y-center.atom.y,neighbors[0].x-center.atom.x),distance=Math.hypot(neighbors[1].x-center.atom.x,neighbors[1].y-center.atom.y);
          neighbors[1].x=center.atom.x+Math.cos(reference+constrainedAngle*Math.PI/180)*distance;
          neighbors[1].y=center.atom.y+Math.sin(reference+constrainedAngle*Math.PI/180)*distance;
        }
      }
      const displayFormula=resolvedFormula.replace(/\d/g,(digit)=>"₀₁₂₃₄₅₆₇₈₉"[Number(digit)]);
      const groupId=Date.now()+1000;
      if(canvasRef.current){
        const minX=Math.min(...created.map((atom)=>atom.x))-125,maxX=Math.max(...created.map((atom)=>atom.x))+125,minY=Math.min(...created.map((atom)=>atom.y))-125,maxY=Math.max(...created.map((atom)=>atom.y))+125;
        const canvasWidth=canvasRef.current.clientWidth,canvasHeight=canvasRef.current.clientHeight;
        const fitScale=Math.max(.25,Math.min(.82,(canvasWidth-36)/(maxX-minX),(canvasHeight-36)/(maxY-minY)));
        setScale(fitScale);setPan({x:canvasWidth/2-(minX+maxX)/2*fitScale,y:canvasHeight/2-(minY+maxY)/2*fitScale});
      }
      const chargedCreated=applyIonicCharges(created,createdBonds);
      setAtoms((items)=>[...items,...chargedCreated]);setBonds((items)=>[...items,...createdBonds]);setFormulaGroups((groups)=>[...groups,{id:groupId,atomIds:ids,formula:displayFormula,name:payload.name,source:payload.source,cid:payload.cid}]);setSelected([]);setSelectedMolecule(groupId);setSelectedBond(null);setFormulaOpen(false);setFormulaInput("");setFormulaError("");
    }catch{setFormulaError("The structure database is unavailable. No structure was guessed.");}
    finally{setFormulaLoading(false);}
  }

  function periodicMatch(symbol:string){
    const valenceMatches=valenceFilter==="all"||elements[symbol].valence===Number(valenceFilter);
    const en=pauling(symbol);
    const characterMatches=characterFilter==="all"||(characterFilter==="electronegative"&&en>=2.5)||(characterFilter==="intermediate"&&en>1.5&&en<2.5)||(characterFilter==="electropositive"&&en>0&&en<=1.5);
    return valenceMatches&&characterMatches;
  }

  function dropPeriodicAtom(event:React.DragEvent,symbol:string){
    const box=canvasRef.current?.getBoundingClientRect();
    if(!box||event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)return;
    addAtom(symbol,(event.clientX-box.left-pan.x)/scale,(event.clientY-box.top-pan.y)/scale);
    setPeriodicOpen(false);
  }

  function stableBond(first: ElementKey, second: ElementKey): { type: BondType; order: 1 | 2 | 3 } | null {
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
    const currentAtoms=atomsRef.current;
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
      const existingPartners = new Set(kept.flatMap((bond) => bond.from === id ? [bond.to] : bond.to === id ? [bond.from] : []));
      const proposed = nearby.filter(({atom}) => !existingPartners.has(atom.id)).map(({atom,distance}) => ({ atom, distance, inferred: stableBond(moved.element, atom.element) })).filter((item): item is {atom:AtomNode;distance:number;inferred:{type:BondType;order:1|2|3}} => Boolean(item.inferred)).sort((a,b)=>Number(a.atom.element===moved.element)-Number(b.atom.element===moved.element)||a.distance-b.distance);
      const capacity = (atom: AtomNode) => atom.element === "H" || ["F","Cl","Br","I"].includes(atom.element) ? 1 : atom.element === "Be" ? 2 : atom.element === "B" || atom.element === "N" ? 3 : atom.element === "O" ? 2 : atom.element === "C" ? 4 : atom.element === "P" ? 5 : atom.element === "S" ? 6 : 8;
      const nextBonds=[...kept];
      const ionicCount=(atomId:number)=>nextBonds.filter((bond)=>bond.type==="ionic"&&(bond.from===atomId||bond.to===atomId)).reduce((sum,bond)=>sum+bond.order,0);
      const occupied=(atomId:number)=>nextBonds.filter((bond)=>bond.from===atomId||bond.to===atomId).reduce((sum,bond)=>{
        if(bond.type==="covalent")return sum+bond.order;
        const atom=currentAtoms.find((item)=>item.id===atomId);
        return sum+(atom&&!metals.has(atom.element)?bond.order:0);
      },0);
      const now=Date.now();
      proposed.forEach(({atom,inferred},index)=>{
        let candidate=inferred;
        if(candidate.type==="ionic"){
          const donor=metals.has(moved.element)?moved:atom,receiver=donor===moved?atom:moved;
          if(ionicCount(donor.id)+candidate.order>ionicDonationLimit(donor.element)||ionicCount(receiver.id)+candidate.order>ionicAcceptanceLimit(receiver.element))return;
        }else if(candidate.type==="covalent"){
          if(moved.element==="O"&&atom.element==="O"&&(ionicCount(moved.id)>0||ionicCount(atom.id)>0))candidate={type:"covalent",order:1};
          if(occupied(moved.id)+candidate.order>capacity(moved)||occupied(atom.id)+candidate.order>capacity(atom))return;
        }else if(occupied(moved.id)+candidate.order>capacity(moved)||occupied(atom.id)+candidate.order>capacity(atom))return;
        nextBonds.push({id:now+index,from:id,to:atom.id,...candidate});
      });
      const charged=applyIonicCharges(currentAtoms,nextBonds);
      const sequence=++validationSequence.current;
      try{
        const response=await fetch("/api/validate-structure",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({atoms:charged,bonds:nextBonds})});
        if(!response.ok)throw new Error("RDKit validation request failed");
        const result=await response.json() as {valid:boolean;reason?:string};
        if(sequence!==validationSequence.current)return false;
        if(!result.valid){
          setValidationNotice(result.reason??"RDKit rejected that bonding arrangement.");
          window.setTimeout(()=>setValidationNotice(""),4200);
          return false;
        }
        setValidationNotice("");
        bondsRef.current=nextBonds;atomsRef.current=charged;
        setBonds(nextBonds);setAtoms(charged);
        return true;
      }catch{
        if(sequence===validationSequence.current){
          setValidationNotice("RDKit validation is unavailable, so no bond was changed.");
          window.setTimeout(()=>setValidationNotice(""),4200);
        }
        return false;
      }
  }

  function removeBond(id:number){
    const nextBonds=bondsRef.current.filter((bond)=>bond.id!==id);
    const charged=applyIonicCharges(atomsRef.current,nextBonds);
    bondsRef.current=nextBonds;atomsRef.current=charged;
    setBonds(nextBonds);setAtoms(charged);setSelectedBond(null);
  }

  function idealAngle(symbol:string,neighborCount:number,bondOrder:number){
    if(symbol==="O"&&neighborCount===2)return 104.5;
    if(symbol==="N"&&neighborCount===3)return 107;
    if(symbol==="C"&&neighborCount===2&&bondOrder>=4)return 180;
    if(neighborCount===2)return 120;
    if(neighborCount===3)return 120;
    if(neighborCount>=4)return 109.5;
    return 180;
  }

  function relaxBondGeometry(movedId:number){
    const currentAtoms=atomsRef.current,currentBonds=bondsRef.current,moved=currentAtoms.find((atom)=>atom.id===movedId);
    if(!moved)return;
    const connected=currentBonds.filter((bond)=>bond.from===movedId||bond.to===movedId);
    if(connected.length!==1)return;
    const joiningBond=connected[0],partnerId=joiningBond.from===movedId?joiningBond.to:joiningBond.from,partner=currentAtoms.find((atom)=>atom.id===partnerId);
    if(!partner)return;
    const partnerBonds=currentBonds.filter((bond)=>bond.from===partnerId||bond.to===partnerId);
    const existingNeighbors=partnerBonds.flatMap((bond)=>{const id=bond.from===partnerId?bond.to:bond.from;return id===movedId?[]:[currentAtoms.find((atom)=>atom.id===id)!];}).filter(Boolean);
    const targetDistance=joiningBond.type==="ionic"?270:225;
    let targetAngle=Math.atan2(moved.y-partner.y,moved.x-partner.x);
    if(existingNeighbors.length){
      const reference=Math.atan2(existingNeighbors[0].y-partner.y,existingNeighbors[0].x-partner.x);
      const bondOrder=partnerBonds.reduce((sum,bond)=>sum+bond.order,0);
      const separation=idealAngle(partner.element,partnerBonds.length,bondOrder)*Math.PI/180;
      const options=[reference+separation,reference-separation];
      targetAngle=options.sort((a,b)=>Math.abs(Math.atan2(Math.sin(a-targetAngle),Math.cos(a-targetAngle)))-Math.abs(Math.atan2(Math.sin(b-targetAngle),Math.cos(b-targetAngle))))[0];
    }
    const target={x:partner.x+Math.cos(targetAngle)*targetDistance,y:partner.y+Math.sin(targetAngle)*targetDistance};
    if(geometryAnimation.current)cancelAnimationFrame(geometryAnimation.current);
    if(window.matchMedia("(prefers-reduced-motion: reduce)").matches){setAtoms((items)=>items.map((atom)=>atom.id===movedId?{...atom,...target}:atom));return;}
    const origin={x:moved.x,y:moved.y},started=performance.now(),duration=520;
    const frame=(now:number)=>{
      const progress=Math.min(1,(now-started)/duration),eased=1-Math.pow(1-progress,4);
      const position={x:origin.x+(target.x-origin.x)*eased,y:origin.y+(target.y-origin.y)*eased};
      setAtoms((items)=>items.map((atom)=>atom.id===movedId?{...atom,...position}:atom));
      if(progress<1)geometryAnimation.current=requestAnimationFrame(frame);else geometryAnimation.current=null;
    };
    geometryAnimation.current=requestAnimationFrame(frame);
  }

  function pointerMove(event: React.PointerEvent) {
    const current=gesture.current;
    if (!current) return;
    const dx = event.clientX - current.sx;
    const dy = event.clientY - current.sy;
    if (current.type === "pan") setPan({ x: current.ox + dx, y: current.oy + dy });
    else if(current.type==="molecule"){
      const origins=current.origins;
      setAtoms((items)=>items.map((atom)=>{const origin=origins.get(atom.id);return origin?{...atom,x:origin.x+dx/scale,y:origin.y+dy/scale}:atom;}));
    }else setAtoms((items) => items.map((atom) => atom.id === current.id ? { ...atom, x: current.ox + dx / scale, y: current.oy + dy / scale } : atom));
  }

  return (
    <main className="lab-shell">
      <div className="lab-layout" style={{"--left-width":`${sidebarWidths.left}px`,"--right-width":`${sidebarWidths.right}px`} as React.CSSProperties}>
        <aside className="element-tray">
          <div className="product-mark"><span><Atom weight="bold" /></span><b>Electron</b></div>
          <button type="button" className="open-periodic" onClick={()=>setPeriodicOpen(true)}><Atom/> Periodic table</button>
          <button type="button" className="open-periodic structure-lookup" onClick={()=>{setFormulaOpen(true);setFormulaError("");setFormulaCandidates([]);}}><MagnifyingGlass/> Add molecule</button>
          <div className="tray-heading"><b>Add atoms</b><small>Click or drag onto canvas</small></div>
          <label className="element-search"><MagnifyingGlass /><input value={elementQuery} onChange={(event) => setElementQuery(event.target.value)} placeholder="Search 118 elements" aria-label="Search elements" /></label>
          <div className="element-palette">
            {visibleElements.map((symbol) => {
              const item = elements[symbol];
              return <button type="button" key={symbol} draggable onDragStart={(event) => event.dataTransfer.setData("element", symbol)} onClick={() => addAtom(symbol)}><small>{item.z}</small><strong>{symbol}</strong><span>{item.name}</span><i>{item.valence} valence</i></button>;
            })}
          </div>
        </aside>
        <div className="sidebar-resizer left" role="separator" aria-label="Resize element sidebar" aria-orientation="vertical" aria-valuenow={sidebarWidths.left} onPointerDown={(event)=>{event.currentTarget.setPointerCapture(event.pointerId);resizing.current={side:"left",startX:event.clientX,startWidth:sidebarWidths.left};}} onPointerMove={(event)=>{const current=resizing.current;if(!current||current.side!=="left")return;setSidebarWidths((widths)=>({...widths,left:Math.max(140,Math.min(360,current.startWidth+event.clientX-current.startX))}));}} onPointerUp={()=>{resizing.current=null;}} onPointerCancel={()=>{resizing.current=null;}} onLostPointerCapture={()=>{resizing.current=null;}}/>

        <section ref={canvasRef} className="chem-canvas" aria-label="Interactive atom canvas"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => { const symbol = event.dataTransfer.getData("element") as ElementKey; const box = event.currentTarget.getBoundingClientRect(); if (symbol in elements) addAtom(symbol, (event.clientX - box.left - pan.x) / scale, (event.clientY - box.top - pan.y) / scale); }}
          onPointerDown={(event) => {
            const target = event.target as Element;
            if (!target.closest(".canvas-atom, .canvas-atom-controls, .bond-toolbar, .bond-target, .molecule-region")) {
              event.currentTarget.setPointerCapture(event.pointerId);
              gesture.current = { type: "pan", sx: event.clientX, sy: event.clientY, ox: pan.x, oy: pan.y };
            }
          }}
          onPointerMove={pointerMove} onPointerUp={() => { gesture.current = null; }} onPointerCancel={()=>{gesture.current=null;}} onLostPointerCapture={()=>{gesture.current=null;}}>
          <div className="bond-toolbar">
            <span><Atom /> Ringed atom electrons appear in shared pairs</span>
            <output className="zoom-level" aria-label="Canvas zoom">{Math.round(scale * 100)}%</output>
          </div>
          {validationNotice&&<div className="validation-notice" role="status">{validationNotice}</div>}
          <div className="canvas-world">
            <svg className="bond-layer" width="1600" height="1000">
              {bonds.map((bond) => {
                const from = atoms.find((atom) => atom.id === bond.from); const to = atoms.find((atom) => atom.id === bond.to); if (!from || !to) return null;
                const x1=pan.x+from.x*scale,y1=pan.y+from.y*scale,x2=pan.x+to.x*scale,y2=pan.y+to.y*scale,mx=(x1+x2)/2,my=(y1+y2)/2;
                const fromSubshells=subshellsForElectronCount(elements[from.element].z-from.charge+from.electronOffset),toSubshells=subshellsForElectronCount(elements[to.element].z-to.charge+to.electronOffset);
                const fromColor=subshellColors[fromSubshells.at(-1)?.kind ?? "s"],toColor=subshellColors[toSubshells.at(-1)?.kind ?? "s"];
                const superoxide=bond.type==="covalent"&&bond.order===1&&from.element==="O"&&to.element==="O"&&bonds.some((item)=>item.type==="ionic"&&[item.from,item.to].some((atomId)=>atomId===from.id||atomId===to.id)&&[item.from,item.to].some((atomId)=>atoms.find((atom)=>atom.id===atomId)?.element==="Li"));
                return <g key={bond.id} className={`bond-line ${bond.type} ${selectedBond === bond.id ? "selected" : ""}`}><line x1={x1} y1={y1} x2={x2} y2={y2} />{bond.order > 1 && <line x1={x1} y1={y1+8*scale} x2={x2} y2={y2+8*scale} />}{bond.type === "covalent" && Array.from({length:bond.order},(_,i)=><g key={i}><circle className="shared-electron" style={{fill:fromColor}} cx={mx-5*scale} cy={my+(i-(bond.order-1)/2)*10*scale} r={3*scale} /><circle className="shared-electron" style={{fill:toColor}} cx={mx+5*scale} cy={my+(i-(bond.order-1)/2)*10*scale} r={3*scale} /></g>)}{superoxide&&<text className="delocalized-charge" x={mx} y={my-18*scale}>−1 over O₂</text>}</g>;
              })}
              {dipoleAttractions.map((attraction)=>{const x1=pan.x+attraction.from.x*scale,y1=pan.y+attraction.from.y*scale,x2=pan.x+attraction.to.x*scale,y2=pan.y+attraction.to.y*scale,mx=(x1+x2)/2,my=(y1+y2)/2;return <g className="dipole-attraction" key={attraction.id}><line x1={x1} y1={y1} x2={x2} y2={y2}/><text x={x1} y={y1-9}>δ+</text><text x={x2} y={y2-9}>δ−</text><text className="dipole-label" x={mx} y={my-7}>dipole–dipole</text></g>;})}
              {active&&bondAngles.map((guide,index)=>{const cx=pan.x+active.x*scale,cy=pan.y+active.y*scale,r=58*scale,startX=cx+Math.cos(guide.start)*r,startY=cy+Math.sin(guide.start)*r,endX=cx+Math.cos(guide.end)*r,endY=cy+Math.sin(guide.end)*r;let middle=guide.start+(guide.end-guide.start)/2;if(guide.end<guide.start)middle+=Math.PI;return <g className="angle-guide" key={`${active.id}-${index}`}><path d={`M ${startX} ${startY} A ${r} ${r} 0 ${guide.angle>180?1:0} 1 ${endX} ${endY}`}/><text x={cx+Math.cos(middle)*(r+17)} y={cy+Math.sin(middle)*(r+17)}>{guide.angle.toFixed(1)}°</text></g>;})}
            </svg>
            {formulaGroups.flatMap((group)=>{
              const members=group.atomIds.map((id)=>atoms.find((atom)=>atom.id===id)).filter((atom):atom is AtomNode=>Boolean(atom));
              if(members.length!==group.atomIds.length||!members.length)return[];
              const padding=115,minX=Math.min(...members.map((atom)=>atom.x))-padding,maxX=Math.max(...members.map((atom)=>atom.x))+padding,minY=Math.min(...members.map((atom)=>atom.y))-padding,maxY=Math.max(...members.map((atom)=>atom.y))+padding;
              return <button type="button" aria-label={`Select ${group.name??group.formula} molecule`} className={`molecule-region ${selectedMolecule===group.id?"selected":""}`} key={`region-${group.id}`}
                style={{width:(maxX-minX)*scale,height:(maxY-minY)*scale,transform:`translate(${pan.x+minX*scale}px,${pan.y+minY*scale}px)`}}
                onClick={(event)=>{event.stopPropagation();setSelectedMolecule(group.id);setSelected([]);setSelectedBond(null);setSelectedElectron(null);}}
                onKeyDown={(event)=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();setSelectedMolecule(group.id);setSelected([]);setSelectedBond(null);}}}
                onPointerDown={(event)=>{event.stopPropagation();event.currentTarget.setPointerCapture(event.pointerId);setSelectedMolecule(group.id);setSelected([]);setSelectedBond(null);gesture.current={type:"molecule",groupId:group.id,sx:event.clientX,sy:event.clientY,origins:new Map(members.map((atom)=>[atom.id,{x:atom.x,y:atom.y}]))};}}
                onPointerMove={pointerMove} onPointerUp={()=>{gesture.current=null;}} onPointerCancel={()=>{gesture.current=null;}} onLostPointerCapture={()=>{gesture.current=null;}}/>;
            })}
            {bonds.map((bond) => { const from=atoms.find((atom)=>atom.id===bond.from),to=atoms.find((atom)=>atom.id===bond.to); if(!from||!to)return null; const mx=pan.x+(from.x+to.x)*scale/2,my=pan.y+(from.y+to.y)*scale/2; return <button type="button" key={`target-${bond.id}`} className="bond-target" style={{transform:`translate(${mx-42}px,${my-30}px)`}} aria-label={`Inspect ${bond.type} bond`} onClick={(event)=>{event.stopPropagation();setSelectedBond(bond.id);setSelectedMolecule(null);setSelected([]);}}>{scale>=.45?bond.type:""}</button>;})}
            {namedCompounds.map((compound) => <div className="compound-label" key={`${compound.formula}-${compound.x}-${compound.y}`} style={{ transform: `translate(${pan.x + compound.x * scale}px, ${pan.y + compound.y * scale}px)` }}><b>{compound.formula}</b><span>{compound.name}</span></div>)}
            {formulaGroups.filter((group)=>!Object.values(compoundNames).some((compound)=>compound.name===group.name)).flatMap((group)=>{const members=group.atomIds.map((id)=>atoms.find((atom)=>atom.id===id)).filter((atom):atom is AtomNode=>Boolean(atom));if(members.length!==group.atomIds.length)return[];const x=members.reduce((sum,atom)=>sum+atom.x,0)/members.length,y=Math.max(...members.map((atom)=>atom.y))+125;return <div className="compound-label imported" key={group.id} style={{transform:`translate(${pan.x+x*scale}px,${pan.y+y*scale}px)`}}><b>{group.formula}</b><span>{group.name??group.source??"database structure"}</span></div>;})}
            {atoms.map((atom) => {
              const item = elements[atom.element]; const isSelected = selectedAtomIds.has(atom.id);
              const sharedElectrons=bonds.filter((bond)=>bond.type==="covalent"&&(bond.from===atom.id||bond.to===atom.id)).reduce((total,bond)=>total+bond.order,0);
              const sharedFrom=bonds.filter((bond)=>bond.type==="covalent"&&(bond.from===atom.id||bond.to===atom.id)).flatMap((bond)=>{const partner=atoms.find((item)=>item.id===(bond.from===atom.id?bond.to:bond.from));if(!partner)return[];const subshell=subshellsForElectronCount(elements[partner.element].z-partner.charge+partner.electronOffset).at(-1);return Array.from({length:bond.order},()=>({color:subshellColors[subshell?.kind??"s"],label:partner.element,subshell:subshell?.label??"unknown"}));});
              const atomSize=200*scale;
              return <div role="group" tabIndex={0} className={`canvas-atom ${isSelected ? "selected" : ""}`} style={{ width:atomSize,height:atomSize,transform:`translate(${pan.x+atom.x*scale-atomSize/2}px, ${pan.y+atom.y*scale-atomSize/2}px)` }} key={atom.id}
                onClick={(event) => { event.stopPropagation(); if(!(event.target as Element).closest(".diagram-electron"))selectAtom(atom.id,event.shiftKey); }}
                onKeyDown={(event)=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();selectAtom(atom.id,event.shiftKey);}}}
                onPointerDown={(event) => { event.stopPropagation(); if((event.target as Element).closest(".diagram-electron"))return; event.currentTarget.setPointerCapture(event.pointerId); gesture.current = { type: "atom", id: atom.id, sx: event.clientX, sy: event.clientY, ox: atom.x, oy: atom.y }; }}
                onPointerMove={pointerMove} onPointerUp={() => { const current=gesture.current;const movedId=current?.type==="atom"?current.id:undefined; gesture.current = null; if (movedId) void settleAtom(movedId).then((valid)=>{if(valid)relaxBondGeometry(movedId);}).catch(()=>setValidationNotice("RDKit validation failed.")); }} onPointerCancel={()=>{gesture.current=null;}} onLostPointerCapture={()=>{gesture.current=null;}} aria-label={`${item.name} atom`}>
                <AtomScene symbol={atom.element} atomicNumber={item.z} subshells={subshellsForElectronCount(item.z - atom.charge + atom.electronOffset)} sharedElectrons={sharedElectrons} sharedFrom={sharedFrom} onElectronSelect={(electron)=>{setSelected([atom.id]);setSelectedBond(null);setSelectedElectron({atomId:atom.id,...electron});}} />
                {atom.charge !== 0 && <span className={`atom-charge ${atom.charge > 0 ? "positive" : "negative"}`}>{atom.charge > 0 ? `+${atom.charge}` : atom.charge}</span>}
              </div>;
            })}
            {active && activeElement && <div className="canvas-atom-controls" style={{transform:`translate(${pan.x+active.x*scale-135}px,${pan.y+active.y*scale-100*scale-48}px)`}} onPointerDown={(event)=>event.stopPropagation()} onClick={(event)=>event.stopPropagation()}>
              <button type="button" aria-label="Remove electron" title={bondSummary.length?"Remove bonds before changing electrons":"Remove electron"} disabled={selected.length>1||bondSummary.length>0||activeElement.z-active.charge+active.electronOffset<=0} onClick={()=>setAtoms((items)=>items.map((atom)=>atom.id===active.id?{...atom,electronOffset:Math.max(-(activeElement.z-active.charge),atom.electronOffset-1)}:atom))}>−</button>
              <label><span>e⁻</span><input aria-label="Electron count" type="number" min="0" max="118" value={activeElement.z-active.charge+active.electronOffset} disabled={selected.length>1||bondSummary.length>0} onChange={(event)=>{const count=Math.max(0,Math.min(118,Number(event.target.value)||0));setAtoms((items)=>items.map((atom)=>atom.id===active.id?{...atom,electronOffset:count-(activeElement.z-active.charge)}:atom));}} /></label>
              <button type="button" aria-label="Add electron" title={bondSummary.length?"Remove bonds before changing electrons":"Add electron"} disabled={selected.length>1||bondSummary.length>0||activeElement.z-active.charge+active.electronOffset>=118} onClick={()=>setAtoms((items)=>items.map((atom)=>atom.id===active.id?{...atom,electronOffset:Math.min(118-(activeElement.z-active.charge),atom.electronOffset+1)}:atom))}>+</button>
              <button type="button" aria-label="Reset electrons" title="Reset electrons" disabled={selected.length>1||bondSummary.length>0||active.electronOffset===0} onClick={()=>setAtoms((items)=>items.map((atom)=>atom.id===active.id?{...atom,electronOffset:0}:atom))}><ArrowCounterClockwise/></button>
              <button type="button" className="canvas-delete" aria-label={selected.length>1?`Delete ${selected.length} selected atoms`:"Delete atom"} onClick={()=>deleteAtoms(selected)}><Trash /></button>
            </div>}
          </div>
          {atoms.length === 0 && <div className="canvas-empty"><Atom /><b>Place your first atom</b><span>Choose an element from the tray or drag it here.</span></div>}
        </section>

        <aside className="atom-inspector">
          {activeBond ? <BondInspector bond={activeBond} atoms={atoms} onClose={() => setSelectedBond(null)} onRemove={() => removeBond(activeBond.id)} /> : activeMolecule ? <MoleculeInspector group={activeMolecule} atoms={atoms} bonds={bonds} onClose={()=>setSelectedMolecule(null)} onDelete={()=>deleteAtoms(activeMolecule.atomIds)}/> : active && activeElement ? <>
            <div className="inspector-title"><div><small>Selected atom</small><h1>{activeElement.name}</h1><code>{activeElement.config}</code></div><button type="button" aria-label="Deselect atom" onClick={() => setSelected([])}><X /></button></div>
            {selectedElectron?.atomId===active.id&&<section className="selected-electron"><h2>Selected electron</h2><div><i style={{background:subshellColors[selectedElectron.kind]}}/><b>{selectedElectron.label}</b><span>{selectedElectron.kind} subshell</span></div><p>{selectedElectron.source?`Shared onto ${active.element} from ${selectedElectron.source}.`:selectedElectron.shared?"This valence electron is contributed to a covalent bond.":"This electron remains owned by the atom."}</p></section>}
            <section><h2>Occupied subshells by shell</h2><div className="shell-groups">{[...new Set(activeSubshells.map((subshell)=>subshell.shell))].map((shell)=>{const shellSubshells=activeSubshells.filter((subshell)=>subshell.shell===shell);const total=shellSubshells.reduce((sum,subshell)=>sum+subshell.count,0);const shared=shell===Math.max(...activeSubshells.map((subshell)=>subshell.shell))?bondSummary.filter((bond)=>bond.type==="covalent").reduce((sum,bond)=>sum+bond.order,0):0;return <div className="shell-group" key={shell}><div className="shell-total"><b>Shell {shell}</b><span>{total} owned electron{total===1?"":"s"}{shared>0&&<em> + {shared} shared</em>}</span></div><div className="subshell-list">{shellSubshells.map((subshell)=><div key={subshell.label}><i style={{background:subshellColors[subshell.kind]}}/><b>{subshell.label}</b><span>{subshell.count} electrons</span></div>)}</div></div>;})}</div></section>
            <AtomLearning atom={active} atoms={atoms} bonds={bonds}/>
            <section><h2>Why it changes</h2><p>{activeElement.note}</p>{active.charge !== 0 && <p className="change-note">This atom is shown as {active.charge > 0 ? `a ${active.charge}+ cation after losing outer electrons` : `a ${Math.abs(active.charge)}− anion after gaining electrons`}.</p>}</section>
            <section><h2>Connected bonds</h2>{bondSummary.length ? <div className="bond-summary">{bondSummary.map((bond) => <div key={bond.id}><span><i className={bond.type} />{bond.type} bond</span><button type="button" aria-label={`Remove ${bond.type} bond`} onClick={() => removeBond(bond.id)}><X /></button></div>)}</div> : <p>No bond. Move this atom close to a compatible atom.</p>}</section>
          </> : <div className="inspector-empty"><Atom /><b>Select an atom</b><span>Its configuration, subshells, charge, and bonds will appear here.</span></div>}
        </aside>
        <div className="sidebar-resizer right" role="separator" aria-label="Resize information sidebar" aria-orientation="vertical" aria-valuenow={sidebarWidths.right} onPointerDown={(event)=>{event.currentTarget.setPointerCapture(event.pointerId);resizing.current={side:"right",startX:event.clientX,startWidth:sidebarWidths.right};}} onPointerMove={(event)=>{const current=resizing.current;if(!current||current.side!=="right")return;setSidebarWidths((widths)=>({...widths,right:Math.max(220,Math.min(460,current.startWidth-event.clientX+current.startX))}));}} onPointerUp={()=>{resizing.current=null;}} onPointerCancel={()=>{resizing.current=null;}} onLostPointerCapture={()=>{resizing.current=null;}}/>
      </div>
      {periodicOpen&&<div className="periodic-backdrop" onPointerDown={()=>setPeriodicOpen(false)}><section className="periodic-panel" role="dialog" aria-modal="true" aria-label="Periodic table" onPointerDown={(event)=>event.stopPropagation()}><header><div><small>Element library</small><h1>Periodic table</h1></div><div className="periodic-filters"><label>Valence<select value={valenceFilter} onChange={(event)=>setValenceFilter(event.target.value)}><option value="all">All</option>{Array.from({length:8},(_,index)=><option key={index+1} value={index+1}>{index+1} electron{index===0?"":"s"}</option>)}</select></label><label>Character<select value={characterFilter} onChange={(event)=>setCharacterFilter(event.target.value)}><option value="all">All</option><option value="electronegative">Electronegative</option><option value="intermediate">Intermediate</option><option value="electropositive">Electropositive</option></select></label></div><button type="button" aria-label="Close periodic table" onClick={()=>setPeriodicOpen(false)}><X/></button></header><div className="periodic-grid">{periodicMain.flatMap((row,rowIndex)=>row.map(([symbol,column])=>{const item=elements[symbol],matches=periodicMatch(symbol);return <button type="button" key={symbol} className={matches?"":"filtered"} disabled={!matches} draggable={matches} style={{gridColumn:column,gridRow:rowIndex+1}} onDragStart={(event)=>{event.dataTransfer.setData("element",symbol);event.dataTransfer.effectAllowed="copy";}} onDragEnd={(event)=>dropPeriodicAtom(event,symbol)} onClick={()=>{addAtom(symbol);setPeriodicOpen(false);}}><small>{item.z}</small><b>{symbol}</b><span>{item.name}</span><i>{item.valence}v · {pauling(symbol)||"—"} EN</i></button>}))}{periodicFBlock.flatMap((row,rowIndex)=>row.map((symbol,index)=>{const item=elements[symbol],matches=periodicMatch(symbol);return <button type="button" key={symbol} className={matches?"f-block":"f-block filtered"} disabled={!matches} draggable={matches} style={{gridColumn:index+4,gridRow:rowIndex+8}} onDragStart={(event)=>event.dataTransfer.setData("element",symbol)} onDragEnd={(event)=>dropPeriodicAtom(event,symbol)} onClick={()=>{addAtom(symbol);setPeriodicOpen(false);}}><small>{item.z}</small><b>{symbol}</b><span>{item.name}</span><i>{item.valence}v · {pauling(symbol)||"—"} EN</i></button>}))}</div></section></div>}
      {formulaOpen&&<div className="formula-command-backdrop" onPointerDown={()=>{if(!formulaLoading)setFormulaOpen(false);}}><form className={`formula-command ${formulaCandidates.length?"has-results":""}`} role="dialog" aria-modal="true" aria-label="Add a PubChem structure" onPointerDown={(event)=>event.stopPropagation()} onSubmit={(event)=>{event.preventDefault();spawnFormula(formulaInput);}}><label><span>Structure lookup</span><input autoFocus value={formulaInput} onChange={(event)=>{setFormulaInput(event.target.value);setFormulaError("");setFormulaCandidates([]);}} spellCheck={false} autoComplete="off" placeholder="Formula, name, CID, or smiles:…"/></label><small>Accepts formulas, compound names, PubChem CIDs, and SMILES prefixed with “smiles:”.</small>{formulaError&&<p role="status">{formulaError}</p>}<button type="submit" disabled={formulaLoading}>{formulaLoading?"Loading…":"Search"}</button>{formulaCandidates.length>0&&<div className="structure-candidates" aria-label="Matching PubChem structures"><header><b>Select a structure</b><span>Showing the first {formulaCandidates.length} PubChem matches</span></header>{formulaCandidates.map((candidate)=><button type="button" key={candidate.cid} onClick={()=>spawnFormula(String(candidate.cid))} disabled={formulaLoading}><span><b>{candidate.name}</b><small>{candidate.formula.replace(/\d/g,(digit)=>"₀₁₂₃₄₅₆₇₈₉"[Number(digit)])}</small></span><code>CID {candidate.cid}</code></button>)}</div>}</form></div>}
    </main>
  );
}

function MoleculeInspector({group,atoms,bonds,onClose,onDelete}:{group:FormulaGroup;atoms:AtomNode[];bonds:BondEdge[];onClose:()=>void;onDelete:()=>void}) {
  const memberIds=new Set(group.atomIds);
  const members=atoms.filter((atom)=>memberIds.has(atom.id));
  const moleculeBonds=bonds.filter((bond)=>memberIds.has(bond.from)&&memberIds.has(bond.to));
  const counts=members.reduce<Record<string,number>>((result,atom)=>{result[atom.element]=(result[atom.element]??0)+1;return result;},{});
  const totalCharge=members.reduce((sum,atom)=>sum+atom.charge,0);
  const covalent=moleculeBonds.filter((bond)=>bond.type==="covalent");
  const ionic=moleculeBonds.filter((bond)=>bond.type==="ionic");
  const polar=covalent.filter((bond)=>{
    const from=atoms.find((atom)=>atom.id===bond.from),to=atoms.find((atom)=>atom.id===bond.to);
    return Boolean(from&&to&&Math.abs(pauling(from.element)-pauling(to.element))>=.4);
  }).length;
  return <div className="molecule-inspector">
    <div className="inspector-title"><div><small>Selected molecule</small><h1>{group.name??group.formula}</h1><code>{group.formula}{group.cid?` · PubChem CID ${group.cid}`:""}</code></div><button type="button" aria-label="Deselect molecule" onClick={onClose}><X/></button></div>
    <section><h2>Composition</h2><div className="molecule-composition">{Object.entries(counts).map(([symbol,count])=><span key={symbol}><b>{symbol}</b>{count}</span>)}</div><p>{members.length} atoms · net charge {totalCharge>0?`+${totalCharge}`:totalCharge}</p></section>
    <section><h2>Structure</h2><div className="learning-metrics"><div><b>{moleculeBonds.length}</b><span>bonds</span></div><div><b>{covalent.length}</b><span>covalent</span></div><div><b>{polar}</b><span>polar</span></div></div>{ionic.length>0&&<p>{ionic.length} ionic interaction{ionic.length===1?" is":"s are"} shown.</p>}<p className="structure-note">Connectivity, bond orders, and drawing coordinates are loaded from {group.source??"the structure database"}; they are not inferred from the formula.</p></section>
    <section><h2>Canvas interaction</h2><p>Drag anywhere in the outlined molecular area to move every atom and bond together. Individual atoms and bonds remain selectable.</p></section>
    <button type="button" className="remove-bond" onClick={onDelete}><Trash/> Delete molecule</button>
  </div>;
}

function BondInspector({bond,atoms,onClose,onRemove}:{bond:BondEdge;atoms:AtomNode[];onClose:()=>void;onRemove:()=>void}) {
  const from=atoms.find((atom)=>atom.id===bond.from)!; const to=atoms.find((atom)=>atom.id===bond.to)!;
  const fromSubshell=subshellsForElectronCount(elements[from.element].z-from.charge+from.electronOffset).at(-1); const toSubshell=subshellsForElectronCount(elements[to.element].z-to.charge+to.electronOffset).at(-1);
  const fromEn=pauling(from.element),toEn=pauling(to.element),difference=Math.abs(fromEn-toEn),moreNegative=fromEn>toEn?from:to;
  const donor=metals.has(from.element)?from:to; const receiver=donor===from?to:from;
  const polarity=bond.type==="ionic"?"ionic":difference<0.4?"mostly nonpolar":"polar covalent";
  return <div className="bond-inspector"><div className="inspector-title"><div><small>Selected bond</small><h1>{from.element} {bond.type === "ionic" ? "→" : "—"} {to.element}</h1><code>{bond.type} bond</code></div><button type="button" aria-label="Close bond details" onClick={onClose}><X /></button></div><section><h2>Electron behavior</h2>{bond.type === "ionic" ? <p><b>{donor.element}</b> donates an outer electron to <b>{receiver.element}</b>. They become oppositely charged ions held by electrostatic attraction.</p> : bond.type === "covalent" ? <><p><b>{from.element}</b> contributes {bond.order} electron{bond.order>1?"s":""} and <b>{to.element}</b> contributes {bond.order}. Together they share <b>{bond.order*2} electrons</b> in {bond.order === 1 ? "one pair" : `${bond.order} pairs`}.</p><div className="bond-contributors"><span><i style={{background:subshellColors[fromSubshell?.kind??"s"]}} />{from.element}: {fromSubshell?.label}</span><span><i style={{background:subshellColors[toSubshell?.kind??"s"]}} />{to.element}: {toSubshell?.label}</span></div><small className="sharing-note">The matching ring on each atom marks the electron used here. Every single bond contains one two-electron pair.</small></> : <p>Valence electrons are delocalized across the metal atoms rather than belonging to one pair.</p>}</section><section><h2>Bond polarity</h2><div className="polarity-scale"><span>{from.element}<small>{fromEn.toFixed(2)}</small></span><i style={{"--polarity":`${Math.min(100,difference/2*100)}%`} as React.CSSProperties}/><span>{to.element}<small>{toEn.toFixed(2)}</small></span></div><p>ΔEN = <b>{difference.toFixed(2)}</b>: this bond is {polarity}.{difference>=0.4&&bond.type==="covalent"&&<> Electron density is pulled toward <b>{moreNegative.element} δ−</b>; the other end is δ+.</>}</p></section><button type="button" className="remove-bond" onClick={onRemove}><Trash /> Remove bond</button></div>;
}

function pauling(symbol:string) {
  return Number((periodicTable as unknown as Record<string,{pauling_negativity?:number|string}>)[symbol]?.pauling_negativity)||0;
}

function AtomLearning({atom,atoms,bonds}:{atom:AtomNode;atoms:AtomNode[];bonds:BondEdge[]}) {
  const data=elements[atom.element];
  const connected=bonds.filter((bond)=>bond.from===atom.id||bond.to===atom.id);
  const covalent=connected.filter((bond)=>bond.type==="covalent");
  const bondOrder=covalent.reduce((sum,bond)=>sum+bond.order,0);
  const ownedValence=Math.max(0,data.valence-atom.charge);
  const nonbonding=Math.max(0,ownedValence-bondOrder);
  const lonePairs=Math.floor(nonbonding/2),unpaired=nonbonding%2;
  const formalCharge=atom.charge||data.valence-nonbonding-bondOrder;
  const neighborCount=new Set(covalent.map((bond)=>bond.from===atom.id?bond.to:bond.from)).size;
  const domains=neighborCount+lonePairs;
  let geometry="No molecular geometry",angle="—";
  if(neighborCount===1){geometry="Linear around this bond";angle="180° axis";}
  else if(domains===2){geometry="Linear";angle="180°";}
  else if(domains===3){geometry=lonePairs?"Bent":"Trigonal planar";angle=lonePairs?"less than 120°":"120°";}
  else if(domains===4){geometry=lonePairs===0?"Tetrahedral":lonePairs===1?"Trigonal pyramidal":"Bent";angle=lonePairs===0?"109.5°":lonePairs===1?"about 107°":"about 104.5°";}
  else if(domains===5){geometry="Trigonal bipyramidal electron geometry";angle="90° and 120°";}
  else if(domains>=6){geometry="Octahedral electron geometry";angle="90°";}
  const ionicShells=subshellsForElectronCount(data.z-atom.charge+atom.electronOffset),outerShell=ionicShells.at(-1)?.shell??1;
  const ionicOuterCount=ionicShells.filter((subshell)=>subshell.shell===outerShell).reduce((sum,subshell)=>sum+subshell.count,0);
  const isIonic=atom.charge!==0&&connected.some((bond)=>bond.type==="ionic");
  const shellCount=isIonic?ionicOuterCount:ownedValence+bondOrder;
  const shellTarget=isIonic&&outerShell===1?2:atom.element==="H"||atom.element==="He"?2:8;
  const exception=atom.element==="H"||atom.element==="He"?"First-shell duet rule":atom.element==="Be"||atom.element==="B"?"Stable electron-deficient structures are possible":shellCount>8&&elements[atom.element].subshells.some((item)=>item.shell>=3)?"Expanded valence shell is possible for some period-3-and-beyond compounds":unpaired?"An unpaired electron makes this a radical-like arrangement":null;
  const permitsNonOctet=Boolean(exception)&&unpaired===0;
  const componentIds=new Set<number>(),stack=[atom.id];
  while(stack.length){const id=stack.pop()!;if(componentIds.has(id))continue;componentIds.add(id);bonds.filter((bond)=>bond.from===id||bond.to===id).forEach((bond)=>stack.push(bond.from===id?bond.to:bond.from));}
  const counts=[...componentIds].map((id)=>atoms.find((item)=>item.id===id)!).reduce<Record<string,number>>((result,item)=>({...result,[item.element]:(result[item.element]??0)+1}),{});
  const signature=Object.keys(counts).sort().map((symbol)=>symbol+(counts[symbol]>1?counts[symbol]:"")).join("");
  const stable=signature==="LiO2"?{tone:"good",title:"RDKit-valid superoxide",text:"The O₂⁻ unit is a radical anion. Its −1 charge and odd electron are delocalized over both oxygen atoms."}:connected.length===0?{tone:"neutral",title:"Unbonded",text:"Move the atom near compatible partners to test a structure."}:shellCount===shellTarget||permitsNonOctet?{tone:"good",title:"Locally satisfied",text:isIonic?`After electron transfer, shell ${outerShell} is the ion’s outer occupied shell and contains ${shellCount} of ${shellTarget} electrons.`:`The displayed valence shell has ${shellCount} electrons when shared electrons are counted.`}:shellCount<shellTarget?{tone:"warn",title:unpaired?"Radical with incomplete shell":"Incomplete valence shell",text:`The actual outer occupied shell ${isIonic?`(shell ${outerShell}) `:""}contains ${shellCount} of ${shellTarget} electrons.`}:{tone:"warn",title:"Check this structure",text:`The actual outer occupied shell contains ${shellCount} electrons, above its usual capacity of ${shellTarget}.`};
  const resonance:Record<string,string>={LiO2:"Lithium superoxide is Li⁺[O₂]⁻. Lithium transfers one electron total; the −1 charge and unpaired electron are delocalized across the O–O unit. A charge drawn on one oxygen is only one resonance bookkeeping form.",O3:"Ozone is a resonance hybrid: the π bonding is delocalized, so its two O–O bonds are equivalent overall.",O2S:"Sulfur dioxide is described by resonance contributors; electron density is delocalized across both S–O bonds.",O3S:"Sulfur trioxide has three equivalent S–O bonds in its resonance description.",C6H6:"Benzene’s six π electrons are delocalized around the ring; alternating drawings are resonance contributors."};
  const molecularDipoles:Record<string,string>={CO2:"The two equal C=O bond dipoles point in opposite directions and cancel, so CO₂ is nonpolar overall.",H2O:"The bent shape prevents the O–H bond dipoles from cancelling, so water has a net dipole.",CH4:"The tetrahedral C–H bond dipoles cancel by symmetry, so methane is nonpolar overall.",H3N:"The trigonal-pyramidal shape leaves ammonia with a net dipole toward nitrogen.",O2S:"The bent shape leaves sulfur dioxide with a net molecular dipole.",O3S:"The three S–O bond dipoles cancel in trigonal-planar SO₃."};
  const polarBonds=covalent.map((bond)=>{const partner=atoms.find((item)=>item.id===(bond.from===atom.id?bond.to:bond.from))!;const difference=Math.abs(pauling(atom.element)-pauling(partner.element));return {partner,difference,toward:pauling(atom.element)>pauling(partner.element)?atom.element:partner.element};}).filter((item)=>item.difference>=0.4);
  return <>
    <section><h2>Lewis accounting</h2><div className="learning-metrics"><div><b>{lonePairs}</b><span>lone pair{lonePairs===1?"":"s"}</span></div><div><b>{unpaired}</b><span>unpaired</span></div><div><b>{formalCharge>0?`+${formalCharge}`:formalCharge}</b><span>formal charge</span></div></div><p>Bonding uses {bondOrder} electron{bondOrder===1?"":"s"} contributed by this atom; {nonbonding} valence electron{nonbonding===1?" remains":"s remain"} nonbonding.</p></section>
    <section><h2>Molecular geometry</h2><div className="geometry-readout"><b>{geometry}</b><span>{angle}</span></div><p>VSEPR estimate from {neighborCount} bonded region{neighborCount===1?"":"s"} and {lonePairs} lone pair{lonePairs===1?"":"s"}. Multiple bonds count as one electron region.</p></section>
    <section><h2>Polarity around this atom</h2>{polarBonds.length?<div className="polarity-list">{polarBonds.map(({partner,difference,toward})=><div key={partner.id}><b>{atom.element}—{partner.element}</b><span>ΔEN {difference.toFixed(2)} · toward {toward} δ−</span></div>)}</div>:<p>{covalent.length?"No strongly polar covalent bond is shown around this atom.":"Create a covalent bond to compare electronegativity."}</p>}{molecularDipoles[signature]&&<p className="dipole-note">{molecularDipoles[signature]}</p>}</section>
    <section><h2>Stability check</h2><div className={`stability ${stable.tone}`}><b>{stable.title}</b><span>{stable.text}</span></div></section>
    <section><h2>Resonance & octet exceptions</h2>{resonance[signature]?<p className="resonance-note">{resonance[signature]}</p>:exception?<p className="resonance-note">{exception}. The octet rule is a useful pattern, not a universal law.</p>:<p>No common resonance or octet exception is detected for this local structure.</p>}</section>
  </>;
}
