// APNs sender (push_type 2 production, 5 sandbox). Fixed loc-key alert + "m".
import type { Env } from "../env";
import { deps, ttlFor, type Cls, type VendorRequest } from "./deps";
import { importEs256Private, signJwt } from "./jwt";
import { getToken, peekToken } from "./tokencache";

const REUSE_MS = 45 * 60 * 1000;
const MIN_REMINT_MS = 20 * 60 * 1000;

export async function mintApnsJwt(env: Env, force = false): Promise<string> {
  const c = await getToken(
    "apns",
    async () => {
      const t = deps.now();
      const key = await importEs256Private(env.APPLE_APNS_KEY_P8);
      const jwt = await signJwt("ES256", key, { alg: "ES256", kid: env.APPLE_APNS_KEY_ID }, { iss: env.APPLE_APNS_TEAM_ID, iat: Math.floor(t / 1000) });
      return { value: jwt, mintedAt: t, useUntil: t + REUSE_MS };
    },
    deps.now(),
    force,
  );
  return c.value;
}

// On 403 ExpiredProviderToken / InvalidProviderToken: mint only if the cached JWT is >= 20 min old.
export function apnsMayRemint(): boolean {
  const c = peekToken("apns");
  return !c || deps.now() - c.mintedAt >= MIN_REMINT_MS;
}

export function apnsPayload(m: string): string {
  return JSON.stringify({ aps: { alert: { "title-loc-key": "PA_TITLE", "loc-key": "PA_FALLBACK" }, "mutable-content": 1 }, m });
}

export async function buildApns(
  env: Env,
  pushType: number,
  push: { token: string },
  m: string,
  cls: Cls,
  pk: string | undefined,
  forceAuth: boolean,
): Promise<VendorRequest> {
  const jwt = await mintApnsJwt(env, forceAuth);
  const host = pushType === 5 ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  const headers: Record<string, string> = {
    authorization: "bearer " + jwt,
    "apns-push-type": "alert",
    "apns-topic": env.APPLE_APNS_TOPIC,
    "apns-priority": "10",
    "apns-expiration": String(Math.floor(deps.now() / 1000) + ttlFor(env)),
  };
  if (cls === "pair" && pk) headers["apns-collapse-id"] = pk;
  return { url: `https://${host}/3/device/${push.token}`, method: "POST", headers, body: apnsPayload(m) };
}
