// RFC 8291 (aes128gcm, RFC 8188 single record) decrypt for the Firefox
// autopush client. Receiver key is a non-extractable ECDH P-256 key.
import { ascii, buf, concat } from "./bytes.ts";
import { hmacSha256 } from "./hash.ts";
import { importEcdhPub } from "./keys.ts";

function hkdfExpand1(prk: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  return hmacSha256(prk, concat(info, new Uint8Array([1]))).then((t) => t.subarray(0, len));
}

export interface Rfc8291Keys {
  prk_key: Uint8Array;
  key_info: Uint8Array;
  ikm: Uint8Array;
  prk: Uint8Array;
  cek: Uint8Array;
  nonce: Uint8Array;
}

/** RFC 8291 section 3.4 key derivation plus the RFC 8188 CEK and nonce. */
export async function rfc8291Derive(ecdhSecret: Uint8Array, authSecret: Uint8Array, uaPublic: Uint8Array, asPublic: Uint8Array, salt: Uint8Array): Promise<Rfc8291Keys> {
  const prk_key = await hmacSha256(authSecret, ecdhSecret);
  const key_info = concat(ascii("WebPush: info"), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hkdfExpand1(prk_key, key_info, 32);
  const prk = await hmacSha256(salt, ikm);
  const cek = await hkdfExpand1(prk, concat(ascii("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
  const nonce = await hkdfExpand1(prk, concat(ascii("Content-Encoding: nonce"), new Uint8Array([0])), 12);
  return { prk_key, key_info, ikm, prk, cek, nonce };
}

export async function rfc8291Ecdh(uaPrivate: CryptoKey, asPublic: Uint8Array): Promise<Uint8Array> {
  const asKey = await importEcdhPub(asPublic);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, uaPrivate, 256));
}

/** Decrypts a single-record aes128gcm body; returns the plaintext without the delimiter and padding. */
export async function rfc8291Decrypt(
  uaPrivate: CryptoKey,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
  body: Uint8Array,
): Promise<Uint8Array> {
  if (body.length < 21) throw new Error("short body");
  const salt = body.subarray(0, 16);
  const rs = ((body[16]! << 24) | (body[17]! << 16) | (body[18]! << 8) | body[19]!) >>> 0;
  const idlen = body[20]!;
  if (idlen !== 65) throw new Error("bad keyid");
  if (body.length < 21 + idlen + 17) throw new Error("short body");
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  if (rs < 18 || ct.length > rs) throw new Error("bad record size");
  const ecdh = await rfc8291Ecdh(uaPrivate, asPublic);
  const k = await rfc8291Derive(ecdh, authSecret, uaPublic, asPublic, salt);
  const key = await crypto.subtle.importKey("raw", buf(k.cek), "AES-GCM", false, ["decrypt"]);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(k.nonce) }, key, buf(ct)));
  let end = pt.length;
  while (end > 0 && pt[end - 1] === 0) end--;
  if (end === 0 || pt[end - 1] !== 2) throw new Error("bad padding delimiter");
  return pt.subarray(0, end - 1);
}

export interface WebPushKeys {
  ecdh: CryptoKeyPair;
  p256dh: Uint8Array;
  auth: Uint8Array;
}

export async function generateWebPushKeys(): Promise<WebPushKeys> {
  const ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])) as CryptoKeyPair;
  const p256dh = new Uint8Array(await crypto.subtle.exportKey("raw", ecdh.publicKey));
  const auth = new Uint8Array(16);
  crypto.getRandomValues(auth);
  return { ecdh, p256dh, auth };
}
