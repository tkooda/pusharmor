// FCM HTTP v1 sender (push_type 1). Data-only message {"m": M}.
import type { Env } from "../env";
import { deps, isNormal, ttlFor, type Cls, type VendorRequest } from "./deps";
import { importRs256Private, signJwt } from "./jwt";
import { getToken } from "./tokencache";

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export async function mintFcmToken(env: Env, force = false): Promise<string> {
  const now = deps.now();
  const c = await getToken(
    "fcm",
    async () => {
      const iat = Math.floor(deps.now() / 1000);
      const key = await importRs256Private(env.GOOGLE_FCM_SA_PRIVATE_KEY);
      const jwt = await signJwt(
        "RS256",
        key,
        { alg: "RS256", typ: "JWT", kid: env.GOOGLE_FCM_SA_KEY_ID },
        { iss: env.GOOGLE_FCM_SA_EMAIL, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 },
      );
      const res = await deps.fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + jwt,
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      if (res.status !== 200) {
        await res.body?.cancel();
        throw new Error("fcm token");
      }
      const j = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
      if (typeof j.access_token !== "string" || typeof j.expires_in !== "number") throw new Error("fcm token");
      const t = deps.now();
      return { value: j.access_token, mintedAt: t, useUntil: t + (j.expires_in - 300) * 1000 };
    },
    now,
    force,
  );
  return c.value;
}

export async function buildFcm(env: Env, push: { token: string }, m: string, cls: Cls, forceAuth: boolean): Promise<VendorRequest> {
  const token = await mintFcmToken(env, forceAuth);
  const body = {
    message: {
      token: push.token,
      data: { m },
      android: { priority: isNormal(cls) ? "NORMAL" : "HIGH", ttl: `${ttlFor(env)}s` },
    },
  };
  return {
    url: `https://fcm.googleapis.com/v1/projects/${env.GOOGLE_FCM_PROJECT_ID}/messages:send`,
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
