import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { b64urlDecode, b64urlEncode, b64urlTryDecode } from "../src/crypto/b64url.ts";
import { ascii, buf, concat, hex, unhex } from "../src/crypto/bytes.ts";
import { hpkeOpen, hpkeSeal, rfc9180A3Suite } from "../src/crypto/hpke.ts";
import { generateKeySet, importPrivate, isValidPub, sign, verify } from "../src/crypto/keys.ts";
import {
  commitHash,
  crockford,
  emailHash,
  idMatchesKeys,
  keyhash,
  normalizeEmail,
  oauthNonce,
  pairingFingerprint,
  pairingId,
  pairingKey,
  pushHash,
} from "../src/crypto/labels.ts";
import { paSig, reqSignedBytes } from "../src/crypto/pasig.ts";
import { generateWebPushKeys, rfc8291Decrypt } from "../src/crypto/rfc8291.ts";

const sha = (...p: Uint8Array[]) => new Uint8Array(createHash("sha256").update(concat(...p)).digest());

test("b64url strict codec", () => {
  for (let n = 0; n < 70; n++) {
    const b = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255);
    const s = b64urlEncode(b);
    assert.equal(s, Buffer.from(b).toString("base64url"));
    assert.deepEqual(b64urlDecode(s), b);
  }
  // rejects: padding, bad chars, length mod 4 = 1
  for (const bad of ["AA==", "A", "AAAAA", "AB+/", "A B", "A\u00c3"]) assert.equal(b64urlTryDecode(bad), null, bad);
  assert.equal(b64urlTryDecode("AB"), null); // spare bits of 1 byte (4 bits) nonzero
  assert.deepEqual(b64urlTryDecode("AA"), new Uint8Array([0]));
  assert.equal(b64urlTryDecode("AAB"), null); // 2 spare bits nonzero
  assert.deepEqual(b64urlTryDecode("AAE"), new Uint8Array([0, 1]));
  // 65-byte key = 87 chars, 2 spare bits must be 0
  const k = new Uint8Array(65).fill(255);
  const s = b64urlEncode(k);
  assert.equal(s.length, 87);
  assert.equal(b64urlTryDecode(s.slice(0, 86) + "/"), null);
  const last = s[86]!;
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bumped = alpha[alpha.indexOf(last) + 1]!;
  assert.equal(b64urlTryDecode(s.slice(0, 86) + bumped), null);
  assert.deepEqual(b64urlDecode(""), new Uint8Array(0));
});

// RFC 9180 Appendix A.3.1: DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, base mode.
// The DHKEM and key schedule are the same as our AES-256-GCM suite; only the AEAD differs.
const A31 = {
  info: "4f6465206f6e2061204772656369616e2055726e",
  ikmE: "4270e54ffd08d79d5928020af4686d8f6b7d35dbe470265f1f5aa22816ce860e",
  pkRm: "04fe8c19ce0905191ebc298a9245792531f26f0cece2460639e8bc39cb7f706a826a779b4cf969b8a0e539c7f62fb3d30ad6aa8f80e30f1d128aafd68a2ce72ea0",
  skRm: "f3ce7fdae57e1a310d87f1ebbde6f328be0a99cdbcadf4d6589cf29de4b8ffd2",
  enc: "04a92719c6195d5085104f469a8b9814d5838ff72b60501e2c4466e5e67b325ac98536d7b61a1af4b78e5b7f951c0900be863c403ce65c9bfcb9382657222d18c4",
  pt: "4265617574792069732074727574682c20747275746820626561757479",
  aad0: "436f756e742d30",
  ct0: "5ad590bb8baa577f8619db35a36311226a896e7342a6d836d8b7bcd2f20b6c7f9076ac232e3ab2523f39513434",
};

test("HPKE RFC 9180 A.3.1 seal (seq 0) and open", async () => {
  const suite = rfc9180A3Suite();
  const pkR = await crypto.subtle.importKey("raw", buf(unhex(A31.pkRm)), { name: "ECDH", namedCurve: "P-256" }, true, []);
  const r = await suite.seal(
    { recipientPublicKey: pkR, info: unhex(A31.info).buffer as ArrayBuffer, ekm: unhex(A31.ikmE).buffer as ArrayBuffer },
    unhex(A31.pt).buffer as ArrayBuffer,
    unhex(A31.aad0).buffer as ArrayBuffer,
  );
  assert.equal(hex(new Uint8Array(r.enc)), A31.enc);
  assert.equal(hex(new Uint8Array(r.ct)), A31.ct0);
  const kp = await importPrivate("ECDH", unhex(A31.skRm), unhex(A31.pkRm));
  const pt = await suite.open(
    { recipientKey: kp, enc: unhex(A31.enc).buffer as ArrayBuffer, info: unhex(A31.info).buffer as ArrayBuffer },
    unhex(A31.ct0).buffer as ArrayBuffer,
    unhex(A31.aad0).buffer as ArrayBuffer,
  );
  assert.equal(hex(new Uint8Array(pt)), A31.pt);
});

test("HPKE AES-256-GCM suite round trip with a non-extractable recipient key", async () => {
  const ks = await generateKeySet();
  assert.equal(ks.enc.privateKey.extractable, false);
  const info = ascii("PA-MSG1");
  const aad = ascii("x".repeat(40));
  const w = await hpkeSeal(ks.enc_pub, info, aad, ascii("hello"));
  assert.equal(w.length, 65 + 5 + 16);
  assert.deepEqual(await hpkeOpen(ks.enc, info, aad, w), ascii("hello"));
  assert.equal(await hpkeOpen(ks.enc, info, ascii("y".repeat(40)), w), null); // wrong aad
  assert.equal(await hpkeOpen(ks.enc, ascii("PA-NAME1"), aad, w), null); // wrong info
  const t = w.slice();
  t[70]! ^= 1;
  assert.equal(await hpkeOpen(ks.enc, info, aad, t), null); // tampered
  // deterministic with ikmE: same enc as the RFC A.3.1 ephemeral key
  const w2 = await hpkeSeal(ks.enc_pub, info, aad, ascii("hello"), unhex(A31.ikmE));
  assert.equal(hex(w2.subarray(0, 65)), A31.enc);
});

// RFC 8291 section 5 / Appendix A.
test("RFC 8291 section 5 vector decrypts", async () => {
  const body = b64urlDecode(
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
      "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
      "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  );
  const uaPub = b64urlDecode("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
  const uaPriv = b64urlDecode("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94");
  const auth = b64urlDecode("BTBZMqHH6r4Tts7J_aSIgg");
  const kp = await importPrivate("ECDH", uaPriv, uaPub);
  const pt = await rfc8291Decrypt(kp.privateKey, uaPub, auth, body);
  assert.equal(new TextDecoder().decode(pt), "When I grow up, I want to be a watermelon");
  const bad = body.slice();
  bad[bad.length - 1]! ^= 1;
  await assert.rejects(rfc8291Decrypt(kp.privateKey, uaPub, auth, bad));
  await assert.rejects(rfc8291Decrypt(kp.privateKey, uaPub, new Uint8Array(16), body));
  const wp = await generateWebPushKeys();
  assert.equal(wp.p256dh.length, 65);
  assert.equal(wp.auth.length, 16);
  assert.equal(wp.ecdh.privateKey.extractable, false);
});

test("ECDSA raw r||s sign/verify and public key validation", async () => {
  const ks = await generateKeySet();
  assert.equal(ks.sign.privateKey.extractable, false);
  assert.equal(ks.sign_pub.length, 65);
  const s = await sign(ks.sign.privateKey, ascii("abc"));
  assert.equal(s.length, 64);
  assert.ok(await verify(ks.sign_pub, s, ascii("abc")));
  assert.ok(!(await verify(ks.sign_pub, s, ascii("abd"))));
  assert.ok(!(await verify(ks.enc_pub, s, ascii("abc"))));
  assert.ok(await isValidPub(ks.sign_pub));
  const off = ks.sign_pub.slice();
  off[64]! ^= 1; // not on the curve
  assert.ok(!(await isValidPub(off)));
  assert.ok(!(await isValidPub(ks.sign_pub.subarray(0, 64))));
});

test("labels: keyhash, id check, c_N, fingerprint, pairing id, pk, nonce, email hash, push hash", async () => {
  const sp = new Uint8Array(65).fill(4);
  const ep = new Uint8Array(65).fill(5);
  sp[1] = 1;
  const kh = await keyhash(sp, ep);
  assert.deepEqual(kh, sha(ascii("PA-ID1\n"), sp, ep).subarray(0, 12));
  const acct = new Uint8Array(9).fill(7);
  const id = concat(acct, kh, new Uint8Array(9).fill(1));
  assert.ok(await idMatchesKeys(id, sp, ep, acct));
  assert.ok(!(await idMatchesKeys(id, sp, ep, new Uint8Array(9))));
  assert.ok(!(await idMatchesKeys(id, ep, sp, acct)));
  assert.ok(!(await idMatchesKeys(id, sp, sp, acct)));

  const rN = new Uint8Array(32).fill(0xaa);
  const rX = new Uint8Array(32).fill(0xbb);
  assert.deepEqual(await commitHash(sp, ep, rN), sha(ascii("PA-SAS1C\n"), sp, ep, rN));
  const fpHash = sha(ascii("PA-SAS1\n"), sp, ep, ep, sp, rN, rX);
  assert.equal(await pairingFingerprint(sp, ep, ep, sp, rN, rX), crockford(fpHash, 4));
  assert.deepEqual(await pairingId(rN, rX), sha(ascii("PA-PAIRID1\n"), rN, rX).subarray(0, 8));
  const xid = new Uint8Array(30).fill(9);
  assert.equal(await pairingKey(id, xid), b64urlEncode(sha(ascii("PA-PAIRKEY1\n"), id, xid).subarray(0, 16)));
  assert.equal((await pairingKey(id, xid)).length, 22);
  const k = b64urlEncode(sha(sp));
  assert.equal(await oauthNonce("register", sp), b64urlEncode(sha(ascii("PA-NONCE1\nregister\n" + k))));
  assert.equal(normalizeEmail("  A.B@Example.COM "), "a.b@example.com");
  assert.equal(normalizeEmail("a@b\u00e9.com"), null);
  assert.deepEqual(await emailHash("a@b.com"), sha(ascii("PA-ACCT1\na@b.com")));
  const p = { type: "webpush" as const, endpoint: "https://e/x", p256dh: "P", auth: "A" };
  assert.equal(await pushHash(p), b64urlEncode(sha(ascii("webpush\nhttps://e/x\nP\nA")).subarray(0, 16)));
});

test("crockford: first 20 bits MSB first", () => {
  assert.equal(crockford(new Uint8Array([0, 0, 0]), 4), "0000");
  assert.equal(crockford(new Uint8Array([0xff, 0xff, 0xf0]), 4), "ZZZZ");
  // 0b00001 00010 00011 00100 -> 1 2 3 4
  assert.equal(crockford(new Uint8Array([0x08, 0x86, 0x40]), 4), "1234");
  // bits beyond 20 are ignored
  assert.equal(crockford(new Uint8Array([0x08, 0x86, 0x4f]), 4), "1234");
});

test("PA-Sig signed bytes and signature", async () => {
  const ks = await generateKeySet();
  const body = ascii('{"v":1}');
  const bytes = reqSignedBytes("POST", "/v1/send", "1761300000000", body);
  assert.deepEqual(bytes, concat(ascii("PA-REQ1\nPOST\n/v1/send\n1761300000000\n"), body));
  const sig = await paSig(ks.sign.privateKey, "POST", "/v1/send", "1761300000000", body);
  assert.ok(await verify(ks.sign_pub, b64urlDecode(sig), bytes));
  assert.throws(() => reqSignedBytes("GET", "/peers", "1", new Uint8Array(0)));
  assert.throws(() => reqSignedBytes("GET", "/v1/peers?x=1", "1", new Uint8Array(0)));
});
