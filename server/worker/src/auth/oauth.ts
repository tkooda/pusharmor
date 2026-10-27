// Shared OAuth logic: Worker-hosted start/callback (PKCE, signed state, no storage) and the
// native token endpoints.
import type { Ctx } from "../context";
import { nowS } from "../context";
import { b64urlDecode, b64urlEncode } from "../codec/b64url";
import { bad, keysExactly } from "../codec/validate";
import { accountId, emailHash } from "../crypto/ids";
import {
  keyRef,
  LABEL_STATE,
  makeTicket,
  makeToken,
  oauthNonce,
  openToken,
  pkceChallenge,
  pkceVerifier,
  seal,
  STATE_LIFE_S,
  TICKET_LIFE_S,
  type Purpose,
} from "../crypto/tokens";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { json, redirect } from "../http";
import { parseJsonObject } from "../pipeline/body";
import { deps } from "../push/deps";
import { checkPurpose, checkSignPub } from "./email";
import { verifyIdToken, type Provider } from "./jwks";
import { normalizeEmail } from "./normalize";

export const CLIENTS = ["chrome", "firefox", "android", "web"] as const;
export type Client = (typeof CLIENTS)[number];

export interface Exchanged {
  id_token: string;
  refresh_token?: string;
}

export interface ProviderCfg {
  name: Provider;
  authorizeUrl: string;
  clientIdWeb(env: Env): string;
  webAuds(env: Env): string[];
  nativeAuds(env: Env): string[];
  authParams: Record<string, string>;
  exchange(env: Env, code: string, clientId: string, redirectUri: string | null, verifier: string | null): Promise<Exchanged>;
}

export function jsonList(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return raw ? [raw] : [];
  }
}

// An unset (empty) or non-https target would make a relative Location: 503.
// Chrome: PA_OAUTH_REDIRECT_CHROME is a JSON list (public and Beta extension); the
// client names its own redirect in u, which must equal a list entry exactly (no
// open redirect); without u the first entry. u is refused for every other client.
function redirectFor(env: Env, r: Client, u: string | null): string {
  let t: string | undefined;
  if (r === "chrome") {
    const list = jsonList(env.PA_OAUTH_REDIRECT_CHROME);
    if (list.length === 0) throw new ApiError(503, "unavailable");
    if (u !== null && !list.includes(u)) throw bad();
    t = u ?? list[0];
  } else {
    if (u !== null) throw bad();
    t = r === "firefox" ? env.PA_OAUTH_REDIRECT_FIREFOX : r === "android" ? env.PA_OAUTH_REDIRECT_ANDROID : env.PA_OAUTH_REDIRECT_WEB;
  }
  if (!t?.startsWith("https://")) throw new ApiError(503, "unavailable");
  return t;
}

function callbackUri(c: Ctx, p: ProviderCfg): string {
  return new URL(c.req.url).origin + `/v1/auth/${p.name}/callback`;
}

// Form POST to a provider token endpoint; returns the JSON reply or throws "invalid id_token".
export async function postForm(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const fail = new ApiError(401, "invalid id_token");
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw fail;
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    throw fail;
  }
  try {
    const j = await res.json();
    if (j && typeof j === "object") return j as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw fail;
}

async function ticketReply(env: Env, email: string, k: string, p: Purpose, sealed?: string): Promise<{ ticket: string; email: string }> {
  const normalized = normalizeEmail(email);
  const a = await accountId(env.PA_ID_SECRET, await emailHash(normalized));
  const t: { a: string; k: string; p: Purpose; x: number; s?: string } = { a, k, p, x: nowS() + TICKET_LIFE_S };
  if (sealed) t.s = sealed;
  return { ticket: await makeTicket(env.PA_TOKEN_SECRET, t), email: normalized };
}

// Sealed Apple refresh token with the client id it was issued to (revoked at DELETE /account).
async function sealApple(env: Env, refresh: string | undefined, clientId: string): Promise<string | undefined> {
  if (!refresh) return undefined;
  return seal(env.PA_TOKEN_SECRET, JSON.stringify({ t: refresh, c: clientId }));
}

// GET /auth/$provider?k=..&r=..&p=..[&u=..]
export async function oauthStart(c: Ctx, p: ProviderCfg): Promise<Response> {
  if (c.body.length !== 0) throw bad();
  const q = new URL(c.req.url).searchParams;
  const k = q.get("k");
  const r = q.get("r");
  const purpose = checkPurpose(q.get("p"));
  if (k === null || k.length !== 43 || b64urlDecode(k)?.length !== 32) throw bad();
  if (r === null || !(CLIENTS as readonly string[]).includes(r)) throw bad();
  if (r === "web" && purpose !== "delete-account") throw bad();
  const want = q.get("u");
  redirectFor(c.env, r as Client, want);
  const n = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const state = await makeToken(c.env.PA_TOKEN_SECRET, LABEL_STATE, { k, r, p: purpose, exp: nowS() + STATE_LIFE_S, n, ...(want !== null ? { u: want } : {}) });
  const verifier = await pkceVerifier(c.env.PA_TOKEN_SECRET, n);
  const u = new URL(p.authorizeUrl);
  const params: Record<string, string> = {
    client_id: p.clientIdWeb(c.env),
    redirect_uri: callbackUri(c, p),
    response_type: "code",
    state,
    nonce: await oauthNonce(purpose, k),
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
    ...p.authParams,
  };
  for (const [key, v] of Object.entries(params)) u.searchParams.set(key, v);
  return redirect(u.toString());
}

// GET (Google) or POST form_post (Apple) callback.
export async function oauthCallback(c: Ctx, p: ProviderCfg, params: URLSearchParams): Promise<Response> {
  const code = params.get("code");
  const st = await openToken(c.env.PA_TOKEN_SECRET, LABEL_STATE, params.get("state"));
  if (!st || typeof st.k !== "string" || typeof st.r !== "string" || typeof st.n !== "string" || typeof st.exp !== "number") throw bad();
  if (st.exp < nowS()) throw bad();
  if (!(CLIENTS as readonly string[]).includes(st.r)) throw bad();
  if (st.u !== undefined && typeof st.u !== "string") throw bad();
  const target = redirectFor(c.env, st.r as Client, st.u ?? null);
  const purpose = checkPurpose(st.p);
  // With a valid state the user returns to the client page with #error=<word>, never a JSON page on the Worker origin.
  if (params.get("error") !== null) return redirect(`${target}#error=cancelled`);
  if (code === null || code.length === 0 || code.length > 4096) return redirect(`${target}#error=failed`);
  try {
    const verifier = await pkceVerifier(c.env.PA_TOKEN_SECRET, st.n);
    const clientId = p.clientIdWeb(c.env);
    const ex = await p.exchange(c.env, code, clientId, callbackUri(c, p), verifier);
    const email = await verifyIdToken(ex.id_token, { provider: p.name, auds: p.webAuds(c.env), nonce: await oauthNonce(purpose, st.k) });
    const sealed = p.name === "apple" && purpose === "delete-account" ? await sealApple(c.env, ex.refresh_token, clientId) : undefined;
    const t = await ticketReply(c.env, email, st.k, purpose, sealed);
    return redirect(`${target}#ticket=${encodeURIComponent(t.ticket)}&email=${encodeURIComponent(t.email)}`);
  } catch (e) {
    if (e instanceof ApiError) return redirect(`${target}#error=failed`);
    throw e;
  }
}

// POST /auth/$provider/token (native).
export async function oauthToken(c: Ctx, p: ProviderCfg): Promise<Response> {
  const b = parseJsonObject(c.body);
  keysExactly(b, ["id_token", "sign_pub", "purpose"], p.name === "apple" ? ["code"] : []);
  const raw = await checkSignPub(b.sign_pub);
  const purpose = checkPurpose(b.purpose);
  if (b.code !== undefined && (purpose !== "delete-account" || typeof b.code !== "string" || b.code.length === 0 || b.code.length > 4096)) throw bad();
  const k = await keyRef(raw);
  const email = await verifyIdToken(b.id_token, { provider: p.name, auds: p.nativeAuds(c.env), nonce: await oauthNonce(purpose, k) });
  let sealed: string | undefined;
  if (typeof b.code === "string") {
    const clientId = c.env.APPLE_SIGNIN_AUD_NATIVE;
    const ex = await p.exchange(c.env, b.code, clientId, null, null);
    sealed = await sealApple(c.env, ex.refresh_token, clientId);
  }
  return json(200, await ticketReply(c.env, email, k, purpose, sealed));
}

export async function formParams(body: Uint8Array): Promise<URLSearchParams> {
  try {
    return new URLSearchParams(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    throw bad();
  }
}
