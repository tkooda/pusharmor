// Inner messages and name entries (catalog r10: Inner message, Name entries,
// Receiver acceptance, Size cap).
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { b64d, b64e, b64ok, cat, u16 } from './bytes.mjs';
import { idMatches } from './ids.mjs';
import { openWire, sealWire } from './hpke.mjs';
import { isValidPub, sign, verify } from './p256.mjs';
import { counterN, JNum, parseStrict } from './jsonstrict.mjs';
import { replayOutcome } from './replay.mjs';

export const BUCKETS = [512, 1024, 2048, 3800];
export const MAX_WIRE = 3800;
export const HPKE_OVERHEAD = 65 + 16;
export const INFLATE_CAP = 16384;
export const CONTENT_CAP = 2048;
export const TYPES = ['url', 'text', 'tel', 'approve', 'deny', 'remove', 'rename', 'delete', 'pause', 'unpause'];

// Unpadded b64url length of n bytes.
export const wireChars = (n) => Math.ceil((n * 4) / 3);

// Smallest bucket that holds the unpadded wire length, or null (refuse).
export function bucketFor(chars) {
  for (const b of BUCKETS) if (chars <= b) return b;
  return null;
}

// HPKE plaintext length (sig included) that fills bucket b exactly.
export const plaintextLenFor = (b) => (b * 3) / 4 - HPKE_OVERHEAD;

export const deflate = (json) => deflateRawSync(Buffer.from(json, 'utf8'), { level: 9 });

export function inflateCapped(bytes) {
  // finishFlush: Z_SYNC_FLUSH is not used; a truncated stream throws.
  return inflateRawSync(bytes, { maxOutputLength: INFLATE_CAP });
}

// body = from id || pairing id || keys flag [|| sign_pub || enc_pub] || u16 len || deflated
export function bodyFor(fromId, pairingId, keys, deflated) {
  const flag = keys ? cat([1], keys.signPub, keys.encPub) : Buffer.from([0]);
  return cat(fromId, pairingId, flag, u16(deflated.length), deflated);
}

// Pads the body with zeros so the final wire length is a bucket.
export function padBody(body) {
  const b = bucketFor(wireChars(HPKE_OVERHEAD + 64 + body.length));
  if (b === null) return null;
  return cat(body, Buffer.alloc(plaintextLenFor(b) - 64 - body.length));
}

export const msgSignedBytes = (recipientIdB64, paddedBody) => cat('PA-MSG1\n' + recipientIdB64 + '\n', paddedBody);

// Full sender pipeline. Returns every intermediate value.
export function buildMessage({ signPriv, fromId, recipientIdB64, recipientEncPub, pairingId, keys, json, ikmE }) {
  const deflated = deflate(json);
  const body = bodyFor(fromId, pairingId, keys, deflated);
  const padded = padBody(body);
  if (padded === null) throw new Error('message: too large');
  const sig = sign(signPriv, msgSignedBytes(recipientIdB64, padded));
  const plaintext = cat(sig, padded);
  const s = sealWire(recipientEncPub, Buffer.from('PA-MSG1'), Buffer.from(recipientIdB64), plaintext, ikmE);
  return { json, deflated, body, padded, sig, plaintext, ...s, message: b64e(s.wire) };
}

// PA-NAME1 signed string; ids 40-char b64url, pairing id 11-char b64url,
// n minimal decimal, name as the b64url string in the entry.
export const nameSignedBytes = (ownerIdB64, recipientIdB64, pairingIdB64, n, nameB64) =>
  Buffer.from('PA-NAME1\n' + ownerIdB64 + '\n' + recipientIdB64 + '\n' + pairingIdB64 + '\n' + n + '\n' + nameB64);

export const isValidName = (name) => /^[\x20-\x7e]{1,32}$/.test(name);

// Checks a parsed {name, n, s} object (approve, rename or name entry).
// Returns { name, n } or null.
export function checkNameObject(o, ownerIdB64, recipientIdB64, pairingIdB64, signPub) {
  if (!(o instanceof Map) || o.size !== 3 || !o.has('name') || !o.has('n') || !o.has('s')) return null;
  const nameB64 = o.get('name');
  const s = o.get('s');
  const n = counterN(o.get('n'));
  if (typeof nameB64 !== 'string' || typeof s !== 'string' || n === null) return null;
  if (!b64ok(nameB64) || !b64ok(s)) return null;
  const name = b64d(nameB64).toString('latin1');
  if (!isValidName(name)) return null;
  if (!verify(signPub, nameSignedBytes(ownerIdB64, recipientIdB64, pairingIdB64, n, nameB64), b64d(s))) return null;
  return { name, n };
}

export function sealNameEntry(recipientIdB64, recipientEncPub, entryJson, ikmE) {
  const s = sealWire(recipientEncPub, Buffer.from('PA-NAME1'), Buffer.from(recipientIdB64), Buffer.from(entryJson), ikmE);
  return { ...s, ciphertext: b64e(s.wire) };
}

// Receiver of a name entry from GET /peers name_for_me. Returns { ok, name, n }.
export function openNameEntry(ciphertext, ownIdB64, ownEncPriv, ownerIdB64, pin) {
  if (ciphertext.length > 1024 || !b64ok(ciphertext)) return { ok: false };
  try {
    const pt = openWire(ownEncPriv, Buffer.from('PA-NAME1'), Buffer.from(ownIdB64), b64d(ciphertext));
    const r = checkNameObject(parseStrict(pt), ownerIdB64, ownIdB64, b64e(pin.pairing_id), pin.sign_pub);
    return r ? { ok: true, ...r } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function contentOk(v) {
  return typeof v === 'string' && Buffer.byteLength(v, 'utf8') <= CONTENT_CAP;
}

// Receive pipeline for one inner message.
// ctx: { own_id (b64url), own_enc_priv, own_account, pins: {id: {sign_pub, enc_pub,
//        pairing_id, ruling}}, window: {h, seen}, history: [n] }
// -> { outcome: "accept" | "invalid" | "represent" | "noop" | "unreadable", type, value, n }
export function receiveMessage(ctx, message) {
  const bad = (why) => ({ outcome: 'unreadable', why });
  if (message.length > MAX_WIRE || !b64ok(message)) return bad('encoding');
  let pt;
  try {
    pt = openWire(ctx.own_enc_priv, Buffer.from('PA-MSG1'), Buffer.from(ctx.own_id), b64d(message));
  } catch {
    return bad('hpke');
  }
  if (pt.length < 64 + 30 + 8 + 1 + 2) return bad('short');
  const sig = pt.subarray(0, 64);
  const fromId = pt.subarray(64, 94);
  const fromB64 = b64e(fromId);
  const pairingId = pt.subarray(94, 102);
  const flag = pt[102];
  let off = 103;
  if (!idMatches(fromId, ctx.own_account)) return bad('account prefix');
  const pin = ctx.pins[fromB64];
  if (!pin) return bad('unknown sender');
  let signPub = pin.sign_pub;
  if (flag === 1) {
    if (pt.length < off + 130 + 2) return bad('short');
    const sp = pt.subarray(off, off + 65);
    const ep = pt.subarray(off + 65, off + 130);
    off += 130;
    if (!isValidPub(sp) || !isValidPub(ep) || sp.equals(ep)) return bad('embedded keys');
    if (!idMatches(fromId, ctx.own_account, sp, ep)) return bad('embedded keyhash');
    if (!sp.equals(pin.sign_pub) || !ep.equals(pin.enc_pub)) return bad('keys not pinned');
    signPub = sp;
  } else if (flag !== 0) {
    return bad('keys flag');
  }
  const len = pt.readUInt16BE(off);
  off += 2;
  if (off + len > pt.length) return bad('length');
  const deflated = pt.subarray(off, off + len);
  if (pt.subarray(off + len).some((x) => x !== 0)) return bad('padding');
  if (!verify(signPub, msgSignedBytes(ctx.own_id, pt.subarray(64)), sig)) return bad('signature');
  if (!pairingId.equals(pin.pairing_id)) return bad('pairing id');
  let obj;
  try {
    obj = parseStrict(inflateCapped(deflated));
  } catch {
    return bad('inflate or json');
  }
  if (!(obj instanceof Map) || obj.size !== 2 || !obj.has('n')) return bad('shape');
  const n = counterN(obj.get('n'));
  if (n === null) return bad('n');
  const type = [...obj.keys()].find((k) => k !== 'n');
  if (!TYPES.includes(type)) return bad('type');
  const value = obj.get(type);
  if (flag === 1 && type !== 'approve') return bad('keys flag on non-approve');
  const pidB64 = b64e(pairingId);
  let result;
  if (type === 'url' || type === 'text' || type === 'tel') {
    if (!contentOk(value)) return bad('content');
    result = value;
  } else if (type === 'approve' || type === 'rename') {
    const r = checkNameObject(value, fromB64, ctx.own_id, pidB64, signPub);
    if (!r) return bad('name entry');
    result = r;
  } else if (type === 'remove') {
    if (typeof value !== 'string' || value.length !== 40 || !b64ok(value)) return bad('remove id');
    result = value;
  } else {
    if (!(value instanceof JNum) || value.raw !== '1') return bad('flag value');
    result = 1;
  }
  const r = replayOutcome(ctx.window, n, type, ctx.history.includes(n));
  if (r !== 'accept') return { outcome: r, type, n };
  // Receiver acceptance table.
  const ruling = pin.ruling;
  if (type === 'approve') {
    if (ruling === 'denied') return bad('approve from denied');
  } else if (ruling !== 'approved') {
    return bad('sender not approved');
  }
  return { outcome: 'accept', type, value: result, n };
}
