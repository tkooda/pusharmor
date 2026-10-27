import { b64urlDecode } from "../codec/b64url";
// Small WebCrypto helpers shared by the crypto modules.
const enc = new TextEncoder();

export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

const hmacKeys = new Map<string, Promise<CryptoKey>>();

// HMAC-SHA256 key from a Worker secret: strict b64url of at least 32 random bytes (the
// golden vectors use the same form for PA_ID_SECRET). Cached per isolate.
export function hmacKey(secret: string): Promise<CryptoKey> {
  let k = hmacKeys.get(secret);
  if (!k) {
    const raw = b64urlDecode(secret);
    if (!raw || raw.length < 32) return Promise.reject(new Error("secret format"));
    k = crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    hmacKeys.set(secret, k);
  }
  return k;
}

export async function hmac(secret: string, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), data));
}

export function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export function ctEqualStr(a: string, b: string): boolean {
  return ctEqual(utf8(a), utf8(b));
}
