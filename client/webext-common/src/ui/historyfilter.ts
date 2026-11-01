// History filter chips (catalog History filter): "All", one chip per verified
// peer by name, "Unknown". Peer chips are hidden while History holds rows
// from only one peer; "Unknown" shows only while an Unknown row exists. A
// peer chip lists RECEIVED rows from that peer only. The filter resets to All
// when it has no rows left.

import { sortByLabel } from "../model/sendsel.ts";

export interface FilterRow {
  dir: "in" | "out";
  peer: string | null;
  sender: string;
}

export interface Chip {
  key: string; // "all", "unknown" or a peer id
  label: string;
}

export function historyChips(rows: FilterRow[]): Chip[] {
  const chips: Chip[] = [{ key: "all", label: "All" }];
  const peers = new Map<string, string>();
  for (const r of rows) if (r.dir === "in" && r.peer && !peers.has(r.peer)) peers.set(r.peer, r.sender);
  if (peers.size > 1) chips.push(...sortByLabel([...peers].map(([key, label]) => ({ key, label }))));
  if (rows.some((r) => r.dir === "in" && r.peer === null)) chips.push({ key: "unknown", label: "Unknown" });
  return chips;
}

export function applyFilter<T extends FilterRow>(rows: T[], key: string): { key: string; rows: T[] } {
  if (key === "all") return { key, rows };
  const out = key === "unknown" ? rows.filter((r) => r.dir === "in" && r.peer === null) : rows.filter((r) => r.dir === "in" && r.peer === key);
  if (out.length === 0 || !historyChips(rows).some((c) => c.key === key)) return { key: "all", rows };
  return { key, rows: out };
}
