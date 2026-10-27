// Byte helpers and the strict b64url codec (catalog r10, General, Encodings).
import { createHash, createHmac } from 'node:crypto';

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const INDEX = new Map([...ALPHA].map((c, i) => [c, i]));

export function b64e(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

// Strict, canonical decode: URL alphabet only, no "=", length mod 4 != 1,
// spare bits must be zero. Throws on any violation.
export function b64d(s) {
  if (typeof s !== 'string') throw new Error('b64url: not a string');
  if (s.length % 4 === 1) throw new Error('b64url: bad length');
  for (const c of s) if (!INDEX.has(c)) throw new Error('b64url: bad char');
  const rem = s.length % 4;
  if (rem === 2 && (INDEX.get(s[s.length - 1]) & 0x0f) !== 0) throw new Error('b64url: spare bits');
  if (rem === 3 && (INDEX.get(s[s.length - 1]) & 0x03) !== 0) throw new Error('b64url: spare bits');
  return Buffer.from(s, 'base64url');
}

export function b64ok(s) {
  try { b64d(s); return true; } catch { return false; }
}

export const hexd = (s) => Buffer.from(s, 'hex');
export const hexe = (b) => Buffer.from(b).toString('hex');
export const utf8 = (s) => Buffer.from(s, 'utf8');
export const cat = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? utf8(p) : Buffer.from(p))));
export const sha256 = (...parts) => createHash('sha256').update(cat(...parts)).digest();
export const hmac = (key, ...parts) => createHmac('sha256', key).update(cat(...parts)).digest();
export const u16 = (n) => Buffer.from([n >> 8, n & 0xff]);
export const bigFrom = (b) => BigInt('0x' + (hexe(b) || '0'));
export const bigTo32 = (x) => hexd(x.toString(16).padStart(64, '0'));
