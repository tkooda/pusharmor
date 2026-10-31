// Reply helpers: JSON body, PA-Epoch, HSTS, no-store, CORS, error bodies.
import { ApiError } from "./errors";

export const CORS_PATHS = new Set(["/v1/auth/email", "/v1/auth/email/verify", "/v1/account"]);

export function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function errorResponse(e: ApiError): Response {
  const body: Record<string, unknown> = { error: e.word };
  if (e.extra) for (const [k, v] of Object.entries(e.extra)) if (!k.startsWith("_")) body[k] = v;
  const headers: Record<string, string> = {};
  if (e.status === 429) headers["Retry-After"] = String(body.retry_after);
  return json(e.status, body, headers);
}

export function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

export function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": "POST, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, PA-Time, PA-Sig, PA-Client",
    },
  });
}

function webOrigins(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Headers on every reply (errors and preflight included). Returns a new Response.
export function finish(res: Response, path: string, origin: string | null, webOriginsVar: string): Response {
  const out = new Response(res.body, res);
  const h = out.headers;
  h.set("PA-Epoch", String(Math.floor(Date.now() / 1000)));
  h.set("Access-Control-Expose-Headers", "PA-Epoch");
  h.set("Cache-Control", "no-store");
  h.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  if (CORS_PATHS.has(path)) {
    h.append("Vary", "Origin");
    if (origin !== null && webOrigins(webOriginsVar).includes(origin)) h.set("Access-Control-Allow-Origin", origin);
  }
  return out;
}
