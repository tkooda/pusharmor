// Outbound I/O hooks (tests replace them with a local vendor mock and a fake clock).
export const deps = {
  fetch: (input: string, init: RequestInit): Promise<Response> => fetch(input, init),
  sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)),
  now: (): number => Date.now(),
};

// Isolate state scoped to the outbound transport: one scope per isolate in production
// (deps.fetch never changes); a newly installed transport starts with empty state.
const scopes = new WeakMap<object, Map<string, unknown>>();
export function transportScoped<T>(name: string, make: () => T): () => T {
  return () => {
    let m = scopes.get(deps.fetch);
    if (!m) {
      m = new Map();
      scopes.set(deps.fetch, m);
    }
    if (!m.has(name)) m.set(name, make());
    return m.get(name) as T;
  };
}

export type Cls = "send" | "approve" | "deny" | "peerchg" | "logout" | "pair";

export interface VendorRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: Uint8Array | string;
}

// Normal urgency for deny and logout, high for the rest.
export function isNormal(cls: Cls): boolean {
  return cls === "deny" || cls === "logout";
}

export function ttlFor(env: { PA_PUSH_TTL_SECONDS: string }): number {
  return Number(env.PA_PUSH_TTL_SECONDS);
}
