// Isolate-global token cache with a single-flight mint per key. Nothing persisted.
export interface Cached {
  value: string;
  mintedAt: number; // ms
  useUntil: number; // ms; reuse while now < useUntil
}

const cache = new Map<string, Cached>();
const inflight = new Map<string, Promise<Cached>>();

export async function getToken(key: string, mint: () => Promise<Cached>, nowMs: number, force = false): Promise<Cached> {
  const c = cache.get(key);
  if (c && !force && nowMs < c.useUntil) return c;
  let p = inflight.get(key);
  if (!p) {
    p = mint().then(
      (v) => {
        cache.set(key, v);
        inflight.delete(key);
        return v;
      },
      (e) => {
        inflight.delete(key);
        throw e;
      },
    );
    inflight.set(key, p);
  }
  return p;
}

export function peekToken(key: string): Cached | undefined {
  return cache.get(key);
}

export function dropToken(key: string): void {
  cache.delete(key);
}

export function clearTokens(): void {
  cache.clear();
  inflight.clear();
}
