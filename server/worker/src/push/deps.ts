// Outbound I/O hooks (tests replace them with a local vendor mock and a fake clock).
export const deps = {
  fetch: (input: string, init: RequestInit): Promise<Response> => fetch(input, init),
  sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)),
  now: (): number => Date.now(),
};

export type Cls = "send" | "approve" | "deny" | "peerchg" | "pause" | "pair";

export interface VendorRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: Uint8Array | string;
}

// Normal urgency for deny and pause, high for the rest.
export function isNormal(cls: Cls): boolean {
  return cls === "deny" || cls === "pause";
}

export function ttlFor(cls: Cls, env: { PA_PUSH_TTL_SECONDS: string; PA_PUSH_PAIR_TTL_SECONDS: string }): number {
  return Number(cls === "pair" ? env.PA_PUSH_PAIR_TTL_SECONDS : env.PA_PUSH_TTL_SECONDS);
}
