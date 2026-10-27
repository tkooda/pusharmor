// Sign in with Apple: provider config, client secret JWT, routes and the best-effort revoke.
import type { Ctx } from "../context";
import type { Env } from "../env";
import { unseal } from "../crypto/tokens";
import { ApiError } from "../errors";
import { deps } from "../push/deps";
import { importEs256Private, signJwt } from "../push/jwt";
import { formParams, jsonList, oauthCallback, oauthStart, oauthToken, postForm, type ProviderCfg } from "./oauth";

// client_secret = ES256 JWT signed with APPLE_SIGNIN_KEY_P8 (team id = APNS_TEAM_ID).
export async function appleClientSecret(env: Env, clientId: string): Promise<string> {
  const iat = Math.floor(deps.now() / 1000);
  const key = await importEs256Private(env.APPLE_SIGNIN_KEY_P8);
  return signJwt(
    "ES256",
    key,
    { alg: "ES256", kid: env.APPLE_SIGNIN_KEY_ID },
    { iss: env.APNS_TEAM_ID, iat, exp: iat + 300, aud: "https://appleid.apple.com", sub: clientId },
  );
}

export const apple: ProviderCfg = {
  name: "apple",
  authorizeUrl: "https://appleid.apple.com/auth/authorize",
  clientIdWeb: (env: Env) => env.APPLE_AUD_WEB,
  webAuds: (env: Env) => jsonList(env.APPLE_AUD_WEB),
  nativeAuds: (env: Env) => jsonList(env.APPLE_AUD_NATIVE),
  authParams: { scope: "email", response_mode: "form_post" },
  async exchange(env, code, clientId, redirectUri, verifier) {
    const form: Record<string, string> = {
      client_id: clientId,
      client_secret: await appleClientSecret(env, clientId),
      code,
      grant_type: "authorization_code",
    };
    if (redirectUri) form.redirect_uri = redirectUri;
    if (verifier) form.code_verifier = verifier;
    const j = await postForm("https://appleid.apple.com/auth/token", form);
    if (typeof j.id_token !== "string") throw new ApiError(401, "invalid id_token");
    return { id_token: j.id_token, refresh_token: typeof j.refresh_token === "string" ? j.refresh_token : undefined };
  },
};

export const start = (c: Ctx) => oauthStart(c, apple);
export const callback = async (c: Ctx) => oauthCallback(c, apple, await formParams(c.body));
export const token = (c: Ctx) => oauthToken(c, apple);

// Best effort: a failed revoke never fails DELETE /account.
export async function revokeAppleSealed(env: Env, sealed: string): Promise<void> {
  try {
    const raw = await unseal(env.TOKEN_SECRET, sealed);
    if (!raw) return;
    const o = JSON.parse(raw) as { t?: unknown; c?: unknown };
    if (typeof o.t !== "string" || typeof o.c !== "string") return;
    const res = await deps.fetch("https://appleid.apple.com/auth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: o.c,
        client_secret: await appleClientSecret(env, o.c),
        token: o.t,
        token_type_hint: "refresh_token",
      }).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    await res.body?.cancel();
  } catch {
    // best effort
  }
}
