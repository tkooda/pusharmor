// Parallel relay to vendors with retry, an 8 s budget per recipient, 6 connection slots,
// and the best-effort gone write-back.
import type { Env } from "../env";
import { nowS } from "../context";
import type { Log } from "../log";
import * as SQL from "../db/sql";
import { buildApns, apnsMayRemint } from "./apns";
import { deps, type Cls, type VendorRequest } from "./deps";
import { buildFcm } from "./fcm";
import { classify, isAuthFailure, recordHealth, type Outcome, type VendorName } from "./results";
import { MintError } from "./tokencache";
import { buildWebPush } from "./webpush";

export const SLOTS = 6;
export const MAX_RETRIES = 3;
export const BACKOFF_MS = [500, 1500, 3000];
export const BUDGET_MS = 8000;
export const ATTEMPT_MS = 5000;
export const PROBE_MS = 3000;
export const BODY_READ_CAP = 4096;
export const MAX_RECIPIENTS = 9;
export const TOKEN_MINTS = 2;
// 9 recipients x (1 + 3 retries + 1 auth refresh) + 2 token mints.
export const SUBREQUEST_WORST_CASE = MAX_RECIPIENTS * (1 + MAX_RETRIES + 1) + TOKEN_MINTS;

export interface Target {
  id: string;
  pushType: number;
  push: string; // stored push JSON as read
  m: string;
  cls: Cls;
  pk?: string;
}

export function vendorOf(pushType: number): VendorName {
  return pushType === 1 ? "fcm" : pushType === 2 || pushType === 5 ? "apns" : pushType === 6 ? "up" : "wp";
}

class Slots {
  private free = SLOTS;
  private waiters: (() => void)[] = [];
  async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
  }
  release(): void {
    const w = this.waiters.shift();
    if (w) w();
    else this.free++;
  }
}

async function build(env: Env, t: Target, force: boolean): Promise<VendorRequest> {
  const p = JSON.parse(t.push);
  if (t.pushType === 1) return buildFcm(env, p, t.m, t.cls, force);
  if (t.pushType === 2 || t.pushType === 5) return buildApns(env, t.pushType, p, t.m, t.cls, t.pk, force);
  return buildWebPush(env, p, t.m, t.cls, force);
}

// Reads at most BODY_READ_CAP bytes of a body, then cancels the rest.
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    while (n < BODY_READ_CAP) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      n += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(Math.min(n, BODY_READ_CAP));
  let o = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, all.length - o);
    all.set(c.subarray(0, take), o);
    o += take;
    if (o >= all.length) break;
  }
  return new TextDecoder().decode(all);
}

interface AttemptResult {
  outcome: Outcome;
  status: number;
}

async function attempt(v: VendorName, req: VendorRequest, timeoutMs: number): Promise<AttemptResult> {
  let res: Response;
  try {
    res = await deps.fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { outcome: { kind: "failed", code: "net", next: "retry" }, status: 0 };
  }
  let text = "";
  if (res.status >= 200 && res.status < 300) await res.body?.cancel().catch(() => {});
  else if (v === "up") await res.body?.cancel().catch(() => {});
  else {
    try {
      text = await readCapped(res);
    } catch {
      text = "";
    }
  }
  return { outcome: classify(v, res.status, text, res.headers.get("Retry-After")), status: res.status };
}

interface Delivery {
  result: string; // sent | gone | not listening | failed:$code
  code?: string;
  retried: boolean;
}

async function deliver(env: Env, t: Target, slots: Slots): Promise<Delivery> {
  const v = vendorOf(t.pushType);
  let deadline = 0;
  let retries = 0;
  let authUsed = false;
  let force = false;
  let last: Outcome = { kind: "failed", code: "net", next: "none" };
  for (;;) {
    await slots.acquire();
    let a: AttemptResult;
    try {
      if (deadline === 0) deadline = deps.now() + BUDGET_MS;
      const remaining = deadline - deps.now();
      if (remaining <= 0) {
        last = { kind: "failed", code: "net", next: "none" };
        break;
      }
      let req: VendorRequest;
      try {
        req = await build(env, t, force);
      } catch (e) {
        last = { kind: "failed", code: e instanceof MintError ? `${v}-auth` : `${v}-build`, next: "none" };
        break;
      }
      a = await attempt(v, req, Math.min(ATTEMPT_MS, remaining));
    } finally {
      slots.release();
    }
    last = a.outcome;
    await recordHealth(env, v, last.kind === "sent", isAuthFailure(v, a.status, last.code), deps.now());
    if (last.kind !== "failed") break;
    if (last.next === "auth" && !authUsed && (v !== "apns" || apnsMayRemint())) {
      authUsed = true;
      force = true;
      continue;
    }
    force = false;
    if (last.next !== "retry" || retries >= MAX_RETRIES) break;
    const wait = last.retryAfterMs ?? BACKOFF_MS[retries];
    if (deps.now() + wait >= deadline) break;
    retries++;
    await deps.sleep(wait);
  }
  const retried = retries > 0 || authUsed;
  if (last.kind === "sent") return { result: "sent", retried };
  if (last.kind === "gone") return { result: "gone", code: last.code, retried };
  if (last.kind === "not listening") return { result: "not listening", code: last.code, retried };
  return { result: "failed:" + (last.code ?? "net"), code: last.code, retried };
}

export interface FanoutOut {
  results: Record<string, string>;
  gone: { id: string; push: string }[];
  notListening: string[]; // ntfy 507
}

export async function fanout(env: Env, targets: Target[], log: Log): Promise<FanoutOut> {
  const slots = new Slots();
  const out: FanoutOut = { results: {}, gone: [], notListening: [] };
  const done = await Promise.all(targets.map((t) => deliver(env, t, slots)));
  targets.forEach((t, i) => {
    const d = done[i];
    out.results[t.id] = d.result;
    if (d.result === "gone") out.gone.push({ id: t.id, push: t.push });
    if (d.result === "not listening") out.notListening.push(t.id);
    log.recipients.push({ id: t.id, class: t.cls, bytes: t.m.length, result: d.result, vendor: d.code, retry: d.retried });
  });
  return out;
}

// Best-effort post-fan-out writes (W_GONE per gone recipient, W_PUSH_FAILED per ntfy 507 (cli
// rows only), plus extras such as W_SEEN).
export async function writeBack(env: Env, acct: string, out: FanoutOut, extra: D1PreparedStatement[], log: Log): Promise<void> {
  const now = nowS();
  const stmts = [
    ...out.gone.map((g) => env.DB.prepare(SQL.W_GONE).bind(g.id, acct, g.push)),
    ...out.notListening.map((id) => env.DB.prepare(SQL.W_PUSH_FAILED).bind(id, acct, now)),
    ...extra,
  ];
  if (!stmts.length) return;
  try {
    const rs = await env.DB.batch(stmts);
    for (const r of rs) log.addMeta(r.meta);
  } catch {
    log.gone_write = "failed";
  }
}

// UnifiedPush probe: one attempt, 3 s cap, no retry. Returns the outcome kind (not part of any reply).
export async function sendProbe(env: Env, push: { endpoint: string; p256dh: string; auth: string }, code: string): Promise<string> {
  try {
    const req = await buildWebPush(env, push, JSON.stringify({ probe: code }), "send", false);
    const res = await deps.fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_MS),
    });
    await res.body?.cancel().catch(() => {});
    const o = classify("up", res.status, "", null);
    return o.kind === "sent" ? "sent" : "failed:" + o.code;
  } catch {
    return "failed:net";
  }
}
