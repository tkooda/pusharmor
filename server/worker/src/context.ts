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
