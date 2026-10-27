// P-256 public key import (uncompressed SEC1, on-curve check by import) and raw r||s verify.
import { b64urlDecode } from "../codec/b64url";

export function rawPoint(b64: unknown): Uint8Array | null {
  if (typeof b64 !== "string" || b64.length !== 87) return null;
  const raw = b64urlDecode(b64);
  if (!raw || raw.length !== 65 || raw[0] !== 4) return null;
  return raw;
}

export async function importVerifyKey(raw: Uint8Array): Promise<CryptoKey | null> {
  if (raw.length !== 65 || raw[0] !== 4) return null;
  try {
    return await crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
  } catch {
    return null;
  }
}

export async function importEcdhPub(raw: Uint8Array): Promise<CryptoKey | null> {
  if (raw.length !== 65 || raw[0] !== 4) return null;
  try {
    return await crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, true, []);
  } catch {
    return null;
  }
}

// sig = 64-byte raw r||s.
export async function verifyRaw(key: CryptoKey, sig: Uint8Array, data: Uint8Array): Promise<boolean> {
  if (sig.length !== 64) return false;
  try {
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, data);
  } catch {
    return false;
  }
}
