// POST /v1/file: streamed upload of one encrypted file blob (nonce + ciphertext + tag).
// Check order: 1 Content-Length and headers, 2 PA-Time, 3 PA-ID MAC, 4 one D1 read, 5 caller
// checks with PA-FILE1, 6 approved by another peer, 7 RL_FILE, 8 pause and storage cap,
// 9 quota charge, 10 stream the body to storage. Steps 1-8 never charge the quota.
import type { Ctx } from "../context";
import { b64urlDecode } from "../codec/b64url";
import { hmac } from "../crypto/hash";
import { all } from "../db/d1";
import * as SQL from "../db/sql";
import { ApiError } from "../errors";
import { json } from "../http";
import { enforce } from "../pipeline/limits";
import { fileSignedBytes } from "../pipeline/signed";
import { nextDay, type Quota } from "../file/quota";
import { storeDeps } from "../file/store";
import { callerCheck, signedStart, type CallerRow } from "./common";

export const MAX_FILE = 100_000_000; // largest plaintext in bytes
export const BLOB_OVERHEAD = 28; // 12-byte nonce + 16-byte tag
export const FILE_HOST = "https://b2file.pusharmor.com/";

// Lifetime in minutes for a plaintext size in bytes: min(24 h, 240 MB-hours / size in MB),
// rounded down to the minute. Lives only here; clients show the expires value they get back.
export function ttlMinutes(size: number): number {
  return size === 0 ? 1440 : Math.min(1440, Math.floor(14_400_000_000 / size));
}

// UTC YYYYMMDDHHMM of the minute holding unix second t.
export function minuteOf(t: number): string {
  return new Date(Math.floor(t / 60) * 60_000).toISOString().replace(/[-T:]/g, "").slice(0, 12);
}

// First 16 lowercase hex of HMAC-SHA256(FILE_ACCT_SECRET, raw account id bytes).
export async function acctHash(secret: string, acct: string): Promise<string> {
  const raw = b64urlDecode(acct);
  if (!raw) throw new Error("account");
  return hex(await hmac(secret, raw)).slice(0, 16);
}

export function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export interface FileName {
  id: string;
  key: string;
  url: string;
}

// id = expiry minute + "-" + 32 hex; key = "v1/" + minute + "/" + acct-hash + "/" + id.
export function fileName(minute: string, hash: string, randHex: string): FileName {
  const id = minute + "-" + randHex;
  const key = "v1/" + minute + "/" + hash + "/" + id;
  return { id, key, url: FILE_HOST + key };
}

// Quota vars: a decimal integer each; 0 = paused. Missing, empty, or anything else: paused
// (fail closed) with an alert.
export function quotaLimits(env: { PA_FILE_DAY_LIMIT?: string; PA_FILE_MONTH_LIMIT?: string }): { day: number; month: number } | "paused" | "config" {
  const p = (v: string | undefined) => (v !== undefined && /^[0-9]{1,9}$/.test(v) ? Number(v) : null);
  const day = p(env.PA_FILE_DAY_LIMIT);
  const month = p(env.PA_FILE_MONTH_LIMIT);
  if (day === null || month === null) return "config";
  if (day === 0 || month === 0) return "paused";
  return { day, month };
}

// A storage cap seen by this isolate: refuse uploads before the charge until 00:00 UTC.
let capUntil = 0;
// Conditions already alerted by this isolate: "config" once, "cap" once per cap period.
const alerted = new Set<string>();
export const testing = {
  reset(): void {
    capUntil = 0;
    alerted.clear();
  },
};

// 503 "files paused". Alerts only the first time this isolate sees the condition.
function paused(c: Ctx, why: "paused" | "config" | "cap", retryAfter?: number): ApiError {
  c.log.file = why;
  const key = why === "cap" ? "cap:" + capUntil : why;
  if (why !== "paused" && !alerted.has(key)) {
    alerted.add(key);
    c.log.fileAlert = true;
  }
  return new ApiError(503, "files paused", retryAfter === undefined ? undefined : { retry_after: retryAfter });
}

const SEND_ID = /^[A-Za-z0-9_-]{22}$/;
const SHA = /^[A-Za-z0-9_-]{43}$/;

function quotaRetryAfter(q: Quota, now: number): number {
  let t = now;
  if (q.day.used >= q.day.limit) t = Math.max(t, q.day.resets_at);
  if (q.month.used >= q.month.limit) t = Math.max(t, q.month.resets_at);
  return Math.max(1, t - now);
}

export async function uploadFile(c: Ctx): Promise<Response> {
  const h = c.req.headers;
  // 1. Content-Length, PA-Send-ID, PA-File-SHA256.
  const cl = h.get("Content-Length");
  if (cl === null) throw new ApiError(411, "length required");
  if (!/^(0|[1-9][0-9]*)$/.test(cl)) throw new ApiError(400, "bad request");
  const length = Number(cl);
  if (length > MAX_FILE + BLOB_OVERHEAD) throw new ApiError(413, "too large");
  if (length < BLOB_OVERHEAD) throw new ApiError(400, "bad request");
  c.log.body_bytes = length;
  const sendId = h.get("PA-Send-ID");
  if (sendId === null || !SEND_ID.test(sendId) || b64urlDecode(sendId)?.length !== 16) throw new ApiError(400, "bad request");
  const shaB64 = h.get("PA-File-SHA256");
  const sha = shaB64 === null || !SHA.test(shaB64) ? null : b64urlDecode(shaB64);
  if (!sha || sha.length !== 32) throw new ApiError(400, "bad request");
  // 2, 3.
  const s = await signedStart(c);
  // 4. One D1 read: caller row and approval by another peer.
  const rows = await all<CallerRow & { approved: number }>(c.env.DB.prepare(SQL.Q_FILE).bind(s.me, s.acct));
  const caller = rows[0];
  // 5. Key hash, PA-Sig over PA-FILE1, RL_PEER, logged out, RL_ACCT.
  await callerCheck(c, s, caller, false, fileSignedBytes(s.paTime, length, shaB64!, sendId));
  // 6.
  if (caller.approved !== 1) throw new ApiError(403, "unapproved");
  // 7. Every attempt counts.
  await enforce(c.env, "RL_FILE", "file:" + s.me, c.log);
  // 8. Pause vars, a remembered storage cap, storage and acct-hash secret configured.
  const limits = quotaLimits(c.env);
  if (typeof limits === "string") throw paused(c, limits);
  const now = Math.floor(Date.now() / 1000);
  if (now < capUntil) throw paused(c, "cap", capUntil - now);
  const store = storeDeps.store(c.env);
  let hash: string;
  try {
    hash = await acctHash(c.env.FILE_ACCT_SECRET, s.acct);
  } catch {
    throw paused(c, "config");
  }
  if (!store) throw paused(c, "config");
  // 9. Charge the account (a free retry when PA-Send-ID matches this device's last charged send).
  const q = c.env.FILE_QUOTA.get(c.env.FILE_QUOTA.idFromName(s.acct));
  const r = await q.charge(s.me, sendId, limits.day, limits.month, now);
  if (!r.ok) throw new ApiError(429, "file quota", { quota: r.quota, retry_after: quotaRetryAfter(r.quota, now) });
  if (r.charged) {
    const day = r.quota.day.used === r.quota.day.limit;
    const month = r.quota.month.used === r.quota.month.limit;
    if (day || month) c.log.file = day && month ? "day-cap,month-cap" : day ? "day-cap" : "month-cap";
  }
  // 10. expires is fixed here, at accept time; a slow upload uses part of the lifetime.
  // TODO: an upload still streaming when its expiry passes is not handled yet (no rule to abort
  // it or to refuse the 201); the object then lives until the cleanup of its expiry minute.
  const expires = now + ttlMinutes(length - BLOB_OVERHEAD) * 60;
  const name = fileName(minuteOf(expires), hash, hex(crypto.getRandomValues(new Uint8Array(16))));
  const body = c.req.body ?? new ReadableStream<Uint8Array>({ start: (ctl) => ctl.close() });
  const put = await store.put(name.key, body, length, sha);
  if (put === "mismatch") throw new ApiError(400, "hash mismatch");
  if (put === "cap") {
    const t = Math.floor(Date.now() / 1000);
    capUntil = nextDay(t);
    throw paused(c, "cap", capUntil - t);
  }
  return json(201, { id: name.id, expires, url: name.url, quota: r.quota });
}
