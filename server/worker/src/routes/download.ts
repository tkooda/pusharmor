// File downloads on the file host (b2file.pusharmor.com): GET /v1/<minute>/<acct-hash>/<id>.
// Only a path that matches the key pattern, with both minute fields equal, is served; the
// storage key is built from the matched groups, never from the raw path. A file is served for
// as long as it exists in storage (it is deleted a few minutes after it expires); a key minute
// more than 24 h + 1 min ahead, or more than 24 h + 5 min behind, is 404 with no storage call. Every reply carries a fixed header
// set; nothing comes from storage metadata except the length, Content-Range and ETag.
// Every GET is signed by a device of the account in the key (PA-DL1), checked with no D1 read:
// PA-ID carries the account and the keyhash, PA-Sign-Pub and PA-Enc-Pub carry the device keys.
import type { Ctx } from "../context";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { errorResponse } from "../http";
import type { Log } from "../log";
import { enforce, ipKey } from "../pipeline/limits";
import { checkKeyhash, checkSig, downloadSignedBytes } from "../pipeline/signed";
import { storeDeps } from "../file/store";
import { signedStart } from "./common";
import { AHEAD_MAX, acctHash, capHit, capLeft, minuteStart, paused, storageError } from "./file";

export const FILE_HOSTNAME = "b2file.pusharmor.com";

const KEY = /^\/v1\/([0-9]{12})\/([0-9a-f]{16})\/([0-9]{12})-([0-9a-f]{32})$/;
const OTHER_VERSION = /^\/v(?!1\/)[0-9]+\//;
const ONE_RANGE = /^bytes=(?:([0-9]+)-([0-9]*)|-[0-9]+)$/;

// One byte range with first <= last (or open-ended, or a suffix); anything else is ignored.
function oneRange(v: string | null): string | null {
  const m = v === null ? null : ONE_RANGE.exec(v);
  if (!m) return null;
  if (m[1] !== undefined && m[2] !== "" && Number(m[2]) < Number(m[1])) return null;
  return v;
}

// A key minute this far behind now cannot hold a live file (24 h + the deletion grace): 404.
export const BEHIND_MAX = 86400 + 300;

const FIXED: Record<string, string> = {
  "Content-Type": "application/octet-stream",
  "X-Content-Type-Options": "nosniff",
  "Content-Disposition": 'attachment; filename="file.bin"',
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Access-Control-Allow-Origin": "*",
  "Referrer-Policy": "no-referrer",
};

// Preflight for the browser extensions (they have no host permission for the file host).
function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET",
      "Access-Control-Allow-Headers": "PA-ID, PA-Time, PA-Sig, PA-Sign-Pub, PA-Enc-Pub, Range",
      "Cache-Control": "no-store",
    },
  });
}

// Error replies: JSON body, readable from any origin, never sniffed or cached. PA-Epoch as on
// API replies, so a client can correct its clock after a 401 clock skew.
export function errorReply(e: ApiError): Response {
  const res = errorResponse(e);
  res.headers.set("PA-Epoch", String(Math.floor(Date.now() / 1000)));
  res.headers.set("Access-Control-Expose-Headers", "PA-Epoch");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Cache-Control", "no-store");
  if (e.status === 405) res.headers.set("Allow", "GET");
  return res;
}

async function serve(c: Ctx): Promise<Response> {
  if (c.method === "OPTIONS" && c.req.headers.has("Access-Control-Request-Method")) return preflight();
  if (c.method !== "GET") throw new ApiError(405, "method not allowed");
  if (c.req.url.includes("?")) throw new ApiError(404, "not found");
  const m = KEY.exec(c.path);
  if (!m) throw new ApiError(404, OTHER_VERSION.test(c.path) ? "update required" : "not found");
  const start = minuteStart(m[1]);
  const now = Math.floor(Date.now() / 1000);
  if (m[1] !== m[3] || start === null || start > now + AHEAD_MAX || start < now - BEHIND_MAX) throw new ApiError(404, "not found");
  const key = "v1/" + m[1] + "/" + m[2] + "/" + m[3] + "-" + m[4];
  await enforce(c.env, "RL_DL_IP", ipKey(c.req.headers.get("CF-Connecting-IP") ?? ""), c.log);
  // Signed by a device (no D1): keys match the PA-ID keyhash, PA-Sig over PA-DL1.
  const s = await signedStart(c);
  const signPub = c.req.headers.get("PA-Sign-Pub") ?? "";
  await checkKeyhash(s.me, signPub, c.req.headers.get("PA-Enc-Pub") ?? "");
  await checkSig(signPub, c.req.headers, c.method, c.path, s.paTime, c.body, downloadSignedBytes(c.path, s.paTime));
  // Device and account limits are charged only after the signature passes (see callerCheck).
  await enforce(c.env, "RL_DL_PEER", "id:" + s.me, c.log);
  await enforce(c.env, "RL_DL_ACCT", "acct:" + s.acct, c.log);
  let hash: string;
  try {
    hash = await acctHash(c.env.FILE_ACCT_SECRET, s.acct);
  } catch {
    throw paused(c, "config");
  }
  // A device of another account: 403, before any per-file limit, so it cannot use up the
  // file's budget.
  if (hash !== m[2]) throw new ApiError(403, "wrong account");
  await enforce(c.env, "RL_DL_PEER_KEY", "dl:" + s.me + ":" + key, c.log);
  await enforce(c.env, "RL_DL_KEY", "dl:" + key, c.log);
  if (capLeft(now, "download") > 0) throw paused(c, "cap", capLeft(now, "download"));
  const store = storeDeps.store(c.env);
  if (!store) throw paused(c, "config");
  // One byte range goes to storage (206); several ranges, a reversed range (bytes=5-2) or
  // anything else: the full body (200).
  let r: Awaited<ReturnType<typeof store.get>>;
  try {
    r = await store.get(key, oneRange(c.req.headers.get("Range")));
  } catch (e) {
    c.log.extra.storage = storageError(e);
    throw new ApiError(502, "storage error");
  }
  if (r === "cap") throw capHit(c, "download");
  if (r === "missing") throw new ApiError(404, "not found");
  if (r.status === 416) {
    const res = errorReply(new ApiError(416, "range not satisfiable"));
    if (r.size !== null) res.headers.set("Content-Range", "bytes */" + r.size);
    return res;
  }
  const h = new Headers(FIXED);
  h.set("Cache-Control", "no-store");
  h.set("Accept-Ranges", "bytes");
  h.set("Access-Control-Expose-Headers", "Content-Range, ETag");
  if (r.etag !== null) h.set("ETag", r.etag);
  if (r.status === 206 && r.contentRange !== null) h.set("Content-Range", r.contentRange);
  c.log.extra.bytes = r.length;
  return new Response(r.body, { status: r.status, headers: h });
}

// Entry for every request on the file host. Logs one line per request (sampled like the API).
export async function fileHost(req: Request, env: Env, exec: ExecutionContext, log: Log): Promise<Response> {
  const path = new URL(req.url).pathname;
  log.route = "GET file";
  const c: Ctx = { env, exec, req, method: req.method, path, params: [], body: new Uint8Array(0), log };
  try {
    return await serve(c);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    log.error = e.word;
    const b = e.extra?._binding;
    if (typeof b === "string") log.rl = b;
    return errorReply(e);
  }
}
