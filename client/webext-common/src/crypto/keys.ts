// P-256 keys: ECDSA (sign) and ECDH (enc). Private keys are non-extractable;
// public keys are exported as 65-byte uncompressed SEC1 points.
import { b64urlEncode } from "./b64url.ts";
import { buf, equal } from "./bytes.ts";

export interface KeySet {
  sign: CryptoKeyPair;
  enc: CryptoKeyPair;
  sign_pub: Uint8Array;
  enc_pub: Uint8Array;
}

const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const SIG = { name: "ECDSA", hash: "SHA-256" } as const;

export async function generateKeySet(): Promise<KeySet> {
  for (;;) {
    const sign = (await crypto.subtle.generateKey(ECDSA, false, ["sign", "verify"])) as CryptoKeyPair;
    const enc = (await crypto.subtle.generateKey(ECDH, false, ["deriveBits"])) as CryptoKeyPair;
    const sign_pub = new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey));
    const enc_pub = new Uint8Array(await crypto.subtle.exportKey("raw", enc.publicKey));
    if (!equal(sign_pub, enc_pub)) return { sign, enc, sign_pub, enc_pub };
  }
}

/** True for a 65-byte uncompressed point on P-256. */
export async function isValidPub(pub: Uint8Array): Promise<boolean> {
  if (pub.length !== 65 || pub[0] !== 4) return false;
  try {
    await crypto.subtle.importKey("raw", buf(pub), ECDSA, true, ["verify"]);
    return true;
  } catch {
    return false;
  }
}

export async function importVerifyKey(pub: Uint8Array): Promise<CryptoKey> {
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("bad public key");
  return crypto.subtle.importKey("raw", buf(pub), ECDSA, true, ["verify"]);
}

export async function importEcdhPub(pub: Uint8Array): Promise<CryptoKey> {
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("bad public key");
  return crypto.subtle.importKey("raw", buf(pub), ECDH, true, []);
}

/** ECDSA P-256 SHA-256, raw r||s (64 bytes). */
export async function sign(priv: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign(SIG, priv, buf(data)));
}

export async function verify(pub: Uint8Array, sig: Uint8Array, data: Uint8Array): Promise<boolean> {
  if (sig.length !== 64) return false;
  try {
    const k = await importVerifyKey(pub);
    return await crypto.subtle.verify(SIG, k, buf(sig), buf(data));
  } catch {
    return false;
  }
}

/** Test and vector helper: import a raw 32-byte private scalar with its public point. */
export async function importPrivate(
  kind: "ECDSA" | "ECDH",
  d: Uint8Array,
  pub: Uint8Array,
  extractable = false,
): Promise<CryptoKeyPair> {
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: b64urlEncode(d),
    x: b64urlEncode(pub.subarray(1, 33)),
    y: b64urlEncode(pub.subarray(33, 65)),
  };
  const alg = kind === "ECDSA" ? ECDSA : ECDH;
  const usages: KeyUsage[] = kind === "ECDSA" ? ["sign"] : ["deriveBits"];
  const privateKey = await crypto.subtle.importKey("jwk", jwk, alg, extractable, usages);
  const publicKey = await crypto.subtle.importKey("raw", buf(pub), alg, true, kind === "ECDSA" ? ["verify"] : []);
  return { privateKey, publicKey };
}
