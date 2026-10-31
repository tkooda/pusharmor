// IDs, email_hash, OAuth nonce, my_push_sha256 (catalog r10: General/IDs,
// Auth, Peers).
import { b64d, b64e, cat, hmac, sha256 } from './bytes.mjs';

const ASCII_WS = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);

// Trim ASCII whitespace, reject any non-ASCII byte, then ASCII lowercase
// (A-Z -> a-z only). Returns null for "bad email".
export function normalizeEmail(s) {
  const b = Buffer.from(s, 'utf8');
  let i = 0;
  let j = b.length;
  while (i < j && ASCII_WS.has(b[i])) i++;
  while (j > i && ASCII_WS.has(b[j - 1])) j--;
  const t = b.subarray(i, j);
  if (t.some((c) => c > 0x7f)) return null;
  return Buffer.from(t.map((c) => (c >= 0x41 && c <= 0x5a ? c + 0x20 : c))).toString('latin1');
}

// Providers that deliver "local+tag" to "local"; Gmail also ignores dots in the local part.
const PLUS_TAG = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'fastmail.com', 'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me',
]);
const GMAIL = new Set(['gmail.com', 'googlemail.com']);

// Account identity (Q334): one mailbox for a normalized address. Strip +tag at PLUS_TAG domains;
// at Gmail also drop dots and map googlemail.com -> gmail.com. Other domains are unchanged.
export function mailboxKey(normalized) {
  const at = normalized.lastIndexOf('@');
  let local = normalized.slice(0, at);
  let domain = normalized.slice(at + 1);
  if (!PLUS_TAG.has(domain)) return normalized;
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (GMAIL.has(domain)) {
    domain = 'gmail.com';
    local = local.replace(/\./g, '') || local;
  }
  return local + '@' + domain;
}

export const emailHash = (normalized) => sha256('PA-ACCT1\n', normalized);
export const accountId = (idSecret, eh) => hmac(idSecret, eh).subarray(0, 9);
export const keyhash = (signPub, encPub) => sha256('PA-ID1\n', signPub, encPub).subarray(0, 12);

export function peerId(idSecret, account, kh) {
  return cat(account, kh, hmac(idSecret, account, kh).subarray(0, 9));
}

// Client-side checks on a listed id or an inner from id (no ID_SECRET):
// account(9) prefix equals mine and the keys hash to the keyhash part.
export function idMatches(idRaw, myAccount, signPub, encPub) {
  return (
    idRaw.length === 30 &&
    idRaw.subarray(0, 9).equals(myAccount) &&
    (signPub === undefined || idRaw.subarray(9, 21).equals(keyhash(signPub, encPub)))
  );
}

// Unsigned lexicographic compare of the decoded 30 raw id bytes (I232).
export function compareIds(a, b) {
  return Buffer.compare(b64d(a), b64d(b));
}

export function oauthNonce(purpose, signPub) {
  const k = b64e(sha256(signPub));
  return { k, nonce: b64e(sha256('PA-NONCE1\n' + purpose + '\n' + k)) };
}

// Command line login code (Q302): k16 = b64url(sha256(sign_pub)[0..16]),
// code = b64url(account || HMAC-SHA256(token_secret, "PA-CLI1\n" a "\n" k16 "\n" p "\n" window)[0..16])
// with a = b64url(account), p = r | l | d, window = floor(unix s / 600) in decimal.
export function cliCode(tokenSecret, account, signPub, p, window) {
  const k16 = b64e(sha256(signPub).subarray(0, 16));
  const mac = hmac(tokenSecret, 'PA-CLI1\n' + b64e(account) + '\n' + k16 + '\n' + p + '\n' + window).subarray(0, 16);
  return { k16, code: b64e(cat(account, mac)) };
}

export function pushString(push) {
  if (push.type === 'fcm' || push.type === 'apns' || push.type === 'apns-sandbox') {
    return push.type + '\n' + push.token;
  }
  return push.type + '\n' + push.endpoint + '\n' + push.p256dh + '\n' + push.auth;
}

export const myPushSha256 = (push) => b64e(sha256(pushString(push)).subarray(0, 16));
