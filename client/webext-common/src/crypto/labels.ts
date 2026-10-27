// Hash labels, ids, pairing values (api catalog r10: IDs, Pairing fingerprint,
// Pairing flow, Auth OAuth nonce, GET /peers my_push_sha256).
import { b64urlEncode } from "./b64url.ts";
import { ascii, concat, equal, utf8 } from "./bytes.ts";
import { sha256 } from "./hash.ts";
import { isValidPub } from "./keys.ts";

export const ID_LEN = 30;
export const ACCOUNT_LEN = 9;
export const KEYHASH_LEN = 12;
export const PAIRING_ID_LEN = 8;
export const R_LEN = 32;
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** keyhash = sha256("PA-ID1\n" || sign_pub || enc_pub)[0..12] */
export async function keyhash(signPub: Uint8Array, encPub: Uint8Array): Promise<Uint8Array> {
  return (await sha256(concat(ascii("PA-ID1\n"), signPub, encPub))).subarray(0, KEYHASH_LEN);
}

/**
 * Checks a peer id against keys and the caller's own account prefix:
 * 30 bytes, account(9) equals myAccount, keyhash(12) equals the keys' hash,
 * and sign_pub differs from enc_pub.
 */
export async function idMatchesKeys(
  id: Uint8Array,
  signPub: Uint8Array,
  encPub: Uint8Array,
  myAccount: Uint8Array,
): Promise<boolean> {
  if (id.length !== ID_LEN || signPub.length !== 65 || encPub.length !== 65) return false;
  if (equal(signPub, encPub)) return false;
  if (!equal(id.subarray(0, ACCOUNT_LEN), myAccount)) return false;
  return equal(id.subarray(ACCOUNT_LEN, ACCOUNT_LEN + KEYHASH_LEN), await keyhash(signPub, encPub));
}

export function accountOf(id: Uint8Array): Uint8Array {
  return id.subarray(0, ACCOUNT_LEN);
}

export function hasAccount(id: Uint8Array, myAccount: Uint8Array): boolean {
  return id.length === ID_LEN && equal(id.subarray(0, ACCOUNT_LEN), myAccount);
}

/** Email normalization: trim, then ASCII lowercase; null when any char is outside ASCII. */
export function normalizeEmail(email: string): string | null {
  const t = email.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
  for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) > 0x7f) return null;
  return t.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** email_hash = sha256("PA-ACCT1\n" || normalized email) */
export async function emailHash(normalized: string): Promise<Uint8Array> {
  return sha256(concat(ascii("PA-ACCT1\n"), ascii(normalized)));
}

/** OAuth nonce = b64url(sha256("PA-NONCE1\n" + purpose + "\n" + k)), k = b64url(sha256(sign_pub)) */
export async function oauthK(signPub: Uint8Array): Promise<string> {
  return b64urlEncode(await sha256(signPub));
}

export async function oauthNonce(purpose: string, signPub: Uint8Array): Promise<string> {
  const k = await oauthK(signPub);
  return b64urlEncode(await sha256(ascii("PA-NONCE1\n" + purpose + "\n" + k)));
}

/** c_N = sha256("PA-SAS1C\n" || sign_pub_N || enc_pub_N || r_N) */
export async function commitHash(signPubN: Uint8Array, encPubN: Uint8Array, rN: Uint8Array): Promise<Uint8Array> {
  return sha256(concat(ascii("PA-SAS1C\n"), signPubN, encPubN, rN));
}

/** 4 Crockford chars from the first 20 bits of the PA-SAS1 hash. */
export async function pairingFingerprint(
  signPubN: Uint8Array,
  encPubN: Uint8Array,
  signPubX: Uint8Array,
  encPubX: Uint8Array,
  rN: Uint8Array,
  rX: Uint8Array,
): Promise<string> {
  return crockford(await fingerprintHash(signPubN, encPubN, signPubX, encPubX, rN, rX), 4);
}

/** sha256("PA-SAS1\n" || sign_pub_N || enc_pub_N || sign_pub_X || enc_pub_X || r_N || r_X) */
export async function fingerprintHash(
  signPubN: Uint8Array,
  encPubN: Uint8Array,
  signPubX: Uint8Array,
  encPubX: Uint8Array,
  rN: Uint8Array,
  rX: Uint8Array,
): Promise<Uint8Array> {
  return sha256(concat(ascii("PA-SAS1\n"), signPubN, encPubN, signPubX, encPubX, rN, rX));
}

/** First (5 * chars) bits, MSB first, as Crockford base32 chars. */
export function crockford(bytes: Uint8Array, chars: number): string {
  let out = "";
  for (let i = 0; i < chars; i++) {
    let v = 0;
    for (let b = 0; b < 5; b++) {
      const bit = i * 5 + b;
      v = (v << 1) | ((bytes[bit >> 3]! >> (7 - (bit & 7))) & 1);
    }
    out += CROCKFORD[v];
  }
  return out;
}

/** pairing id = first 8 bytes of sha256("PA-PAIRID1\n" || r_N || r_X) */
export async function pairingId(rN: Uint8Array, rX: Uint8Array): Promise<Uint8Array> {
  return (await sha256(concat(ascii("PA-PAIRID1\n"), rN, rX))).subarray(0, PAIRING_ID_LEN);
}

/** pk = b64url(first 16 bytes of sha256("PA-PAIRKEY1\n" || N id || X id)), ids as raw 30 bytes. */
export async function pairingKey(nId: Uint8Array, xId: Uint8Array): Promise<string> {
  return b64urlEncode((await sha256(concat(ascii("PA-PAIRKEY1\n"), nId, xId))).subarray(0, 16));
}

/** Push fields as PATCHed / registered by the extensions. */
export interface PushFields {
  type: "webpush";
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type AnyPush =
  | { type: "fcm" | "apns" | "apns-sandbox"; token: string }
  | { type: "webpush" | "unifiedpush"; endpoint: string; p256dh: string; auth: string };

/**
 * my_push_sha256 = b64url(first 16 bytes of sha256(UTF-8 of: fcm, apns:
 * type + "\n" + token; webpush, unifiedpush: type + "\n" + endpoint + "\n" +
 * p256dh + "\n" + auth)).
 */
export async function pushHash(p: AnyPush): Promise<string> {
  const s = "token" in p ? p.type + "\n" + p.token : p.type + "\n" + p.endpoint + "\n" + p.p256dh + "\n" + p.auth;
  return b64urlEncode((await sha256(utf8(s))).subarray(0, 16));
}

/**
 * A GET /peers list entry checked against the receiver account: 30-byte id
 * with the own account prefix, keyhash of the keys, valid 65-byte points,
 * sign_pub != enc_pub. Invalid entries are dropped.
 */
export async function validPeerEntry(id: Uint8Array, signPub: Uint8Array, encPub: Uint8Array, myAccount: Uint8Array): Promise<boolean> {
  if (!(await idMatchesKeys(id, signPub, encPub, myAccount))) return false;
  return (await isValidPub(signPub)) && (await isValidPub(encPub));
}
