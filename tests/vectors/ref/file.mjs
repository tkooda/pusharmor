// File send reference: PA-FILE1 and PA-DL1 signing strings, the AES-256-GCM blob, the
// Worker lifetime and key rules, file names, CLI name collisions, and the
// auto-download decision.
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { hmac, hexe, utf8 } from './bytes.mjs';
import { sign, verify } from './p256.mjs';

export const MAX_FILE = 100000000; // plaintext bytes, decimal
export const BLOB_OVERHEAD = 28; // 12-byte nonce + 16-byte GCM tag

// ---------------------------------------------------------------- PA-FILE1
// Frozen strings, no trailing newline. PA-Sig = ECDSA P-256 SHA-256 raw r||s.
export const filePostBytes = (paTime, contentLength, fileSha256, sendId) =>
  utf8('PA-FILE1\nPOST\n/v1/file\n' + paTime + '\n' + contentLength + '\n' + fileSha256 + '\n' + sendId);
export const fileDeleteBytes = (id, paTime) => utf8('PA-FILE1\nDELETE\n/v1/file/' + id + '\n' + paTime);
// PA-DL1: a file host GET, path = URL pathname with its leading "/". Range is not signed.
export const downloadBytes = (path, paTime) => utf8('PA-DL1\nGET\n' + path + '\n' + paTime);
export const signFile = (sk, bytes) => sign(sk, bytes);
export const verifyFile = (pub, bytes, sig) => verify(pub, bytes, sig);

// ---------------------------------------------------------------- blob
// blob = nonce (12) || ciphertext || tag (16); no AAD; length = plaintext + 28.
export function sealBlob(key, nonce, plaintext) {
  const c = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]);
}

export function openBlob(key, blob) {
  if (blob.length < BLOB_OVERHEAD) throw new Error('blob: too short');
  const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]);
}

// ---------------------------------------------------------------- Worker only
// Lifetime in minutes: min(1440, floor(14,400,000,000 / size)); size 0 -> 1440.
// size = Content-Length - 28. Content-Length > MAX_FILE + 28 -> 413 (null).
// Content-Length < 28 -> 400 (null).
export function ttlMinutes(size) {
  if (size < 0 || size > MAX_FILE) return null;
  if (size === 0) return 1440;
  return Math.min(1440, Math.floor(14400000000 / size));
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function minuteStamp(unixSec) {
  const d = new Date(Math.floor(unixSec / 60) * 60000);
  return pad(d.getUTCFullYear(), 4) + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + pad(d.getUTCHours()) +
    pad(d.getUTCMinutes());
}

// acct-hash = first 16 hex of HMAC-SHA256(secret, raw account id bytes).
export const acctHash = (secret, account) => hexe(hmac(secret, account)).slice(0, 16);

export function fileKey({ acceptTime, size, secret, account, randHex }) {
  const expires = acceptTime + ttlMinutes(size) * 60;
  const minute = minuteStamp(expires);
  const id = minute + '-' + randHex;
  const key = 'v1/' + minute + '/' + acctHash(secret, account) + '/' + id;
  return { expires, minute, id, key, url: 'https://b2file.pusharmor.com/' + key };
}

// ---------------------------------------------------------------- names
const RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL',
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((i) => ['COM' + i, 'LPT' + i])]);

export function fallbackStamp(unixSec) {
  const d = new Date(unixSec * 1000);
  return pad(d.getUTCFullYear(), 4) + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + '-' + pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) + pad(d.getUTCSeconds());
}

export function splitExt(s) {
  const i = s.lastIndexOf('.');
  if (i >= 0 && /^[A-Za-z0-9]{1,10}$/.test(s.slice(i + 1))) return [s.slice(0, i), s.slice(i + 1)];
  return [s, ''];
}

export function sanitizeName(raw, timeSec, image) {
  let s = raw.split(/[/\\]/).pop(); // 1 basename
  s = [...s].map((c) => (/^[A-Za-z0-9 ._()-]$/.test(c) ? c : '_')).join(''); // 2
  s = s.replace(/_+/g, '_').replace(/ +/g, ' '); // 3
  s = s.replace(/^[. ]+/, '').replace(/[. ]+$/, ''); // 4
  let [base, ext] = splitExt(s); // 5
  if (!/[A-Za-z0-9]/.test(base) || base.length > 64) base = (image ? 'image-' : 'file-') + fallbackStamp(timeSec); // 6
  if (base.length + (ext ? ext.length + 1 : 0) > 100) base = base.slice(0, 100 - (ext ? ext.length + 1 : 0)); // 7
  let out = ext ? base + '.' + ext : base;
  if (RESERVED.has(out.split('.')[0].replace(/[ .]+$/, '').toUpperCase())) out = '_' + out; // 8
  return out;
}

// CLI listen --files DIR: "base (N).ext", N from 1; names match ignoring case.
export function collisionName(name, existing) {
  const have = new Set(existing.map((e) => e.toLowerCase()));
  if (!have.has(name.toLowerCase())) return name;
  const [base, ext] = splitExt(name);
  for (let n = 1; ; n++) {
    const c = base + ' (' + n + ')' + (ext ? '.' + ext : '');
    if (!have.has(c.toLowerCase())) return c;
  }
}

// ---------------------------------------------------------------- auto-download
// client phone: picker = the picker for the current network; Data Saver / Low
// Data Mode on mobile = Off. browser: one picker, network ignored. cli: every
// file up to MAX_FILE. picker 0 = Off.
export function autoDownload({ client, network, data_saver: dataSaver, picker, size }) {
  if (client === 'cli') return size <= MAX_FILE;
  if (client === 'phone' && network === 'mobile' && dataSaver) return false;
  return picker > 0 && size <= picker;
}
