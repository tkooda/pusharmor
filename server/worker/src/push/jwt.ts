// JWT signing: RS256 (FCM service account) and ES256 (APNs, VAPID, Apple client secret).
import { b64urlDecode, b64urlEncode } from "../codec/b64url";
import { utf8 } from "../crypto/hash";

export function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\\n/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

export function importEs256Private(pemOrD: string, publicKeyB64?: string): Promise<CryptoKey> {
  const ck = "es:" + pemOrD;
  let k = keyCache.get(ck);
  if (!k) {
    if (pemOrD.includes("-----BEGIN")) {
      k = crypto.subtle.importKey("pkcs8", pemToDer(pemOrD), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    } else {
      // Raw d (b64url, 32 bytes) plus the 65-byte public point as a JWK.
      const pub = publicKeyB64 ? b64urlDecode(publicKeyB64) : null;
      if (!pub || pub.length !== 65) return Promise.reject(new Error("vapid key"));
      const jwk = {
        kty: "EC",
        crv: "P-256",
        d: pemOrD,
        x: b64urlEncode(pub.slice(1, 33)),
        y: b64urlEncode(pub.slice(33, 65)),
      };
      k = crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    }
    keyCache.set(ck, k);
    k.catch(() => keyCache.delete(ck));
  }
  return k;
}

export function importRs256Private(pem: string): Promise<CryptoKey> {
  const ck = "rs:" + pem;
  let k = keyCache.get(ck);
  if (!k) {
    k = crypto.subtle.importKey("pkcs8", pemToDer(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    keyCache.set(ck, k);
    k.catch(() => keyCache.delete(ck));
  }
  return k;
}

function part(o: object): string {
  return b64urlEncode(utf8(JSON.stringify(o)));
}

export async function signJwt(alg: "ES256" | "RS256", key: CryptoKey, header: object, claims: object): Promise<string> {
  const input = part(header) + "." + part(claims);
  const algo = alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" };
  const sig = new Uint8Array(await crypto.subtle.sign(algo, key, utf8(input)));
  return input + "." + b64urlEncode(sig);
}
