// Rate-limit binding wrappers. A throwing limit() fails open for RL_IP, RL_PEER, RL_ACCT, RL_PAIR,
// RL_PROBE and fails closed (429) for RL_MAIL_EMAIL, RL_MAIL_IP, RL_MAIL_GLOBAL, RL_CODE.
import type { Env } from "../env";
import { rateLimited } from "../errors";
import type { Log } from "../log";

export type Binding = "RL_IP" | "RL_PEER" | "RL_MAIL_EMAIL" | "RL_MAIL_IP" | "RL_MAIL_GLOBAL" | "RL_CODE" | "RL_PAIR" | "RL_PROBE" | "RL_ACCT";
const FAIL_CLOSED = new Set<Binding>(["RL_MAIL_EMAIL", "RL_MAIL_IP", "RL_MAIL_GLOBAL", "RL_CODE"]);

// Returns true when the call may proceed.
export async function allow(env: Env, binding: Binding, key: string, log: Log): Promise<boolean> {
  try {
    const r = await env[binding].limit({ key });
    return r.success;
  } catch {
    log.rl_error.push(binding);
    return !FAIL_CLOSED.has(binding);
  }
}

// Throws 429 when over the limit.
export async function enforce(env: Env, binding: Binding, key: string, log: Log): Promise<void> {
  if (!(await allow(env, binding, key, log))) throw rateLimited(binding);
}

// RL_IP key: IPv4 as is, IPv6 by its /64 prefix.
export function ipKey(ip: string): string {
  if (!ip.includes(":")) return "ip:" + ip;
  const groups = expandIPv6(ip);
  return "ip:" + (groups ? groups.slice(0, 4).join(":") + "::/64" : ip);
}

function expandIPv6(ip: string): string[] | null {
  let s = ip.toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  // An embedded IPv4 tail only affects the last 32 bits, never the /64 prefix.
  const parts = s.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const tailLen = tail.reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0);
  const fill = parts.length === 2 ? 8 - head.length - tailLen : 0;
  if (fill < 0) return null;
  const all = [...head, ...Array(fill).fill("0"), ...tail];
  return all.map((g) => (g.includes(".") ? g : g.replace(/^0+(?=.)/, "")));
}

// RL_ACCT: one counter per account for every signed call and POST /peers, so 10 peers (or a
// register/evict churn) cannot multiply the per-peer limit.
export function enforceAccount(env: Env, acct: string, log: Log): Promise<void> {
  return enforce(env, "RL_ACCT", "acct:" + acct, log);
}
