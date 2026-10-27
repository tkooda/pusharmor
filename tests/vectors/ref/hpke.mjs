// RFC 9180 HPKE, base mode, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256,
// AES-GCM (AES-256-GCM is the PushArmor suite). Single-shot seal/open
// (sequence number 0). The sender ephemeral key comes from DeriveKeyPair(ikmE)
// so the generator is deterministic; production senders use a random key.
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { cat, hmac, u16, bigFrom } from './bytes.mjs';
import { N, ecdh, isValidPub, pubFromPriv } from './p256.mjs';

const KEM_ID = 0x0010;
const KDF_ID = 0x0001;
export const AEAD_AES_128_GCM = 0x0001;
export const AEAD_AES_256_GCM = 0x0002;

const KEM_SUITE = cat('KEM', u16(KEM_ID));
const hpkeSuite = (aead) => cat('HPKE', u16(KEM_ID), u16(KDF_ID), u16(aead));

const extract = (salt, ikm) => hmac(salt.length ? salt : Buffer.alloc(32), ikm);
function expand(prk, info, len) {
  let t = Buffer.alloc(0);
  let out = Buffer.alloc(0);
  for (let i = 1; out.length < len; i++) {
    t = hmac(prk, t, info, [i]);
    out = Buffer.concat([out, t]);
  }
  return out.subarray(0, len);
}
const labeledExtract = (suite, salt, label, ikm) => extract(salt, cat('HPKE-v1', suite, label, ikm));
const labeledExpand = (suite, prk, label, info, len) =>
  expand(prk, cat(u16(len), 'HPKE-v1', suite, label, info), len);

export function deriveKeyPair(ikm) {
  const prk = labeledExtract(KEM_SUITE, Buffer.alloc(0), 'dkp_prk', ikm);
  for (let counter = 0; counter < 256; counter++) {
    const bytes = labeledExpand(KEM_SUITE, prk, 'candidate', Buffer.from([counter]), 32);
    const sk = bigFrom(bytes);
    if (sk !== 0n && sk < N) return { sk: bytes, pk: pubFromPriv(bytes) };
  }
  throw new Error('hpke: DeriveKeyPairError');
}

function extractAndExpand(dh, kemContext) {
  const prk = labeledExtract(KEM_SUITE, Buffer.alloc(0), 'eae_prk', dh);
  return labeledExpand(KEM_SUITE, prk, 'shared_secret', kemContext, 32);
}

function keySchedule(aead, sharedSecret, info) {
  const suite = hpkeSuite(aead);
  const nk = aead === AEAD_AES_256_GCM ? 32 : 16;
  const pskIdHash = labeledExtract(suite, Buffer.alloc(0), 'psk_id_hash', Buffer.alloc(0));
  const infoHash = labeledExtract(suite, Buffer.alloc(0), 'info_hash', info);
  const context = cat([0], pskIdHash, infoHash);
  const secret = labeledExtract(suite, sharedSecret, 'secret', Buffer.alloc(0));
  return {
    key_schedule_context: context,
    secret,
    key: labeledExpand(suite, secret, 'key', context, nk),
    base_nonce: labeledExpand(suite, secret, 'base_nonce', context, 12),
    exporter_secret: labeledExpand(suite, secret, 'exp', context, 32),
  };
}

function gcm(key) {
  return key.length === 32 ? 'aes-256-gcm' : 'aes-128-gcm';
}

export function aeadSeal(key, nonce, aad, pt) {
  const c = createCipheriv(gcm(key), key, nonce);
  c.setAAD(Buffer.from(aad));
  return Buffer.concat([c.update(Buffer.from(pt)), c.final(), c.getAuthTag()]);
}

export function aeadOpen(key, nonce, aad, ct) {
  if (ct.length < 16) throw new Error('aead: short');
  const d = createDecipheriv(gcm(key), key, nonce);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
}

// Returns every intermediate value plus enc and ct.
export function sealBase({ pkR, info, aad, pt, ikmE, aead = AEAD_AES_256_GCM }) {
  const { sk: skE, pk: pkE } = deriveKeyPair(ikmE);
  const dh = ecdh(skE, pkR);
  const sharedSecret = extractAndExpand(dh, cat(pkE, pkR));
  const ks = keySchedule(aead, sharedSecret, info);
  const ct = aeadSeal(ks.key, ks.base_nonce, aad, pt);
  return { ikmE, skE, enc: pkE, shared_secret: sharedSecret, ...ks, ct };
}

export function openBase({ skR, enc, info, aad, ct, aead = AEAD_AES_256_GCM }) {
  if (!isValidPub(enc)) throw new Error('hpke: bad enc');
  const pkR = pubFromPriv(skR);
  const dh = ecdh(skR, enc);
  const sharedSecret = extractAndExpand(dh, cat(enc, pkR));
  const ks = keySchedule(aead, sharedSecret, info);
  return aeadOpen(ks.key, ks.base_nonce, aad, ct);
}

// PushArmor wire form: b64url(enc(65) || ct+tag); here as raw bytes.
export function sealWire(pkR, info, aad, pt, ikmE) {
  const r = sealBase({ pkR, info, aad, pt, ikmE });
  return { ...r, wire: Buffer.concat([r.enc, r.ct]) };
}

export function openWire(skR, info, aad, wire) {
  if (wire.length < 65 + 16) throw new Error('hpke: short');
  return openBase({ skR, enc: wire.subarray(0, 65), info, aad, ct: wire.subarray(65) });
}
