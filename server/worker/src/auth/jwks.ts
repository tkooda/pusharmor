// Provider JWKS fetch with an isolate cache (by max-age, refetch once on unknown kid) and
// id_token verification (RS256 / ES256).
import { b64urlDecode } from "../codec/b64url";
import { utf8 } from "../crypto/hash";
import { ApiError } from "../errors";
import { deps } from "../push/deps";

export type Provider = "google" | "apple";

export const JWKS_URL: Record<Provider, string> = {
  google: "https://www.googleapis.com/oauth2/v3/certs",
  apple: "https://appleid.apple.com/auth/keys",
};
export const ISSUERS: Record<Provider, string[]> = {
  google: ["https://accounts.google.com", "accounts.google.com"],
  apple: ["https://appleid.apple.com"],
};

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

const jwksCache = new Map<Provider, { keys: Jwk[]; until: number }>();
const lastRefetch = new Map<Provider, number>();

export function clearJwks(): void {
  jwksCache.clear();
  lastRefetch.clear();
}

async function fetchJwks(p: Provider): Promise<Jwk[]> {
  const res = await deps.fetch(JWKS_URL[p], { method: "GET", redirect: "manual", signal: AbortSignal.timeout(5000) });
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new Error("jwks");
  }
  const j = (await res.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(j.keys) ? j.keys : [];
  const m = /max-age=([0-9]+)/.exec(res.headers.get("Cache-Control") ?? "");
  jwksCache.set(p, { keys, until: deps.now() + (m ? Math.min(Number(m[1]), 86400) : 3600) * 1000 });
  return keys;
}

async function findKey(p: Provider, kid: string): Promise<Jwk | undefined> {
  const c = jwksCache.get(p);
  if (!c) return (await fetchJwks(p)).find((x) => x.kid === kid);
  const now = deps.now();
  const k = c.keys.find((x) => x.kid === kid);
  if (k && now < c.until) return k;
  // Unknown kid or stale cache: refetch at most once per 60 s per provider; on a
  // failed refetch keep the cached keys.
  const t = lastRefetch.get(p);
  if (t !== undefined && now - t < 60000) return k;
  lastRefetch.set(p, now);
  try {
    return (await fetchJwks(p)).find((x) => x.kid === kid);
  } catch {
    return k;
  }
}

function decodeJson(part: string): Record<string, unknown> | null {
  const raw = b64urlDecode(part);
  if (!raw) return null;
  try {
    const v = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export interface IdTokenCheck {
  provider: Provider;
  auds: string[];
  nonce: string;
}

// Returns the email claim (not yet normalized). Fail -> 401 "invalid id_token" /
// "email not verified".
export async function verifyIdToken(token: unknown, chk: IdTokenCheck): Promise<string> {
  const bad = new ApiError(401, "invalid id_token");
  if (typeof token !== "string" || token.length > 8192) throw bad;
  const parts = token.split(".");
  if (parts.length !== 3) throw bad;
  const header = decodeJson(parts[0]);
  const claims = decodeJson(parts[1]);
  const sig = b64urlDecode(parts[2]);
  if (!header || !claims || !sig || typeof header.kid !== "string") throw bad;
  const alg = header.alg;
  if (alg !== "RS256" && alg !== "ES256") throw bad;
  let jwk: Jwk | undefined;
  try {
    jwk = await findKey(chk.provider, header.kid);
  } catch {
    throw bad;
  }
  if (!jwk) throw bad;
  let ok = false;
  try {
    const data = utf8(parts[0] + "." + parts[1]);
    if (alg === "RS256" && jwk.kty === "RSA") {
      const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data);
    } else if (alg === "ES256" && jwk.kty === "EC" && jwk.crv === "P-256") {
      const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      ok = sig.length === 64 && (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, data));
    }
  } catch {
    ok = false;
  }
  if (!ok) throw bad;
  const now = Math.floor(deps.now() / 1000);
  if (typeof claims.iss !== "string" || !ISSUERS[chk.provider].includes(claims.iss)) throw bad;
  const aud = claims.aud;
  const audOk = typeof aud === "string" ? chk.auds.includes(aud) : Array.isArray(aud) && aud.length > 0 && aud.every((a) => typeof a === "string" && chk.auds.includes(a));
  if (!audOk) throw bad;
  if (typeof claims.exp !== "number" || claims.exp <= now) throw bad;
  if (claims.nonce !== chk.nonce) throw bad;
  if (typeof claims.email !== "string") throw bad;
  if (claims.email_verified !== true && claims.email_verified !== "true") throw new ApiError(401, "email not verified");
  return claims.email;
}
