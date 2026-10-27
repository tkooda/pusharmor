// storage.local state: pairing entries ("pair:" + peer id), the automatic
// reply cap ("pair_auto"), the persisted allow set, Retry-After gates.
import type { KV } from "../platform.ts";
import type { PairState, Role } from "../model/pairdecide.ts";

export const PAIR_PREFIX = "pair:";
export const PAIR_AUTO = "pair_auto";
export const PAIR_MSG_PREFIX = "pairmsg:";
export const ALLOW_SET = "allow";
export const NET_NOT_BEFORE = "net_not_before";
export const REG_MARKER = "registered";

export interface PairEntry {
  role: Role;
  state: PairState;
  pk: string;
  r: string; // own r (b64url), wiped with the entry
  c_N: string; // N: own commit; X: the commit received
  keys?: { sign_pub: string; enc_pub: string }; // pinned keys of this pairing
  started: number;
  fingerprint?: string;
  authorized?: boolean; // X only
  unsent?: boolean; // X only
  not_before?: number;
  msg?: string; // last pair message sent (commit, reply or open)
  last_send?: number;
  last_result?: string;
  approved?: boolean; // this device tapped Approve
  approve_body?: string; // stored POST /approve body (same bytes on re-fetch)
  approve_name?: string; // own name when approve_body was built
  approve_result?: string;
  approve_last?: number;
}

export const pairKeyOf = (id: string) => PAIR_PREFIX + id;

/** Serialized async lock (one in-memory promise chain) for pairing writes. */
export class Lock {
  private chain: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }
}

export async function getEntry(kv: KV, id: string): Promise<PairEntry | null> {
  const k = pairKeyOf(id);
  const v = await kv.get([k]);
  return (v[k] as PairEntry | undefined) ?? null;
}

export async function allEntries(kv: KV): Promise<Map<string, PairEntry>> {
  const all = await kv.get(null);
  const out = new Map<string, PairEntry>();
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(PAIR_PREFIX)) out.set(k.slice(PAIR_PREFIX.length), v as PairEntry);
  }
  return out;
}

export async function getAllowSet(kv: KV): Promise<string[]> {
  const v = await kv.get([ALLOW_SET]);
  return (v[ALLOW_SET] as string[] | undefined) ?? [];
}
