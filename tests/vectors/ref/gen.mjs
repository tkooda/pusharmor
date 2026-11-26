// Writes ../golden-v1.json deterministically. Run once; every change to the
// output is a reviewed change. Usage: node ref/gen.mjs [output-path]
import { writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { b64d, b64e, cat, hexe, sha256 } from './bytes.mjs';
import { isValidPriv, pubFromPriv, sign } from './p256.mjs';
import { checkInput, display, setupDefault, uniqueDefault } from './names.mjs';
import { accountId, cliCode, deviceId, emailHash, keyhash, mailboxKey, myPushSha256, normalizeEmail, oauthNonce, peerId } from './ids.mjs';
import {
  commitBody, commitHash, crockford20, fingerprintHash, keysBody, pairDecide, pairHint, pairKey,
  pairingId, pairTimeout, sealPair,
} from './pairing.mjs';
import { reqBytes } from './request.mjs';
import {
  BUCKETS, bodyFor, bucketFor, buildMessage, deflate, msgSignedBytes, nameSignedBytes, padBody,
  plaintextLenFor, sealNameEntry, wireChars,
} from './message.mjs';
import { sealWire } from './hpke.mjs';
import { windowAccept, replayOutcome } from './replay.mjs';
import { isPhone, parseReceivedUrl } from './detect.mjs';
import { RFC8291_EXAMPLE, RFC9180_SUITE } from './rfc-vectors.mjs';
import {
  BLOB_OVERHEAD, MAX_FILE, autoDownload, collisionName, downloadBytes, fileDeleteBytes, fileKey, filePostBytes, sanitizeName, sealBlob,
  ttlMinutes,
} from './file.mjs';

const label = (s) => sha256('PA-TEST1\n' + s);
const ikm = (s) => label('ikmE\n' + s);

function testScalar(name) {
  for (let i = 0; ; i++) {
    const sk = label('key\n' + name + '\n' + i);
    if (isValidPriv(sk)) return sk;
  }
}

// ---------------------------------------------------------------- fixtures
const ID_SECRET = label('ID_SECRET');
const EMAIL_A = 'alice@example.com';
const EMAIL_B = 'bob@example.org';
const ACCT_A = accountId(ID_SECRET, emailHash(EMAIL_A));
const ACCT_B = accountId(ID_SECRET, emailHash(EMAIL_B));

function makePeer(name, email, account, same = false) {
  const signPriv = testScalar(name + '\nsign');
  const encPriv = same ? signPriv : testScalar(name + '\nenc');
  const signPub = pubFromPriv(signPriv);
  const encPub = pubFromPriv(encPriv);
  const kh = keyhash(signPub, encPub);
  const id = peerId(ID_SECRET, account, kh);
  return { name, email, account, signPriv, encPriv, signPub, encPub, kh, id, idB64: b64e(id) };
}

const PEERS = {
  N: makePeer('N', EMAIL_A, ACCT_A),
  X: makePeer('X', EMAIL_A, ACCT_A),
  O: makePeer('O', EMAIL_A, ACCT_A),
  Z: makePeer('Z', EMAIL_B, ACCT_B),
  S: makePeer('S', EMAIL_A, ACCT_A, true),
};
const { N, X, O, Z, S } = PEERS;

const R_N = label('r_N');
const R_X = label('r_X');
const C_N = commitHash(N.signPub, N.encPub, R_N);
const PAIRING_ID = pairingId(R_N, R_X);
const PID_B64 = b64e(PAIRING_ID);
const OLD_PAIRING_ID = pairingId(label('old r_N'), label('old r_X'));

// ---------------------------------------------------------------- helpers
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
    return o;
  }
  return v;
}

export function stableJson(v) {
  const s = JSON.stringify(sortKeys(v), null, 2) + '\n';
  return s.replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

const hpkeInfo = (r) => ({
  ikmE: b64e(r.ikmE),
  skE: b64e(r.skE),
  enc: b64e(r.enc),
  shared_secret: b64e(r.shared_secret),
  key: b64e(r.key),
  base_nonce: b64e(r.base_nonce),
});

const pin = (p, pid = PAIRING_ID, ruling = 'approved') => ({
  id: p.idB64, sign_pub: b64e(p.signPub), enc_pub: b64e(p.encPub), pairing_id: b64e(pid), ruling,
});

function nameObj(owner, recipient, n, name, pid = PAIRING_ID, nText = String(n)) {
  const nameB64 = b64e(Buffer.from(name, 'latin1'));
  const signed = nameSignedBytes(owner.idB64, recipient.idB64, b64e(pid), nText, nameB64);
  return { nameB64, signed, s: b64e(sign(owner.signPriv, signed)) };
}

const nameJson = (no, nToken) => '{"name":"' + no.nameB64 + '","n":' + nToken + ',"s":"' + no.s + '"}';

// Builds an inner message with optional low-level overrides for must_fail.
function inner(label_, o) {
  const from = o.from ?? X;
  const to = o.to ?? N;
  const sealTo = o.sealTo ?? to;
  const aadId = o.aadId ?? to.idB64;
  const pid = o.pid ?? PAIRING_ID;
  const keys = o.keys === undefined ? null : o.keys;
  const deflated = o.deflated ?? deflate(o.json);
  let body = bodyFor(from.id, pid, keys, deflated);
  if (o.lenOverride !== undefined) body.writeUInt16BE(o.lenOverride, 30 + 8 + 1 + (keys ? 130 : 0));
  let padded = padBody(body);
  if (o.padByte !== undefined) padded[padded.length - 1] = o.padByte;
  const signedBytes = o.signedBytes ? o.signedBytes(padded, body) : msgSignedBytes(to.idB64, padded);
  let sig = sign((o.signer ?? from).signPriv, signedBytes);
  if (o.flipSig) sig = Buffer.from(sig.map((b, i) => (i === 40 ? b ^ 1 : b)));
  const plaintext = cat(sig, padded);
  const s = sealWire(sealTo.encPub, Buffer.from(o.info ?? 'PA-MSG1'), Buffer.from(aadId), plaintext, ikm(label_));
  let wire = s.wire;
  if (o.flipCt) wire = Buffer.from(wire.map((b, i) => (i === 100 ? b ^ 0x01 : b)));
  return { s, plaintext, padded, sig, signedBytes, deflated, message: b64e(wire) };
}

// ---------------------------------------------------------------- sections
function keysSection() {
  const peers = {};
  for (const p of Object.values(PEERS)) {
    peers[p.name] = {
      email: p.email,
      account: b64e(p.account),
      sign_priv: b64e(p.signPriv),
      sign_pub: b64e(p.signPub),
      enc_priv: b64e(p.encPriv),
      enc_pub: b64e(p.encPub),
      keyhash: b64e(p.kh),
      id: p.idB64,
    };
  }
  return {
    description:
      'Fixed test keys and ids. Private keys are raw 32-byte P-256 scalars, public keys 65-byte SEC1 points. ' +
      'id_secret is the test ID_SECRET. Assert byte for byte: sign_pub/enc_pub from the private scalars, ' +
      'account = HMAC-SHA256(id_secret, email_hash(email))[0..9], keyhash = sha256("PA-ID1\\n" || sign_pub || enc_pub)[0..12], ' +
      'id = account || keyhash || HMAC-SHA256(id_secret, account || keyhash)[0..9]. N, X, O share account A; Z is on account B; ' +
      'S has sign_pub equal to enc_pub (negative cases only). Other sections refer to these peers by name.',
    id_secret: b64e(ID_SECRET),
    peers,
  };
}

function emailSection() {
  const inputs = [
    'alice@example.com', ' A@B.Com ', 'a@b.com', '\tUser.Name+Tag@Example.ORG\r\n', 'INFO@B.COM',
    'BOB@Example.org', '\u00c9@b.com', 'a@b\u00fc.com', '\u0130nfo@b.com', '\u00a0a@b.com', 'a@b.com\u00a0',
  ];
  return {
    description:
      'Email normalization and email_hash (Worker). Trim ASCII whitespace (TAB LF VT FF CR SPACE) only, then any byte ' +
      'outside ASCII -> 400 "bad email" (normalized null; NBSP is not trimmed and so rejects), then ASCII lowercase A-Z -> a-z. ' +
      'email_hash = sha256("PA-ACCT1\\n" || normalized), account = HMAC-SHA256(keys.id_secret, email_hash)[0..9]. ' +
      'Assert normalized, email_hash and account byte for byte.',
    cases: inputs.map((input) => {
      const norm = normalizeEmail(input);
      if (norm === null) return { input, normalized: null, email_hash: null, account: null };
      const eh = emailHash(norm);
      return { input, normalized: norm, email_hash: b64e(eh), account: b64e(accountId(ID_SECRET, eh)) };
    }),
  };
}

function mailboxSection() {
  const inputs = [
    'A.B.C+Tag@Gmail.com', 'a.b+x+y@googlemail.com', 'abc@gmail.com', '+tag@gmail.com', '..@gmail.com',
    'A.B+tag@outlook.com', 'a.b+tag@hotmail.com', 'a.b+tag@live.com', 'a.b+tag@msn.com', 'a.b+tag@icloud.com',
    'a.b+tag@me.com', 'a.b+tag@mac.com', 'a.b+tag@fastmail.com', 'a.b+tag@proton.me', 'a.b+tag@protonmail.com',
    'a.b+tag@protonmail.ch', 'a.b+tag@pm.me', 'a.b+tag@example.com', 'a.b+tag@mail.gmail.com', 'a.b+tag@gmail.co',
  ];
  return {
    description:
      'Account identity (Worker and command line ban tool). mailbox = normalized address with, at gmail.com googlemail.com ' +
      'outlook.com hotmail.com live.com msn.com icloud.com me.com mac.com fastmail.com proton.me protonmail.com protonmail.ch ' +
      'pm.me only: the local part cut at its first "+" (when that is not the first char); at gmail.com and googlemail.com ' +
      'also every "." removed from the local part (kept when that leaves it empty) and the domain set to gmail.com. ' +
      'Other domains (subdomains included) are unchanged. email_hash = sha256("PA-ACCT1\\n" || mailbox), account = ' +
      'HMAC-SHA256(keys.id_secret, email_hash)[0..9]. Login codes still go to the normalized address. Assert normalized, ' +
      'mailbox, email_hash and account.',
    cases: inputs.map((input) => {
      const norm = normalizeEmail(input);
      const mb = mailboxKey(norm);
      const eh = emailHash(mb);
      return { input, normalized: norm, mailbox: mb, email_hash: b64e(eh), account: b64e(accountId(ID_SECRET, eh)) };
    }),
  };
}

function idOrderSection() {
  const acct = ACCT_A;
  const id = (head, fill = 0x11) => b64e(cat(acct, head, Buffer.alloc(30 - 9 - head.length, fill)));
  const raw = (bytes) => b64e(Buffer.from(bytes));
  const prefix29 = Buffer.alloc(29, 0xa5);
  const cases = [
    { name: 'first_byte_0x00_vs_0x80', a: raw([0x00, ...Array(29).fill(7)]), b: raw([0x80, ...Array(29).fill(7)]) },
    { name: 'first_byte_0x7f_vs_0x80', a: raw([0x7f, ...Array(29).fill(0)]), b: raw([0x80, ...Array(29).fill(0)]) },
    { name: 'first_byte_0xff_vs_0x01', a: raw([0xff, ...Array(29).fill(0)]), b: raw([0x01, ...Array(29).fill(0xff)]) },
    { name: 'shared_prefix_last_byte', a: b64e(cat(prefix29, [0x01])), b: b64e(cat(prefix29, [0xff])) },
    { name: 'shared_prefix_last_byte_high', a: b64e(cat(prefix29, [0x90])), b: b64e(cat(prefix29, [0x10])) },
    { name: 'same_account_keyhash_0x7f_vs_0x80', a: id([0x7f]), b: id([0x80]) },
    { name: 'same_account_keyhash_0xc0_vs_0x3f', a: id([0xc0]), b: id([0x3f]) },
    { name: 'test_peers_N_X', a: N.idB64, b: X.idB64 },
  ];
  return {
    description:
      'Lower id for the crossing tie-break: unsigned lexicographic compare of the decoded 30 raw id bytes, ' +
      'each byte 0..255. lower names the lower side ("a" or "b"). Every leg asserts every case.',
    cases: cases.map((c) => ({ ...c, lower: Buffer.compare(b64d(c.a), b64d(c.b)) < 0 ? 'a' : 'b' })),
  };
}

function deviceIdSection() {
  const id = (kh5) => cat(ACCT_A, kh5, Buffer.alloc(30 - 9 - 5, 0x11));
  const cases = [
    { name: 'peer_N', id: N.id },
    { name: 'peer_X', id: X.id },
    { name: 'peer_Z', id: Z.id },
    { name: 'keyhash_zero', id: id(Buffer.alloc(5, 0x00)) },
    { name: 'keyhash_multiple_of_1e9', id: id(Buffer.from([0xe8, 0xd4, 0xa5, 0x10, 0x00])) },
    { name: 'keyhash_max', id: id(Buffer.alloc(5, 0xff)) },
  ];
  return {
    description:
      'Device ID shown to users: raw id bytes 9..14 (the first 5 keyhash bytes) as a big-endian unsigned integer, ' +
      'mod 1000000000, zero-padded to 9 decimal digits, written "NNN-NNN-NNN". Never uses the account bytes 0..9. ' +
      'Assert device_id for each case.',
    cases: cases.map((c) => ({ name: c.name, id: b64e(c.id), device_id: deviceId(c.id) })),
  };
}

function clashCases() {
  const b32 = 'Abcdefghijklmnopqrstuvwxyz 12345';
  const h30 = 'Hello'.repeat(6);
  const to9 = [b32].concat([2, 3, 4, 5, 6, 7, 8, 9].map((n) => b32.slice(0, 28) + ' (' + n + ')'));
  return [
    { base: h30, taken: [] },
    { base: h30, taken: [h30] },
    { base: h30, taken: [h30, 'HelloHelloHelloHelloHelloHel (2)'] },
    { base: 'Pixel 8', taken: [] },
    { base: 'Pixel 8', taken: ['Tablet'] },
    { base: 'Pixel 8', taken: ['Pixel 8'] },
    { base: 'Pixel 8', taken: ['PIXEL 8', 'pixel 8 (2)'] },
    { base: 'Pixel 8', taken: ['Pixel 8', 'Pixel 8 (3)'] },
    { base: b32, taken: [b32] },
    { base: b32, taken: to9 },
    { base: 'a'.repeat(27) + ' ' + 'bcd', taken: ['a'.repeat(27) + ' ' + 'bcd'] },
    { base: 'a'.repeat(32), taken: ['a'.repeat(32), 'a'.repeat(28) + ' (2)'] },
  ];
}

function deviceNameSection() {
  const ex = (ch) => 'a' + ch + 'b';
  const cases = [
    'Phone', 'My Laptop', '  My   Laptop  ', 'a  b', ' -a', '- a', 'a' + ' '.repeat(40) + 'b', 'a'.repeat(31) + ' b', '   ', 'a', 'x', 'A-b-c', 'a-', ' ', ' a ', 'a?b', '?', 'it\'s', "Tom's phone", 'Caf\u00e9', '\u00e9',
    ex('`'), ex('\\'), ex('"'), ex('{'), ex('}'), ex('<'), ex('>'), ex('|'), ex('!'), ex('$'), ex(';'), 'a.b,c:d',
    '-', '-abc', '--a', '\u2018a\u2019', 'Tom\u2019s', 'Tom\u2018s', '\u201cq\u201d', 'a\u2013b\u2014c',
    '\ud83d\ude00', 'a\ud83d\ude00b', '\ud83d\udc68\u200d\ud83d\udc69', 'e\u0301', 'a\u0300\u0301',
    'a\tb', 'a\nb', 'a\rb', 'a\x00b', 'a\x1fb', 'a\x7fb', 'a\x80b', '\u00a0', 'a\u00a0b',
    'a'.repeat(31), 'a'.repeat(32), 'a'.repeat(33), '\u00e9'.repeat(32), '\u00e9'.repeat(33), '\ud83d\ude00'.repeat(32), '\ud83d\ude00'.repeat(33),
    '-' + 'a'.repeat(32), 'a'.repeat(31) + '\u2019', 'a'.repeat(31) + '\ud83d\ude00' + 'b',
  ];
  const defaults = cases.filter((s) => setupDefault(s) !== '');
  return {
    description:
      'Device name rule. Allowed: ASCII 32..126 except backtick, backslash, double quote, { } < > | ! $ ; ?; 1..32 characters; no ' +
      'leading "-"; no padding. All lengths and positions count Unicode code points (an astral character such as an emoji ' +
      'is one). "Space cleanup" means: trim leading and trailing spaces and collapse each run of spaces to one; only the ' +
      'ASCII space 0x20 is a space (tab, newline and U+00A0 are disallowed characters). Three legs, each over its own cases: ' +
      '(1) input_cases: for a typed name (setup and rename) apply space cleanup, then check: error must equal the error ' +
      '(null when accepted) and name must equal the name to save (null on error). Empty after cleanup is "Name too short"; ' +
      'more than 32 code points is "Name too long\\nUse 32 characters or fewer" (two lines; the input field stops typing at ' +
      '32); else any disallowed character (including every non-ASCII character and control character) or a leading "-" ' +
      'is "Invalid characters". ' +
      '(2) default_cases: setupDefault(input) must equal name: per code point U+2018 and U+2019 become "\'", every other ' +
      'disallowed character becomes "?"; then space cleanup; then a leading "-" becomes "?"; then keep at most the first ' +
      '32 code points and trim a trailing space left by the cut. A system name whose result is empty is not a case: each ' +
      'client then uses its own fallback name. ' +
      '(3) display_cases: display(input) must equal shown: per code point every disallowed character (curly apostrophes ' +
      'too) becomes "?"; then space cleanup; then a leading "-" becomes "?"; an empty result is shown as "?". No ' +
      'truncation and no padding. ' +
      '(4) clash_cases: uniqueDefault(base, taken) must equal name. base is a setup default; taken lists the other ' +
      'devices\' names. If base equals no taken name ignoring ASCII case, name is base. Else N is the smallest number >= 2 ' +
      'whose result equals no taken name ignoring ASCII case; suffix is " (N)"; name is base cut to 32 minus the suffix ' +
      'length code points, trailing spaces trimmed, then the suffix.',
    clash_cases: clashCases().map((c) => ({ base: c.base, name: uniqueDefault(c.base, c.taken), taken: c.taken })),
    default_cases: defaults.map((s) => ({ input: s, name: setupDefault(s) })),
    display_cases: cases.concat(['']).map((s) => ({ input: s, shown: display(s) })),
    input_cases: cases.concat(['']).map((s) => ({ input: s, ...checkInput(s) })),
  };
}

function nonceSection() {
  return {
    description:
      'OAuth nonce: k = b64url(sha256(sign_pub)), nonce = b64url(sha256("PA-NONCE1\\n" + purpose + "\\n" + k)) ' +
      '(k as its b64url string). Assert k and nonce.',
    cases: ['register', 'login', 'delete-account'].map((purpose) => ({
      purpose, sign_pub: b64e(N.signPub), ...oauthNonce(purpose, N.signPub),
    })),
  };
}

function cliCodeSection() {
  const tokenSecret = label('TOKEN_SECRET');
  const cases = [['register', 'r', 2969856], ['login', 'l', 2969857]].map(([purpose, p, window]) => {
    const r = cliCode(tokenSecret, N.account, N.signPub, p, window);
    return { purpose, p, window, sign_pub: b64e(N.signPub), account: b64e(N.account), k16: r.k16, link: 'https://pusharmor.com/auth/cli#' + p + r.k16, code: r.code };
  });
  return {
    description:
      'Command line login code. k16 = b64url(sha256(sign_pub)[0..16]) (22 chars); link = "https://pusharmor.com/auth/cli#" + p + k16 ' +
      '(p = r register, l login, d delete-account); code = b64url(account (9 bytes) || HMAC-SHA256(token_secret, "PA-CLI1\\n" + ' +
      'b64url(account) + "\\n" + k16 + "\\n" + p + "\\n" + window)[0..16]) (34 chars), window = floor(unix s / 600) in decimal. ' +
      'token_secret is a test PA_TOKEN_SECRET. Assert k16, link and code (the Worker and the command line client).',
    token_secret: b64e(tokenSecret),
    cases,
  };
}

function pushSection() {
  const p256dh = b64e(X.encPub);
  const auth = b64e(label('auth').subarray(0, 16));
  const pushes = [
    { type: 'fcm', token: 'fGx3-test-token:APA91bHtest_token_value' },
    { type: 'apns', token: '5f0c3e1a9b8d7c6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e' },
    { type: 'apns-sandbox', token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
    { type: 'webpush', endpoint: 'https://fcm.googleapis.com/fcm/send/abc123:XYZ', p256dh, auth },
    { type: 'webpush', endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABtest', p256dh, auth },
    { type: 'unifiedpush', endpoint: 'https://ntfy.example.net/upAbC123?up=1', p256dh, auth },
  ];
  return {
    description:
      'my_push_sha256 = b64url(first 16 bytes of sha256(UTF-8 of: fcm, apns, apns-sandbox: type + "\\n" + token; ' +
      'webpush, unifiedpush: type + "\\n" + endpoint + "\\n" + p256dh + "\\n" + auth)). Field strings are used as given. ' +
      'Assert my_push_sha256.',
    cases: pushes.map((push) => ({ push, my_push_sha256: myPushSha256(push) })),
  };
}

function pairingSection() {
  const fph = fingerprintHash(N.signPub, N.encPub, X.signPub, X.encPub, R_N, R_X);
  const commit = sealPair('commit', N.id, commitBody(C_N), X.idB64, X.encPub, ikm('pair commit'));
  const reply = sealPair('reply', X.id, keysBody(X.signPub, X.encPub, R_X), N.idB64, N.encPub, ikm('pair reply'));
  const open = sealPair('open', N.id, keysBody(N.signPub, N.encPub, R_N), X.idB64, X.encPub, ikm('pair open'));
  const pm = (kind, from, to, r) => ({
    kind, from: from.name, to: to.name, plaintext: b64e(r.plaintext), hpke: hpkeInfo(r), message: r.message,
  });
  const symbols = [];
  for (let i = 0; i < 8; i++) {
    const v = ((4 * i) << 15) | ((4 * i + 1) << 10) | ((4 * i + 2) << 5) | (4 * i + 3);
    const h = cat([v >> 12, (v >> 4) & 0xff, ((v & 0x0f) << 4) | 0x0a], label('fp ' + i).subarray(0, 29));
    symbols.push({ hash: b64e(h), fingerprint: crockford20(h) });
  }
  return {
    description:
      'One pairing of N (new peer) with X (existing peer). c_N = sha256("PA-SAS1C\\n" || sign_pub_N || enc_pub_N || r_N); ' +
      'fingerprint_hash = sha256("PA-SAS1\\n" || sign_pub_N || enc_pub_N || sign_pub_X || enc_pub_X || r_N || r_X); ' +
      'fingerprint = first 20 bits MSB first as 4 Crockford chars of "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; ' +
      'pairing_id = sha256("PA-PAIRID1\\n" || r_N || r_X)[0..8] (11-char b64url); ' +
      'pk = b64url(sha256("PA-PAIRKEY1\\n" || N id || X id)[0..16]) over the raw 30-byte ids, N first. ' +
      'pair_messages: plaintext = kind(1: commit, 2: reply, 3: open) || from id(30) || body(162), 193 bytes; ' +
      'HPKE info "PA-PAIR1", aad = recipient 40-char id; message = b64url(enc || ct), 366 chars. ' +
      'Assert c_N, fingerprint_hash, fingerprint, pairing_id, pk byte for byte; open each message with the recipient enc_priv ' +
      'and compare the plaintext; for the open, check sha256("PA-SAS1C\\n" || keys || r_N) equals c_N. ' +
      'fingerprint_cases check the 20-bit Crockford mapping (every symbol once). The hpke block (DeriveKeyPair(ikmE) ' +
      'ephemeral) is optional to assert.',
    N: 'N',
    X: 'X',
    r_N: b64e(R_N),
    r_X: b64e(R_X),
    c_N: b64e(C_N),
    fingerprint_hash: b64e(fph),
    fingerprint: crockford20(fph),
    pairing_id: PID_B64,
    pk: pairKey(N.id, X.id),
    pair_messages: [pm('commit', N, X, commit), pm('reply', X, N, reply), pm('open', N, X, open)],
    fingerprint_cases: symbols,
  };
}

function pairDecideSection() {
  const now = 1761300000;
  const capFull = Array.from({ length: 10 }, (_, i) => now - 3600 * (i + 1));
  const lo = b64e(cat(ACCT_A, [0x7f], Buffer.alloc(20, 0x22)));
  const hi = b64e(cat(ACCT_A, [0x80], Buffer.alloc(20, 0x22)));
  const otherC = b64e(label('other c_N'));
  const base = {
    own_id: X.idB64, from_id: N.idB64, commit_c_N: b64e(C_N), entry: null, pinned: false, approved: false,
    approve_verified: false, approves_me: null, get_after_verify: false, listed: 'yes', open_entries: 0, cap: [], now,
  };
  const xe = (state, authorized, c = b64e(C_N)) => ({ role: 'X', state, c_N: c, reply_authorized: authorized });
  const ne = (state) => ({ role: 'N', state });
  const cases = [
    ['e_new_entry_reply', {}],
    ['e_cap_10th_automatic_reply', { cap: capFull.slice(0, 9) }],
    ['e_cap_11th_prompted', { cap: capFull }],
    ['e_cap_rollover_exactly_24h', { cap: [...capFull.slice(0, 9), now - 86400] }],
    ['e_cap_not_rolled_over_24h_minus_1s', { cap: [...capFull.slice(0, 9), now - 86399] }],
    ['e_24th_open_entry_ok', { open_entries: 23 }],
    ['e_25th_open_entry_dropped', { open_entries: 24 }],
    ['e_not_listed_after_fetch_dropped', { listed: 'no' }],
    ['e_listed_after_one_fetch', { listed: 'after_fetch' }],
    ['e_after_cancel_pairing_fresh_entry', { approves_me: true }],
    ['a_duplicate_authorized_reply_resent', { entry: xe('replied', true), cap: capFull, open_entries: 1 }],
    ['a_duplicate_on_cap_prompted_sends_nothing', { entry: xe('prompted', false), cap: capFull, open_entries: 1 }],
    ['a_duplicate_failed_authorized_send_resent', { entry: xe('prompted', true), open_entries: 1 }],
    ['a_duplicate_in_shown', { entry: xe('shown', true), pinned: true, open_entries: 1 }],
    ['a_duplicate_in_shown_waiting', { entry: xe('shown', true), pinned: true, approved: true, open_entries: 1 }],
    ['b_different_c_N_replied_aborts', { entry: xe('replied', true, otherC), open_entries: 1 }],
    ['b_different_c_N_prompted_aborts', { entry: xe('prompted', false, otherC), open_entries: 1 }],
    ['b_different_c_N_shown_before_approve_aborts', { entry: xe('shown', true, otherC), pinned: true, open_entries: 1 }],
    ['b_not_after_approve_half_state', { entry: xe('shown', true, otherC), pinned: true, approved: true, open_entries: 1 }],
    ['c_crossing_own_id_lower_stays_N', { own_id: lo, from_id: hi, entry: ne('committed'), open_entries: 1 }],
    ['c_crossing_own_id_higher_goes_on_as_X', { own_id: hi, from_id: lo, entry: ne('committed'), cap: capFull, open_entries: 1 }],
    ['c_own_N_entry_shown_waiting_half_state', { entry: ne('shown'), pinned: true, approved: true, open_entries: 1 }],
    ['c_own_N_entry_shown_unapproved_drop', { entry: ne('shown'), pinned: true, open_entries: 1 }],
    ['d_pinned_half_state_get_after_verify', { pinned: true, approved: true, approve_verified: true, approves_me: false, get_after_verify: true }],
    ['d_pinned_older_get_stays_paired', { pinned: true, approved: true, approve_verified: true, approves_me: false }],
    ['d_pinned_approves_me_true', { pinned: true, approved: true, approve_verified: true, approves_me: true, get_after_verify: true }],
    ['d_pinned_no_get_since_verify', { pinned: true, approved: true, approve_verified: true }],
    ['d_pinned_not_approved_not_counted', { pinned: true, cap: capFull.slice(0, 5) }],
    ['e_cap_future_stamps_not_counted', { cap: Array.from({ length: 10 }, () => now + 365 * 86400) }],
  ];
  return {
    description:
      'PURE pairing decision on X for a commit push (Pairing flow step 3, rules a-e, first match wins). ' +
      'Input fields: own_id, from_id; commit_c_N; entry (null or the open entry for from_id: role N|X, state ' +
      'N: committed|shown, X: replied|prompted|shown, c_N and reply_authorized for X role); pinned; approved (implies pinned); ' +
      'approve_verified (from_id\'s approve verified here); approves_me (last GET /peers, null if none) and get_after_verify ' +
      '(that GET was fetched after the approve verified); listed (yes | after_fetch | no: in the last GET /peers, after one ' +
      'fetch, still absent); open_entries (all roles); cap (unix s of counted automatic replies); now (unix s). ' +
      'Output: action reply|notice|abort|prompt|drop; notice commit ("A new peer wants to pair. Open PushArmor.") | ' +
      'half_state ("$X wants to pair again. Tap Cancel pairing request on its row, then pair.", tag pk) | crossing ("Pairing with ' +
      '$X in progress. Open PushArmor.", platforms that notify every push only) | could_not_read (generic, platforms that ' +
      'notify every push only) | represent (re-present the current notice, same tag/id); entry created_replied | ' +
      'created_prompted | n_wiped_x_replied | aborted | unchanged | none; cap_counted (the reply counts in the cap). ' +
      'A cap timestamp t counts while 0 <= now - t < 86400 (a future t does not count and is not kept). Lower id = unsigned byte compare (see id_order). ' +
      'Every leg (android, ios, webext) asserts all four output fields.',
    cases: cases.map(([name, over]) => {
      const input = { ...base, ...over };
      return { name, input, output: pairDecide(input) };
    }),
  };
}

function pairTimeoutSection() {
  const inputs = [
    ['approve_verified_keeps_pin', { approve_verified: true, approved: true, resend: null }],
    ['not_approved_drops_pin', { approve_verified: false, approved: false, resend: null }],
    ['waiting_runs_resend_first', { approve_verified: false, approved: true, resend: null }],
    ['waiting_resend_offline', { approve_verified: false, approved: true, resend: 'offline' }],
    ['waiting_resend_logged_out', { approve_verified: false, approved: true, resend: 'logged out' }],
    ['waiting_resend_429', { approve_verified: false, approved: true, resend: '429' }],
    ['waiting_resend_5xx', { approve_verified: false, approved: true, resend: '5xx' }],
    ['waiting_resend_200_verified_c_completes', { approve_verified: false, approved: true, resend: '200_c_verified' }],
    ['waiting_resend_200_other_drops_pin', { approve_verified: false, approved: true, resend: '200_other' }],
  ];
  return {
    description:
      'Pairing timeout at 14 days (Pairing flow step 8). input: approve_verified (the other side\'s approve verified), ' +
      'approved (this device approved; with approve_verified false the row is "Waiting for $X"), resend (result of the ' +
      're-send of POST /v1/approve/$X: null not run yet | offline | logged out | 429 | 5xx | 200_c_verified | 200_other). ' +
      'output: keep_pin | drop_pin (drop r, c_N and the pin, show "Pairing timed out. Tap Pair to start again.", then ' +
      'the allow reconcile) | resend (run the re-send first) | keep_waiting (row stays Waiting with Cancel pairing request; ' +
      'retry at next app open, Refresh or login) | complete (the verified c completes the pairing).',
    cases: inputs.map(([name, input]) => ({ name, input, output: pairTimeout(input) })),
  };
}

function pairHintSection() {
  const d = 86400;
  const inputs = [
    ['approves_me_true_day_1', { approves_me: true, committed_s: d }],
    ['approves_me_true_day_5', { approves_me: true, committed_s: 5 * d }],
    ['approves_me_false_day_2', { approves_me: false, committed_s: 2 * d }],
    ['approves_me_false_3_days', { approves_me: false, committed_s: 3 * d }],
    ['no_get_day_4', { approves_me: null, committed_s: 4 * d }],
  ];
  return {
    description:
      'N-side hint on a row in state committed (Pairing flow step 8). input: approves_me of X in the last GET /peers ' +
      '(null if none), committed_s (seconds in state committed). output: still_holds ("$X still holds an earlier pairing. ' +
      'On $X, tap Cancel pairing request, then tap Send again.") | no_reply_yet ("No reply yet. Open PushArmor on $X, or tap Send ' +
      'again.", from 3 days) | null.',
    cases: inputs.map(([name, input]) => ({ name, input, output: pairHint(input) })),
  };
}

const T0 = '1761300000123';
function reqCase(name, signer, method, path, paTime, bodyText) {
  const body = Buffer.from(bodyText, 'utf8');
  const signed = reqBytes(method, path, paTime, body);
  return {
    name, signer: signer.name, sign_pub: b64e(signer.signPub), method, path, pa_time: paTime,
    body: b64e(body), body_text: bodyText, signed_bytes: b64e(signed), sig: b64e(sign(signer.signPriv, signed)),
  };
}

function requestSection() {
  return {
    description:
      'PA-Sig: ECDSA P-256 SHA-256 raw r||s over "PA-REQ1\\n" + METHOD + "\\n" + path + "\\n" + PA-Time + "\\n" + raw body ' +
      'bytes; path includes /v1, no query string; empty body = zero bytes; PA-Time 13 decimal digits. Assert signed_bytes ' +
      'byte for byte from the fields, and that sig verifies with sign_pub (ECDSA is randomized: verify only).',
    cases: [
      reqCase('get_peers_empty_body', X, 'GET', '/v1/peers', T0, ''),
      reqCase('post_send', X, 'POST', '/v1/send', T0, '{"v":1,"m":{"' + N.idB64 + '":"AAAA"}}'),
      reqCase('post_peers_new_key', N, 'POST', '/v1/peers', '1761300000999', '{"ticket":"t","sign_pub":"' + b64e(N.signPub) + '"}'),
      reqCase('patch_utf8_body', X, 'PATCH', '/v1/peers/' + X.idB64, T0, '{"push":{"type":"fcm","token":"\u00e9\u20ac"}}'),
      reqCase('delete_peer', X, 'DELETE', '/v1/peers/' + O.idB64, T0, '{"m":{}}'),
    ],
  };
}

function nameSection() {
  const cases = [
    ['X_for_N', X, N, 4, 'Pixel 8'],
    ['N_for_X', N, X, 1, 'Chrome laptop'],
    ['X_for_N_max_len', X, N, 9007199254740991, '~'.repeat(32)],
  ].map(([name, owner, rec, n, nm]) => {
    const no = nameObj(owner, rec, n, nm);
    const json = nameJson(no, String(n));
    const sealed = sealNameEntry(rec.idB64, rec.encPub, json, ikm('name ' + name));
    return {
      name, owner: owner.name, recipient: rec.name, pairing_id: PID_B64, n, name_text: nm, name_b64: no.nameB64,
      signed_string: no.signed.toString('latin1'), s: no.s, entry_json: json, hpke: hpkeInfo(sealed), ciphertext: sealed.ciphertext,
    };
  });
  return {
    description:
      'Name entries. s = owner signature over "PA-NAME1\\n" + owner id + "\\n" + recipient id + "\\n" + pairing id (11 chars) ' +
      '+ "\\n" + n + "\\n" + name (the b64url string). ciphertext = b64url(enc || ct), HPKE to the recipient enc_pub, info ' +
      '"PA-NAME1", aad = recipient 40-char id, at most 1024 chars. Assert signed_string from the fields; open ciphertext ' +
      'with the recipient enc_priv and compare entry_json; verify s with the owner sign_pub; name 1..32 printable ASCII, no double quote.',
    cases,
  };
}

function mustDecodeSection() {
  const url = 'https://example.com/a';
  const xKeys = { signPub: X.signPub, encPub: X.encPub };
  const unruled = pin(X, PAIRING_ID, 'unruled');
  const withExtra = (no, extra) => nameJson(no, 4).replace(/}$/, ',' + extra + '}');
  const msgs = [
    ['url_plus_unknown_key', '{"n":1,"url":"' + url + '","x":1}', null, 'url', 1, url],
    ['text_plus_unknown_key', '{"n":2,"text":"hi","x":"y"}', null, 'text', 2, 'hi'],
    ['unknown_key_before_type', '{"x":[1,2],"n":3,"tel":"+1 555-123-4567"}', null, 'tel', 3, '+1 555-123-4567'],
    ['url_and_text_is_url', '{"n":4,"text":"a","url":"' + url + '"}', null, 'url', 4, url],
    ['text_and_tel_is_text', '{"n":5,"tel":"+1 555-123-4567","text":"a"}', null, 'text', 5, 'a'],
    ['logout_plus_unknown_key', '{"n":6,"logout":1,"x":1}', null, 'logout', 6, 1],
  ].map(([name, json, keys, type, n, value]) => ({
    name, ...msgCase(name, inner('md ' + name, { json, keys }), { json, full: true }),
    expect: { outcome: 'accept', type, n, value },
  }));
  const no = nameObj(X, N, 4, 'Pixel 8');
  const apprJson = '{"n":4,"approve":' + withExtra(no, '"x":1') + ',"y":2}';
  msgs.push({
    name: 'approve_name_entry_unknown_key',
    ...msgCase('approve_name_entry_unknown_key', inner('md approve', { json: apprJson, keys: xKeys }), { json: apprJson, full: true, pin: unruled }),
    expect: { outcome: 'accept', type: 'approve', n: 4, value: { name: 'Pixel 8', n: 4 } },
  });
  const entryJson = withExtra(nameObj(X, N, 4, 'Pixel 8'), '"x":{"y":1}');
  const sealed = sealNameEntry(N.idB64, N.encPub, entryJson, ikm('md name entry'));
  const names = [{
    name: 'name_entry_unknown_key', owner: 'X', receiver: 'N', pin: pin(X), entry_json: entryJson, ciphertext: sealed.ciphertext,
    expect: { ok: true, name: 'Pixel 8', n: 4 },
  }];
  return {
    description:
      'Lenient receivers: inputs every client must DECODE. Inner message: unknown keys are ignored; the type is ' +
      'the first known type key in the fixed order url, text, tel, approve, deny, remove, rename, delete, logout, login ' +
      '(so url + text is a url). Duplicate keys and the "n" rules still reject (see must_fail). Name entry (and the ' +
      'name object inside approve / rename): unknown extra keys are ignored; name, n and s are still required. ' +
      'messages: run the receive pipeline as in messages (pin default approved) and compare expect. name_entries: ' +
      'open as in name_entries with pin and compare expect.',
    messages: msgs,
    name_entries: names,
  };
}

const MSG_N = { url: 1, text: 2, tel: 3, approve: 4, deny: 5, remove: 6, rename: 7, delete: 8, logout: 9, login: 10 };

function typeJson(type, n) {
  switch (type) {
    case 'url': return '{"n":' + n + ',"url":"https://example.com/a"}';
    case 'text': return '{"n":' + n + ',"text":"Hello from PushArmor \\u00e9"}';
    case 'tel': return '{"n":' + n + ',"tel":"+1 555-123-4567"}';
    case 'approve': return '{"n":' + n + ',"approve":' + nameJson(nameObj(X, N, n, 'Pixel 8'), n) + '}';
    case 'rename': return '{"n":' + n + ',"rename":' + nameJson(nameObj(X, N, n, 'Work phone'), n) + '}';
    case 'remove': return '{"n":' + n + ',"remove":"' + O.idB64 + '"}';
    default: return '{"n":' + n + ',"' + type + '":1}';
  }
}

const expectValue = {
  url: 'https://example.com/a', text: 'Hello from PushArmor \u00e9', tel: '+1 555-123-4567',
  approve: { name: 'Pixel 8', n: 4 }, rename: { name: 'Work phone', n: 7 }, remove: O.idB64,
  deny: 1, delete: 1, logout: 1, login: 1,
};

function msgCase(name, r, extra) {
  return {
    name,
    from: (extra.from ?? X).name,
    receiver: (extra.to ?? N).name,
    pin: extra.pin === undefined ? pin(extra.from ?? X) : extra.pin,
    window: extra.window ?? { h: 0, seen: [] },
    history: extra.history ?? [],
    message: r.message,
    ...(extra.full ? {
      json: extra.json,
      deflated: b64e(r.deflated),
      plaintext: b64e(r.plaintext),
      signed_bytes: b64e(r.signedBytes),
      sig: b64e(r.sig),
      hpke: hpkeInfo(r.s),
    } : {}),
  };
}

function messagesSection() {
  const cases = Object.keys(MSG_N).map((type) => {
    const json = typeJson(type, MSG_N[type]);
    const keys = type === 'approve' ? { signPub: X.signPub, encPub: X.encPub } : null;
    const r = inner('msg ' + type, { json, keys });
    const p = type === 'approve' ? pin(X, PAIRING_ID, 'unruled') : pin(X);
    return {
      type, ...msgCase(type, r, { json, full: true, pin: p }),
      expect: { outcome: 'accept', type, n: MSG_N[type], value: expectValue[type] },
      wire_chars: r.message.length,
    };
  });
  return {
    description:
      'One full inner message per type, X -> N. JSON {"n": counter, type: value} -> deflate-raw (any valid stream is ' +
      'fine for senders; receivers inflate the given bytes) -> body = from id(30) || pairing id(8) || keys flag(1; 1 on ' +
      'approve, 0 on every other type) [|| sign_pub || enc_pub, approve only] || u16 BE deflated length || deflated -> zero pad so the wire length is the ' +
      'next of 512/1024/2048/3800 chars -> sig = ECDSA over "PA-MSG1\\n" + recipient 40-char id + "\\n" + padded body ' +
      '(signed_bytes) -> plaintext = sig || padded body -> HPKE (info "PA-MSG1", aad = recipient id) -> message = ' +
      'b64url(enc || ct). Receiver state: pin (the pinned keys, pairing id and ruling approved | unruled | denied of the ' +
      'sender), window (h and the seen n values), history (n values with a History row). Assert: open message with the ' +
      'receiver enc_priv and compare plaintext; verify sig before inflate; inflate deflated and compare json; run the ' +
      'full receive pipeline and compare expect (outcome, type, n, value; approve/rename value = verified name and n; the name entry n must equal the message n; the name entry is checked before the replay window).',
    cases,
  };
}

function prng(seedLabel, len) {
  const out = [];
  for (let i = 0; out.length < len; i++) {
    for (const b of sha256(seedLabel + '\n' + i)) if (out.length < len && b >= 0x41 && b <= 0x7a && b !== 0x5c) out.push(b);
  }
  return Buffer.from(out).toString('latin1');
}

function paddedSection() {
  const sizes = { 512: 2, 1024: 300, 2048: 900, 3800: 2048 };
  const cases = BUCKETS.map((b) => {
    const text = b === 512 ? 'hi' : prng('pad ' + b, sizes[b]);
    const json = '{"n":' + (20 + BUCKETS.indexOf(b)) + ',"text":"' + text + '"}';
    const r = inner('padded ' + b, { json });
    if (r.message.length !== b) throw new Error('padded case missed bucket ' + b);
    return {
      bucket: b, ...msgCase('bucket_' + b, r, { json, full: true }),
      expect: { outcome: 'accept', type: 'text', n: 20 + BUCKETS.indexOf(b), value: text },
      unpadded_body_len: bodyFor(X.id, PAIRING_ID, null, r.deflated).length,
    };
  });
  return {
    description:
      'One text message per padding bucket (512, 1024, 2048, 3800 wire chars), X -> N; the 3800 case carries 2048 bytes ' +
      'of content (the max-size padded message). Same format and assertions as messages; also assert message length == bucket.',
    cases,
  };
}

function paddingSection() {
  const lens = [105, 303, 304, 687, 688, 1455, 1456, 2769, 2770];
  return {
    description:
      'Padding math. plaintext_len = HPKE plaintext length before padding (sig 64 + body). unpadded_chars = ' +
      'ceil((plaintext_len + 81) * 4 / 3) (enc 65 + tag 16, b64url without "="). bucket = smallest of 512/1024/2048/3800 ' +
      '>= unpadded_chars, null = sender refuses (> 3800). padded_plaintext_len = bucket * 3 / 4 - 81.',
    cases: lens.map((l) => {
      const chars = wireChars(l + 81);
      const b = bucketFor(chars);
      return { plaintext_len: l, unpadded_chars: chars, bucket: b, padded_plaintext_len: b === null ? null : plaintextLenFor(b) };
    }),
  };
}

function contentCapSection() {
  const cut = (s) => {
    const b = Buffer.from(s, 'utf8');
    if (b.length <= 2048) return s;
    let end = 2048;
    while ((b[end] & 0xc0) === 0x80) end--;
    return b.subarray(0, end).toString('utf8');
  };
  const inputs = [
    'a'.repeat(2048), 'a'.repeat(2049), '\u00e9'.repeat(1024), '\u00e9'.repeat(1024) + 'a',
    '\u20ac'.repeat(682), 'a' + '\u20ac'.repeat(700), '\ud83d\ude00'.repeat(512), '\ud83d\ude00'.repeat(513),
  ];
  return {
    description:
      'Size cap: 2048 UTF-8 bytes of the raw url / text / tel string. ok = utf8_bytes <= 2048. truncated = the "send ' +
      'the first 2048 bytes" text cut on a UTF-8 code point boundary (equal to input when ok).',
    cases: inputs.map((input) => {
      const n = Buffer.byteLength(input, 'utf8');
      return { input, utf8_bytes: n, ok: n <= 2048, truncated: cut(input) };
    }),
  };
}

function inflateSection() {
  const json = Buffer.from('{"n":42,"url":"https://example.com/a"}');
  const l9 = deflateRawSync(json, { level: 9 });
  const cases = [
    ['level_9', l9, json],
    ['stored_block', deflateRawSync(json, { level: 0 }), json],
    ['level_1', deflateRawSync(json, { level: 1 }), json],
    ['exactly_16384_bytes', deflateRawSync(Buffer.alloc(16384, 0x61), { level: 9 }), Buffer.alloc(16384, 0x61)],
    ['over_cap_16385_bytes', deflateRawSync(Buffer.alloc(16385, 0x61), { level: 9 }), null],
    ['truncated_stream', l9.subarray(0, l9.length - 3), null],
  ];
  return {
    description:
      'deflate-raw (RFC 1951) inflate of the given bytes with a 16384-byte output cap. ok false = reject (over cap or ' +
      'invalid/truncated stream). Assert ok, inflated_len and inflated_sha256 (b64url); inflated is given when <= 256 bytes.',
    cases: cases.map(([name, d, out]) => ({
      name, deflated: b64e(d), ok: out !== null,
      inflated_len: out ? out.length : null,
      inflated_sha256: out ? b64e(sha256(out)) : null,
      inflated: out && out.length <= 256 ? b64e(out) : null,
    })),
  };
}

function replaySection() {
  const cases = [
    ['first_message', { h: 0, seen: [] }, 1, 'url', false],
    ['out_of_order_within_window', { h: 10, seen: [10] }, 8, 'text', false],
    ['repeat_url_no_history_invalid', { h: 5, seen: [5, 4, 3, 2, 1] }, 5, 'url', false],
    ['repeat_text_with_history_represent', { h: 5, seen: [5, 4, 3, 2, 1] }, 3, 'text', true],
    ['repeat_control_type_noop', { h: 5, seen: [5, 4, 3, 2, 1] }, 4, 'approve', false],
    ['repeat_logout_noop', { h: 5, seen: [5, 4] }, 4, 'logout', false],
    ['n_equals_h_minus_100_invalid', { h: 150, seen: [150] }, 50, 'url', false],
    ['n_equals_h_minus_100_with_history_invalid', { h: 150, seen: [150] }, 50, 'text', true],
    ['n_equals_h_minus_99_accept', { h: 150, seen: [150] }, 51, 'url', false],
    ['shift_by_one_drops_bit_99', { h: 150, seen: [150, 51] }, 151, 'url', false],
    ['jump_over_100_clears', { h: 10, seen: [10, 8] }, 200, 'tel', false],
    ['small_shift_keeps_bits', { h: 10, seen: [10, 9] }, 12, 'text', false],
  ];
  return {
    description:
      'Replay window per sender: h = highest accepted n, seen = the n values whose bit is set (bit k = n = h - k, ' +
      'k 0..99), listed high to low. Accept iff n > h - 100 and n not seen; on accept with n > h shift (h = n, drop bits ' +
      'past 99), else set the bit. A rejected n: n <= h - 100 -> invalid; seen n of a control type (approve rename ' +
      'remove delete logout login deny) -> noop; seen n of url/text/tel with a History row -> represent; else invalid. ' +
      'Assert outcome and state_after (equal to state when not accepted).',
    cases: cases.map(([name, state, n, type, historyRow]) => {
      const outcome = replayOutcome(state, n, type, historyRow);
      return { name, state, n, type, history_row: historyRow, outcome, state_after: outcome === 'accept' ? windowAccept(state, n) : state };
    }),
  };
}

function urlSection() {
  const inputs = [
    'https://example.com/a', 'http://example.com/', 'HTTPS://Example.COM/Path?q=1#f', 'https://user:pw@example.com/',
    'https://user@example.com/', 'ftp://example.com/', 'javascript:alert(1)', 'data:text/html,x', 'example.com',
    'https://', 'https://10.0.0.1/', 'https://[::1]/', 'https://example.com:8443/', 'https://intranet/',
    'https://foo.localhost/', 'https://localhost./', 'https://x.local./', 'https://Example.COM./',
    'https://\u0430pple.com/', 'https://sub.example.co.uk/x',
    // space, controls and the path, query and fragment encode sets
    'http://a.com/x y', 'http://a.com/x y?q a#f g', ' https://a.com/', 'https://a.com/ ', 'https://a.com/x\ty',
    'https://a b.com/', 'https://a.com/a|b', 'https://a.com/{}^`', "https://a.com/?q='`{}", "https://a.com/#`{}' x",
    'https://A.com/\u00e9', 'https://a.com/%zz', 'https://a.com/a/../b/./c', 'https://a.com/%2e/b/%2E%2e/c',
    'https://a.com/a/..', 'https://a.com/a\\b?c\\d', 'https://a.com\\b', 'https://a.com?x#y', 'HTTP://A.COM',
    // trailing punctuation stays part of the URL
    'https://example.com/a.', 'https://example.com/a)', 'https://example.com/a,', 'https://example.com).',
    // ASCII hosts
    'http://my_host.com/', 'https://a..com/', 'https://./', 'https://ex%61mple.com/', 'https://@a.com/',
    // IPv6 literals: parse, then print in the URL standard form
    'https://[1::2::3]/', 'https://[0:0:0:0:0:0:0:1]/', 'https://[0:0::1]/x', 'https://[1]/', 'https://[:::]/',
    'https://[::ffff:1.2.3.4]/', 'https://[2001:DB8::A]/', 'https://[1:0:0:2:0:0:3:4]/', 'https://[1:2:3:0:5:6:7:8]/',
    'https://0x7f.1/', 'https://1.2.3/', 'https://1.2.3.4./', 'https://example.123/', 'https://09.a/',
    'https:/a.com/', 'https:a.com', 'https:///a.com/',
    // ports
    'https://a.com:/', 'https://a.com:000443/', 'https://a.com:080/', 'https://a.com:65536/',
    // IDN hosts: per code point lowercase, then punycode per label (no other UTS 46 mapping or check)
    'https://stra\u00dfe.de/', 'https://caf\u00e9.com/', 'https://B\u00fccher.de/', 'https://\u4f8b\u3048.jp/',
    'https://\ud55c\uad6d.kr/', 'https://\u03b1\u03b2.gr/', 'https://\u0410pple.com/', 'https://\uff41.com/',
    'https://a\u200db.com/', 'https://a\u200cb.com/', 'https://a\u00adb.com/', 'https://a\u3002com/',
    'https://\u05d0\u05d1.com/', 'https://cafe\u0301.com/', 'https://\ud83d\ude00.com/',
    // Hebrew, Arabic, emoji, uppercase non-ASCII
    'https://\u05e9\u05dc\u05d5\u05dd.co.il/', 'https://\u0645\u062b\u0627\u0644.\u0625\u062e\u062a\u0628\u0627\u0631/',
    'https://\u0627\u0644\u0639\u0631\u0628\u064a\u0629.com/x', 'https://i\u2764.ws/', 'https://\ud83d\udc4d\ud83c\udffd.com/',
    'https://\u0391\u0392\u0393.gr/', 'https://M\u00dcNCHEN.de/', 'https://\u041f\u0420\u0418\u041c\u0415\u0420.\u0420\u0424/',
    'https://\u212a.com/', 'https://\u0130stanbul.tr/', 'https://\u00c9:8443/',
    // IDN hosts that stay text
    'https://\u05d0 \u05d1.com/', 'https://\u00e9%41.com/', 'https://\u00e9@a.com/', 'https://\u0645\u062b.123/',
    'https://\u00e9<.com/', 'https://\u00e9|.com/', 'https://[\u00e9]/',
    // UTS 46 would map, delete or reject: stays text
    'https://\uff21.com/', 'https://a\uff0ecom/', 'https://a\uff61com/', 'https://\u00e9\u3000.com/',
    'https://\u00e9\u00a0.com/', 'https://\u00e9\ufeff.com/', 'https://\u00e9\u2060.com/', 'https://a\u200bb.com/',
    'https://i\u2764\ufe0f.ws/', 'https://\u00e9\u{e0041}.com/', 'https://x\u00b2.com/', 'https://\ufb01.com/',
    'https://\u2460.com/', 'https://\u3131.kr/', 'https://\u00b5.com/', 'https://\u017f.com/', 'https://\u1e9e.de/',
    'https://\u01c5.com/', 'https://e\u0301.com/', 'https://\u0301a.com/', 'https://a.\u0903b.com/',
    'https://\u05d0\u202e.com/', 'https://\u00e9.\u3002com/',
    // NFC, lowercase, no mapping: still a link
    'https://\u00e9.com/', 'https://\u03c2.gr/', 'https://x\u0301.com/x',
  ];
  return {
    description:
      'Received url: a strict URL parse, scheme http or https (any case), non-empty host, no userinfo; url false = shown ' +
      'as a plain text notification. href = WHATWG URL().href shown in notification, History and Open; host = the ' +
      'parsed hostname shown to the user (IDN as punycode). Shape rules first (else url false): no C0 control or ' +
      'DEL, no leading or trailing space; "http://" or "https://" (any case) not followed by "/" or "\\"; no "@" or ' +
      '"%" in the authority; a host that ends in a number ' +
      'only as a dotted quad 0-255 without leading zeros. A host that UTS 46 would map or reject is url false: ' +
      'the host must equal its NFKC form; each non-ASCII code point must equal its own full lowercase mapping and ' +
      'not be a Default_Ignorable_Code_Point (U+00AD, U+034F, U+061C, U+115F-U+1160, U+17B4-U+17B5, U+180B-U+180F, ' +
      'U+200B-U+200F, U+202A-U+202E, U+2060-U+206F, U+3164, U+FE00-U+FE0F, U+FEFF, U+FFA0, U+FFF0-U+FFF8, ' +
      'U+1BCA0-U+1BCA3, U+1D173-U+1D17A, U+E0000-U+E0FFF) or U+3002; no label may start with a combining mark ' +
      '(Mn, Mc, Me). Then ASCII A-Z to lowercase and each label with a non-ASCII code point becomes ' +
      '"xn--" + RFC 3492 punycode. A space in the path, query or fragment is kept as %20. ' +
      'auto_open (extensions only): https, DNS hostname, no IP ' +
      'literal, no explicit port, at least two labels after stripping one trailing dot, no empty label, not "localhost", last label not ' +
      '"localhost" or "local".',
    cases: inputs.map((input) => ({ input, ...parseReceivedUrl(input) })),
  };
}

function phoneSection() {
  const inputs = [
    '+1 555-123-4567', '(555) 123.4567', '2026-10-24', '10.0.0.1', '123456', '5551234', 'tel:+15551234567',
    ' \u00a0+1 555 123 4567\n', '123456789012345', '1234567890123456', '+', '2026.10.24', '24-10-2026', '24 10 2026',
    '2026-10.24', '10.0.0.255', '555-1234 ext 5', '\uff15\uff15\uff15\uff11\uff12\uff13\uff14', '++1 555 1234567',
    '+1-(555)-123-4567', '1 2 3 4 5 6 7', '555-123-4567.', 'tel:5551234', 'https://example.com/5551234567',
  ];
  return {
    description:
      'Phone number detection: trim ASCII whitespace (TAB LF FF CR SPACE) and NBSP, strip a leading "tel:", then ' +
      'phone iff ^\\+?(?:[ ().-]*[0-9]){7,15}[ ().-]*$ (ASCII digits) and not IPv4 shape ^[0-9]{1,3}(\\.[0-9]{1,3}){3}$ ' +
      'and not date shape ^([0-9]{4}([-. ])[0-9]{2}\\2[0-9]{2}|[0-9]{2}([-. ])[0-9]{2}\\3[0-9]{4})$. Assert phone.',
    cases: inputs.map((input) => ({ input, phone: isPhone(input) })),
  };
}

function b64Section() {
  const key = b64e(X.encPub);
  const badKey = key.slice(0, -1) + String.fromCharCode(key.charCodeAt(key.length - 1) + 1);
  const accept = ['', 'AA', 'AAA', 'AAAA', '_-8', 'AQID', 'AQI', 'AQ', key];
  const reject = ['A', 'AB', 'AAB', 'AA==', 'AA=', 'A+8', 'A/8', 'AA AA', 'AAAA\n', '\u00e9AAA', 'AAAAA', badKey];
  return {
    description:
      'Strict canonical b64url decoding: RFC 4648 URL alphabet, no "=", reject any other char, length mod 4 = 1 and ' +
      'nonzero spare bits. ok true gives hex = the decoded bytes (hex here only, to avoid testing the codec with itself).',
    cases: [
      ...accept.map((input) => ({ input, ok: true, hex: hexe(b64d(input)) })),
      ...reject.map((input) => ({ input, ok: false, hex: null })),
    ],
  };
}

function mustFailSection() {
  const out = [];
  const mf = (name, kind, outcome, rest) => out.push({ name, kind, outcome, ...rest });
  const msg = (name, outcome, o, ctx = {}) => {
    const r = inner('mf ' + name, o);
    mf(name, 'message', outcome, msgCase(name, r, { ...ctx, json: o.json }));
  };
  const url = (n) => '{"n":' + n + ',"url":"https://example.com/a"}';
  const appr = (n, pid = PAIRING_ID, nText = String(n)) => '{"n":' + n + ',"approve":' + nameJson(nameObj(X, N, n, 'Pixel 8', pid, nText), n) + '}';
  const xKeys = { signPub: X.signPub, encPub: X.encPub };

  msg('tampered_ciphertext', 'unreadable', { json: url(1), flipCt: true });
  msg('wrong_recipient_key', 'unreadable', { json: url(1), sealTo: O, aadId: O.idB64 });
  msg('wrong_recipient_aad', 'unreadable', { json: url(1), aadId: O.idB64 });
  msg('wrong_hpke_info', 'unreadable', { json: url(1), info: 'PA-NAME1' });
  msg('repeated_n', 'invalid', { json: url(5) }, { window: { h: 5, seen: [5] } });
  msg('replay_repeated_n_text_no_history', 'invalid', { json: '{"n":3,"text":"hi"}' }, { window: { h: 5, seen: [5, 4, 3] }, history: [5] });
  msg('n_at_h_minus_100', 'invalid', { json: url(50) }, { window: { h: 150, seen: [150] } });
  msg('n_below_h_minus_100', 'invalid', { json: url(7) }, { window: { h: 150, seen: [150] } });
  msg('n_zero', 'unreadable', { json: url(0) });
  msg('n_float_1.0', 'unreadable', { json: '{"n":1.0,"url":"https://example.com/a"}' });
  msg('n_exp_1e0', 'unreadable', { json: '{"n":1e0,"url":"https://example.com/a"}' });
  msg('n_negative', 'unreadable', { json: url(-1) });
  msg('n_string', 'unreadable', { json: '{"n":"1","url":"https://example.com/a"}' });
  msg('n_leading_zero', 'unreadable', { json: '{"n":01,"url":"https://example.com/a"}' });
  msg('n_2_pow_53', 'unreadable', { json: url('9007199254740992') });
  msg('duplicate_key_n', 'unreadable', { json: '{"n":1,"n":2,"url":"https://example.com/a"}' });
  msg('duplicate_key_type', 'unreadable', { json: '{"n":1,"text":"a","text":"b"}' });
  msg('wrong_pairing_id', 'unreadable', { json: url(1), pid: OLD_PAIRING_ID });
  msg('bad_signature', 'unreadable', { json: url(1), flipSig: true });
  msg('signed_by_other_key', 'unreadable', { json: url(1), signer: O });
  msg('bad_label_raw_recipient_id', 'unreadable', { json: url(1), signedBytes: (p) => cat('PA-MSG1\n', N.id, '\n', p) });
  msg('bad_label_other_label', 'unreadable', { json: url(1), signedBytes: (p) => cat('PA-NAME1\n' + N.idB64 + '\n', p) });
  msg('signature_excludes_padding', 'unreadable', { json: url(1), signedBytes: (p, b) => msgSignedBytes(N.idB64, b) });
  msg('nonzero_padding', 'unreadable', { json: url(1), padByte: 1 });
  msg('length_field_past_end', 'unreadable', { json: url(1), lenOverride: 0xffff });
  msg('unknown_sender', 'unreadable', { json: url(1), from: O }, { from: O, pin: null });
  msg('other_account_sender', 'unreadable', { json: url(1), from: Z }, { from: Z, pin: pin(Z) });
  msg('url_from_unruled', 'unreadable', { json: url(1) }, { pin: pin(X, PAIRING_ID, 'unruled') });
  msg('rename_from_unruled', 'unreadable', { json: typeJson('rename', 7) }, { pin: pin(X, PAIRING_ID, 'unruled') });
  msg('logout_from_denied', 'unreadable', { json: '{"n":1,"logout":1}' }, { pin: pin(X, PAIRING_ID, 'denied') });
  msg('approve_from_denied', 'unreadable', { json: appr(4), keys: xKeys }, { pin: pin(X, PAIRING_ID, 'denied') });
  msg('approve_not_pinned', 'unreadable', { json: '{"n":1,"approve":' + nameJson(nameObj(O, N, 1, 'Other'), 1) + '}', from: O, keys: { signPub: O.signPub, encPub: O.encPub } }, { from: O, pin: null });
  msg('keys_flag_on_text', 'unreadable', { json: '{"n":1,"text":"hi"}', keys: xKeys });
  msg('embedded_keys_wrong_keyhash', 'unreadable', { json: appr(4), keys: { signPub: O.signPub, encPub: O.encPub }, signer: O });
  msg('embedded_keys_sign_pub_equals_enc_pub', 'unreadable',
    { json: '{"n":1,"approve":' + nameJson(nameObj(S, N, 1, 'Same'), 1) + '}', from: S, keys: { signPub: S.signPub, encPub: S.encPub } },
    { from: S, pin: pin(S, PAIRING_ID, 'unruled') });
  msg('approve_name_earlier_pairing_id', 'unreadable', { json: appr(4, OLD_PAIRING_ID), keys: xKeys }, { pin: pin(X, PAIRING_ID, 'unruled') });
  msg('approve_name_n_leading_zero_signed', 'unreadable', { json: appr(7, PAIRING_ID, '07'), keys: xKeys }, { pin: pin(X, PAIRING_ID, 'unruled') });
  msg('approve_name_n_differs', 'unreadable',
    { json: '{"n":5,"approve":' + nameJson(nameObj(X, N, 4, 'Pixel 8'), 4) + '}', keys: xKeys }, { pin: pin(X, PAIRING_ID, 'unruled') });
  msg('approve_keys_flag_0', 'unreadable', { json: appr(4) }, { pin: pin(X, PAIRING_ID, 'unruled') });
  msg('approve_bad_name_entry_seen_n', 'unreadable', { json: appr(4, OLD_PAIRING_ID), keys: xKeys },
    { pin: pin(X, PAIRING_ID, 'unruled'), window: { h: 4, seen: [4] } });
  msg('rename_bad_name_entry_seen_n', 'unreadable',
    { json: '{"n":7,"rename":' + nameJson(nameObj(X, N, 7, 'Work phone', OLD_PAIRING_ID), 7) + '}' }, { window: { h: 7, seen: [7] } });
  msg('rename_name_n_differs', 'unreadable', { json: '{"n":8,"rename":' + nameJson(nameObj(X, N, 7, 'Work phone'), 7) + '}' });
  msg('no_type_key', 'unreadable', { json: '{"n":1}' });
  msg('unknown_type', 'unreadable', { json: '{"n":1,"foo":1}' });
  msg('remove_id_39_chars', 'unreadable', { json: '{"n":1,"remove":"' + O.idB64.slice(0, 39) + '"}' });
  msg('remove_id_39_chars_seen_n', 'unreadable', { json: '{"n":1,"remove":"' + O.idB64.slice(0, 39) + '"}' },
    { window: { h: 1, seen: [1] } });
  msg('remove_id_not_b64url', 'unreadable', { json: '{"n":1,"remove":"' + O.idB64.slice(0, 39) + '+"}' });
  msg('deny_value_true', 'unreadable', { json: '{"n":1,"deny":true}' });
  msg('logout_value_1.0', 'unreadable', { json: '{"n":1,"logout":1.0}' });
  msg('content_over_2048_bytes', 'unreadable', { json: '{"n":1,"text":"' + 'a'.repeat(2049) + '"}' });
  msg('inflate_over_16384_bytes', 'unreadable', { json: '{"n":1,"text":"' + 'a'.repeat(16400) + '"}' });
  {
    const r = inner('mf noncanonical', { json: url(1) });
    const m = r.message;
    const i = [...m].findIndex((c) => c === '-' || c === '_');
    const bad = m.slice(0, i) + (m[i] === '-' ? '+' : '/') + m.slice(i + 1);
    mf('message_not_b64url_alphabet', 'message', 'unreadable', { ...msgCase('x', r, {}), message: bad, name: 'message_not_b64url_alphabet' });
    mf('message_with_padding_char', 'message', 'unreadable', { ...msgCase('x', r, {}), message: m + '==', name: 'message_with_padding_char' });
  }

  // Pair messages.
  const pair = (name, receiver, expectedKind, sealed, extra = {}) =>
    mf(name, 'pair', 'unreadable', { receiver: receiver.name, expected_kind: expectedKind, message: sealed, ...extra });
  const sealRaw = (lbl, pt, to, info = 'PA-PAIR1') =>
    b64e(sealWire(to.encPub, Buffer.from(info), Buffer.from(to.idB64), pt, ikm('mf pair ' + lbl)).wire);
  const commitPt = cat([1], N.id, commitBody(C_N));
  pair('pair_plaintext_192_bytes', X, 'commit', sealRaw('192', commitPt.subarray(0, 192), X));
  pair('pair_plaintext_194_bytes', X, 'commit', sealRaw('194', cat(commitPt, [0]), X));
  pair('pair_wrong_hpke_info', X, 'commit', sealRaw('info', commitPt, X, 'PA-MSG1'));
  pair('pair_bad_kind', X, 'commit', sealRaw('kind', cat([4], commitPt.subarray(1)), X));
  pair('pair_other_account_from', X, 'commit', sealRaw('acct', cat([1], Z.id, commitBody(C_N)), X));
  pair('pair_kind_not_fitting_state', X, 'open', sealPair('commit', N.id, commitBody(C_N), X.idB64, X.encPub, ikm('mf state')).message, { stored_c_N: b64e(C_N) });
  pair('bad_commit_open', X, 'open',
    sealPair('open', N.id, keysBody(N.signPub, N.encPub, label('wrong r_N')), X.idB64, X.encPub, ikm('mf open')).message,
    { stored_c_N: b64e(C_N) });
  pair('reply_keys_not_matching_from_id', N, 'reply',
    sealPair('reply', X.id, keysBody(O.signPub, O.encPub, R_X), N.idB64, N.encPub, ikm('mf reply kh')).message);
  pair('reply_sign_pub_equals_enc_pub', N, 'reply',
    sealPair('reply', S.id, keysBody(S.signPub, S.encPub, R_X), N.idB64, N.encPub, ikm('mf reply same')).message);

  // Name entries (GET /peers name_for_me), owner X, recipient N.
  const ne = (name, json, o = {}) => {
    const to = o.sealFor ?? N;
    const ct = b64e(sealWire(to.encPub, Buffer.from('PA-NAME1'), Buffer.from(to.idB64), Buffer.from(json), ikm('mf ne ' + name)).wire);
    mf(name, 'name_entry', 'unreadable', { owner: 'X', receiver: 'N', pin: pin(X), ciphertext: ct });
  };
  ne('name_entry_earlier_pairing_id', nameJson(nameObj(X, N, 3, 'Pixel 8', OLD_PAIRING_ID), 3));
  ne('name_entry_n_float', nameJson(nameObj(X, N, 1, 'Pixel 8'), '1.0'));
  ne('name_entry_signed_n_leading_zero', nameJson(nameObj(X, N, 7, 'Pixel 8', PAIRING_ID, '07'), 7));
  ne('name_entry_name_33_chars', nameJson(nameObj(X, N, 1, 'a'.repeat(33)), 1));
  ne('name_entry_name_control_char', nameJson(nameObj(X, N, 1, 'Pixel\n8'), 1));
  ne('name_entry_name_double_quote', nameJson(nameObj(X, N, 1, 'Pixel "8"'), 1));
  ne('name_entry_wrong_recipient', nameJson(nameObj(X, O, 1, 'Pixel 8'), 1), { sealFor: O });
  ne('name_entry_over_1024_chars', nameJson(nameObj(X, N, 1, 'Pixel 8'), 1) + ' '.repeat(600));
  {
    const no = nameObj(X, N, 1, 'Pixel 8');
    ne('name_entry_missing_s', '{"name":"' + no.nameB64 + '","n":1,"x":1}');
    ne('name_entry_duplicate_key', '{"name":"' + no.nameB64 + '","n":1,"n":1,"s":"' + no.s + '"}');
  }

  // PA-Sig requests (the Worker rejects with 401).
  const good = reqCase('good', X, 'POST', '/v1/send', T0, '{"v":1,"m":{}}');
  const rq = (name, over) => mf(name, 'request', 'unreadable', { ...good, ...over, name });
  rq('request_body_changed', { body: b64e(Buffer.from('{"v":1,"m":{} }')), body_text: '{"v":1,"m":{} }' });
  rq('request_path_changed', { path: '/v1/peers' });
  rq('request_path_without_v1', { ...reqCase('x', X, 'POST', '/send', T0, '{"v":1,"m":{}}'), path: '/v1/send' });
  rq('request_time_changed', { pa_time: '1761300000124' });
  rq('request_method_changed', { method: 'PUT' });
  rq('request_other_key', { sign_pub: b64e(O.signPub) });
  rq('request_pa_time_12_digits', reqCase('x', X, 'POST', '/v1/send', '176130000012', '{"v":1,"m":{}}'));
  {
    const sig = b64d(good.sig);
    const der = (x) => { let i = 0; while (i < 31 && x[i] === 0) i++; let v = x.subarray(i); if (v[0] & 0x80) v = cat([0], v); return cat([2, v.length], v); };
    const seq = cat(der(sig.subarray(0, 32)), der(sig.subarray(32)));
    rq('request_sig_der_encoded', { sig: b64e(cat([0x30, seq.length], seq)) });
  }

  // GET /peers list entries (the client drops the entry).
  const pe = (name, id, signPub, encPub) =>
    mf(name, 'peer_entry', 'unreadable', { receiver: 'N', id, sign_pub: b64e(signPub), enc_pub: b64e(encPub) });
  pe('peer_entry_sign_pub_equals_enc_pub', S.idB64, S.signPub, S.encPub);
  pe('peer_entry_other_account', Z.idB64, Z.signPub, Z.encPub);
  pe('peer_entry_keyhash_mismatch', X.idB64, O.signPub, O.encPub);
  {
    const off = Buffer.from(X.encPub);
    off[64] ^= 1;
    pe('peer_entry_point_not_on_curve', b64e(peerId(ID_SECRET, ACCT_A, keyhash(X.signPub, off))), X.signPub, off);
    const short = X.encPub.subarray(0, 64);
    pe('peer_entry_key_64_bytes', b64e(peerId(ID_SECRET, ACCT_A, keyhash(X.signPub, short))), X.signPub, short);
    const comp = cat([2 + (X.encPub[64] & 1)], X.encPub.subarray(1, 33));
    pe('peer_entry_compressed_key', b64e(peerId(ID_SECRET, ACCT_A, keyhash(X.signPub, comp))), X.signPub, comp);
  }
  return {
    description:
      'Inputs every client must reject, with the expected outcome: "invalid" (a replay: a seen n of url/text/tel with ' +
      'no History row, or n <= h - 100; notice and History event "Invalid message received") or "unreadable" (every other ' +
      'case: drop under the Notice rule, the generic "could not read"; for request and peer_entry kinds it means reject/drop ' +
      'with no Invalid notice). kind message: receiver state as in messages (pin null = sender not pinned); kind pair: open ' +
      'with the receiver key, kind must equal expected_kind, for open sha256("PA-SAS1C\\n" || keys || r_N) must equal ' +
      'stored_c_N; kind name_entry: as name_entries with pin; kind request: verify PA-Sig over the fields (the Worker ' +
      'returns 401); kind peer_entry: a GET /peers entry checked against the receiver account (prefix, keyhash, valid ' +
      '65-byte points, sign_pub != enc_pub). Every leg asserts every case and its outcome. Counter key is "n".',
    cases: out,
  };
}

function rfcSections() {
  const e = RFC9180_SUITE;
  return {
    rfc9180: {
      description:
        'RFC 9180 base mode, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM (kem 16, kdf 1, aead 2): the entry from ' +
        'the test vector file RFC 9180 cites ([TestVectors], cfrg/draft-irtf-cfrg-hpke commit 5f503c56). Values in hex as ' +
        'in the source. Assert DeriveKeyPair(ikmE/ikmR) -> skEm/skRm, the key schedule (shared_secret, ' +
        'key_schedule_context, secret, key, base_nonce, exporter_secret), seal of pt with aad == ct at sequence 0, and open.',
      ...e,
    },
    rfc8291: {
      description:
        'RFC 8291 section 5 example with the Appendix A intermediate values (base64url as in the RFC). Assert the ' +
        'derivation from as_private, ua_public, auth_secret and salt (record size 4096) gives every intermediate and body ' +
        'byte for byte, and that decrypting body with ua_private gives plaintext.',
      ...RFC8291_EXAMPLE,
    },
  };
}

export function buildGolden() {
  return {
    version: 1,
    description:
      'PushArmor golden cross-platform vectors v1 (normative; catalog r10). Binary values are strict b64url (RFC 4648 URL ' +
      'alphabet, no padding) unless a field says otherwise: b64url.cases[].hex and rfc9180 use hex. Ids are 40-char b64url; ' +
      'raw id bytes are their decoded 30 bytes. Times are unix seconds. Peers are named N, X, O, Z, S (see keys). ' +
      'Randomized primitives (ECDSA, HPKE seal) are checked in the verify/open direction; generator signatures use RFC 6979 ' +
      'and HPKE ephemeral keys use DeriveKeyPair(ikmE) only to make this file reproducible.',
    keys: keysSection(),
    email_hash: emailSection(),
    mailbox: mailboxSection(),
    id_order: idOrderSection(),
    device_id: deviceIdSection(),
    device_name: deviceNameSection(),
    oauth_nonce: nonceSection(),
    cli_code: cliCodeSection(),
    my_push_sha256: pushSection(),
    b64url: b64Section(),
    pairing: pairingSection(),
    pair_decide: pairDecideSection(),
    pair_timeout: pairTimeoutSection(),
    pair_hint: pairHintSection(),
    request_sig: requestSection(),
    name_entries: nameSection(),
    messages: messagesSection(),
    padded_messages: paddedSection(),
    padding: paddingSection(),
    content_cap: contentCapSection(),
    inflate: inflateSection(),
    replay_window: replaySection(),
    url_parse: urlSection(),
    phone: phoneSection(),
    must_decode: mustDecodeSection(),
    must_fail: mustFailSection(),
    ...rfcSections(),
  };
}

// ---------------------------------------------------------------- file-v1.json
const FILE_TIME = '1795319232123'; // 2026-11-22 03:47:12.123 UTC
const sendIdOf = (s) => b64e(label('send id\n' + s).subarray(0, 16));
const randHexOf = (s) => hexe(label('file id\n' + s).subarray(0, 16));
const ACCT_SECRET = label('ACCT_HASH_SECRET');

function fileSigSection() {
  const post = (name, cl, sha, sendId, paTime = FILE_TIME) => {
    const signed = filePostBytes(paTime, cl, sha, sendId);
    return {
      name, method: 'POST', signer: X.name, sign_pub: b64e(X.signPub), pa_time: paTime, content_length: cl,
      file_sha256: sha, send_id: sendId, signed_text: signed.toString('utf8'), signed_bytes: b64e(signed),
      sig: b64e(sign(X.signPriv, signed)), verifies: true,
    };
  };
  const del = (name, id, paTime = FILE_TIME) => {
    const signed = fileDeleteBytes(id, paTime);
    return {
      name, method: 'DELETE', signer: X.name, sign_pub: b64e(X.signPub), pa_time: paTime, id, path: '/v1/file/' + id,
      signed_text: signed.toString('utf8'), signed_bytes: b64e(signed), sig: b64e(sign(X.signPriv, signed)),
      verifies: true,
    };
  };
  const tampered = (c) => {
    const s = b64d(c.sig);
    s[s.length - 1] ^= 1;
    return { ...c, sig: b64e(s), verifies: false };
  };
  const id = '202611230347-' + randHexOf('sig');
  return {
    description:
      'PA-FILE1 signing strings, frozen, UTF-8, no trailing newline. POST: "PA-FILE1\\nPOST\\n/v1/file\\n" + PA-Time + "\\n" + ' +
      'Content-Length (decimal) + "\\n" + PA-File-SHA256 + "\\n" + PA-Send-ID. DELETE: "PA-FILE1\\nDELETE\\n/v1/file/" + id + ' +
      '"\\n" + PA-Time (no body line). PA-Sig = b64url of raw r||s, ECDSA P-256 SHA-256 over the string, as PA-REQ1. ' +
      'Signer X from golden-v1.json keys.peers. Assert signed_bytes byte for byte from the fields and that sig verifies ' +
      'with sign_pub (verify only) exactly when verifies is true; a false row has a changed PA-Sig and must be refused.',
    cases: [
      post('post_small', 33, b64e(sha256('example blob')), sendIdOf('small')),
      post('post_max_file', MAX_FILE + BLOB_OVERHEAD, b64e(sha256('max blob')), sendIdOf('max')),
      del('delete', id),
      del('delete_other_time', id, '1795320000999'),
      tampered(post('post_small_tampered_sig', 33, b64e(sha256('example blob')), sendIdOf('small'))),
    ],
  };
}

function downloadSigSection() {
  const k = fileKey({ acceptTime: Date.UTC(2026, 10, 22, 3, 47, 12) / 1000, size: 1234567, secret: ACCT_SECRET, account: X.account, randHex: randHexOf('download') });
  const path = new URL(k.url).pathname;
  const one = (name, paTime = FILE_TIME) => {
    const signed = downloadBytes(path, paTime);
    const sig = b64e(sign(X.signPriv, signed));
    return {
      name, method: 'GET', signer: X.name, sign_pub: b64e(X.signPub), enc_pub: b64e(X.encPub), url: k.url, path,
      pa_time: paTime, signed_text: signed.toString('utf8'), signed_bytes: b64e(signed), sig, verifies: true,
      headers: { 'PA-ID': X.idB64, 'PA-Time': paTime, 'PA-Sign-Pub': b64e(X.signPub), 'PA-Enc-Pub': b64e(X.encPub), 'PA-Sig': sig },
    };
  };
  const tampered = (c) => {
    const s = b64d(c.sig);
    s[s.length - 1] ^= 1;
    return { ...c, sig: b64e(s), headers: { ...c.headers, 'PA-Sig': b64e(s) }, verifies: false };
  };
  return {
    description:
      'PA-DL1 signing string for a GET on the file host, frozen, UTF-8, no trailing newline: "PA-DL1\\nGET\\n" + path + ' +
      '"\\n" + PA-Time, where path is the URL pathname with its leading "/". The Range header is not signed; each request ' +
      '(each retry and each resumed Range request) gets a fresh PA-Time and PA-Sig. Headers: PA-ID, PA-Time, PA-Sign-Pub and ' +
      'PA-Enc-Pub (87-char b64url raw points of the signing device), PA-Sig (86-char b64url raw r||s, ECDSA P-256 SHA-256, ' +
      'as PA-REQ1). Signer X from golden-v1.json keys.peers; the url is a file of the account of X. Assert signed_bytes byte ' +
      'for byte from path and pa_time, path equals the url pathname, every header from the fields, and that sig verifies with ' +
      'sign_pub (verify only) exactly when verifies is true; a false row has a changed PA-Sig and must be refused.',
    cases: [one('download'), one('download_other_time', '1795320000999'), tampered(one('download_tampered_sig'))],
  };
}

const BLOB_INPUTS = [
  ['empty', ''],
  ['hello', 'hello, file'],
  ['prng_1000', prng('file blob 1000', 1000)],
];

function blobCase(name, text) {
  const key = label('file key\n' + name);
  const nonce = label('file nonce\n' + name).subarray(0, 12);
  const pt = Buffer.from(text, 'latin1');
  const blob = sealBlob(key, nonce, pt);
  return {
    name, key: b64e(key), nonce: b64e(nonce), plaintext: b64e(pt), size: pt.length, blob: b64e(blob),
    blob_size: blob.length, sha256: b64e(sha256(blob)),
  };
}

function blobSection() {
  return {
    description:
      'AES-256-GCM, one random 32-byte key and one random 12-byte nonce per file, no AAD, one tag, never chunked. blob = ' +
      'nonce (12) || ciphertext || tag (16); blob_size = size + 28 exactly. key is the 43-char b64url file.key. sha256 is ' +
      'the 43-char b64url SHA-256 of the whole blob (file.sha256 and the PA-File-SHA256 header). Assert: seal(key, nonce, ' +
      'plaintext) == blob; open(key, blob) == plaintext; sha256(blob) == sha256; a blob with any bit flipped fails to open.',
    cases: BLOB_INPUTS.map(([n, t]) => blobCase(n, t)),
  };
}

function uploadSection() {
  const b = blobCase('hello', 'hello, file');
  const blob = b64d(b.blob);
  const sendId = sendIdOf('upload');
  const signed = filePostBytes(FILE_TIME, blob.length, b.sha256, sendId);
  return {
    description:
      'One full POST /v1/file request (blob from blob.cases "hello"). Content-Length = body length; PA-File-SHA256 = ' +
      'b64url SHA-256 of the body; PA-Send-ID = 22-char b64url of 16 random bytes, the same on each retry of one send; ' +
      'PA-Sig over the PA-FILE1 POST string. Assert every header from the body and the fields, that PA-Sig verifies with ' +
      'sign_pub, and that the body opens with key to plaintext.',
    method: 'POST',
    path: '/v1/file',
    signer: X.name,
    sign_pub: b64e(X.signPub),
    key: b.key,
    plaintext: b.plaintext,
    headers: {
      'PA-ID': X.idB64,
      'PA-Time': FILE_TIME,
      'PA-Client': 'cli/0.0.55',
      'PA-File-SHA256': b.sha256,
      'Content-Length': String(blob.length),
      'PA-Send-ID': sendId,
      'PA-Sig': b64e(sign(X.signPriv, signed)),
    },
    body: b.blob,
    signed_bytes: b64e(signed),
  };
}

function sha256Section() {
  const ins = [['empty', ''], ['abc', 'abc'], ['blob_hello', b64d(blobCase('hello', 'hello, file').blob)]];
  return {
    description: 'SHA-256 of bytes as 43-char b64url (no padding). input is b64url bytes. Assert sha256(input) == sha256.',
    cases: ins.map(([name, v]) => ({ name, input: b64e(Buffer.from(v)), sha256: b64e(sha256(v)) })),
  };
}

function ttlSection() {
  const pts = [
    ['zero', 0], ['one', 1], ['10_000_000', 10000000], ['10_000_001', 10000001], ['25_mb', 25000000],
    ['50_mb', 50000000], ['95_mb', 95000000], ['100_mb', 100000000], ['max_file', MAX_FILE], ['max_file_plus_1', MAX_FILE + 1],
  ];
  return {
    description:
      'WORKER ONLY. Clients never implement or hardcode a lifetime; they show file.expires. size = Content-Length - 28 ' +
      '(plaintext bytes, decimal). ttl_min = min(1440, floor(14,400,000,000 / size)); size 0 -> 1440. Content-Length > ' +
      'MAX_FILE + 28 -> 413 and ttl_min null. Content-Length < 28 (no room for nonce and tag) -> 400, size and ttl_min ' +
      'null. Assert ttl_min and status for each content_length.',
    worker_only: true,
    cases: [
      ...pts.map(([name, size]) => {
        const t = ttlMinutes(size);
        return { name, size, content_length: size + BLOB_OVERHEAD, ttl_min: t, status: t === null ? 413 : 201 };
      }),
      ...[0, BLOB_OVERHEAD - 1].map((cl) => ({
        name: 'content_length_' + cl, size: null, content_length: cl, ttl_min: ttlMinutes(cl - BLOB_OVERHEAD), status: 400,
      })),
    ],
  };
}

function keySection() {
  const u = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
  const cases = [
    ['plan_example_24h', u(2026, 11, 22, 3, 47, 12), 1234567, ACCT_A],
    ['25_mb', u(2026, 11, 22, 3, 47, 12), 25000000, ACCT_A],
    ['other_account', u(2026, 11, 22, 3, 47, 12), 1234567, ACCT_B],
    ['expires_on_minute', u(2026, 11, 22, 10, 0, 0), 100000000, ACCT_A],
    ['year_end_100mb_last_minute', u(2026, 12, 31, 21, 35, 59), 100000000, ACCT_A],
    ['year_end_100mb_rollover', u(2026, 12, 31, 21, 36, 0), 100000000, ACCT_A],
    ['year_end_24h_last_minute', u(2026, 12, 30, 23, 59, 59), 1, ACCT_A],
    ['year_end_24h_rollover', u(2026, 12, 31, 0, 0, 0), 1, ACCT_A],
  ];
  return {
    description:
      'WORKER ONLY (clients use url and id as received). expires = accept_time + ttl_min * 60 (unix seconds); minute = ' +
      'UTC YYYYMMDDHHMM of floor(expires / 60); acct_hash = first 16 lowercase hex of HMAC-SHA256(acct_secret, raw ' +
      'account id bytes); id = minute + "-" + rand_hex (32 lowercase hex of 16 random bytes); key = "v1/" + minute + "/" + ' +
      'acct_hash + "/" + id; url = "https://b2file.pusharmor.com/" + key. Assert every output from the inputs.',
    worker_only: true,
    acct_secret: b64e(ACCT_SECRET),
    cases: cases.map(([name, acceptTime, size, account]) => {
      const randHex = randHexOf(name);
      const r = fileKey({ acceptTime, size, secret: ACCT_SECRET, account, randHex });
      return {
        name, accept_time: acceptTime, size, account: b64e(account), rand_hex: randHex,
        acct_hash: r.key.split('/')[2], ...r,
      };
    }),
  };
}

const NAME_TIME = 1795405632; // 2026-11-23 03:47:12 UTC
const NAME_INPUTS = [
  ['report.pdf'], ['report (1).pdf'], ['My Photo 2026.JPG', true], ['/home/user/docs/notes.txt'],
  ['C:\\Users\\me\\file.docx'], ['../../etc/passwd'], ['dir/'], [''], ['...'], ['.bashrc'], ['..hidden.txt'],
  ['trailing dot.'], [' spaced name .txt '], ['multi   space.txt'], ['under___score.txt'], ['a_ _b.txt'],
  ['caf\u00e9.txt'], ['\u65e5\u672c\u8a9e.txt'], ['\u{1F600}.png', true], ['\u{1F600}smile.png', true],
  ['a<b>c:d"e|f?g*h.txt'], ['tab\there.txt'], ['new\nline.txt'], ['archive.tar.gz'], ['noext'],
  ['photo.jpeg', true], ['x.abcdefghij'], ['x.abcdefghijk'], ['x.tar-gz'], ['12345.jpg', true], ['0000'],
  ['con.txt'], ['CON'], ['Nul.tar.gz'], ['com1.log'], ['LPT9'], ['com10.txt'], ['console.txt'], ['aux_file.txt'],
  ['CON .txt'], ['a'.repeat(64) + '.txt'], ['a'.repeat(65) + '.txt'], ['a'.repeat(65)],
  ['a'.repeat(64) + '.' + 'b'.repeat(11)], ['_.pdf'], ['-.pdf'], ['(1).pdf'], ['screenshot.PNG', true],
  ['\u00e9\u00e9\u00e9', true], ['file.name.with.dots.md'], ['dots...txt'], ['  '], ['%20encoded%2F.txt'],
  ['name.\u00e9xt'], ['report.pdf.'], ['C:'], ['CON. .txt'], ['lpt1 .tar.gz'], ['e\u0301.txt'],
  ['Cafe\u0301 Menu.pdf'], ['invoice\u202Egpj.exe'],
];

function namesSection() {
  return {
    description:
      'File names, applied by sender and receiver. Steps: 1 basename (split on "/" and "\\\\"); 2 every char (code point) ' +
      'outside [A-Za-z0-9 ._()-] -> "_"; 3 collapse runs of "_" to one "_" and runs of spaces to one space; 4 trim ' +
      'leading and trailing dots and spaces; 5 extension = text after the last dot if 1-10 chars of [A-Za-z0-9], else ' +
      'none (base = all); 6 fallback base if the base has no [A-Za-z0-9] or is > 64 chars: "file-YYYYMMDD-HHMMSS" (or ' +
      '"image-..." when image is true) from time in UTC, extension kept; 7 cut so the total is <= 100 (guard); 8 if the ' +
      'text before the first dot, without trailing spaces and dots, equals CON, PRN, AUX, NUL, COM1-COM9 or LPT1-LPT9 (any case), prefix "_". Digits-only ' +
      'names are kept. Code points are not normalized (an NFD name keeps its combining marks as "_"). image and time are inputs (the caller decides image; time is send or receive time). Assert ' +
      'sanitize(input, time, image) == output.',
    time: NAME_TIME,
    cases: NAME_INPUTS.map(([input, image = false]) => ({ input, image, output: sanitizeName(input, NAME_TIME, image) })),
  };
}

function collisionSection() {
  const ten = ['a.pdf', ...Array.from({ length: 9 }, (_, i) => 'a (' + (i + 1) + ').pdf')];
  const cs = [
    ['free', 'report.pdf', []],
    ['taken', 'report.pdf', ['report.pdf']],
    ['next_free', 'report.pdf', ['report.pdf', 'report (1).pdf']],
    ['gap', 'report.pdf', ['report.pdf', 'report (1).pdf', 'report (3).pdf']],
    ['only_numbered_taken', 'report.pdf', ['report (1).pdf']],
    ['no_ext', 'README', ['README']],
    ['last_dot_ext', 'archive.tar.gz', ['archive.tar.gz']],
    ['already_numbered', 'report (1).pdf', ['report (1).pdf']],
    ['long_ext_is_base', 'x.abcdefghijk', ['x.abcdefghijk']],
    ['ten', 'a.pdf', ten],
    ['case_differs', 'Photo.jpg', ['photo.jpg']],
    ['case_differs_numbered', 'Photo.jpg', ['PHOTO.JPG', 'photo (1).jpg']],
    ['case_same_numbered_differs', 'Photo.jpg', ['Photo.jpg', 'PHOTO (1).jpg']],
  ];
  return {
    description:
      'CLI listen --files DIR: when the sanitized name exists in DIR, use "base (N).ext" with the smallest N >= 1 that ' +
      'is free; base and ext split as names step 5 (no ext -> "base (N)"). existing = names already in DIR. mode ' +
      '"ignore_case" when DIR is on a case-insensitive file system (detected per DIR at run time): names match ' +
      'ignoring case (ASCII, as names are sanitized); mode "exact" elsewhere: names match exactly. Every case is ' +
      'given in both modes. Assert collide(name, existing, mode) == output.',
    cases: ['ignore_case', 'exact'].flatMap((mode) =>
      cs.map(([name, n, existing]) => ({ name, mode, input: n, existing, output: collisionName(n, existing, mode) }))),
  };
}

function autoDownloadSection() {
  const pickers = [['off', 0], ['10_mb', 10000000], ['25_mb', 25000000], ['50_mb', 50000000], ['100_mb', 100000000]];
  const sizes = [1, 10000000, 10000001, 25000000, 25000001, 50000000, 50000001, 100000000, 100000001];
  const cases = [];
  for (const network of ['wifi', 'mobile']) {
    for (const dataSaver of [false, true]) {
      for (const [pn, picker] of pickers) {
        for (const size of sizes) {
          const input = { client: 'phone', network, data_saver: dataSaver, picker, size };
          cases.push({ ...input, picker_name: pn, download: autoDownload(input) });
        }
      }
    }
  }
  for (const [pn, picker] of pickers) {
    for (const size of sizes) {
      const input = { client: 'browser', network: 'any', data_saver: false, picker, size };
      cases.push({ ...input, picker_name: pn, download: autoDownload(input) });
    }
  }
  for (const size of [1, MAX_FILE, 100000001]) {
    const input = { client: 'cli', network: 'any', data_saver: false, picker: null, size };
    cases.push({ ...input, picker_name: null, download: autoDownload(input) });
  }
  return {
    description:
      'Auto-download (catch-up and on arrival) for a pending, non-expired file. phone: picker is the picker for the ' +
      'current network ("On Wi-Fi" or "On mobile data"); Data Saver / Low Data Mode on mobile = Off. browser: one ' +
      'picker, network ignored. cli (listen --files DIR): every file up to MAX_FILE, no picker. picker is the limit in ' +
      'bytes (0 = Off); download = picker > 0 and size <= picker. Assert download for each row.',
    cases,
  };
}

export function buildFile() {
  return {
    version: 1,
    description:
      'PushArmor file send vectors v1 (normative). Binary values are strict b64url unless a field says hex. Sizes are ' +
      'bytes (decimal), times are unix seconds, PA-Time is unix ms. Sections marked worker_only (ttl, key) are for the ' +
      'Worker; clients never hardcode a lifetime.',
    constants: {
      description: 'MAX_FILE = largest plaintext size in bytes; BLOB_OVERHEAD = blob bytes beyond the plaintext (nonce 12 + ' +
        'tag 16). Content-Length limit = MAX_FILE + BLOB_OVERHEAD.',
      MAX_FILE,
      BLOB_OVERHEAD,
    },
    file_sig: fileSigSection(),
    download_sig: downloadSigSection(),
    blob: blobSection(),
    upload_request: uploadSection(),
    sha256: sha256Section(),
    ttl: ttlSection(),
    key: keySection(),
    names: namesSection(),
    collision: collisionSection(),
    auto_download: autoDownloadSection(),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2] ?? new URL('../golden-v1.json', import.meta.url).pathname;
  writeFileSync(path, stableJson(buildGolden()));
  process.stdout.write('wrote ' + path + '\n');
  const filePath = process.argv[3] ?? new URL('../file-v1.json', import.meta.url).pathname;
  writeFileSync(filePath, stableJson(buildFile()));
  process.stdout.write('wrote ' + filePath + '\n');
}
