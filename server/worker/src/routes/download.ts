// File downloads on the file host (b2file.pusharmor.com): GET /v1/<minute>/<acct-hash>/<id>.
// Only a path that matches the key pattern, with both minute fields equal, is served; the
// storage key is built from the matched groups, never from the raw path. A file is served for
// as long as it exists in storage (it is deleted a few minutes after it expires); a key minute
// more than 24 h + 1 min ahead is 404 with no storage call. Every reply carries a fixed header
// set; nothing comes from storage metadata except the length, Content-Range and ETag.
import type { Ctx } from "../context";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { errorResponse } from "../http";
import type { Log } from "../log";
import { enforce, ipKey } from "../pipeline/limits";
import { storeDeps } from "../file/store";
import { AHEAD_MAX, capHit, capLeft, minuteStart, paused, storageError } from "./file";

export const FILE_HOSTNAME = "b2file.pusharmor.com";

const KEY = /^\/v1\/([0-9]{12})\/([0-9a-f]{16})\/([0-9]{12})-([0-9a-f]{32})$/;
const OTHER_VERSION = /^\/v(?!1\/)[0-9]+\//;
const ONE_RANGE = /^bytes=([0-9]+-[0-9]*|-[0-9]+)$/;

const FIXED: Record<string, string> = {
  "Content-Type": "application/octet-stream",
  "X-Content-Type-Options": "nosniff",
  "Content-Disposition": 'attachment; filename="file.bin"',
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Access-Control-Allow-Origin": "*",
  "Referrer-Policy": "no-referrer",
};

// Error replies: JSON body, readable from any origin, never sniffed or cached.
function errorReply(e: ApiError): Response {
  const res = errorResponse(e);
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Cache-Control", "no-store");
  if (e.status === 405) res.headers.set("Allow", "GET");
  return res;
}

async function serve(c: Ctx): Promise<Response> {
  if (c.method !== "GET") throw new ApiError(405, "method not allowed");
  if (c.req.url.includes("?")) throw new ApiError(404, "not found");
  const m = KEY.exec(c.path);
  if (!m) throw new ApiError(404, OTHER_VERSION.test(c.path) ? "update required" : "not found");
  const start = minuteStart(m[1]);
  const now = Math.floor(Date.now() / 1000);
  if (m[1] !== m[3] || start === null || start > now + AHEAD_MAX) throw new ApiError(404, "not found");
  const key = "v1/" + m[1] + "/" + m[2] + "/" + m[3] + "-" + m[4];
  await enforce(c.env, "RL_DL_IP", ipKey(c.req.headers.get("CF-Connecting-IP") ?? ""), c.log);
  await enforce(c.env, "RL_DL_KEY", "dl:" + key, c.log);
  if (capLeft(now) > 0) throw paused(c, "cap", capLeft(now));
  const store = storeDeps.store(c.env);
  if (!store) throw paused(c, "config");
  // One byte range goes to storage (206); several ranges or anything else: the full body (200).
  const range = c.req.headers.get("Range");
  let r: Awaited<ReturnType<typeof store.get>>;
  try {
    r = await store.get(key, range !== null && ONE_RANGE.test(range) ? range : null);
  } catch (e) {
    c.log.extra.storage = storageError(e);
    throw new ApiError(502, "storage error");
  }
  if (r === "cap") throw capHit(c);
  if (r === "missing") throw new ApiError(404, "not found");
  if (r === "range") throw new ApiError(416, "range not satisfiable");
  const h = new Headers(FIXED);
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
