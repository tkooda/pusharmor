// storage.local state: pairing entries ("pair:" + peer id), the automatic
// reply cap ("pair_auto"), the persisted allow set, Retry-After gates.
import type { KV } from "../platform.ts";
import type { PairState, Role } from "../model/pairdecide.ts";
import { SEND_SEL_KEY } from "../model/sendsel.ts";

export const PAIR_PREFIX = "pair:";
export const PAIR_AUTO = "pair_auto";
export const PAIR_MSG_PREFIX = "pairmsg:";
/** Commits from an unlisted sender kept while GET /peers could not run; decided again after the next fetch. */
export const PAIR_HELD = "pair_held";
export const ALLOW_SET = "allow";
export const NET_NOT_BEFORE = "net_not_before";
/** storage.local: the extension version that got HTTP 426. It stops counting once the version changes. */
export const UPDATE_NEEDED = "update_needed";
/** storage.local: when "Check again" on the update screen last asked the relay server (ms). */
export const RECHECK_AT = "recheck_at";
export const REG_MARKER = "registered";

/** A storage.local key of the active account (it moves on an account switch); the rest belong to the device. */
export function accountKey(k: string): boolean {
  return k.startsWith(PAIR_PREFIX) || k.startsWith(PAIR_MSG_PREFIX) || [PAIR_AUTO, PAIR_HELD, ALLOW_SET, NET_NOT_BEFORE, REG_MARKER, SEND_SEL_KEY].includes(k);
}
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
  wait_from?: number; // start of the current no-reply window (ms); started when absent
  last_result?: string;
  approved?: boolean; // this device tapped Approve
  approve_body?: string; // stored POST /approve body (same bytes on re-fetch)
  approve_name?: string; // own name when approve_body was built
  approve_result?: string;
  approve_last?: number;
  half?: boolean; // the device started a new pairing while this one was open (row offers Pair again)
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
