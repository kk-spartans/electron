import type { Subshell } from "@/components/AtomScene";

export function subshellsForElectronCount(count: number): Subshell[] {
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

export const subshellColors = {
  s: "#cba6f7",
  p: "#5b9cf5",
  d: "#e8945c",
  f: "#8b9dc3",
};
