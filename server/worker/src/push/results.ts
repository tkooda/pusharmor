import type { Env } from "../env";
import * as SQL from "../db/sql";

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
// runs in another isolate, so the counts live in D1. Successes only need to be known as "some",
// so each isolate writes one success row per vendor and hour.
const okSeen = new Map<string, number>();

export function resetHealthCache(): void {
  okSeen.clear();
}

export function isAuthFailure(v: VendorName, status: number, code: string | undefined): boolean {
  if (v === "apns") return code === "apns-403-InvalidProviderToken" || code === "apns-429-TooManyProviderTokenUpdates";
  if (v === "fcm") return status === 401 || status === 403;
  return false;
}

export async function recordHealth(env: Env, v: VendorName, ok: boolean, authFailure: boolean, nowMs: number): Promise<void> {
  const hour = Math.floor(nowMs / 3600000);
  let sql: string;
  if (ok) {
    if (okSeen.get(v) === hour) return;
    okSeen.set(v, hour);
    sql = SQL.W_HEALTH_OK;
  } else if (authFailure) {
    sql = SQL.W_HEALTH_AUTH;
  } else {
    return;
  }
  try {
    await env.DB.prepare(sql).bind(v, hour).run();
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
  const rs = await env.DB.prepare(SQL.Q_HEALTH_HOUR).bind(hour).all<{ vendor: string; auth: number; ok: number }>();
  for (const r of rs.results) out[r.vendor] = { auth: r.auth, ok: r.ok };
  return out;
}
