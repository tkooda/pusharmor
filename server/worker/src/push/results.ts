// Vendor status -> result word (vendor-wrap section 6).
export type VendorName = "fcm" | "apns" | "wp" | "up";

export interface Outcome {
  kind: "sent" | "gone" | "failed" | "not listening";
  code?: string; // vendor code, e.g. "fcm-404-UNREGISTERED"
  next: "none" | "retry" | "auth";
  retryAfterMs?: number;
  log?: VendorDetail; // log-only detail; never part of a reply
  // Relay-side fault: the vendor refused our credentials or config (not the device's address).
  relay?: true;
}

// Vendor error detail for the log line only.
export interface VendorDetail {
  vendor: string; // e.g. "fcm-403-SENDER_ID_MISMATCH"
  status?: string; // e.g. "PERMISSION_DENIED"
  msg?: string; // vendor message, cleaned and cut to MSG_MAX characters
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

export const MSG_MAX = 120;
const WORD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

// Vendor message text safe to log: printable ASCII only, URLs and token-like runs (16+ chars
// of letters, digits, and token punctuation that include a digit) replaced, cut to MSG_MAX.
export function cleanMsg(m: unknown): string | undefined {
  if (typeof m !== "string") return undefined;
  let t = m.replace(/[^\x20-\x7e]/g, " ");
  t = t.replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, "[url]");
  t = t.replace(/[A-Za-z0-9_\-:.\/=+%~]{16,}/g, (w) => (/[0-9]/.test(w) || w.length >= 32 ? "[redacted]" : w));
  t = t.replace(/\s+/g, " ").trim().slice(0, MSG_MAX);
  return t || undefined;
}

// FCM v1 error detail: error.status, details[].errorCode, and the message.
export function fcmDetail(status: number, body: string): VendorDetail {
  let st: string | undefined;
  let ec: string | undefined;
  let msg: string | undefined;
  try {
    const e = JSON.parse(body)?.error;
    if (e && typeof e === "object") {
      if (typeof e.status === "string" && WORD.test(e.status)) st = e.status;
      if (Array.isArray(e.details)) {
        for (const d of e.details) {
          if (d && typeof d.errorCode === "string" && WORD.test(d.errorCode)) {
            ec = d.errorCode;
            break;
          }
        }
      }
      msg = cleanMsg(e.message);
    }
  } catch {
    // no detail
  }
  const r = ec ?? st;
  const out: VendorDetail = { vendor: r ? `fcm-${status}-${r}` : `fcm-${status}` };
  if (st) out.status = st;
  if (msg) out.msg = msg;
  return out;
}

// OAuth token endpoint error detail: {"error": "...", "error_description": "..."}.
export function oauthDetail(status: number, body: string): { code: string; msg?: string } {
  let err: string | undefined;
  let msg: string | undefined;
  try {
    const j = JSON.parse(body);
    if (j && typeof j.error === "string" && WORD.test(j.error)) err = j.error;
    msg = cleanMsg(j?.error_description);
  } catch {
    // no detail
  }
  return msg ? { code: err ? `${status}-${err}` : `${status}`, msg } : { code: err ? `${status}-${err}` : `${status}` };
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
  const o = classifyStatus(v, status, body, retryAfter);
  if (v === "fcm" && o.kind !== "sent" && status >= 400) o.log = fcmDetail(status, body);
  return o;
}

function classifyStatus(v: VendorName, status: number, body: string, retryAfter: string | null): Outcome {
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
    if (status === 401) return { kind: "failed", code: code(v, status, reason), next: "auth", relay: true };
    if (status === 429 || status >= 500) return { kind: "failed", code: code(v, status, reason), next: "retry", retryAfterMs: ra };
    if (status === 400 && reason === "INVALID_ARGUMENT") return { kind: "failed", code: code(v, status, reason), next: "none" };
    if (status === 403 && reason === "SENDER_ID_MISMATCH") return { kind: "failed", code: code(v, status, reason), next: "none" };
    if (status === 403) return { kind: "failed", code: code(v, status), next: "none", relay: true };
    return { kind: "failed", code: code(v, status), next: "none" };
  }
  if (v === "apns") {
    const reason = apnsReason(body);
    if (status === 200) return { kind: "sent", next: "none" };
    if (status === 410 && (reason === "Unregistered" || reason === "ExpiredToken")) {
      return { kind: "gone", code: code(v, status, reason), next: "none" };
    }
    if (status === 403 && (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken")) {
      return { kind: "failed", code: code(v, status, reason), next: "auth", relay: true };
    }
    if (status === 403 && reason === "MissingProviderToken") return { kind: "failed", code: code(v, status, reason), next: "none", relay: true };
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
  // Google and Mozilla push services refuse our VAPID key with 401/403; a UnifiedPush server's
  // 401/403 is about its own topic, not our credentials.
  if (status === 401 || status === 403) return v === "wp" ? { kind: "failed", code: code(v, status), next: "auth", relay: true } : { kind: "failed", code: code(v, status), next: "auth" };
  if (status === 429 || status >= 500) return { kind: "failed", code: code(v, status), next: "retry", retryAfterMs: ra };
  return { kind: "failed", code: code(v, status), next: "none" };
}
