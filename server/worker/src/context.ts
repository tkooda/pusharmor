// Per-request context passed to handlers.
import type { Env } from "./env";
import type { Log } from "./log";

export interface Ctx {
  env: Env;
  exec: ExecutionContext;
  req: Request;
  method: string;
  path: string;
  params: string[];
  body: Uint8Array;
  log: Log;
}

export function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

// accounts.created is stored to the UTC day, accounts.last_seen_month to the 30-day period.
export function dayStart(t: number): number {
  return t - (t % 86400);
}

export function monthStart(t: number): number {
  return t - (t % 2592000);
}
