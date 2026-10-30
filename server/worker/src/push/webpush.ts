// Web Push sender (push_type 3 chrome, 4 firefox, 6 unifiedpush): RFC 8291 + VAPID (RFC 8292).
import { b64urlDecode } from "../codec/b64url";
import type { Env } from "../env";
import { utf8 } from "../crypto/hash";
import { deps, isNormal, ttlFor, type Cls, type VendorRequest } from "./deps";
import { importEs256Private, signJwt } from "./jwt";
import { encryptAes128gcm } from "./rfc8291";
import { getToken } from "./tokencache";

const VAPID_LIFE_S = 43200;

export async function mintVapid(env: Env, aud: string, force = false): Promise<string> {
  const c = await getToken(
    "vapid:" + aud,
    async () => {
      const t = deps.now();
      const exp = Math.floor(t / 1000) + VAPID_LIFE_S;
      const key = await importEs256Private(env.WEBPUSH_VAPID_PRIVATE_KEY, env.WEBPUSH_VAPID_PUBLIC_KEY);
      const jwt = await signJwt("ES256", key, { typ: "JWT", alg: "ES256" }, { aud, exp, sub: env.WEBPUSH_VAPID_SUB });
      return { value: jwt, mintedAt: t, useUntil: (exp - 3600) * 1000 };
    },
    deps.now(),
    force,
  );
  return c.value;
}

export interface WebPushFields {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function buildWebPush(
  env: Env,
  push: WebPushFields,
  plaintext: string,
  cls: Cls,
  forceAuth: boolean,
): Promise<VendorRequest> {
  const aud = new URL(push.endpoint).origin;
  const jwt = await mintVapid(env, aud, forceAuth);
  const ua = b64urlDecode(push.p256dh);
  const auth = b64urlDecode(push.auth);
  if (!ua || !auth) throw new Error("push keys");
  const body = await encryptAes128gcm(utf8(plaintext), ua, auth);
  return {
    url: push.endpoint,
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${env.WEBPUSH_VAPID_PUBLIC_KEY}`,
      TTL: String(ttlFor(env)),
      Urgency: isNormal(cls) ? "normal" : "high",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
    },
    body,
  };
}
