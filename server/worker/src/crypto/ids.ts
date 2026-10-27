// Ids (catalog IDs): email_hash, account id, keyhash, peer id and its MAC check.
import { b64urlDecode, b64urlEncode } from "../codec/b64url";
import { concat, ctEqual, hmac, sha256, utf8 } from "./hash";

export async function emailHash(normalizedEmail: string): Promise<Uint8Array> {
  return sha256(utf8("PA-ACCT1\n" + normalizedEmail));
}

// 9 bytes -> 12 b64url chars.
export async function accountId(idSecret: string, eh: Uint8Array): Promise<string> {
  return b64urlEncode((await hmac(idSecret, eh)).slice(0, 9));
}

// sha256("PA-ID1\n" || sign_pub || enc_pub)[0..12]
export async function keyhash(signPub: Uint8Array, encPub: Uint8Array): Promise<Uint8Array> {
  return (await sha256(concat(utf8("PA-ID1\n"), signPub, encPub))).slice(0, 12);
}

async function idMac(idSecret: string, account: Uint8Array, kh: Uint8Array): Promise<Uint8Array> {
  return (await hmac(idSecret, concat(account, kh))).slice(0, 9);
}

export async function peerId(idSecret: string, account: string, signPub: Uint8Array, encPub: Uint8Array): Promise<string> {
  const a = b64urlDecode(account);
  if (!a || a.length !== 9) throw new Error("account");
  const kh = await keyhash(signPub, encPub);
  return b64urlEncode(concat(a, kh, await idMac(idSecret, a, kh)));
}

// Strict b64url, 30 bytes, MAC recomputed and compared in constant time.
export async function checkPeerIdMac(idSecret: string, id: string): Promise<boolean> {
  if (typeof id !== "string" || id.length !== 40) return false;
  const raw = b64urlDecode(id);
  if (!raw || raw.length !== 30) return false;
  const mac = await idMac(idSecret, raw.slice(0, 9), raw.slice(9, 21));
  return ctEqual(mac, raw.slice(21, 30));
}

// keyhash bytes embedded in a peer id.
export function idKeyhash(id: string): Uint8Array {
  return (b64urlDecode(id) as Uint8Array).slice(9, 21);
}
