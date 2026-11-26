// Asserts every section of ../golden-v1.json and ../file-v1.json through the
// reference code.
// Run: node --test ref/check.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { b64d, b64e, hexd, hexe, sha256 } from './bytes.mjs';
import { isValidPub, pubFromPriv, sign, verify } from './p256.mjs';
import { checkInput, display, setupDefault, uniqueDefault } from './names.mjs';
import { accountId, cliCode, compareIds, deviceId, emailHash, idMatches, keyhash, mailboxKey, myPushSha256, normalizeEmail, oauthNonce, peerId } from './ids.mjs';
import {
  commitHash, crockford20, fingerprintHash, openMatchesCommit, openPair, pairDecide, pairHint, pairKey, pairingId, pairTimeout,
} from './pairing.mjs';
import { reqBytes, verifyRequest } from './request.mjs';
import {
  bucketFor, inflateCapped, msgSignedBytes, nameSignedBytes, openNameEntry, plaintextLenFor, receiveMessage, wireChars,
} from './message.mjs';
import { deriveKeyPair, openBase, openWire, sealBase, AEAD_AES_256_GCM } from './hpke.mjs';
import { replayOutcome, windowAccept } from './replay.mjs';
import { isPhone, parseReceivedUrl } from './detect.mjs';
import { decrypt as wpDecrypt, encrypt as wpEncrypt } from './webpush.mjs';
import { RFC6979_P256 } from './rfc-vectors.mjs';
import {
  BLOB_OVERHEAD, MAX_FILE, acctHash, autoDownload, collisionName, downloadBytes, fileDeleteBytes, fileKey, filePostBytes, openBlob,
  sanitizeName, sealBlob, ttlMinutes, verifyFile,
} from './file.mjs';
import { buildFile, buildGolden, stableJson } from './gen.mjs';

const PATH = new URL('../golden-v1.json', import.meta.url);
const RAW = readFileSync(PATH);
const G = JSON.parse(RAW.toString('utf8'));
const peer = (name) => {
  const p = G.keys.peers[name];
  return {
    id: p.id, idRaw: b64d(p.id), account: b64d(p.account), signPriv: b64d(p.sign_priv), signPub: b64d(p.sign_pub),
    encPriv: b64d(p.enc_priv), encPub: b64d(p.enc_pub),
  };
};
const ID_SECRET = b64d(G.keys.id_secret);

test('file: ASCII, version 1, stable and reproducible', () => {
  assert.ok(RAW.every((b) => b < 0x80), 'non-ASCII byte in golden file');
  assert.equal(G.version, 1);
  assert.equal(RAW.toString('utf8'), stableJson(G), 'not in stable sorted form');
  assert.equal(RAW.toString('utf8'), stableJson(buildGolden()), 'generator output differs from the committed file');
  for (const [k, v] of Object.entries(G)) if (v && typeof v === 'object') assert.equal(typeof v.description, 'string', k);
});

test('ref: RFC 6979 deterministic signer', () => {
  const x = hexd(RFC6979_P256.x);
  assert.equal(hexe(sign(x, Buffer.from('sample'))).toUpperCase(), RFC6979_P256.sample);
  assert.equal(hexe(sign(x, Buffer.from('test'))).toUpperCase(), RFC6979_P256.test);
});

test('keys', () => {
  for (const [name, p] of Object.entries(G.keys.peers)) {
    const q = peer(name);
    assert.equal(b64e(pubFromPriv(q.signPriv)), p.sign_pub);
    assert.equal(b64e(pubFromPriv(q.encPriv)), p.enc_pub);
    const acct = accountId(ID_SECRET, emailHash(normalizeEmail(p.email)));
    assert.equal(b64e(acct), p.account);
    const kh = keyhash(q.signPub, q.encPub);
    assert.equal(b64e(kh), p.keyhash);
    assert.equal(b64e(peerId(ID_SECRET, acct, kh)), p.id);
  }
});

test('mailbox', () => {
  for (const c of G.mailbox.cases) {
    const n = normalizeEmail(c.input);
    assert.equal(n, c.normalized, c.input);
    assert.equal(mailboxKey(n), c.mailbox, c.input);
    assert.equal(b64e(emailHash(c.mailbox)), c.email_hash);
    assert.equal(b64e(accountId(ID_SECRET, emailHash(c.mailbox))), c.account);
  }
});

test('email_hash', () => {
  for (const c of G.email_hash.cases) {
    const n = normalizeEmail(c.input);
    assert.equal(n, c.normalized, c.input);
    if (n !== null) {
      assert.equal(b64e(emailHash(n)), c.email_hash);
      assert.equal(b64e(accountId(ID_SECRET, emailHash(n))), c.account);
    }
  }
});

test('id_order', () => {
  for (const c of G.id_order.cases) assert.equal(compareIds(c.a, c.b) < 0 ? 'a' : 'b', c.lower, c.name);
});

test('device_name', () => {
  for (const c of G.device_name.input_cases) assert.deepEqual(checkInput(c.input), { error: c.error, name: c.name }, JSON.stringify(c.input));
  for (const c of G.device_name.default_cases) assert.equal(setupDefault(c.input), c.name, JSON.stringify(c.input));
  for (const c of G.device_name.display_cases) assert.equal(display(c.input), c.shown, JSON.stringify(c.input));
  for (const c of G.device_name.clash_cases) assert.equal(uniqueDefault(c.base, c.taken), c.name, JSON.stringify(c));
});

test('device_id', () => {
  for (const c of G.device_id.cases) assert.equal(deviceId(b64d(c.id)), c.device_id, c.name);
  assert.throws(() => deviceId(Buffer.alloc(29)));
});

test('oauth_nonce', () => {
  for (const c of G.oauth_nonce.cases) {
    const r = oauthNonce(c.purpose, b64d(c.sign_pub));
    assert.equal(r.k, c.k);
    assert.equal(r.nonce, c.nonce);
  }
});

test('cli_code', () => {
  for (const c of G.cli_code.cases) {
    const r = cliCode(b64d(G.cli_code.token_secret), b64d(c.account), b64d(c.sign_pub), c.p, c.window);
    assert.equal(r.k16, c.k16);
    assert.equal('https://pusharmor.com/auth/cli#' + c.p + r.k16, c.link);
    assert.equal(r.code, c.code);
    assert.equal(c.code.length, 34);
  }
});

test('my_push_sha256', () => {
  for (const c of G.my_push_sha256.cases) assert.equal(myPushSha256(c.push), c.my_push_sha256);
});

test('b64url', () => {
  for (const c of G.b64url.cases) {
    if (c.ok) assert.equal(hexe(b64d(c.input)), c.hex, JSON.stringify(c.input));
    else assert.throws(() => b64d(c.input), JSON.stringify(c.input));
  }
});

test('pairing', () => {
  const P = G.pairing;
  const n = peer(P.N);
  const x = peer(P.X);
  const rN = b64d(P.r_N);
  const rX = b64d(P.r_X);
  assert.equal(b64e(commitHash(n.signPub, n.encPub, rN)), P.c_N);
  const fph = fingerprintHash(n.signPub, n.encPub, x.signPub, x.encPub, rN, rX);
  assert.equal(b64e(fph), P.fingerprint_hash);
  assert.equal(crockford20(fph), P.fingerprint);
  assert.equal(b64e(pairingId(rN, rX)), P.pairing_id);
  assert.equal(P.pairing_id.length, 11);
  assert.equal(pairKey(n.idRaw, x.idRaw), P.pk);
  for (const c of P.fingerprint_cases) assert.equal(crockford20(b64d(c.hash)), c.fingerprint);
  for (const m of P.pair_messages) {
    const to = peer(m.to);
    const from = peer(m.from);
    assert.equal(m.message.length, 366);
    const pt = openWire(to.encPriv, Buffer.from('PA-PAIR1'), Buffer.from(to.id), b64d(m.message));
    assert.equal(b64e(pt), m.plaintext);
    const r = openPair(m.message, to.id, to.encPriv, to.account);
    assert.ok(r.ok, m.kind);
    assert.equal(r.kind, m.kind);
    assert.ok(r.fromId.equals(from.idRaw));
    if (m.kind === 'commit') assert.equal(b64e(r.cN), P.c_N);
    if (m.kind === 'reply') assert.equal(b64e(r.r), P.r_X);
    if (m.kind === 'open') assert.ok(openMatchesCommit(r, b64d(P.c_N)));
  }
});

test('pair_decide, pair_timeout, pair_hint', () => {
  for (const c of G.pair_decide.cases) assert.deepEqual(pairDecide(c.input), c.output, c.name);
  for (const c of G.pair_timeout.cases) assert.equal(pairTimeout(c.input), c.output, c.name);
  for (const c of G.pair_hint.cases) assert.equal(pairHint(c.input), c.output, c.name);
});

test('request_sig', () => {
  for (const c of G.request_sig.cases) {
    assert.equal(b64e(reqBytes(c.method, c.path, c.pa_time, b64d(c.body))), c.signed_bytes, c.name);
    assert.equal(b64d(c.body).toString('utf8'), c.body_text);
    assert.equal(c.sign_pub, G.keys.peers[c.signer].sign_pub);
    assert.ok(verifyRequest(b64d(c.sign_pub), c.method, c.path, c.pa_time, b64d(c.body), b64d(c.sig)), c.name);
  }
});

const pinOf = (p) => p && {
  [p.id]: { sign_pub: b64d(p.sign_pub), enc_pub: b64d(p.enc_pub), pairing_id: b64d(p.pairing_id), ruling: p.ruling },
};

test('name_entries', () => {
  for (const c of G.name_entries.cases) {
    const owner = peer(c.owner);
    const rec = peer(c.recipient);
    const signed = nameSignedBytes(owner.id, rec.id, c.pairing_id, c.n, c.name_b64);
    assert.equal(signed.toString('latin1'), c.signed_string);
    assert.equal(b64d(c.name_b64).toString('latin1'), c.name_text);
    assert.ok(verify(owner.signPub, signed, b64d(c.s)));
    assert.ok(c.ciphertext.length <= 1024);
    const pt = openWire(rec.encPriv, Buffer.from('PA-NAME1'), Buffer.from(rec.id), b64d(c.ciphertext));
    assert.equal(pt.toString('utf8'), c.entry_json);
    const r = openNameEntry(c.ciphertext, rec.id, rec.encPriv, owner.id, { sign_pub: owner.signPub, pairing_id: b64d(c.pairing_id) });
    assert.deepEqual(r, { ok: true, name: c.name_text, n: c.n }, c.name);
  }
});

function ctxFor(c) {
  const r = peer(c.receiver);
  return {
    own_id: r.id, own_enc_priv: r.encPriv, own_account: r.account, pins: pinOf(c.pin) || {}, window: c.window, history: c.history,
  };
}

function checkFullMessage(c) {
  const r = peer(c.receiver);
  const from = peer(c.from);
  const pt = openWire(r.encPriv, Buffer.from('PA-MSG1'), Buffer.from(r.id), b64d(c.message));
  assert.equal(b64e(pt), c.plaintext, c.name);
  assert.equal(b64e(msgSignedBytes(r.id, pt.subarray(64))), c.signed_bytes);
  assert.equal(b64e(pt.subarray(0, 64)), c.sig);
  assert.ok(verify(from.signPub, b64d(c.signed_bytes), b64d(c.sig)), c.name);
  assert.equal(inflateCapped(b64d(c.deflated)).toString('utf8'), c.json);
  assert.ok([512, 1024, 2048, 3800].includes(c.message.length));
  const got = receiveMessage(ctxFor(c), c.message);
  const value = got.value;
  assert.deepEqual({ outcome: got.outcome, type: got.type, n: got.n, value }, c.expect, c.name);
}

test('messages', () => {
  assert.deepEqual(G.messages.cases.map((c) => c.type).sort(),
    ['approve', 'delete', 'deny', 'login', 'logout', 'remove', 'rename', 'tel', 'text', 'url']);
  for (const c of G.messages.cases) {
    checkFullMessage(c);
    assert.equal(c.message.length, c.wire_chars);
    if (c.type === 'approve') assert.ok(c.message.length >= 1024);
  }
});

test('padded_messages', () => {
  assert.deepEqual(G.padded_messages.cases.map((c) => c.bucket), [512, 1024, 2048, 3800]);
  for (const c of G.padded_messages.cases) {
    checkFullMessage(c);
    assert.equal(c.message.length, c.bucket);
    assert.equal(bucketFor(wireChars(64 + c.unpadded_body_len + 81)), c.bucket);
  }
});

test('padding', () => {
  for (const c of G.padding.cases) {
    const chars = wireChars(c.plaintext_len + 81);
    assert.equal(chars, c.unpadded_chars);
    const b = bucketFor(chars);
    assert.equal(b, c.bucket);
    assert.equal(b === null ? null : plaintextLenFor(b), c.padded_plaintext_len);
  }
});

test('content_cap', () => {
  for (const c of G.content_cap.cases) {
    const n = Buffer.byteLength(c.input, 'utf8');
    assert.equal(n, c.utf8_bytes);
    assert.equal(n <= 2048, c.ok);
    const t = Buffer.from(c.truncated, 'utf8');
    assert.ok(t.length <= 2048 && Buffer.from(c.input, 'utf8').subarray(0, t.length).equals(t));
    assert.ok(c.ok ? c.truncated === c.input : 2048 - t.length < 4);
  }
});

test('inflate', () => {
  for (const c of G.inflate.cases) {
    let out = null;
    try { out = inflateCapped(b64d(c.deflated)); } catch { out = null; }
    assert.equal(out !== null, c.ok, c.name);
    if (out) {
      assert.equal(out.length, c.inflated_len);
      assert.equal(b64e(sha256(out)), c.inflated_sha256);
      if (c.inflated !== null) assert.equal(b64e(out), c.inflated);
    }
  }
});

test('replay_window', () => {
  for (const c of G.replay_window.cases) {
    const o = replayOutcome(c.state, c.n, c.type, c.history_row);
    assert.equal(o, c.outcome, c.name);
    assert.deepEqual(o === 'accept' ? windowAccept(c.state, c.n) : c.state, c.state_after, c.name);
  }
});

test('url_parse', () => {
  for (const c of G.url_parse.cases) {
    const { input, ...want } = c;
    assert.deepEqual(parseReceivedUrl(input), want, input);
  }
});

test('phone', () => {
  for (const c of G.phone.cases) assert.equal(isPhone(c.input), c.phone, JSON.stringify(c.input));
});

test('must_decode', () => {
  for (const c of G.must_decode.messages) {
    const got = receiveMessage(ctxFor(c), c.message);
    assert.deepEqual({ outcome: got.outcome, type: got.type, n: got.n, value: got.value }, c.expect, c.name);
  }
  for (const c of G.must_decode.name_entries) {
    const r = peer(c.receiver);
    const owner = peer(c.owner);
    assert.deepEqual(openNameEntry(c.ciphertext, r.id, r.encPriv, owner.id, pinOf(c.pin)[owner.id]), c.expect, c.name);
  }
});

function mustFailOutcome(c) {
  if (c.kind === 'message') return receiveMessage(ctxFor(c), c.message).outcome;
  if (c.kind === 'pair') {
    const r = peer(c.receiver);
    const p = openPair(c.message, r.id, r.encPriv, r.account);
    if (!p.ok || p.kind !== c.expected_kind) return 'unreadable';
    if (p.kind === 'open' && !openMatchesCommit(p, b64d(c.stored_c_N))) return 'unreadable';
    return 'accept';
  }
  if (c.kind === 'name_entry') {
    const r = peer(c.receiver);
    const owner = peer(c.owner);
    const pin = pinOf(c.pin)[owner.id];
    return openNameEntry(c.ciphertext, r.id, r.encPriv, owner.id, pin).ok ? 'accept' : 'unreadable';
  }
  if (c.kind === 'request') {
    return verifyRequest(b64d(c.sign_pub), c.method, c.path, c.pa_time, b64d(c.body), b64d(c.sig)) ? 'accept' : 'unreadable';
  }
  if (c.kind === 'peer_entry') {
    const r = peer(c.receiver);
    const id = b64d(c.id);
    const sp = b64d(c.sign_pub);
    const ep = b64d(c.enc_pub);
    const ok = isValidPub(sp) && isValidPub(ep) && !sp.equals(ep) && idMatches(id, r.account, sp, ep);
    return ok ? 'accept' : 'unreadable';
  }
  throw new Error('unknown kind ' + c.kind);
}

test('must_fail', () => {
  const names = new Set();
  for (const c of G.must_fail.cases) {
    assert.ok(!names.has(c.name), 'duplicate name ' + c.name);
    names.add(c.name);
    assert.ok(c.outcome === 'invalid' || c.outcome === 'unreadable');
    assert.equal(mustFailOutcome(c), c.outcome, c.name);
  }
});

test('rfc9180', () => {
  const v = G.rfc9180;
  const h = hexd;
  assert.deepEqual([v.mode, v.kem_id, v.kdf_id, v.aead_id], [0, 16, 1, 2]);
  assert.equal(hexe(deriveKeyPair(h(v.ikmR)).sk), v.skRm);
  assert.equal(hexe(deriveKeyPair(h(v.ikmR)).pk), v.pkRm);
  const e = v.encryptions[0];
  assert.equal(e.nonce, v.base_nonce);
  const s = sealBase({ pkR: h(v.pkRm), info: h(v.info), aad: h(e.aad), pt: h(e.pt), ikmE: h(v.ikmE), aead: AEAD_AES_256_GCM });
  assert.equal(hexe(s.skE), v.skEm);
  for (const k of ['enc', 'shared_secret', 'key_schedule_context', 'secret', 'key', 'base_nonce', 'exporter_secret']) {
    assert.equal(hexe(s[k]), v[k], k);
  }
  assert.equal(hexe(s.ct), e.ct);
  assert.equal(hexe(openBase({ skR: h(v.skRm), enc: h(v.enc), info: h(v.info), aad: h(e.aad), ct: h(e.ct) })), e.pt);
});

test('rfc8291', () => {
  const v = G.rfc8291;
  const r = wpEncrypt({
    plaintext: b64d(v.plaintext), asPrivate: b64d(v.as_private), uaPublic: b64d(v.ua_public), authSecret: b64d(v.auth_secret),
    salt: b64d(v.salt), rs: v.record_size,
  });
  for (const k of ['ecdh_secret', 'prk_key', 'key_info', 'ikm', 'prk', 'cek_info', 'cek', 'nonce_info', 'nonce', 'header',
    'padded_plaintext', 'ciphertext', 'body']) {
    assert.equal(b64e(r[k]), v[k], k);
  }
  assert.equal(b64e(pubFromPriv(b64d(v.as_private))), v.as_public);
  assert.equal(b64e(wpDecrypt({ body: b64d(v.body), uaPrivate: b64d(v.ua_private), authSecret: b64d(v.auth_secret) })), v.plaintext);
});

// ---------------------------------------------------------------- file-v1.json
const FRAW = readFileSync(new URL('../file-v1.json', import.meta.url));
const F = JSON.parse(FRAW.toString('utf8'));

test('file-v1: ASCII, version 1, stable and reproducible', () => {
  assert.ok(FRAW.every((b) => b < 0x80), 'non-ASCII byte in file-v1.json');
  assert.equal(F.version, 1);
  assert.equal(FRAW.toString('utf8'), stableJson(F), 'not in stable sorted form');
  assert.equal(FRAW.toString('utf8'), stableJson(buildFile()), 'generator output differs from the committed file');
  for (const [k, v] of Object.entries(F)) if (v && typeof v === 'object') assert.equal(typeof v.description, 'string', k);
  assert.equal(F.constants.MAX_FILE, MAX_FILE);
  assert.equal(F.constants.BLOB_OVERHEAD, BLOB_OVERHEAD);
  assert.equal(F.ttl.worker_only, true);
  assert.equal(F.key.worker_only, true);
});

test('file-v1: file_sig', () => {
  for (const c of F.file_sig.cases) {
    const bytes = c.method === 'POST'
      ? filePostBytes(c.pa_time, c.content_length, c.file_sha256, c.send_id)
      : fileDeleteBytes(c.id, c.pa_time);
    assert.equal(b64e(bytes), c.signed_bytes, c.name);
    assert.equal(bytes.toString('utf8'), c.signed_text, c.name);
    assert.ok(!c.signed_text.endsWith('\n'), c.name);
    assert.equal(c.sign_pub, G.keys.peers[c.signer].sign_pub);
    assert.equal(typeof c.verifies, 'boolean', c.name);
    assert.equal(verifyFile(b64d(c.sign_pub), bytes, b64d(c.sig)), c.verifies, c.name);
    if (c.method === 'POST') {
      assert.match(c.send_id, /^[A-Za-z0-9_-]{22}$/);
      assert.equal(b64d(c.send_id).length, 16);
    } else {
      assert.equal(c.path, '/v1/file/' + c.id);
    }
  }
});

test('file-v1: download_sig', () => {
  const X = G.keys.peers.X;
  assert.equal(F.download_sig.cases.length, 3);
  for (const c of F.download_sig.cases) {
    const bytes = downloadBytes(c.path, c.pa_time);
    assert.equal(b64e(bytes), c.signed_bytes, c.name);
    assert.equal(bytes.toString('utf8'), c.signed_text, c.name);
    assert.ok(!c.signed_text.endsWith('\n'), c.name);
    assert.equal(c.method, 'GET');
    assert.equal(c.path, new URL(c.url).pathname, c.name);
    assert.match(c.path, /^\/v1\/[0-9]{12}\/[0-9a-f]{16}\/[0-9]{12}-[0-9a-f]{32}$/);
    assert.equal(c.path.split('/')[3], acctHash(b64d(F.key.acct_secret), b64d(X.id).subarray(0, 9)), c.name);
    assert.equal(c.sign_pub, X.sign_pub);
    assert.equal(c.enc_pub, X.enc_pub);
    assert.deepEqual(Object.keys(c.headers).sort(), ['PA-Enc-Pub', 'PA-ID', 'PA-Sig', 'PA-Sign-Pub', 'PA-Time']);
    assert.equal(c.headers['PA-ID'], X.id);
    assert.equal(c.headers['PA-Time'], c.pa_time);
    assert.equal(c.headers['PA-Sign-Pub'], c.sign_pub);
    assert.equal(c.headers['PA-Enc-Pub'], c.enc_pub);
    assert.equal(c.headers['PA-Sig'], c.sig);
    assert.equal(c.sign_pub.length, 87);
    assert.equal(c.enc_pub.length, 87);
    assert.equal(c.sig.length, 86);
    assert.equal(typeof c.verifies, 'boolean', c.name);
    assert.equal(verifyFile(b64d(c.sign_pub), bytes, b64d(c.sig)), c.verifies, c.name);
  }
});

test('file-v1: blob and sha256', () => {
  for (const c of F.blob.cases) {
    const key = b64d(c.key);
    const pt = b64d(c.plaintext);
    assert.equal(c.key.length, 43);
    const blob = sealBlob(key, b64d(c.nonce), pt);
    assert.equal(b64e(blob), c.blob, c.name);
    assert.equal(blob.length, c.size + BLOB_OVERHEAD);
    assert.equal(c.blob_size, blob.length);
    assert.equal(b64e(openBlob(key, blob)), c.plaintext);
    assert.equal(b64e(sha256(blob)), c.sha256);
    assert.equal(c.sha256.length, 43);
    for (const i of [0, 12, blob.length - 1]) {
      const bad = Buffer.from(blob);
      bad[i] ^= 1;
      assert.throws(() => openBlob(key, bad), c.name + ' flip ' + i);
    }
  }
  for (const c of F.sha256.cases) assert.equal(b64e(sha256(b64d(c.input))), c.sha256, c.name);
});

test('file-v1: upload_request', () => {
  const u = F.upload_request;
  const body = b64d(u.body);
  const h = u.headers;
  assert.equal(h['Content-Length'], String(body.length));
  assert.equal(h['PA-File-SHA256'], b64e(sha256(body)));
  assert.equal(h['PA-ID'], G.keys.peers[u.signer].id);
  assert.equal(u.sign_pub, G.keys.peers[u.signer].sign_pub);
  assert.match(h['PA-Time'], /^[1-9][0-9]{12}$/);
  const bytes = filePostBytes(h['PA-Time'], body.length, h['PA-File-SHA256'], h['PA-Send-ID']);
  assert.equal(b64e(bytes), u.signed_bytes);
  assert.ok(verifyFile(b64d(u.sign_pub), bytes, b64d(h['PA-Sig'])));
  assert.equal(b64e(openBlob(b64d(u.key), body)), u.plaintext);
});

test('file-v1: ttl (Worker only)', () => {
  for (const c of F.ttl.cases) {
    if (c.content_length < BLOB_OVERHEAD) {
      assert.equal(c.size, null, c.name);
      assert.equal(c.ttl_min, null, c.name);
      assert.equal(c.status, 400, c.name);
      continue;
    }
    assert.equal(c.content_length, c.size + BLOB_OVERHEAD, c.name);
    assert.equal(ttlMinutes(c.size), c.ttl_min, c.name);
    assert.equal(c.status, c.content_length > MAX_FILE + BLOB_OVERHEAD ? 413 : 201, c.name);
  }
  assert.ok(F.ttl.cases.some((c) => c.status === 400), 'a Content-Length < 28 row');
});

test('file-v1: key (Worker only)', () => {
  const secret = b64d(F.key.acct_secret);
  const minutes = new Set();
  for (const c of F.key.cases) {
    const r = fileKey({ acceptTime: c.accept_time, size: c.size, secret, account: b64d(c.account), randHex: c.rand_hex });
    for (const k of ['expires', 'minute', 'id', 'key', 'url']) assert.equal(r[k], c[k], c.name + ' ' + k);
    assert.equal(acctHash(secret, b64d(c.account)), c.acct_hash);
    assert.match(c.key, /^v1\/([0-9]{12})\/[0-9a-f]{16}\/\1-[0-9a-f]{32}$/);
    minutes.add(c.minute);
  }
  assert.ok(minutes.has('202612312359') && minutes.has('202701010000'), 'year rollover');
});

test('file-v1: names', () => {
  assert.ok(F.names.cases.length >= 40 && F.names.cases.length <= 70);
  for (const c of F.names.cases) {
    assert.equal(sanitizeName(c.input, F.names.time, c.image), c.output, JSON.stringify(c.input));
    assert.match(c.output, /^[A-Za-z0-9 ._()-]{1,100}$/);
  }
  assert.equal(sanitizeName('CON .txt', 0, false), '_CON .txt');
});

test('file-v1: collision', () => {
  for (const c of F.collision.cases) assert.equal(collisionName(c.input, c.existing, c.mode), c.output, c.name + ' ' + c.mode);
  assert.equal(collisionName('Photo.jpg', ['photo.jpg'], 'ignore_case'), 'Photo (1).jpg');
  assert.equal(collisionName('Photo.jpg', ['photo.jpg'], 'exact'), 'Photo.jpg');
  assert.equal(collisionName('Photo.jpg', ['Photo.jpg', 'PHOTO (1).jpg'], 'exact'), 'Photo (1).jpg');
  for (const mode of ['ignore_case', 'exact']) assert.ok(F.collision.cases.some((c) => c.mode === mode), mode);
});

test('file-v1: auto_download', () => {
  for (const c of F.auto_download.cases) assert.equal(autoDownload(c), c.download, JSON.stringify(c));
});
