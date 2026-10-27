// Runs every section of tests/vectors/golden-v1.json through the production
// modules (CI doc section 3, webext leg).
import assert from "node:assert/strict";
import { createECDH, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CipherSuite, Aes256Gcm, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";
import { b64urlDecode, b64urlEncode, b64urlTryDecode } from "../src/crypto/b64url.ts";
import { ascii, buf, concat, hex, unhex } from "../src/crypto/bytes.ts";
import { sha256 } from "../src/crypto/hash.ts";
import { hpkeOpen } from "../src/crypto/hpke.ts";
import { importPrivate, verify } from "../src/crypto/keys.ts";
import {
  type AnyPush,
  commitHash,
  crockford,
  emailHash,
  fingerprintHash,
  idMatchesKeys,
  keyhash,
  normalizeEmail,
  oauthK,
  oauthNonce,
  pairingFingerprint,
  pairingId,
  pairingKey,
  pushHash,
  validPeerEntry,
} from "../src/crypto/labels.ts";
import { reqSignedBytes } from "../src/crypto/pasig.ts";
import { rfc8291Decrypt, rfc8291Derive, rfc8291Ecdh } from "../src/crypto/rfc8291.ts";
import { inflateRaw } from "../src/model/deflate.ts";
import { autoOpenAllowed, isPhone, parseHttpUrl } from "../src/model/detect.ts";
import { parseStrictJson } from "../src/model/json.ts";
import {
  type NameEntry,
  type PairKind,
  encodePair,
  inflateInner,
  msgSignedBytes,
  nameSignedString,
  openInner,
  openNameEntry,
  openPair,
  pairAcceptable,
  pairPlain,
  parseInnerPlain,
  sealNameEntry,
  verifyInner,
  verifyNameEntry,
} from "../src/model/message.ts";
import { CONTENT_CAP, INFLATE_CAP, paddedWireBytes, truncateUtf8, utf8Len, wireChars } from "../src/model/padding.ts";
import { type PairDecision, type PairState, idLower, pairDecide, pairHint, pairTimeout } from "../src/model/pairdecide.ts";
import { type Pin, receiveDecide } from "../src/model/receive.ts";
import { replayClassify, replayFromSeen, replayRecord, replaySeen } from "../src/model/replay.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const G: Any = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "tests", "vectors", "golden-v1.json"), "utf8"));
const d = b64urlDecode;
const P: Record<string, Any> = G.keys.peers;
const peerOf = (name: string) => P[name];

async function encPair(name: string): Promise<CryptoKeyPair> {
  const p = peerOf(name);
  return importPrivate("ECDH", d(p.enc_priv), d(p.enc_pub));
}

function hmac(key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("sha256", key).update(data).digest());
}

test("golden: version", () => assert.equal(G.version, 1));

test("golden: keys", async () => {
  const secret = d(G.keys.id_secret);
  for (const [name, p] of Object.entries(P) as [string, Any][]) {
    for (const [priv, pub] of [["sign_priv", "sign_pub"], ["enc_priv", "enc_pub"]]) {
      const e = createECDH("prime256v1");
      e.setPrivateKey(Buffer.from(d(p[priv])));
      assert.equal(b64urlEncode(new Uint8Array(e.getPublicKey())), p[pub], name + " " + pub);
    }
    const norm = normalizeEmail(p.email)!;
    const account = hmac(secret, await emailHash(norm)).subarray(0, 9);
    assert.equal(b64urlEncode(account), p.account, name);
    const kh = await keyhash(d(p.sign_pub), d(p.enc_pub));
    assert.equal(b64urlEncode(kh), p.keyhash, name);
    const id = concat(account, kh, hmac(secret, concat(account, kh)).subarray(0, 9));
    assert.equal(b64urlEncode(id), p.id, name);
    assert.equal(await idMatchesKeys(d(p.id), d(p.sign_pub), d(p.enc_pub), account), name !== "S", name);
  }
});

test("golden: email_hash", async () => {
  const secret = d(G.keys.id_secret);
  for (const c of G.email_hash.cases) {
    const n = normalizeEmail(c.input);
    assert.equal(n, c.normalized, JSON.stringify(c.input));
    if (n === null) continue;
    const h = await emailHash(n);
    assert.equal(b64urlEncode(h), c.email_hash);
    assert.equal(b64urlEncode(hmac(secret, h).subarray(0, 9)), c.account);
  }
});

test("golden: id_order", () => {
  for (const c of G.id_order.cases) {
    const a = d(c.a);
    const b = d(c.b);
    assert.equal(idLower(a, b) ? "a" : "b", c.lower, c.name);
  }
});

test("golden: oauth_nonce", async () => {
  for (const c of G.oauth_nonce.cases) {
    assert.equal(await oauthK(d(c.sign_pub)), c.k);
    assert.equal(await oauthNonce(c.purpose, d(c.sign_pub)), c.nonce);
  }
});

test("golden: my_push_sha256", async () => {
  for (const c of G.my_push_sha256.cases) assert.equal(await pushHash(c.push as AnyPush), c.my_push_sha256, c.push.type);
});

test("golden: b64url", () => {
  for (const c of G.b64url.cases) {
    const r = b64urlTryDecode(c.input);
    if (c.ok) assert.equal(r === null ? null : hex(r), c.hex, JSON.stringify(c.input));
    else assert.equal(r, null, JSON.stringify(c.input));
  }
});

test("golden: pairing", async () => {
  const g = G.pairing;
  const N = peerOf(g.N);
  const X = peerOf(g.X);
  const rN = d(g.r_N);
  const rX = d(g.r_X);
  assert.equal(b64urlEncode(await commitHash(d(N.sign_pub), d(N.enc_pub), rN)), g.c_N);
  assert.equal(b64urlEncode(await fingerprintHash(d(N.sign_pub), d(N.enc_pub), d(X.sign_pub), d(X.enc_pub), rN, rX)), g.fingerprint_hash);
  assert.equal(await pairingFingerprint(d(N.sign_pub), d(N.enc_pub), d(X.sign_pub), d(X.enc_pub), rN, rX), g.fingerprint);
  assert.equal(b64urlEncode(await pairingId(rN, rX)), g.pairing_id);
  assert.equal(await pairingKey(d(N.id), d(X.id)), g.pk);
  for (const c of g.fingerprint_cases) assert.equal(crockford(d(c.hash), 4), c.fingerprint);
  for (const m of g.pair_messages) {
    const to = peerOf(m.to);
    const from = peerOf(m.from);
    const msg = await openPair(await encPair(m.to), to.id, m.message);
    assert.ok(msg, m.kind);
    assert.equal(b64urlEncode(pairPlain(msg.fromId, msg.body)), m.plaintext);
    assert.equal(msg.body.kind, m.kind);
    assert.equal(b64urlEncode(msg.fromId), from.id);
    assert.ok(await pairAcceptable(msg, d(to.account), m.kind as PairKind, m.kind === "open" ? d(g.c_N) : undefined));
    // deterministic seal with the given ikmE reproduces the message
    assert.equal(await encodePair(msg.fromId, msg.body, to.id, d(to.enc_pub), d(m.hpke.ikmE)), m.message);
  }
});

function adaptDecision(dec: PairDecision): Any {
  switch (dec.action) {
    case "reply":
      return dec.rule === "e"
        ? { action: "reply", notice: "commit", entry: "created_replied", cap_counted: true }
        : { action: "reply", notice: "commit", entry: "n_wiped_x_replied", cap_counted: false };
    case "resend":
      return { action: "reply", notice: "represent", entry: "unchanged", cap_counted: false };
    case "prompt":
      return { action: "prompt", notice: "commit", entry: "created_prompted", cap_counted: false };
    case "abort":
      return { action: "abort", notice: "could_not_read", entry: "aborted", cap_counted: false };
    case "notice":
      if (dec.notice === "half") return { action: "drop", notice: "half_state", entry: "unchanged", cap_counted: false };
      if (dec.notice === "crossing") return { action: "drop", notice: "crossing", entry: "unchanged", cap_counted: false };
      return { action: "notice", notice: "represent", entry: "unchanged", cap_counted: false };
    case "drop":
      return { action: "drop", notice: "could_not_read", entry: dec.rule === "e" ? "none" : "unchanged", cap_counted: false };
    case "fetch":
      return { action: "fetch" };
  }
}

test("golden: pair_decide", () => {
  for (const c of G.pair_decide.cases) {
    const i = c.input;
    const dec = pairDecide({
      myId: d(i.own_id),
      fromId: d(i.from_id),
      c_N: d(i.commit_c_N),
      entry: i.entry
        ? { role: i.entry.role, state: i.entry.state as PairState, c_N: i.entry.c_N ? d(i.entry.c_N) : undefined, authorized: !!i.entry.reply_authorized }
        : null,
      pinned: i.pinned,
      approved: i.approved,
      approveVerified: i.approve_verified,
      lastGetApprovesMe: i.get_after_verify ? i.approves_me : null,
      inLastList: i.listed !== "no",
      fetched: i.listed !== "yes",
      openEntries: i.open_entries,
      capTimestamps: i.cap.map((t: number) => t * 1000),
      now: i.now * 1000,
    });
    assert.deepEqual(adaptDecision(dec), c.output, c.name);
  }
});

test("golden: pair_timeout and pair_hint", () => {
  for (const c of G.pair_timeout.cases) assert.equal(pairTimeout(c.input.approve_verified, c.input.approved, c.input.resend), c.output, c.name);
  for (const c of G.pair_hint.cases) assert.equal(pairHint(c.input.approves_me, c.input.committed_s * 1000), c.output, c.name);
});

test("golden: request_sig", async () => {
  for (const c of G.request_sig.cases) {
    const body = d(c.body);
    assert.equal(new TextDecoder().decode(body), c.body_text);
    const bytes = reqSignedBytes(c.method, c.path, c.pa_time, body);
    assert.equal(b64urlEncode(bytes), c.signed_bytes, c.name);
    assert.ok(await verify(d(c.sign_pub), d(c.sig), bytes), c.name);
  }
});

test("golden: name_entries", async () => {
  for (const c of G.name_entries.cases) {
    const owner = peerOf(c.owner);
    const rec = peerOf(c.recipient);
    const ss = nameSignedString(owner.id, rec.id, d(c.pairing_id), c.n, c.name_b64);
    assert.equal(new TextDecoder().decode(ss), c.signed_string);
    const e = await openNameEntry(await encPair(c.recipient), rec.id, c.ciphertext);
    assert.ok(e, c.name);
    assert.deepEqual(e, parseStrictJsonEntry(c.entry_json));
    assert.equal(await verifyNameEntry(d(owner.sign_pub), owner.id, rec.id, d(c.pairing_id), e), c.name_text);
    assert.equal(await sealNameEntry(e, rec.id, d(rec.enc_pub), d(c.hpke.ikmE)), c.ciphertext);
  }
});

function parseStrictJsonEntry(s: string): NameEntry {
  const v = parseStrictJson(s) as Any;
  return { name: v.name, n: Number(v.n.raw), s: v.s };
}

function pinFor(c: Any): Pin | null {
  if (!c.pin) return null;
  return {
    id: c.pin.id,
    sign_pub: d(c.pin.sign_pub),
    enc_pub: d(c.pin.enc_pub),
    pairing_id: d(c.pin.pairing_id),
    ruling: c.pin.ruling,
  };
}

async function runPipeline(c: Any) {
  const rec = peerOf(c.receiver);
  const pin = pinFor(c);
  return receiveDecide({
    enc: await encPair(c.receiver),
    id: rec.id,
    m: c.message,
    pin: async (from) => (pin && pin.id === from ? pin : null),
    window: async () => (pin ? replayFromSeen(pin.pairing_id, c.window.h, c.window.seen) : null),
    hasHistory: async (_f, _p, n) => (c.history as number[]).includes(n),
  });
}

function valueOf(r: Any): Any {
  const c = r.content;
  switch (c.type) {
    case "url":
    case "text":
    case "tel":
      return c.value;
    case "approve":
    case "rename":
      return { n: c.entry.n, name: r.name };
    case "remove":
      return c.id;
    default:
      return 1;
  }
}

for (const section of ["messages", "padded_messages"]) {
  describe("golden: " + section, () => {
    for (const c of G[section].cases) {
      test(c.name, async () => {
        const rec = peerOf(c.receiver);
        const sender = peerOf(c.from);
        const enc = await encPair(c.receiver);
        const pt = await openInner(enc, rec.id, c.message);
        assert.ok(pt);
        assert.equal(b64urlEncode(pt), c.plaintext);
        const p = parseInnerPlain(pt)!;
        assert.ok(p);
        assert.equal(b64urlEncode(p.sig), c.sig);
        assert.equal(b64urlEncode(msgSignedBytes(rec.id, p.body)), c.signed_bytes);
        assert.ok(await verifyInner(d(sender.sign_pub), rec.id, p));
        assert.equal(b64urlEncode(p.deflated), c.deflated);
        const inflated = await inflateInner(p);
        assert.equal(new TextDecoder().decode(inflated!), c.json);
        if (c.wire_chars !== undefined) assert.equal(c.message.length, c.wire_chars);
        if (section === "padded_messages") assert.equal(c.message.length, Number(c.name.replace("bucket_", "")));
        const r = await runPipeline(c);
        assert.equal(r.outcome, c.expect.outcome);
        if (r.outcome !== "unreadable") {
          assert.equal(r.n, c.expect.n);
          assert.equal(r.content.type, c.expect.type);
          assert.deepEqual(valueOf(r), c.expect.value);
        }
        // the HPKE layer alone opens with the receiver key
        assert.ok(await hpkeOpen(enc, ascii("PA-MSG1"), ascii(rec.id), d(c.message)));
      });
    }
  });
}

test("golden: padding", () => {
  for (const c of G.padding.cases) {
    const total = c.plaintext_len + 81;
    assert.equal(wireChars(total), c.unpadded_chars);
    const target = paddedWireBytes(total, false);
    if (c.bucket === null) {
      assert.equal(target, null);
      continue;
    }
    assert.equal(wireChars(target!), c.bucket);
    assert.equal(target! - 81, c.padded_plaintext_len);
  }
});

test("golden: content_cap", () => {
  for (const c of G.content_cap.cases) {
    assert.equal(utf8Len(c.input), c.utf8_bytes);
    assert.equal(utf8Len(c.input) <= CONTENT_CAP, c.ok);
    assert.equal(truncateUtf8(c.input), c.truncated);
  }
});

test("golden: inflate", async () => {
  for (const c of G.inflate.cases) {
    const out = await inflateRaw(d(c.deflated), INFLATE_CAP);
    assert.equal(out !== null, c.ok, c.name);
    if (!out) continue;
    assert.equal(out.length, c.inflated_len);
    assert.equal(b64urlEncode(await sha256(out)), c.inflated_sha256);
    if (c.inflated != null) assert.equal(b64urlEncode(out), c.inflated);
  }
});

test("golden: replay_window", () => {
  for (const c of G.replay_window.cases) {
    const s = replayFromSeen(new Uint8Array(8), c.state.h, c.state.seen);
    const out = replayClassify(s, c.n, c.type, c.history_row);
    assert.equal(out, c.outcome, c.name);
    const after = out === "accept" ? replayRecord(s, c.n) : s;
    assert.equal(after.h, c.state_after.h, c.name);
    assert.deepEqual(replaySeen(after), c.state_after.seen, c.name);
  }
});

test("golden: url_parse", () => {
  for (const c of G.url_parse.cases) {
    const u = parseHttpUrl(c.input);
    assert.equal(u !== null, c.url, c.input);
    if (!u) continue;
    assert.equal(u.href, c.href);
    assert.equal(u.hostname, c.host);
    assert.equal(autoOpenAllowed(u), c.auto_open, c.input);
  }
});

test("golden: phone", () => {
  for (const c of G.phone.cases) assert.equal(isPhone(c.input), c.phone, JSON.stringify(c.input));
});

describe("golden: must_fail", () => {
  for (const c of G.must_fail.cases) {
    test(c.kind + " " + c.name, async () => {
      if (c.kind === "message") {
        const r = await runPipeline(c);
        const outcome = r.outcome === "unreadable" ? "unreadable" : r.outcome === "invalid" ? "invalid" : "accepted:" + r.outcome;
        assert.equal(outcome, c.outcome);
      } else if (c.kind === "pair") {
        const rec = peerOf(c.receiver);
        const msg = await openPair(await encPair(c.receiver), rec.id, c.message);
        const ok = msg !== null && (await pairAcceptable(msg, d(rec.account), c.expected_kind, c.stored_c_N ? d(c.stored_c_N) : undefined));
        assert.equal(ok, false);
        assert.equal(c.outcome, "unreadable");
      } else if (c.kind === "name_entry") {
        const rec = peerOf(c.receiver);
        const owner = peerOf(c.owner);
        const e = await openNameEntry(await encPair(c.receiver), rec.id, c.ciphertext);
        const name = e ? await verifyNameEntry(d(owner.sign_pub), owner.id, rec.id, d(c.pin.pairing_id), e) : null;
        assert.equal(name, null);
        assert.equal(c.outcome, "unreadable");
      } else if (c.kind === "request") {
        let ok = false;
        try {
          ok = await verify(d(c.sign_pub), d(c.sig), reqSignedBytes(c.method, c.path, c.pa_time, d(c.body)));
        } catch {
          ok = false;
        }
        assert.equal(ok, false);
      } else if (c.kind === "peer_entry") {
        const rec = peerOf(c.receiver);
        const id = b64urlTryDecode(c.id);
        const sp = b64urlTryDecode(c.sign_pub);
        const ep = b64urlTryDecode(c.enc_pub);
        const ok = !!id && !!sp && !!ep && (await validPeerEntry(id, sp, ep, d(rec.account)));
        assert.equal(ok, false);
      } else assert.fail("unknown kind " + c.kind);
    });
  }
});

test("golden: rfc9180 (P-256, HKDF-SHA256, AES-256-GCM)", async () => {
  const r = G.rfc9180;
  assert.deepEqual([r.kem_id, r.kdf_id, r.aead_id, r.mode], [16, 1, 2, 0]);
  const kem = new DhkemP256HkdfSha256();
  for (const [ikm, sk, pk] of [[r.ikmE, r.skEm, r.pkEm], [r.ikmR, r.skRm, r.pkRm]]) {
    const kp = await kem.deriveKeyPair(buf(unhex(ikm)).buffer);
    assert.equal(hex(new Uint8Array(await kem.serializePrivateKey(kp.privateKey))), sk);
    assert.equal(hex(new Uint8Array(await kem.serializePublicKey(kp.publicKey))), pk);
  }
  const suite = new CipherSuite({ kem, kdf: new HkdfSha256(), aead: new Aes256Gcm() });
  const pkR = await crypto.subtle.importKey("raw", buf(unhex(r.pkRm)), { name: "ECDH", namedCurve: "P-256" }, true, []);
  const sender = await suite.createSenderContext({ recipientPublicKey: pkR, info: buf(unhex(r.info)).buffer, ekm: buf(unhex(r.ikmE)).buffer });
  assert.equal(hex(new Uint8Array(sender.enc)), r.enc);
  const e0 = r.encryptions[0];
  assert.equal(hex(new Uint8Array(await sender.seal(buf(unhex(e0.pt)).buffer, buf(unhex(e0.aad)).buffer))), e0.ct);
  // open through the production code path with a non-extractable recipient key
  const recip = await importPrivate("ECDH", unhex(r.skRm), unhex(r.pkRm));
  const wire = concat(unhex(r.enc), unhex(e0.ct));
  assert.equal(hex((await hpkeOpen(recip, unhex(r.info), unhex(e0.aad), wire))!), e0.pt);
  // exporter_secret and the other key schedule values are internal to @hpke/core;
  // the byte-equal enc and ct above depend on all of them.
  assert.equal(typeof r.exporter_secret, "string");
});

test("golden: rfc8291", async () => {
  const r = G.rfc8291;
  const uaPub = d(r.ua_public);
  const asPub = d(r.as_public);
  const ua = await importPrivate("ECDH", d(r.ua_private), uaPub);
  const ecdh = await rfc8291Ecdh(ua.privateKey, asPub);
  assert.equal(b64urlEncode(ecdh), r.ecdh_secret);
  const k = await rfc8291Derive(ecdh, d(r.auth_secret), uaPub, asPub, d(r.salt));
  assert.equal(b64urlEncode(k.prk_key), r.prk_key);
  assert.equal(b64urlEncode(k.key_info), r.key_info);
  assert.equal(b64urlEncode(k.ikm), r.ikm);
  assert.equal(b64urlEncode(k.prk), r.prk);
  assert.equal(b64urlEncode(k.cek), r.cek);
  assert.equal(b64urlEncode(k.nonce), r.nonce);
  assert.equal(b64urlEncode(concat(ascii("Content-Encoding: aes128gcm"), new Uint8Array([0]))), r.cek_info);
  assert.equal(b64urlEncode(concat(ascii("Content-Encoding: nonce"), new Uint8Array([0]))), r.nonce_info);
  const body = d(r.body);
  assert.equal(b64urlEncode(body.subarray(0, 86)), r.header);
  assert.equal(b64urlEncode(body.subarray(86)), r.ciphertext);
  assert.equal(r.record_size, 4096);
  const pt = await rfc8291Decrypt(ua.privateKey, uaPub, d(r.auth_secret), body);
  assert.equal(b64urlEncode(pt), r.plaintext);
  assert.equal(b64urlEncode(concat(pt, new Uint8Array([2]))), r.padded_plaintext);
  // the RFC example key from the as_private side gives the same ECDH secret
  const as = await importPrivate("ECDH", d(r.as_private), asPub);
  assert.equal(b64urlEncode(await rfc8291Ecdh(as.privateKey, uaPub)), r.ecdh_secret);
});
