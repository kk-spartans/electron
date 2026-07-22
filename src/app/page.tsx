"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Atom,
  HandGrabbing,
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

const compoundNames: Record<string, { formula: string; name: string }> = {
  ClNa: { formula: "NaCl", name: "sodium chloride" }, CO2: { formula: "CO₂", name: "carbon dioxide" },
  H2O: { formula: "H₂O", name: "water" }, CH4: { formula: "CH₄", name: "methane" },
  H3N: { formula: "NH₃", name: "ammonia" }, ClH: { formula: "HCl", name: "hydrogen chloride" },
  CO: { formula: "CO", name: "carbon monoxide" }, O2: { formula: "O₂", name: "oxygen" },
  N2: { formula: "N₂", name: "nitrogen" }, H2: { formula: "H₂", name: "hydrogen" },
  Cl2: { formula: "Cl₂", name: "chlorine" }, C2H6: { formula: "C₂H₆", name: "ethane" },
  C2H4: { formula: "C₂H₄", name: "ethene" }, C2H2: { formula: "C₂H₂", name: "ethyne" },
  H2O2: { formula: "H₂O₂", name: "hydrogen peroxide" }, O3: { formula: "O₃", name: "ozone" },
  O2S: { formula: "SO₂", name: "sulfur dioxide" }, O3S: { formula: "SO₃", name: "sulfur trioxide" },
  CaCl2: { formula: "CaCl₂", name: "calcium chloride" }, Cl2Mg: { formula: "MgCl₂", name: "magnesium chloride" },
  Fe2O3: { formula: "Fe₂O₃", name: "iron(III) oxide" }, Na2O: { formula: "Na₂O", name: "sodium oxide" },
  C6H6: { formula: "C₆H₆", name: "benzene" },
};

export default function Home() {
  const [atoms, setAtoms] = useState<AtomNode[]>(initialAtoms);
  const [bonds, setBonds] = useState<BondEdge[]>([{ id: 1, from: 1, to: 2, type: "ionic", order: 1 }]);
  const [selected, setSelected] = useState<number[]>([1]);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const [elementQuery, setElementQuery] = useState("");
  const [selectedBond, setSelectedBond] = useState<number | null>(null);
  const nextId = useRef(3);
  const canvasRef = useRef<HTMLElement>(null);
  const gesture = useRef<{ type: "pan" | "atom"; id?: number; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const active = atoms.find((atom) => atom.id === selected[selected.length - 1]);
  const activeElement = active ? elements[active.element] : null;
  const activeSubshells = active && activeElement ? subshellsForElectronCount(activeElement.z - active.charge + active.electronOffset) : [];
  const activeBond = bonds.find((bond) => bond.id === selectedBond);
  const visibleElements = allSymbols.filter((symbol) => symbol.toLowerCase().includes(elementQuery.toLowerCase()) || elements[symbol].name.toLowerCase().includes(elementQuery.toLowerCase()));

  const bondSummary = useMemo(() => {
    if (!active) return [];
    return bonds.filter((bond) => bond.from === active.id || bond.to === active.id);
  }, [active, bonds]);

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
      return [{ ...known, x: members.reduce((sum, atom) => sum + atom.x, 0) / members.length, y: Math.max(...members.map((atom) => atom.y)) + 125 }];
    });
  }, [atoms, bonds]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheel = (event: WheelEvent) => zoomCanvas(event);
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [pan, scale]);

  function addAtom(element: ElementKey, x?: number, y?: number) {
    const id = nextId.current++;
    const centerX = ((canvasRef.current?.clientWidth ?? 960) / 2 - pan.x) / scale;
    const centerY = ((canvasRef.current?.clientHeight ?? 620) / 2 - pan.y) / scale;
    setAtoms((items) => [...items, { id, element, x: x ?? centerX, y: y ?? centerY, charge: 0, electronOffset: 0 }]);
    setSelected([id]);
  }

  function selectAtom(id: number) {
    setSelectedBond(null);
    setSelected((current) => current[0] === id ? [] : [id]);
  }

  function stableBond(first: ElementKey, second: ElementKey): { type: BondType; order: 1 | 2 | 3 } | null {
    const noble = new Set(["He","Ne","Ar","Kr","Xe","Rn","Og"]);
    if (noble.has(first) || noble.has(second)) return null;
    const metals = new Set("Li Be Na Mg Al K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv".split(" "));
    const firstMetal = metals.has(first);
    const secondMetal = metals.has(second);
    if (firstMetal && secondMetal) return { type: "metallic", order: 1 };
    if (firstMetal !== secondMetal) return { type: "ionic", order: 1 };
    const pair = [first, second].sort().join("");
    if (pair === "NN") return { type: "covalent", order: 3 };
    if (pair === "OO" || pair === "CO") return { type: "covalent", order: 2 };
    return { type: "covalent", order: 1 };
  }

  function settleAtom(id: number) {
    const moved = atoms.find((atom) => atom.id === id);
    if (!moved) return;
    const nearby = atoms
      .filter((atom) => atom.id !== id)
      .map((atom) => ({ atom, distance: Math.hypot(atom.x - moved.x, atom.y - moved.y) }))
      .sort((a, b) => a.distance - b.distance)[0];

    setBonds((current) => {
      const kept = current.filter((bond) => {
        if (bond.from !== id && bond.to !== id) return true;
        const otherId = bond.from === id ? bond.to : bond.from;
        const other = atoms.find((atom) => atom.id === otherId);
        return Boolean(other && Math.hypot(other.x - moved.x, other.y - moved.y) <= 310);
      });
      if (!nearby || nearby.distance > 225) return kept;
      if (kept.some((bond) => (bond.from === id && bond.to === nearby.atom.id) || (bond.to === id && bond.from === nearby.atom.id))) return kept;
      const inferred = stableBond(moved.element, nearby.atom.element);
      if (!inferred) return kept;
      return [...kept, { id: Date.now(), from: id, to: nearby.atom.id, ...inferred }];
    });

    if (nearby && nearby.distance <= 225) {
      const inferred = stableBond(moved.element, nearby.atom.element);
      if (!inferred) return;
      if (inferred.type === "ionic") {
        const metals = new Set("Li Be Na Mg Al K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Cs Ba La Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Fr Ra Ac Th Pa U".split(" "));
        setAtoms((items) => items.map((atom) => atom.id === id || atom.id === nearby.atom.id
          ? { ...atom, charge: metals.has(atom.element) ? 1 : -1 }
          : atom));
      }
    }
  }

  function pointerMove(event: React.PointerEvent) {
    if (!gesture.current) return;
    const dx = event.clientX - gesture.current.sx;
    const dy = event.clientY - gesture.current.sy;
    if (gesture.current.type === "pan") setPan({ x: gesture.current.ox + dx, y: gesture.current.oy + dy });
    else setAtoms((items) => items.map((atom) => atom.id === gesture.current?.id ? { ...atom, x: gesture.current.ox + dx / scale, y: gesture.current.oy + dy / scale } : atom));
  }

  function zoomCanvas(event: WheelEvent) {
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const box = canvas.getBoundingClientRect();
    const pointerX = event.clientX - box.left;
    const pointerY = event.clientY - box.top;
    const nextScale = Math.min(2.5, Math.max(0.45, scale * Math.exp(-event.deltaY * 0.0015)));
    if (nextScale === scale) return;
    const worldX = (pointerX - pan.x) / scale;
    const worldY = (pointerY - pan.y) / scale;
    setPan({ x: pointerX - worldX * nextScale, y: pointerY - worldY * nextScale });
    setScale(nextScale);
  }

  return (
    <main className="lab-shell">
      <header className="lab-topbar">
        <div className="lab-brand"><span><Atom weight="bold" /></span><b>Orbital</b><small>2D bond workspace</small></div>
        <div className="subshell-key" aria-label="Subshell color key">
          {(Object.keys(subshellColors) as Array<keyof typeof subshellColors>).map((kind) => <span key={kind}><i style={{ background: subshellColors[kind] }} />{kind} subshell</span>)}
        </div>
        <div className="canvas-hint"><HandGrabbing /> Drag empty space to pan</div>
      </header>

      <div className="lab-layout">
        <aside className="element-tray">
          <div className="tray-heading"><b>Add atoms</b><small>Click or drag onto canvas</small></div>
          <label className="element-search"><MagnifyingGlass /><input value={elementQuery} onChange={(event) => setElementQuery(event.target.value)} placeholder="Search 118 elements" aria-label="Search elements" /></label>
          <div className="element-palette">
            {visibleElements.map((symbol) => {
              const item = elements[symbol];
              return <button key={symbol} draggable onDragStart={(event) => event.dataTransfer.setData("element", symbol)} onClick={() => addAtom(symbol)}><small>{item.z}</small><strong>{symbol}</strong><span>{item.name}</span><i>{item.valence} valence</i></button>;
            })}
          </div>
        </aside>

        <section ref={canvasRef} className="chem-canvas" aria-label="Interactive atom canvas"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => { const symbol = event.dataTransfer.getData("element") as ElementKey; const box = event.currentTarget.getBoundingClientRect(); if (symbol in elements) addAtom(symbol, (event.clientX - box.left - pan.x) / scale, (event.clientY - box.top - pan.y) / scale); }}
          onPointerDown={(event) => {
            const target = event.target as Element;
            if (!target.closest(".canvas-atom, .bond-toolbar, .bond-target")) {
              event.currentTarget.setPointerCapture(event.pointerId);
              gesture.current = { type: "pan", sx: event.clientX, sy: event.clientY, ox: pan.x, oy: pan.y };
            }
          }}
          onPointerMove={pointerMove} onPointerUp={() => { gesture.current = null; }}>
          <div className="bond-toolbar">
            <span><Atom /> Bonds form automatically at stable distance</span>
            <output className="zoom-level" aria-label="Canvas zoom">{Math.round(scale * 100)}%</output>
          </div>
          <div className="canvas-world">
            <svg className="bond-layer" width="1600" height="1000">
              {bonds.map((bond) => {
                const from = atoms.find((atom) => atom.id === bond.from); const to = atoms.find((atom) => atom.id === bond.to); if (!from || !to) return null;
                const x1=pan.x+from.x*scale,y1=pan.y+from.y*scale,x2=pan.x+to.x*scale,y2=pan.y+to.y*scale,mx=(x1+x2)/2,my=(y1+y2)/2;
                return <g key={bond.id} className={`bond-line ${bond.type} ${selectedBond === bond.id ? "selected" : ""}`}><line x1={x1} y1={y1} x2={x2} y2={y2} />{bond.order > 1 && <line x1={x1} y1={y1+8*scale} x2={x2} y2={y2+8*scale} />}{bond.type === "covalent" && Array.from({length:bond.order*2},(_,i)=><circle className="shared-electron" key={i} cx={mx+(i%2?5:-5)*scale} cy={my+(Math.floor(i/2)-(bond.order-1)/2)*10*scale} r={3*scale} />)}</g>;
              })}
            </svg>
            {bonds.map((bond) => { const from=atoms.find((atom)=>atom.id===bond.from),to=atoms.find((atom)=>atom.id===bond.to); if(!from||!to)return null; const mx=pan.x+(from.x+to.x)*scale/2,my=pan.y+(from.y+to.y)*scale/2; return <button key={`target-${bond.id}`} className="bond-target" style={{transform:`translate(${mx-42}px,${my-30}px)`}} aria-label={`Inspect ${bond.type} bond`} onClick={(event)=>{event.stopPropagation();setSelectedBond(bond.id);setSelected([]);}}>{bond.type}</button>;})}
            {namedCompounds.map((compound, index) => <div className="compound-label" key={`${compound.formula}-${index}`} style={{ transform: `translate(${pan.x + compound.x * scale}px, ${pan.y + compound.y * scale}px)` }}><b>{compound.formula}</b><span>{compound.name}</span></div>)}
            {atoms.map((atom) => {
              const item = elements[atom.element]; const isSelected = selected.includes(atom.id);
              const atomSize=200*scale;
              return <button className={`canvas-atom ${isSelected ? "selected" : ""}`} style={{ width:atomSize,height:atomSize,transform:`translate(${pan.x+atom.x*scale-atomSize/2}px, ${pan.y+atom.y*scale-atomSize/2}px)` }} key={atom.id}
                onClick={(event) => { event.stopPropagation(); selectAtom(atom.id); }}
                onPointerDown={(event) => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); gesture.current = { type: "atom", id: atom.id, sx: event.clientX, sy: event.clientY, ox: atom.x, oy: atom.y }; }}
                onPointerMove={pointerMove} onPointerUp={() => { const movedId = gesture.current?.id; gesture.current = null; if (movedId) window.setTimeout(() => settleAtom(movedId), 0); }} aria-label={`${item.name} atom`}>
                <AtomScene symbol={atom.element} atomicNumber={item.z} subshells={subshellsForElectronCount(item.z - atom.charge + atom.electronOffset)} />
                {atom.charge !== 0 && <span className={`atom-charge ${atom.charge > 0 ? "positive" : "negative"}`}>{atom.charge > 0 ? `+${atom.charge}` : atom.charge}</span>}
              </button>;
            })}
          </div>
          {atoms.length === 0 && <div className="canvas-empty"><Atom /><b>Place your first atom</b><span>Choose an element from the tray or drag it here.</span></div>}
        </section>

        <aside className="atom-inspector">
          {activeBond ? <BondInspector bond={activeBond} atoms={atoms} onClose={() => setSelectedBond(null)} onRemove={() => { setBonds((items) => items.filter((item) => item.id !== activeBond.id)); setAtoms((items) => items.map((atom) => atom.id === activeBond.from || atom.id === activeBond.to ? {...atom,charge:0}:atom)); setSelectedBond(null); }} /> : active && activeElement ? <>
            <div className="inspector-title"><div><small>Selected atom</small><h1>{activeElement.name}</h1><code>{activeElement.config}</code></div><button aria-label="Deselect atom" onClick={() => setSelected([])}><X /></button></div>
            <div className="atom-preview"><AtomScene symbol={active.element} atomicNumber={activeElement.z} subshells={activeSubshells} /></div>
            <section><h2>Occupied subshells</h2><div className="subshell-list">{activeSubshells.map((subshell) => <div key={subshell.label}><i style={{ background: subshellColors[subshell.kind] }} /><b>{subshell.label}</b><span>{subshell.count} electrons</span></div>)}</div></section>
            <section><h2>Why it changes</h2><p>{activeElement.note}</p>{active.charge !== 0 && <p className="change-note">This atom is shown as {active.charge > 0 ? `a ${active.charge}+ cation after losing outer electrons` : `a ${Math.abs(active.charge)}− anion after gaining electrons`}.</p>}</section>
            <section><h2>Connected bonds</h2>{bondSummary.length ? <div className="bond-summary">{bondSummary.map((bond) => <div key={bond.id}><span><i className={bond.type} />{bond.type} bond</span><button aria-label={`Remove ${bond.type} bond`} onClick={() => { setBonds((items) => items.filter((item) => item.id !== bond.id)); setAtoms((items) => items.map((atom) => atom.id === bond.from || atom.id === bond.to ? { ...atom, charge: 0 } : atom)); }}><X /></button></div>)}</div> : <p>No bond. Move this atom close to a compatible atom.</p>}</section>
            <section className="electron-demo"><h2>Electron filling demonstration</h2><p>{bondSummary.length ? "Remove the bond before changing this atom’s electron count." : "Step through Aufbau filling and outer-electron removal."}</p><div><button disabled={bondSummary.length>0} onClick={() => setAtoms((items) => items.map((atom) => atom.id === active.id ? {...atom,electronOffset:atom.electronOffset-1}:atom))}>Remove electron</button><b>{activeElement.z-active.charge+active.electronOffset} e⁻</b><button disabled={bondSummary.length>0} onClick={() => setAtoms((items) => items.map((atom) => atom.id === active.id ? {...atom,electronOffset:atom.electronOffset+1}:atom))}>Add electron</button></div><small>{activeSubshells.at(-1)?.label} is the active subshell</small></section>
            <div className="inspector-actions"><button className="danger" onClick={() => { setAtoms((items) => items.filter((atom) => atom.id !== active.id)); setBonds((items) => items.filter((bond) => bond.from !== active.id && bond.to !== active.id)); setSelected([]); }}><Trash /> Remove atom</button></div>
          </> : <div className="inspector-empty"><Atom /><b>Select an atom</b><span>Its configuration, subshells, charge, and bonds will appear here.</span></div>}
        </aside>
      </div>
    </main>
  );
}

function BondInspector({bond,atoms,onClose,onRemove}:{bond:BondEdge;atoms:AtomNode[];onClose:()=>void;onRemove:()=>void}) {
  const from=atoms.find((atom)=>atom.id===bond.from)!; const to=atoms.find((atom)=>atom.id===bond.to)!;
  const metal = new Set(["Na","Fe","Li","K","Mg","Ca","Al"]);
  const donor=metal.has(from.element)?from:to; const receiver=donor===from?to:from;
  return <div className="bond-inspector"><div className="inspector-title"><div><small>Selected bond</small><h1>{from.element} {bond.type === "ionic" ? "→" : "—"} {to.element}</h1><code>{bond.type} bond</code></div><button onClick={onClose}><X /></button></div><section><h2>Electron behavior</h2>{bond.type === "ionic" ? <p><b>{donor.element}</b> donates an outer electron to <b>{receiver.element}</b>. They become oppositely charged ions held by electrostatic attraction.</p> : bond.type === "covalent" ? <p>The atoms share <b>{bond.order*2} electrons</b>, forming {bond.order === 1 ? "one shared pair" : `${bond.order} shared pairs`}. The paired dots are drawn directly on the bond.</p> : <p>Valence electrons are delocalized across the metal atoms rather than belonging to one pair.</p>}</section><button className="remove-bond" onClick={onRemove}><Trash /> Remove bond</button></div>;
}
