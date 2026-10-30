import type { Env } from "../env";
import * as SQL from "../db/sql";
import { globalDb } from "../db/shard";

// Vendor status -> result word (vendor-wrap section 6).
export type VendorName = "fcm" | "apns" | "wp" | "up";

export interface Outcome {
  kind: "sent" | "gone" | "failed";
  code?: string; // vendor code, e.g. "fcm-404-UNREGISTERED"
  next: "none" | "retry" | "auth";
  retryAfterMs?: number;
}

// Reason words that may appear in a result code. Anything else is dropped from the code.
const FCM_REASONS = new Set([
  "UNREGISTERED",
  "INVALID_ARGUMENT",
  "SENDER_ID_MISMATCH",
  "QUOTA_EXCEEDED",
  "UNAVAILABLE",
  "INTERNAL",
  "THIRD_PARTY_AUTH_ERROR",
]);
const APNS_REASON = /^[A-Za-z]{1,64}$/;

export function fcmReason(body: string): string | undefined {
  try {
    const e = JSON.parse(body)?.error;
    if (!e || typeof e !== "object") return undefined;
    if (Array.isArray(e.details)) {
      for (const d of e.details) {
        if (d && typeof d.errorCode === "string" && FCM_REASONS.has(d.errorCode)) return d.errorCode;
      }
    }
    if (typeof e.status === "string" && FCM_REASONS.has(e.status)) return e.status;
  } catch {
    // no reason
  }
  return undefined;
}

export function apnsReason(body: string): string | undefined {
  try {
    const r = JSON.parse(body)?.reason;
    return typeof r === "string" && APNS_REASON.test(r) ? r : undefined;
  } catch {
    return undefined;
  }
}

export function parseRetryAfter(v: string | null): number | undefined {
  if (v === null || !/^[0-9]{1,6}$/.test(v.trim())) return undefined;
  return Number(v.trim()) * 1000;
}

function code(v: VendorName, status: number, reason?: string): string {
  return reason ? `${v}-${status}-${reason}` : `${v}-${status}`;
}

export function classify(v: VendorName, status: number, body: string, retryAfter: string | null): Outcome {
  if (status >= 300 && status < 400) return { kind: "failed", code: `${v}-3xx`, next: "none" };
  const ra = parseRetryAfter(retryAfter);
  if (v === "fcm") {
    const reason = fcmReason(body);
    if (status === 200) return { kind: "sent", next: "none" };
    if (status === 404 && reason === "UNREGISTERED") return { kind: "gone", code: code(v, status, reason), next: "none" };
    if (status === 401) return { kind: "failed", code: code(v, status, reason), next: "auth" };
    if (status === 429 || status >= 500) return { kind: "failed", code: code(v, status, reason), next: "retry", retryAfterMs: ra };
    if (status === 400 && reason === "INVALID_ARGUMENT") return { kind: "failed", code: code(v, status, reason), next: "none" };
    if (status === 403 && reason === "SENDER_ID_MISMATCH") return { kind: "failed", code: code(v, status, reason), next: "none" };
    return { kind: "failed", code: code(v, status), next: "none" };
  }
  if (v === "apns") {
    const reason = apnsReason(body);
    if (status === 200) return { kind: "sent", next: "none" };
    if (status === 410 && (reason === "Unregistered" || reason === "ExpiredToken")) {
      return { kind: "gone", code: code(v, status, reason), next: "none" };
    }
    if (status === 403 && (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken")) {
      return { kind: "failed", code: code(v, status, reason), next: "auth" };
    }
    if (status === 429 && reason === "TooManyProviderTokenUpdates") return { kind: "failed", code: code(v, status, reason), next: "none" };
    if (status === 429 || status === 500 || status === 503) {
      return { kind: "failed", code: code(v, status, reason), next: "retry", retryAfterMs: ra };
    }
    return { kind: "failed", code: code(v, status, reason), next: "none" };
  }
  // wp and up
  if (status >= 200 && status < 300) return { kind: "sent", next: "none" };
  if (status === 404 || status === 410) return { kind: "gone", code: code(v, status), next: "none" };
  if (status === 401 || status === 403) return { kind: "failed", code: code(v, status), next: "auth" };
  if (status === 429 || status >= 500) return { kind: "failed", code: code(v, status), next: "retry", retryAfterMs: ra };
  return { kind: "failed", code: code(v, status), next: "none" };
}

// Vendor auth alert counters (D1, per UTC hour): auth-type failures vs successes. The hourly cron
// runs in another isolate, so the counts live in D1. Only failures of OUR credentials count; a
// per-token error (a token from another Firebase project, a bad or expired device token) is the
// caller's problem and must not reach the shared row. Writes are batched per isolate: counts
// collect in memory and go to D1 at most once per vendor per HEALTH_FLUSH_MS (the first event
// of a window is written at once, so an hour with any failure or success is never empty).
// Successes only need to be known as "some", so each isolate counts (and writes at once) one
// success per vendor and hour.
export const HEALTH_FLUSH_MS = 60000;

interface Pending {
  hour: number;
  auth: number;
  ok: number;
  okSeen: boolean;
  last: number;
}
const health = new Map<string, Pending>();

export function resetHealthCache(): void {
  health.clear();
}

export function isAuthFailure(v: VendorName, status: number, code: string | undefined): boolean {
  if (v === "apns") return code === "apns-403-InvalidProviderToken" || code === "apns-429-TooManyProviderTokenUpdates";
  if (v === "fcm") return status === 401 || (status === 403 && code !== "fcm-403-SENDER_ID_MISMATCH");
  return false;
}

export async function recordHealth(env: Env, v: VendorName, ok: boolean, authFailure: boolean, nowMs: number): Promise<void> {
  if (!ok && !authFailure) return;
  const hour = Math.floor(nowMs / 3600000);
  let p = health.get(v);
  if (!p) {
    p = { hour, auth: 0, ok: 0, okSeen: false, last: -Infinity };
    health.set(v, p);
  }
  const stmts: D1PreparedStatement[] = [];
  try {
    if (p.hour !== hour) {
      // Left-over counts of the previous hour go out with this write.
      if (p.auth || p.ok) stmts.push(globalDb(env).prepare(SQL.W_HEALTH_ADD).bind(v, p.hour, p.auth, p.ok));
      p.hour = hour;
      p.auth = 0;
      p.ok = 0;
      p.okSeen = false;
      p.last = -Infinity;
    }
    // The first success of the hour is written at once: a retry that succeeds right after an
    // auth failure must not leave the hour looking like "only auth failures".
    const firstOk = ok && !p.okSeen;
    if (authFailure) p.auth++;
    else if (firstOk) {
      p.okSeen = true;
      p.ok = 1;
    }
    if (!stmts.length && !firstOk && (nowMs - p.last < HEALTH_FLUSH_MS || (!p.auth && !p.ok))) return;
    const auth = p.auth;
    const okN = p.ok;
    if (auth || okN) stmts.push(globalDb(env).prepare(SQL.W_HEALTH_ADD).bind(v, hour, auth, okN));
    // Claimed before the await, so concurrent sends in this isolate do not all write.
    p.auth = 0;
    p.ok = 0;
    p.last = nowMs;
    try {
      if (stmts.length === 1) await stmts[0].run();
      else if (stmts.length) await globalDb(env).batch(stmts);
    } catch {
      // Keep the counts for the next call.
      p.auth += auth;
      p.ok += okN;
      p.last = -Infinity;
    }
  } catch {
    // Health counting must never fail a delivery.
  }
}

// Vendors whose counts for the given hour show only auth failures and no success.
export async function authAlerts(env: Env, hour: number): Promise<string[]> {
  const snap = await healthSnapshot(env, hour);
  return Object.keys(snap).filter((v) => snap[v].auth > 0 && snap[v].ok === 0).sort();
}

export async function healthSnapshot(env: Env, hour: number): Promise<Record<string, { auth: number; ok: number }>> {
  const out: Record<string, { auth: number; ok: number }> = {};
  const rs = await globalDb(env).prepare(SQL.Q_HEALTH_HOUR).bind(hour).all<{ vendor: string; auth: number; ok: number }>();
  for (const r of rs.results) out[r.vendor] = { auth: r.auth, ok: r.ok };
  return out;
}
