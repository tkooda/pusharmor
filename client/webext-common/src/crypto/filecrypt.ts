// File blobs: AES-256-GCM in one Web Crypto call, one random key and nonce per
// file, no AAD, one tag. blob = nonce (12) || ciphertext || tag (16).
import { buf, randomBytes } from "./bytes.ts";

/** Largest plaintext of a file, in bytes. */
export const MAX_FILE = 100_000_000;
/** Blob bytes beyond the plaintext: the 12-byte nonce and the 16-byte tag. */
export const BLOB_OVERHEAD = 28;
const NONCE_LEN = 12;

function aesKey(key: Uint8Array, use: KeyUsage): Promise<CryptoKey> {
  if (key.length !== 32) throw new Error("bad file key");
  return crypto.subtle.importKey("raw", buf(key), "AES-GCM", false, [use]);
}

/** A new random 32-byte file key. */
export function newFileKey(): Uint8Array {
  return randomBytes(32);
}

/** b itself when it views an ArrayBuffer (no copy), else a copy. */
function view(b: Uint8Array): Uint8Array<ArrayBuffer> {
  return b.buffer instanceof ArrayBuffer ? (b as Uint8Array<ArrayBuffer>) : buf(b);
}

/**
 * The blob of plaintext, as a Blob of the nonce and the Web Crypto output, so that no joined copy is
 * made in script memory: peak about 2 x size (plaintext and ciphertext). nonce: tests only.
 */
export async function sealFile(key: Uint8Array, plaintext: Uint8Array, nonce: Uint8Array = randomBytes(NONCE_LEN)): Promise<Blob> {
  if (nonce.length !== NONCE_LEN) throw new Error("bad nonce");
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(nonce), tagLength: 128 }, await aesKey(key, "encrypt"), view(plaintext));
  return new Blob([buf(nonce), ct]);
}

/** The plaintext of a blob, or null when the blob is too short or its tag fails. */
export async function openFile(key: Uint8Array, blob: Uint8Array): Promise<Uint8Array | null> {
  if (blob.length < BLOB_OVERHEAD) return null;
  const k = await aesKey(key, "decrypt");
  try {
    const iv = buf(blob.subarray(0, NONCE_LEN));
    // a view of the blob after the nonce, not a copy: peak about 2 x size (blob and plaintext)
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, k, view(blob.subarray(NONCE_LEN))));
  } catch (e) {
    if (e instanceof DOMException && e.name === "OperationError") return null;
    throw e; // out of memory and other failures are not a damaged file
  }
}
