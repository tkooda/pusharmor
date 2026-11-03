// Vendor status -> result word (vendor-wrap section 6).
export type VendorName = "fcm" | "apns" | "wp" | "up";

export interface Outcome {
  kind: "sent" | "gone" | "failed" | "not listening";
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

// True when an FCM 400 body blames the request rather than the token: a field violation on
// a field other than message.token, or a message-too-big text. The token is then still valid.
export function fcmRequestFault(body: string): boolean {
  try {
    const e = JSON.parse(body)?.error;
    if (!e || typeof e !== "object") return false;
    if (typeof e.message === "string" && /too (big|large)/i.test(e.message)) return true;
    if (Array.isArray(e.details)) {
      for (const d of e.details) {
        if (!d || !Array.isArray(d.fieldViolations)) continue;
        for (const f of d.fieldViolations) {
          if (f && typeof f.field === "string" && f.field !== "message.token") return true;
        }
      }
    }
  } catch {
    // no detail
  }
  return false;
}

// True when a Web Push 400 body is an autopush error (it carries an errno). Autopush reports a
// dead subscription as 404 or 410 and uses 400 only for request header faults.
function autopushRequestFault(body: string): boolean {
  try {
    return typeof JSON.parse(body)?.errno === "number";
  } catch {
    return false;
  }
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
    // Any 404, and a 400 INVALID_ARGUMENT that does not blame the request, mean the token is
    // dead or malformed. The payload is fixed and size-bounded, so the token is the variable part.
    if (status === 404) return { kind: "gone", code: code(v, status, reason), next: "none" };
    if (status === 400 && reason === "INVALID_ARGUMENT" && !fcmRequestFault(body)) {
      return { kind: "gone", code: code(v, status, reason), next: "none" };
    }
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
  // wp and up. ntfy 507: no subscriber of an "up" topic in the last 24 h.
  if (v === "up" && status === 507) return { kind: "not listening", code: code(v, status), next: "none" };
  if (status >= 200 && status < 300) return { kind: "sent", next: "none" };
  if (status === 404 || status === 410) return { kind: "gone", code: code(v, status), next: "none" };
  // A 400 means the vendor rejects the endpoint (e.g. an ntfy topic it no longer accepts), except
  // an autopush 400, which names a request header fault. The up body is not read, so up is gone.
  if (status === 400 && !(v === "wp" && autopushRequestFault(body))) return { kind: "gone", code: code(v, status), next: "none" };
  if (status === 401 || status === 403) return { kind: "failed", code: code(v, status), next: "auth" };
  if (status === 429 || status >= 500) return { kind: "failed", code: code(v, status), next: "retry", retryAfterMs: ra };
  return { kind: "failed", code: code(v, status), next: "none" };
}
