"use client";

export type Subshell = { label: string; count: number; shell: number; kind: "s" | "p" | "d" | "f" };

const subshellColors = {
  s: "#c7ff5c",
  p: "#62d9ff",
  d: "#ff826b",
  f: "#c994ff",
};

export { subshellColors };

export default function AtomScene({
  symbol,
  atomicNumber,
  subshells,
  charge = 0,
  sharedElectrons = 0,
  sharedFrom = [],
}: {
  symbol: string;
  atomicNumber: number;
  subshells: Subshell[];
  charge?: number;
  sharedElectrons?: number;
  sharedFrom?: Array<{ color: string; label: string }>;
}) {
  let removal = Math.max(0, charge);
  const adjusted = [...subshells].reverse().map((subshell) => {
    const removed = Math.min(removal, subshell.count);
    removal -= removed;
    return { ...subshell, count: subshell.count - removed };
  }).reverse();
  if (charge < 0) adjusted[adjusted.length - 1] = {
    ...adjusted[adjusted.length - 1],
    count: adjusted[adjusted.length - 1].count + Math.abs(charge),
  };

  const shells = Math.max(...subshells.map((item) => item.shell));
  const center = 100;
  const radii = Array.from({ length: shells }, (_, index) => 29 + index * 18);
  const electrons = adjusted.flatMap((subshell) =>
    Array.from({ length: subshell.count }, (_, index) => ({ ...subshell, index })),
  );

  return (
    <svg className="atom-diagram" viewBox="0 0 200 200" role="img" aria-label={`Bohr model of ${symbol}`}>
      <g className="atom-shells">
        {radii.map((radius, index) => (
          <circle key={radius} cx={center} cy={center} r={radius} data-shell={index + 1} />
        ))}
      </g>
      <g className="atom-electrons">
        {electrons.map((electron, electronIndex) => {
          const isShared = electronIndex >= electrons.length - sharedElectrons;
          const shellElectrons = electrons.filter((item) => item.shell === electron.shell);
          const position = shellElectrons.findIndex(
            (item) => item.label === electron.label && item.index === electron.index,
          );
          const displayedShellCount = shellElectrons.length + (electron.shell === shells ? sharedFrom.length : 0);
          const angle = -Math.PI / 2 + (position * Math.PI * 2) / displayedShellCount;
          const radius = radii[electron.shell - 1];
          const x = (center + Math.cos(angle) * radius).toFixed(2);
          const y = (center + Math.sin(angle) * radius).toFixed(2);
          return (
            <g key={`${electron.label}-${electronIndex}`} className={isShared ? "shared-origin" : undefined} transform={`translate(${x} ${y})`}>
              {isShared && <circle r="7" className="shared-origin-ring" />}
              <circle r="4.6" className="electron-ring" />
              <circle r="3" fill={subshellColors[electron.kind]} />
            </g>
          );
        })}
        {sharedFrom.map((source, index) => {
          const outerElectrons = electrons.filter((electron) => electron.shell === shells).length;
          const angle = -Math.PI / 2 + ((outerElectrons + index) * Math.PI * 2) / (outerElectrons + sharedFrom.length);
          const radius = radii[shells - 1];
          const x = (center + Math.cos(angle) * radius).toFixed(2);
          const y = (center + Math.sin(angle) * radius).toFixed(2);
          return <g key={`shared-from-${index}`} className="shared-received" transform={`translate(${x} ${y})`}>
            <circle r="6.5" className="shared-received-ring" />
            <circle r="3" fill={source.color} />
            <title>{`Shared from ${source.label}`}</title>
          </g>;
        })}
      </g>
      <g className="atom-nucleus">
        <circle cx={center} cy={center} r="20" />
        <text x={center} y={center - 1}>{symbol}</text>
        <text x={center} y={center + 11}>{atomicNumber}p⁺</text>
      </g>
    </svg>
  );
}
