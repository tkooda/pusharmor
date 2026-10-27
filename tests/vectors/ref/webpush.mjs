// RFC 8291 Web Push message encryption (aes128gcm, RFC 8188), one record.
import { cat, hmac } from './bytes.mjs';
import { aeadOpen, aeadSeal } from './hpke.mjs';
import { ecdh, pubFromPriv } from './p256.mjs';

function derive(ecdhSecret, authSecret, uaPublic, asPublic, salt) {
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = cat('WebPush: info', [0], uaPublic, asPublic);
  const ikm = hmac(prkKey, keyInfo, [1]);
  const prk = hmac(salt, ikm);
  const cekInfo = cat('Content-Encoding: aes128gcm', [0]);
  const nonceInfo = cat('Content-Encoding: nonce', [0]);
  return {
    ecdh_secret: ecdhSecret,
    prk_key: prkKey,
    key_info: keyInfo,
    ikm,
    prk,
    cek_info: cekInfo,
    cek: hmac(prk, cekInfo, [1]).subarray(0, 16),
    nonce_info: nonceInfo,
    nonce: hmac(prk, nonceInfo, [1]).subarray(0, 12),
  };
}

// Application server side (the Worker). Returns intermediates and body.
export function encrypt({ plaintext, asPrivate, uaPublic, authSecret, salt, rs = 4096 }) {
  const asPublic = pubFromPriv(asPrivate);
  const d = derive(ecdh(asPrivate, uaPublic), authSecret, uaPublic, asPublic, salt);
  const rsb = Buffer.alloc(4);
  rsb.writeUInt32BE(rs);
  const header = cat(salt, rsb, [65], asPublic);
  const padded = cat(plaintext, [2]);
  const ciphertext = aeadSeal(d.cek, d.nonce, Buffer.alloc(0), padded);
  return { ...d, header, padded_plaintext: padded, ciphertext, body: cat(header, ciphertext) };
}

// User agent side (Firefox add-on). Single record, delimiter 0x02.
export function decrypt({ body, uaPrivate, authSecret }) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ua = pubFromPriv(uaPrivate);
  const d = derive(ecdh(uaPrivate, asPublic), authSecret, ua, asPublic, salt);
  const padded = aeadOpen(d.cek, d.nonce, Buffer.alloc(0), body.subarray(21 + idlen));
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (end < 0 || padded[end] !== 2) throw new Error('webpush: bad padding delimiter');
  return padded.subarray(0, end);
}
