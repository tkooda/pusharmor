// P-256 keys, ECDH, and ECDSA with SHA-256 in raw r||s form.
// Signing uses RFC 6979 deterministic k so the generator is reproducible;
// any valid signature is acceptable to a verifier.
import { createECDH, createPublicKey, verify as nodeVerify } from 'node:crypto';
import { bigFrom, bigTo32, hmac, sha256, b64e } from './bytes.mjs';

export const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
export const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

const mod = (a, m) => ((a % m) + m) % m;
function inv(a, m) {
  let [r0, r1, s0, s1] = [mod(a, m), m, 1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return mod(s0, m);
}

// 65-byte uncompressed SEC1 point on P-256 (catalog: reject other lengths
// and points not on the curve).
export function isValidPub(pub) {
  if (!pub || pub.length !== 65 || pub[0] !== 0x04) return false;
  const x = bigFrom(pub.subarray(1, 33));
  const y = bigFrom(pub.subarray(33, 65));
  if (x >= P || y >= P) return false;
  return mod(y * y - (x * x * x - 3n * x + B), P) === 0n;
}

export function isValidPriv(sk) {
  if (!sk || sk.length !== 32) return false;
  const d = bigFrom(sk);
  return d > 0n && d < N;
}

export function pubFromPriv(sk) {
  if (!isValidPriv(sk)) throw new Error('p256: bad private key');
  const e = createECDH('prime256v1');
  e.setPrivateKey(Buffer.from(sk));
  return e.getPublicKey();
}

// Returns the 32-byte x coordinate of sk * pub.
export function ecdh(sk, pub) {
  if (!isValidPub(pub)) throw new Error('p256: bad public key');
  const e = createECDH('prime256v1');
  e.setPrivateKey(Buffer.from(sk));
  return e.computeSecret(Buffer.from(pub));
}

function rfc6979k(d, h1, attempt) {
  const x = bigTo32(d);
  const h = bigTo32(mod(bigFrom(h1), N));
  let V = Buffer.alloc(32, 1);
  let K = Buffer.alloc(32, 0);
  K = hmac(K, V, [0], x, h); V = hmac(K, V);
  K = hmac(K, V, [1], x, h); V = hmac(K, V);
  for (;;) {
    V = hmac(K, V);
    const k = bigFrom(V);
    if (k >= 1n && k < N) {
      if (attempt === 0) return k;
      attempt -= 1;
    }
    K = hmac(K, V, [0]); V = hmac(K, V);
  }
}

// ECDSA P-256 SHA-256, raw r||s (64 bytes), deterministic k (RFC 6979).
export function sign(sk, msg) {
  const d = bigFrom(sk);
  const h1 = sha256(msg);
  const z = bigFrom(h1);
  for (let attempt = 0; ; attempt++) {
    const k = rfc6979k(d, h1, attempt);
    const r = mod(bigFrom(pubFromPriv(bigTo32(k)).subarray(1, 33)), N);
    if (r === 0n) continue;
    const s = mod(inv(k, N) * (z + r * d), N);
    if (s === 0n) continue;
    return Buffer.concat([bigTo32(r), bigTo32(s)]);
  }
}

export function verify(pub, msg, sig) {
  if (!isValidPub(pub) || !sig || sig.length !== 64) return false;
  const key = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64e(pub.subarray(1, 33)), y: b64e(pub.subarray(33, 65)) },
    format: 'jwk',
  });
  return nodeVerify('sha256', Buffer.from(msg), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig));
}
