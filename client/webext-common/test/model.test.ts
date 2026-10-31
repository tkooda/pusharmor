import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { test } from "node:test";
import { b64urlDecode, b64urlEncode } from "../src/crypto/b64url.ts";
import { ascii, concat, utf8 } from "../src/crypto/bytes.ts";
import { hpkeSeal } from "../src/crypto/hpke.ts";
import { generateKeySet, sign } from "../src/crypto/keys.ts";
import { formatCountdown } from "../src/model/countdown.ts";
import { inflateRaw } from "../src/model/deflate.ts";
import { autoOpenAllowed, detectType, isPhone, parseHttpUrl } from "../src/model/detect.ts";
import { JNum, counterN, parseStrictJson } from "../src/model/json.ts";
import {
  INFO_MSG,
  buildJson,
  encodeInner,
  encodePair,
  inflateInner,
  makeNameEntry,
  nameSignedString,
  msgSignedBytes,
  openInner,
  openNameEntry,
  openPair,
  parseInnerJson,
  parseInnerPlain,
  sealNameEntry,
  verifyInner,
  verifyNameEntry,
} from "../src/model/message.ts";
import { paddedWireBytes } from "../src/model/padding.ts";
import { type PairDecideInput, capCount, idLower, pairDecide } from "../src/model/pairdecide.ts";
import { freshReplay, replayCheck, replayRecord } from "../src/model/replay.ts";

const ID_A = b64urlEncode(new Uint8Array(30).fill(1));
const ID_B = b64urlEncode(new Uint8Array(30).fill(2));

test("strict JSON: duplicate keys and raw n token", () => {
  assert.throws(() => parseStrictJson('{"n":1,"n":2}'));
  assert.throws(() => parseStrictJson('{"a":{"x":1,"x":1}}'));
  assert.throws(() => parseStrictJson('{"n":1} x'));
  const v = parseStrictJson('{"n":1.0,"m":1e0,"k":42}') as Record<string, JNum>;
  assert.equal(counterN(v.n), null);
  assert.equal(counterN(v.m), null);
  assert.equal(counterN(v.k), 42);
  assert.equal(counterN(new JNum("0")), null);
  assert.equal(counterN(new JNum("-1")), null);
  assert.equal(counterN(new JNum("01")), null);
  assert.equal(counterN(new JNum("9007199254740991")), 9007199254740991);
  assert.equal(counterN(new JNum("9007199254740992")), null);
});

test("inner JSON parse rules", () => {
  const p = (s: string) => parseInnerJson(utf8(s));
  assert.deepEqual(p('{"n":42,"url":"https://example.com/a"}'), { n: 42, content: { type: "url", value: "https://example.com/a" } });
  assert.equal(p('{"n":1.0,"text":"a"}'), null);
  assert.equal(p('{"n":1e0,"text":"a"}'), null);
  assert.equal(p('{"n":1,"text":"a","text":"b"}'), null);
  assert.equal(p('{"n":0,"text":"a"}'), null);
  assert.equal(p('{"n":1}'), null);
  assert.deepEqual(p('{"n":1,"text":"a","url":"b"}'), { n: 1, content: { type: "url", value: "b" } });
  assert.deepEqual(p('{"n":1,"text":"a","x":1}'), { n: 1, content: { type: "text", value: "a" } });
  assert.equal(p('{"n":1,"foo":"a"}'), null);
  assert.equal(p('{"n":1,"deny":2}'), null);
  assert.deepEqual(p('{"n":1,"deny":1}'), { n: 1, content: { type: "deny" } });
  assert.equal(p('{"n":1,"text":"' + "a".repeat(2049) + '"}'), null);
  assert.ok(p('{"n":1,"text":"' + "a".repeat(2048) + '"}'));
  assert.equal(p('{"n":1,"remove":"short"}'), null);
  assert.deepEqual(p('{"n":3,"remove":"' + ID_A + '"}'), { n: 3, content: { type: "remove", id: ID_A } });
  for (const c of [
    { type: "url" as const, value: "https://x" },
    { type: "text" as const, value: "a\"b\\c\n" },
    { type: "tel" as const, value: "+1 555-123-4567" },
    { type: "logout" as const },
    { type: "login" as const },
    { type: "delete" as const },
  ]) {
    assert.deepEqual(p(buildJson(7, c)), { n: 7, content: c });
  }
  assert.equal(buildJson(42, { type: "url", value: "https://example.com/a" }), '{"n":42,"url":"https://example.com/a"}');
});

test("padding buckets", () => {
  assert.equal(paddedWireBytes(100, false), 384);
  assert.equal(paddedWireBytes(384, false), 384);
  assert.equal(paddedWireBytes(385, false), 768);
  assert.equal(paddedWireBytes(100, true), 768);
  assert.equal(paddedWireBytes(1537, false), 2850);
  assert.equal(paddedWireBytes(2850, false), 2850);
  assert.equal(paddedWireBytes(2851, false), null);
});

async function pair() {
  const a = await generateKeySet();
  const b = await generateKeySet();
  return { a, b };
}

test("inner message round trip per type, every bucket, sig and pad checks", async () => {
  const { a, b } = await pair();
  const pid = new Uint8Array(8).fill(3);
  const fromId = b64urlDecode(ID_A);
  const sizes: number[] = [];
  for (const text of ["hi", randomText(600), randomText(1400), randomText(2048)]) {
    const m = await encodeInner({ signKey: a.sign.privateKey, fromId, pairingId: pid, json: buildJson(5, { type: "text", value: text }), recipientId: ID_B, recipientEncPub: b.enc_pub });
    sizes.push(m.length);
    const pt = await openInner(b.enc, ID_B, m);
    assert.ok(pt);
    const p = parseInnerPlain(pt!)!;
    assert.ok(p);
    assert.deepEqual(p.fromId, fromId);
    assert.deepEqual(p.pairingId, pid);
    assert.ok(await verifyInner(a.sign_pub, ID_B, p));
    assert.ok(!(await verifyInner(b.sign_pub, ID_B, p)));
    assert.ok(!(await verifyInner(a.sign_pub, ID_A, p)));
    const j = parseInnerJson((await inflateInner(p))!);
    assert.deepEqual(j, { n: 5, content: { type: "text", value: text } });
    assert.equal(await openInner(a.enc, ID_B, m), null); // wrong recipient key
    assert.equal(await openInner(b.enc, ID_A, m), null); // wrong aad id
  }
  assert.deepEqual(sizes, [512, 1024, 2048, 3800]);
  // approve carries keys and lands at >= 1024
  const entry = await makeNameEntry(a.sign.privateKey, ID_A, ID_B, pid, 9, "Laptop");
  const m = await encodeInner({ signKey: a.sign.privateKey, fromId, pairingId: pid, keys: { sign_pub: a.sign_pub, enc_pub: a.enc_pub }, json: buildJson(9, { type: "approve", entry }), recipientId: ID_B, recipientEncPub: b.enc_pub });
  assert.equal(m.length, 1024);
  const p = parseInnerPlain((await openInner(b.enc, ID_B, m))!)!;
  assert.deepEqual(p.keys!.sign_pub, a.sign_pub);
  const j = parseInnerJson((await inflateInner(p))!)!;
  assert.equal(j.content.type, "approve");
  assert.equal(await verifyNameEntry(a.sign_pub, ID_A, ID_B, pid, (j.content as { entry: typeof entry }).entry), "Laptop");
  assert.equal(await verifyNameEntry(a.sign_pub, ID_A, ID_B, new Uint8Array(8), entry), null); // other pairing id

  // a nonzero pad byte drops
  const body = concat(fromId, pid, new Uint8Array([0]), new Uint8Array([0, 3]), new Uint8Array([1, 2, 3]), new Uint8Array([0, 0, 1]));
  const sig = await sign(a.sign.privateKey, msgSignedBytes(ID_B, body));
  assert.equal(parseInnerPlain(concat(sig, body)), null);
  // keys flag other than 0/1 drops
  assert.equal(parseInnerPlain(concat(sig, fromId, pid, new Uint8Array([2, 0, 1, 0]))), null);
  // a sealed but tampered ciphertext does not open
  const raw = b64urlDecode(m);
  raw[100]! ^= 1;
  assert.equal(await openInner(b.enc, ID_B, b64urlEncode(raw)), null);
  // non-canonical b64url does not open
  assert.equal(await openInner(b.enc, ID_B, m + "="), null);
  // signed with the wrong info never opens under PA-MSG1
  const wrongInfo = b64urlEncode(await hpkeSeal(b.enc_pub, ascii("PA-NAME1"), ascii(ID_B), new Uint8Array(200)));
  assert.equal(await openInner(b.enc, ID_B, wrongInfo), null);
  assert.ok(INFO_MSG);
});

test("inflate is capped at 16 KB and rejects garbage", async () => {
  const big = new Uint8Array(deflateRawSync(new Uint8Array(20000)));
  assert.equal(await inflateRaw(big, 16384), null);
  const ok = new Uint8Array(deflateRawSync(new Uint8Array(16384)));
  assert.equal((await inflateRaw(ok, 16384))!.length, 16384);
  assert.equal(await inflateRaw(new Uint8Array([0xff, 0xff, 0xff]), 16384), null);
});

test("name entry seal/open", async () => {
  const { a, b } = await pair();
  const pid = new Uint8Array(8).fill(1);
  const e = await makeNameEntry(a.sign.privateKey, ID_A, ID_B, pid, 4, "Phone");
  const ct = await sealNameEntry(e, ID_B, b.enc_pub);
  assert.ok(ct.length <= 1024);
  const back = await openNameEntry(b.enc, ID_B, ct);
  assert.deepEqual(back, e);
  assert.equal(await openNameEntry(b.enc, ID_A, ct), null);
  await assert.rejects(makeNameEntry(a.sign.privateKey, ID_A, ID_B, pid, 4, ""));
  await assert.rejects(makeNameEntry(a.sign.privateKey, ID_A, ID_B, pid, 4, "x".repeat(33)));
  await assert.rejects(makeNameEntry(a.sign.privateKey, ID_A, ID_B, pid, 4, "caf\u00e9"));
  await assert.rejects(makeNameEntry(a.sign.privateKey, ID_A, ID_B, pid, 4, 'Dad"s'));
});

test("received name entry with a double quote is ignored", async () => {
  const { a } = await pair();
  const pid = new Uint8Array(8).fill(1);
  const nameB64 = b64urlEncode(ascii('Dad"s'));
  const s = await sign(a.sign.privateKey, nameSignedString(ID_A, ID_B, pid, 4, nameB64));
  const e = { name: nameB64, n: 4, s: b64urlEncode(s) };
  assert.equal(await verifyNameEntry(a.sign_pub, ID_A, ID_B, pid, e), null);
});

test("pair messages: 366 chars, kinds, commit zero tail", async () => {
  const { a, b } = await pair();
  const from = b64urlDecode(ID_A);
  const cN = new Uint8Array(32).fill(8);
  const m1 = await encodePair(from, { kind: "commit", c_N: cN }, ID_B, b.enc_pub);
  assert.equal(m1.length, 366);
  const p1 = await openPair(b.enc, ID_B, m1);
  assert.deepEqual(p1, { fromId: from, body: { kind: "commit", c_N: cN } });
  const r = new Uint8Array(32).fill(6);
  const m2 = await encodePair(from, { kind: "reply", sign_pub: a.sign_pub, enc_pub: a.enc_pub, r }, ID_B, b.enc_pub);
  const p2 = await openPair(b.enc, ID_B, m2);
  assert.equal(p2!.body.kind, "reply");
  assert.equal(await openPair(b.enc, ID_A, m2), null);
  assert.equal(await openPair(b.enc, ID_B, m2.slice(0, 365)), null);
  // commit with nonzero tail drops
  const pt = new Uint8Array(193);
  pt[0] = 1;
  pt[100] = 1;
  const bad = b64urlEncode(await hpkeSeal(b.enc_pub, ascii("PA-PAIR1"), ascii(ID_B), pt));
  assert.equal(await openPair(b.enc, ID_B, bad), null);
  // reply with sign_pub == enc_pub drops
  const pt2 = new Uint8Array(193);
  pt2[0] = 2;
  pt2.set(a.sign_pub, 31);
  pt2.set(a.sign_pub, 96);
  const bad2 = b64urlEncode(await hpkeSeal(b.enc_pub, ascii("PA-PAIR1"), ascii(ID_B), pt2));
  assert.equal(await openPair(b.enc, ID_B, bad2), null);
});

test("replay window", () => {
  let s = freshReplay(new Uint8Array(8));
  assert.equal(replayCheck(s, 1), "accept");
  s = replayRecord(s, 1);
  assert.equal(replayCheck(s, 1), "seen");
  s = replayRecord(s, 5);
  assert.equal(replayCheck(s, 3), "accept"); // out of order within 100
  s = replayRecord(s, 3);
  assert.equal(replayCheck(s, 3), "seen");
  assert.equal(replayCheck(s, 1), "seen");
  assert.equal(replayCheck(s, 5), "seen");
  assert.equal(replayCheck(s, 4), "accept");
  s = replayRecord(s, 150);
  assert.equal(s.h, 150);
  assert.equal(replayCheck(s, 50), "old"); // n <= h - 100
  assert.equal(replayCheck(s, 51), "accept");
  assert.equal(replayCheck(s, 150), "seen");
  s = replayRecord(s, 51);
  assert.equal(replayCheck(s, 51), "seen");
  s = replayRecord(s, 1000); // shift >= 100 clears all
  assert.equal(replayCheck(s, 999), "accept");
  assert.equal(replayCheck(s, 1000), "seen");
  assert.equal(replayCheck(s, 900), "old");
});

test("phone detection and URL rules", () => {
  assert.equal(detectType("+1 555-123-4567"), "tel");
  assert.equal(detectType("(555) 123.4567"), "tel");
  assert.equal(detectType("2026-10-24"), "text");
  assert.equal(detectType("10.0.0.1"), "text");
  assert.equal(detectType("123456"), "text");
  assert.equal(detectType("tel:+15551234567"), "tel");
  assert.equal(detectType("https://example.com/a"), "url");
  assert.equal(detectType(" https://example.com/a "), "url");
  assert.equal(detectType("http://a.com/x y"), "url"); // Q221: space in the path is kept as %20
  assert.equal(detectType("http://a.com/x\ty"), "text");
  assert.equal(detectType("see https://example.com"), "text");
  assert.equal(detectType("ftp://example.com"), "text");
  assert.equal(detectType("https://user:pw@example.com"), "text");
  assert.ok(isPhone("\u00a0+1 555 123 4567\u00a0"));
  assert.equal(parseHttpUrl("https://xn--pple-43d.com/")!.hostname, "xn--pple-43d.com");
  assert.equal(parseHttpUrl("https://\u0430pple.com/")!.href, "https://xn--pple-43d.com/");
  const ok = (s: string) => autoOpenAllowed(parseHttpUrl(s)!);
  assert.ok(ok("https://Example.COM./x"));
  assert.ok(!ok("https://foo.localhost/"));
  assert.ok(!ok("https://localhost./"));
  assert.ok(!ok("https://x.local./"));
  assert.ok(!ok("http://example.com/"));
  assert.ok(!ok("https://example.com:8443/"));
  assert.ok(!ok("https://10.0.0.1/"));
  assert.ok(!ok("https://[::1]/"));
  assert.ok(!ok("https://intranet/"));
});

test("pairing countdown formatting", () => {
  const H = 3600e3;
  assert.equal(formatCountdown(30 * 24 * H), "30 days");
  assert.equal(formatCountdown(24 * H), "1 day");
  assert.equal(formatCountdown(24 * H - 1), "23 hours");
  assert.equal(formatCountdown(60 * 60e3), "1 hour");
  assert.equal(formatCountdown(60 * 60e3 - 1), "59 minutes");
  assert.equal(formatCountdown(5 * 60e3), "5 minutes");
});

const ME = new Uint8Array(30).fill(0x10);
const HI = new Uint8Array(30).fill(0x10);
HI[29] = 0x80;
function base(over: Partial<PairDecideInput> = {}): PairDecideInput {
  return {
    myId: ME,
    fromId: HI,
    c_N: new Uint8Array(32).fill(1),
    entry: null,
    pinned: false,
    approved: false,
    approveVerified: false,
    lastGetApprovesMe: null,
    inLastList: true,
    fetched: false,
    openEntries: 0,
    capTimestamps: [],
    now: 1_000_000_000_000,
    ...over,
  };
}

test("pair_decide rules a to e", () => {
  const c = new Uint8Array(32).fill(1);
  const c2 = new Uint8Array(32).fill(2);
  assert.deepEqual(pairDecide(base()), { action: "reply", rule: "e", counted: true, tapped: false });
  // a: duplicate, authorized -> resend; cap-prompted -> notice only; shown -> notice
  assert.equal(pairDecide(base({ entry: { role: "X", state: "replied", c_N: c, authorized: true } })).action, "resend");
  assert.equal(pairDecide(base({ entry: { role: "X", state: "prompted", c_N: c, authorized: true } })).action, "resend");
  assert.deepEqual(pairDecide(base({ entry: { role: "X", state: "prompted", c_N: c, authorized: false } })), { action: "notice", rule: "a", notice: "current" });
  assert.deepEqual(pairDecide(base({ pinned: true, entry: { role: "X", state: "shown", c_N: c, authorized: true } })), { action: "notice", rule: "a", notice: "current" });
  // b: different c_N
  assert.equal(pairDecide(base({ entry: { role: "X", state: "replied", c_N: c2, authorized: true } })).action, "abort");
  // c: crossing, lower id stays N
  assert.deepEqual(pairDecide(base({ entry: { role: "N", state: "committed" } })), { action: "notice", rule: "c", notice: "crossing" });
  assert.deepEqual(pairDecide(base({ myId: HI, fromId: ME, entry: { role: "N", state: "committed" } })), { action: "reply", rule: "c", counted: false, tapped: true });
  // c: own N entry past committed: approved and waiting -> half notice; else drop
  assert.deepEqual(pairDecide(base({ pinned: true, approved: true, entry: { role: "N", state: "shown" } })), { action: "notice", rule: "c", notice: "half" });
  assert.deepEqual(pairDecide(base({ pinned: true, entry: { role: "N", state: "shown" } })), { action: "drop", rule: "c", notice: "unreadable" });
  // d: pinned, no entry, fully paired -> plain drop; GET after verify approves_me false -> half
  assert.deepEqual(pairDecide(base({ pinned: true, approved: true, approveVerified: true, lastGetApprovesMe: true })), { action: "drop", rule: "d", notice: "unreadable" });
  assert.deepEqual(pairDecide(base({ pinned: true, approved: true, approveVerified: true, lastGetApprovesMe: null })), { action: "drop", rule: "d", notice: "unreadable" });
  assert.deepEqual(pairDecide(base({ pinned: true, approved: true, approveVerified: true, lastGetApprovesMe: false })), { action: "notice", rule: "d", notice: "half" });
  // e: not listed -> fetch; 10th open entry dropped; 11th automatic reply prompted; cap rolls over at 24 h
  assert.equal(pairDecide(base({ inLastList: false })).action, "fetch");
  assert.equal(pairDecide(base({ inLastList: false, fetched: true })).action, "drop");
  assert.equal(pairDecide(base({ openEntries: 9 })).action, "drop");
  assert.equal(pairDecide(base({ openEntries: 8 })).action, "reply");
  const now = 1_000_000_000_000;
  const ten = Array.from({ length: 10 }, (_, i) => now - i * 1000);
  assert.equal(pairDecide(base({ capTimestamps: ten })).action, "prompt");
  const rolled = ten.map((t) => t - 24 * 3600e3);
  assert.equal(pairDecide(base({ capTimestamps: rolled })).action, "reply");
  assert.equal(capCount([now - 24 * 3600e3 + 1, now - 24 * 3600e3], now), 1);
});

test("id_order: unsigned lexicographic", () => {
  const a = new Uint8Array(30).fill(0x7f);
  const b = new Uint8Array(30).fill(0x7f);
  b[0] = 0x80; // first differing byte >= 0x80
  assert.ok(idLower(a, b));
  assert.ok(!idLower(b, a));
  const c = a.slice();
  c[29] = 0x80; // shared prefix
  assert.ok(idLower(a, c));
  assert.ok(!idLower(a, a));
});

function randomText(n: number): string {
  let s = "";
  let x = 12345;
  while (s.length < n) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s += String.fromCharCode(33 + (x % 90));
  }
  return s;
}
