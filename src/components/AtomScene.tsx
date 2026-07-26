"use client";

import { memo } from "react";

export type Subshell = { label: string; count: number; shell: number; kind: "s" | "p" | "d" | "f" };

const subshellColors = {
  s: "#cba6f7",
  p: "#89b4fa",
  d: "#fab387",
  f: "#b4befe",
};

export { subshellColors };

function AtomScene({
  symbol,
  atomicNumber,
  subshells,
  charge = 0,
  sharedElectrons = 0,
  sharedFrom = [],
  onElectronSelect,
}: {
  symbol: string;
  atomicNumber: number;
  subshells: Subshell[];
  charge?: number;
  sharedElectrons?: number;
  sharedFrom?: Array<{ color: string; label: string; subshell: string }>;
  onElectronSelect?: (electron: {
    label: string;
    kind: "s" | "p" | "d" | "f";
    shared: boolean;
    source?: string;
  }) => void;
}) {
  const adjusted = [...subshells]
    .reverse()
    .reduce<{ subshells: Subshell[]; remaining: number }>(
      (result, subshell) => {
        const removed = Math.min(result.remaining, subshell.count);
        result.subshells.push({ ...subshell, count: subshell.count - removed });
        result.remaining -= removed;
        return result;
      },
      { subshells: [], remaining: Math.max(0, charge) },
    )
    .subshells.reverse();
  if (charge < 0)
    adjusted[adjusted.length - 1] = {
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
    <svg className="atom-diagram" viewBox="0 0 200 200" aria-label={`Bohr model of ${symbol}`}>
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
          const displayedShellCount =
            shellElectrons.length + (electron.shell === shells ? sharedFrom.length : 0);
          const angle = -Math.PI / 2 + (position * Math.PI * 2) / displayedShellCount;
          const radius = radii[electron.shell - 1];
          const x = (center + Math.cos(angle) * radius).toFixed(2);
          const y = (center + Math.sin(angle) * radius).toFixed(2);
          return (
            <g
              key={`${electron.label}-${electronIndex}`}
              className={`diagram-electron${isShared ? " shared-origin" : ""}`}
              transform={`translate(${x} ${y})`}
              role={onElectronSelect ? "button" : undefined}
              tabIndex={onElectronSelect ? 0 : undefined}
              aria-label={`${electron.label} electron${isShared ? ", contributed to a bond" : ""}`}
              onClick={(event) => {
                event.stopPropagation();
                onElectronSelect?.({
                  label: electron.label,
                  kind: electron.kind,
                  shared: isShared,
                });
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onElectronSelect?.({
                    label: electron.label,
                    kind: electron.kind,
                    shared: isShared,
                  });
                }
              }}
            >
              {isShared && <circle r="7" className="shared-origin-ring" />}
              <circle r="4.6" className="electron-ring" />
              <circle r="3" fill={subshellColors[electron.kind]} />
            </g>
          );
        })}
        {sharedFrom.map((source, index) => {
          const outerElectrons = electrons.filter((electron) => electron.shell === shells).length;
          const angle =
            -Math.PI / 2 +
            ((outerElectrons + index) * Math.PI * 2) / (outerElectrons + sharedFrom.length);
          const radius = radii[shells - 1];
          const x = (center + Math.cos(angle) * radius).toFixed(2);
          const y = (center + Math.sin(angle) * radius).toFixed(2);
          return (
            <g
              key={`shared-from-${index}`}
              className="diagram-electron shared-received"
              transform={`translate(${x} ${y})`}
              role={onElectronSelect ? "button" : undefined}
              tabIndex={onElectronSelect ? 0 : undefined}
              aria-label={`${source.subshell} electron shared from ${source.label}`}
              onClick={(event) => {
                event.stopPropagation();
                onElectronSelect?.({
                  label: source.subshell,
                  kind: source.subshell.at(-1) as "s" | "p" | "d" | "f",
                  shared: true,
                  source: source.label,
                });
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onElectronSelect?.({
                    label: source.subshell,
                    kind: source.subshell.at(-1) as "s" | "p" | "d" | "f",
                    shared: true,
                    source: source.label,
                  });
                }
              }}
            >
              <circle r="6.5" className="shared-received-ring" />
              <circle r="3" fill={source.color} />
              <title>{`Shared from ${source.label}`}</title>
            </g>
          );
        })}
      </g>
      <g className="atom-nucleus">
        <circle cx={center} cy={center} r="20" />
        <text x={center} y={center - 1}>
          {symbol}
        </text>
        <text x={center} y={center + 11}>
          {atomicNumber}p⁺
        </text>
      </g>
    </svg>
  );
}

export default memo(AtomScene, (previous, next) => {
  const previousSources = previous.sharedFrom ?? [],
    nextSources = next.sharedFrom ?? [];
  if (
    previous.symbol !== next.symbol ||
    previous.atomicNumber !== next.atomicNumber ||
    previous.charge !== next.charge ||
    (previous.sharedElectrons ?? 0) !== (next.sharedElectrons ?? 0) ||
    previous.subshells.length !== next.subshells.length ||
    previousSources.length !== nextSources.length
  )
    return false;

  return (
    previous.subshells.every((subshell, index) => {
      const candidate = next.subshells[index];
      return (
        subshell.label === candidate.label &&
        subshell.count === candidate.count &&
        subshell.shell === candidate.shell &&
        subshell.kind === candidate.kind
      );
    }) &&
    previousSources.every((source, index) => {
      const candidate = nextSources[index];
      return (
        source.color === candidate.color &&
        source.label === candidate.label &&
        source.subshell === candidate.subshell
      );
    })
  );
});
