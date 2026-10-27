// Isolate-global token cache with a single-flight mint per key. Nothing persisted.
import { transportScoped } from "./deps";

export interface Cached {
  value: string;
  mintedAt: number; // ms
  useUntil: number; // ms; reuse while now < useUntil
}

const state = transportScoped("tokens", () => ({ cache: new Map<string, Cached>(), inflight: new Map<string, Promise<Cached>>() }));

// VAPID keys follow attacker-chosen push origins: bound the cache.
export const MAX_TOKENS = 256;
// A forced remint (auth refresh) of a token younger than this reuses it.
export const MIN_FORCE_MS = 60 * 1000;

// Thrown when mint() fails, so callers can tell a mint failure from other build errors.
export class MintError extends Error {}

// Only "vapid:" keys are bounded and evicted. Fixed vendor tokens ("apns", "fcm") never are.
const VAPID_PREFIX = "vapid:";

function put(cache: Map<string, Cached>, key: string, v: Cached, nowMs: number): void {
  cache.delete(key);
  if (key.startsWith(VAPID_PREFIX)) {
    let n = 0;
    for (const k of cache.keys()) if (k.startsWith(VAPID_PREFIX)) n++;
    if (n >= MAX_TOKENS) {
      for (const [k, x] of cache) if (k.startsWith(VAPID_PREFIX) && nowMs >= x.useUntil) { cache.delete(k); n--; }
    }
    for (const k of cache.keys()) {
      if (n < MAX_TOKENS) break;
      if (k.startsWith(VAPID_PREFIX)) { cache.delete(k); n--; }
    }
  }
  cache.set(key, v);
}

export async function getToken(key: string, mint: () => Promise<Cached>, nowMs: number, force = false): Promise<Cached> {
  const { cache, inflight } = state();
  const c = cache.get(key);
  if (c && nowMs < c.useUntil && (!force || nowMs - c.mintedAt < MIN_FORCE_MS)) return c;
  let p = inflight.get(key);
  if (!p) {
    p = mint().then(
      (v) => {
        put(cache, key, v, nowMs);
        inflight.delete(key);
        return v;
      },
      (e) => {
        inflight.delete(key);
        throw e instanceof MintError ? e : new MintError(String(e));
      },
    );
    inflight.set(key, p);
  }
  return p;
}

export function peekToken(key: string): Cached | undefined {
  return state().cache.get(key);
}

export function dropToken(key: string): void {
  state().cache.delete(key);
}
