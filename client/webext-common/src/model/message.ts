// Inner message (catalog Inner message), name entries (Name entries) and
// pair messages (Pairing). Sender order: build body, pad to bucket, sign,
// prepend sig, HPKE seal. Receiver: open, parse, verify, then inflate.
import { b64urlEncode, b64urlTryDecode } from "../crypto/b64url.ts";
import { ascii, concat, equal, utf8, utf8Decode } from "../crypto/bytes.ts";
import { ENC_LEN, TAG_LEN, hpkeOpen, hpkeSeal } from "../crypto/hpke.ts";
import { sign, verify } from "../crypto/keys.ts";
import { ID_LEN, PAIRING_ID_LEN, R_LEN, commitHash, hasAccount, validPeerEntry } from "../crypto/labels.ts";
import { deflateRaw, inflateRaw } from "./deflate.ts";
import { type JObject, type JValue, JNum, counterN, isObject, nStr, parseStrictJson } from "./json.ts";
import { CONTENT_CAP, INFLATE_CAP, PAIR_WIRE_LEN, WIRE_CAP, paddedWireBytes, utf8Len } from "./padding.ts";

export const INFO_MSG = ascii("PA-MSG1");
export const INFO_NAME = ascii("PA-NAME1");
export const INFO_PAIR = ascii("PA-PAIR1");
const SIG_LEN = 64;
const KEYS_LEN = 130;

export interface NameEntry {
  name: string; // b64url of the name, exactly as in the entry
  n: number;
  s: string; // b64url signature
}

export type Content =
  | { type: "url"; value: string }
  | { type: "text"; value: string }
  | { type: "tel"; value: string }
  | { type: "approve"; entry: NameEntry }
  | { type: "rename"; entry: NameEntry }
  | { type: "deny" }
  | { type: "remove"; id: string }
  | { type: "delete" }
  | { type: "pause" }
  | { type: "unpause" };

export type ContentType = Content["type"];
export const CONTROL_TYPES: ReadonlySet<ContentType> = new Set([
  "approve",
  "rename",
  "remove",
  "delete",
  "pause",
  "unpause",
  "deny",
]);
const TYPE_KEYS: ReadonlySet<string> = new Set([
  "url",
  "text",
  "tel",
  "approve",
  "deny",
  "remove",
  "rename",
  "delete",
  "pause",
  "unpause",
]);

/** JSON {"n": n, type: value}. */
export function buildJson(n: number, c: Content): string {
  const ns = nStr(n);
  switch (c.type) {
    case "url":
    case "text":
    case "tel":
      return '{"n":' + ns + "," + JSON.stringify(c.type) + ":" + JSON.stringify(c.value) + "}";
    case "approve":
    case "rename":
      return '{"n":' + ns + ',"' + c.type + '":' + nameEntryJson(c.entry) + "}";
    case "remove":
      return '{"n":' + ns + ',"remove":' + JSON.stringify(c.id) + "}";
    default:
      return '{"n":' + ns + ',"' + c.type + '":1}';
  }
}

export function nameEntryJson(e: NameEntry): string {
  return '{"name":' + JSON.stringify(e.name) + ',"n":' + nStr(e.n) + ',"s":' + JSON.stringify(e.s) + "}";
}

/** Signed bytes of an inner message: "PA-MSG1\n" + recipient id + "\n" + body. */
export function msgSignedBytes(recipientId: string, body: Uint8Array): Uint8Array {
  return concat(ascii("PA-MSG1\n" + recipientId + "\n"), body);
}

export interface EncodeArgs {
  signKey: CryptoKey;
  fromId: Uint8Array; // 30 raw bytes
  pairingId: Uint8Array; // 8 bytes
  keys?: { sign_pub: Uint8Array; enc_pub: Uint8Array }; // approve only
  json: string;
  recipientId: string; // 40-char b64url
  recipientEncPub: Uint8Array;
  ikmE?: Uint8Array; // tests only
}

/** Builds body (unsigned plaintext after sig) padded to the bucket. */
export async function buildBody(a: EncodeArgs): Promise<Uint8Array> {
  if (a.fromId.length !== ID_LEN || a.pairingId.length !== PAIRING_ID_LEN) throw new Error("bad ids");
  const deflated = await deflateRaw(utf8(a.json));
  if (deflated.length > 0xffff) throw new Error("too large");
  const flag = a.keys ? 1 : 0;
  const head = concat(
    a.fromId,
    a.pairingId,
    new Uint8Array([flag]),
    a.keys ? concat(a.keys.sign_pub, a.keys.enc_pub) : new Uint8Array(0),
    new Uint8Array([deflated.length >> 8, deflated.length & 255]),
    deflated,
  );
  const unpadded = ENC_LEN + SIG_LEN + head.length + TAG_LEN;
  const target = paddedWireBytes(unpadded, flag === 1);
  if (target === null) throw new Error("too large");
  return concat(head, new Uint8Array(target - unpadded));
}

export async function encodeInner(a: EncodeArgs): Promise<string> {
  const body = await buildBody(a);
  const sig = await sign(a.signKey, msgSignedBytes(a.recipientId, body));
  const wire = await hpkeSeal(a.recipientEncPub, INFO_MSG, ascii(a.recipientId), concat(sig, body), a.ikmE);
  const m = b64urlEncode(wire);
  if (m.length > WIRE_CAP) throw new Error("too large");
  return m;
}

export interface InnerPlain {
  sig: Uint8Array;
  body: Uint8Array; // every byte after sig (signed)
  fromId: Uint8Array;
  pairingId: Uint8Array;
  keys: { sign_pub: Uint8Array; enc_pub: Uint8Array } | null;
  deflated: Uint8Array;
}

/** Parse the HPKE plaintext; checks lengths and an all-zero pad. */
export function parseInnerPlain(pt: Uint8Array): InnerPlain | null {
  let o = SIG_LEN + ID_LEN + PAIRING_ID_LEN + 1;
  if (pt.length < o + 2) return null;
  const sig = pt.subarray(0, SIG_LEN);
  const fromId = pt.subarray(SIG_LEN, SIG_LEN + ID_LEN);
  const pairingId = pt.subarray(SIG_LEN + ID_LEN, SIG_LEN + ID_LEN + PAIRING_ID_LEN);
  const flag = pt[o - 1];
  let keys: InnerPlain["keys"] = null;
  if (flag === 1) {
    if (pt.length < o + KEYS_LEN + 2) return null;
    keys = { sign_pub: pt.subarray(o, o + 65), enc_pub: pt.subarray(o + 65, o + KEYS_LEN) };
    o += KEYS_LEN;
  } else if (flag !== 0) return null;
  const len = (pt[o]! << 8) | pt[o + 1]!;
  o += 2;
  if (len === 0 || o + len > pt.length) return null;
  const deflated = pt.subarray(o, o + len);
  for (let i = o + len; i < pt.length; i++) if (pt[i] !== 0) return null;
  return { sig, body: pt.subarray(SIG_LEN), fromId, pairingId, keys, deflated };
}

export async function openInner(myEnc: CryptoKeyPair, myId: string, m: string): Promise<Uint8Array | null> {
  if (m.length > WIRE_CAP) return null;
  const wire = b64urlTryDecode(m);
  if (!wire || wire.length < ENC_LEN + TAG_LEN) return null;
  return hpkeOpen(myEnc, INFO_MSG, ascii(myId), wire);
}

export async function verifyInner(signPub: Uint8Array, myId: string, p: InnerPlain): Promise<boolean> {
  return verify(signPub, p.sig, msgSignedBytes(myId, p.body));
}

export interface ParsedJson {
  n: number;
  content: Content;
}

export function isPrintableName(name: string): boolean {
  return name.length >= 1 && name.length <= 32 && /^[\x20-\x7e]+$/.test(name);
}

function parseEntry(v: JValue | undefined): NameEntry | null {
  if (!isObject(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 3 || !("name" in v) || !("n" in v) || !("s" in v)) return null;
  const n = counterN(v.n);
  if (n === null || typeof v.name !== "string" || typeof v.s !== "string") return null;
  const nb = b64urlTryDecode(v.name);
  if (!nb || !isPrintableName(String.fromCharCode(...nb))) return null;
  const sb = b64urlTryDecode(v.s);
  if (!sb || sb.length !== SIG_LEN) return null;
  return { name: v.name, n, s: v.s };
}

/** Inflated JSON -> {n, content}; null on any rule violation (Notice rule drop). */
export function parseInnerJson(bytes: Uint8Array): ParsedJson | null {
  let text: string;
  let v: JValue;
  try {
    text = utf8Decode(bytes);
    v = parseStrictJson(text);
  } catch {
    return null;
  }
  if (!isObject(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 2 || !("n" in v)) return null;
  const n = counterN(v.n);
  if (n === null) return null;
  const t = keys.find((k) => k !== "n")!;
  if (!TYPE_KEYS.has(t)) return null;
  const val = v[t];
  switch (t) {
    case "url":
    case "text":
    case "tel":
      if (typeof val !== "string" || utf8Len(val) > CONTENT_CAP) return null;
      return { n, content: { type: t, value: val } };
    case "approve":
    case "rename": {
      const entry = parseEntry(val);
      if (!entry || entry.n !== n) return null;
      return { n, content: { type: t, entry } };
    }
    case "remove": {
      if (typeof val !== "string") return null;
      const id = b64urlTryDecode(val);
      if (!id || id.length !== ID_LEN) return null;
      return { n, content: { type: "remove", id: val } };
    }
    default:
      if (!(val instanceof JNum) || val.raw !== "1") return null;
      return { n, content: { type: t as "deny" | "delete" | "pause" | "unpause" } };
  }
}

export async function inflateInner(p: InnerPlain): Promise<Uint8Array | null> {
  return inflateRaw(p.deflated, INFLATE_CAP);
}

// ---- Name entries ----

export function nameSignedString(owner: string, recipient: string, pairingId: Uint8Array, n: number, nameB64: string): Uint8Array {
  return ascii("PA-NAME1\n" + owner + "\n" + recipient + "\n" + b64urlEncode(pairingId) + "\n" + nStr(n) + "\n" + nameB64);
}

export async function makeNameEntry(
  signKey: CryptoKey,
  owner: string,
  recipient: string,
  pairingId: Uint8Array,
  n: number,
  name: string,
): Promise<NameEntry> {
  if (!isPrintableName(name)) throw new Error("bad name");
  const nameB64 = b64urlEncode(ascii(name));
  const s = await sign(signKey, nameSignedString(owner, recipient, pairingId, n, nameB64));
  return { name: nameB64, n, s: b64urlEncode(s) };
}

/** Returns the decoded name when the entry verifies, else null. */
export async function verifyNameEntry(
  ownerSignPub: Uint8Array,
  owner: string,
  recipient: string,
  pairingId: Uint8Array,
  e: NameEntry,
): Promise<string | null> {
  const sig = b64urlTryDecode(e.s);
  const nb = b64urlTryDecode(e.name);
  if (!sig || !nb) return null;
  const ok = await verify(ownerSignPub, sig, nameSignedString(owner, recipient, pairingId, e.n, e.name));
  if (!ok) return null;
  const name = String.fromCharCode(...nb);
  return isPrintableName(name) ? name : null;
}

export async function sealNameEntry(e: NameEntry, recipient: string, recipientEncPub: Uint8Array, ikmE?: Uint8Array): Promise<string> {
  const ct = b64urlEncode(await hpkeSeal(recipientEncPub, INFO_NAME, ascii(recipient), utf8(nameEntryJson(e)), ikmE));
  if (ct.length > 1024) throw new Error("name entry too large");
  return ct;
}

export async function openNameEntry(myEnc: CryptoKeyPair, myId: string, ct: string): Promise<NameEntry | null> {
  if (ct.length > 1024) return null;
  const wire = b64urlTryDecode(ct);
  if (!wire) return null;
  const pt = await hpkeOpen(myEnc, INFO_NAME, ascii(myId), wire);
  if (!pt) return null;
  try {
    return parseEntry(parseStrictJson(utf8Decode(pt)));
  } catch {
    return null;
  }
}

// ---- Pair messages ----

export type PairKind = "commit" | "reply" | "open";
const KIND_BYTE: Record<PairKind, number> = { commit: 1, reply: 2, open: 3 };

export type PairBody =
  | { kind: "commit"; c_N: Uint8Array }
  | { kind: "reply" | "open"; sign_pub: Uint8Array; enc_pub: Uint8Array; r: Uint8Array };

export function pairPlain(fromId: Uint8Array, b: PairBody): Uint8Array {
  const body = new Uint8Array(162);
  if (b.kind === "commit") {
    if (b.c_N.length !== 32) throw new Error("bad c_N");
    body.set(b.c_N, 0);
  } else {
    if (b.sign_pub.length !== 65 || b.enc_pub.length !== 65 || b.r.length !== R_LEN) throw new Error("bad pair body");
    body.set(b.sign_pub, 0);
    body.set(b.enc_pub, 65);
    body.set(b.r, 130);
  }
  return concat(new Uint8Array([KIND_BYTE[b.kind]]), fromId, body);
}

export async function encodePair(
  fromId: Uint8Array,
  b: PairBody,
  recipientId: string,
  recipientEncPub: Uint8Array,
  ikmE?: Uint8Array,
): Promise<string> {
  const wire = await hpkeSeal(recipientEncPub, INFO_PAIR, ascii(recipientId), pairPlain(fromId, b), ikmE);
  const m = b64urlEncode(wire);
  if (m.length !== PAIR_WIRE_LEN) throw new Error("pair size");
  return m;
}

export interface PairMsg {
  fromId: Uint8Array;
  body: PairBody;
}

export function parsePairPlain(pt: Uint8Array): PairMsg | null {
  if (pt.length !== 193) return null;
  const k = pt[0];
  const fromId = pt.slice(1, 31);
  const body = pt.subarray(31);
  if (k === 1) {
    for (let i = 32; i < 162; i++) if (body[i] !== 0) return null;
    return { fromId, body: { kind: "commit", c_N: body.slice(0, 32) } };
  }
  if (k === 2 || k === 3) {
    const sign_pub = body.slice(0, 65);
    const enc_pub = body.slice(65, 130);
    if (equal(sign_pub, enc_pub)) return null;
    return { fromId, body: { kind: k === 2 ? "reply" : "open", sign_pub, enc_pub, r: body.slice(130, 162) } };
  }
  return null;
}

export async function openPair(myEnc: CryptoKeyPair, myId: string, m: string): Promise<PairMsg | null> {
  if (m.length !== PAIR_WIRE_LEN) return null;
  const wire = b64urlTryDecode(m);
  if (!wire) return null;
  const pt = await hpkeOpen(myEnc, INFO_PAIR, ascii(myId), wire);
  return pt ? parsePairPlain(pt) : null;
}

export function isPairWire(m: string): boolean {
  return m.length === PAIR_WIRE_LEN;
}

export type { JObject };

/**
 * Receiver checks on an opened pair message (catalog Pairing): the from id
 * carries the own account prefix; in reply and open the keys hash to the from
 * id's keyhash and are valid points (sign_pub != enc_pub is checked at parse);
 * the kind fits the receiver state; an open matches the stored c_N.
 */
export async function pairAcceptable(msg: PairMsg, myAccount: Uint8Array, expectedKind: PairKind, storedCN?: Uint8Array): Promise<boolean> {
  if (!hasAccount(msg.fromId, myAccount) || msg.body.kind !== expectedKind) return false;
  const b = msg.body;
  if (b.kind === "commit") return true;
  if (!(await validPeerEntry(msg.fromId, b.sign_pub, b.enc_pub, myAccount))) return false;
  if (b.kind === "open" && storedCN) return equal(await commitHash(b.sign_pub, b.enc_pub, b.r), storedCN);
  return true;
}
