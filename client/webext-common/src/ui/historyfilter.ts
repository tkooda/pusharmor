// History filter chips (catalog History filter): "All", one chip per verified
// peer by name, "Unknown". Peer chips are hidden while History holds rows
// from only one peer; "Unknown" shows only while an Unknown row exists. A
// peer chip lists RECEIVED rows from that peer only. A filter that matches no
// rows stays on (History says "No matching messages"); only All shows every row.

import { sortByLabel } from "../model/sendsel.ts";

interface FilterRow {
  dir: "in" | "out";
  peer: string | null;
  sender: string;
}

export interface Chip {
  key: string; // "all", "unknown" or a peer id
  label: string;
}

/** active: the filter in force; it stays a choice when it no longer has rows (its last row deleted). */
export function historyChips(rows: FilterRow[], active?: Chip): Chip[] {
  const chips: Chip[] = [{ key: "all", label: "All" }];
  const peers = new Map<string, string>();
  for (const r of rows) if (r.dir === "in" && r.peer && !peers.has(r.peer)) peers.set(r.peer, r.sender);
  if (peers.size > 1) chips.push(...sortByLabel([...peers].map(([key, label]) => ({ key, label }))));
  if (rows.some((r) => r.dir === "in" && r.peer === null)) chips.push({ key: "unknown", label: "Unknown" });
  if (active && active.key !== "all" && !chips.some((c) => c.key === active.key)) chips.push(active);
  return chips;
}

export function applyFilter<T extends FilterRow>(rows: T[], key: string): { key: string; rows: T[] } {
  if (key === "all") return { key, rows };
  const out = key === "unknown" ? rows.filter((r) => r.dir === "in" && r.peer === null) : rows.filter((r) => r.dir === "in" && r.peer === key);
  return { key, rows: out };
}
