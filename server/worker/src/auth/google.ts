// Google sign-in: provider config and routes.
import type { Ctx } from "../context";
import type { Env } from "../env";
import { ApiError } from "../errors";
import { jsonList, oauthCallback, oauthStart, oauthToken, postForm, type ProviderCfg } from "./oauth";

export const google: ProviderCfg = {
  name: "google",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  clientIdWeb: (env: Env) => jsonList(env.GOOGLE_AUD_WEB)[0] ?? "",
  webAuds: (env: Env) => jsonList(env.GOOGLE_AUD_WEB),
  nativeAuds: (env: Env) => jsonList(env.GOOGLE_AUD_NATIVE),
  authParams: { scope: "openid email" },
  async exchange(env, code, clientId, redirectUri, verifier) {
    const form: Record<string, string> = {
      code,
      client_id: clientId,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: "authorization_code",
    };
    if (redirectUri) form.redirect_uri = redirectUri;
    if (verifier) form.code_verifier = verifier;
    const j = await postForm("https://oauth2.googleapis.com/token", form);
    if (typeof j.id_token !== "string") throw new ApiError(401, "invalid id_token");
    return { id_token: j.id_token };
  },
};

export const start = (c: Ctx) => oauthStart(c, google);
export const callback = (c: Ctx) => {
  if (c.body.length !== 0) throw new ApiError(400, "bad request");
  return oauthCallback(c, google, new URL(c.req.url).searchParams);
};
export const token = (c: Ctx) => oauthToken(c, google);
