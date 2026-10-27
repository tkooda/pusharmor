import { describe, expect, it } from "vitest";
import { b64urlDecode, b64urlEncode, isB64urlBytes } from "../src/codec/b64url";
import { accountId, checkPeerIdMac, emailHash, keyhash, peerId } from "../src/crypto/ids";
import { importVerifyKey, rawPoint, verifyRaw } from "../src/crypto/ecdsa";
import { deriveCode, normalizeCode, checkCode, CROCKFORD } from "../src/crypto/code";
import { LABEL_TICKET, makeToken, oauthNonce, openToken, seal, unseal } from "../src/crypto/tokens";
import { encryptAes128gcm } from "../src/push/rfc8291";
import { importEs256Private, importRs256Private, signJwt } from "../src/push/jwt";
import { hmac, utf8 } from "../src/crypto/hash";
import { TEST_SECRETS as S } from "./secrets";
import { decodeJwt, vendorKeys } from "./helpers";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)));

describe("b64url strict", () => {
  it("round trips and rejects non-canonical input", () => {
    for (let n = 0; n < 40; n++) {
      const b = crypto.getRandomValues(new Uint8Array(n));
      const s = b64urlEncode(b);
      expect(s).not.toMatch(/[=+/]/);
      expect(hex(b64urlDecode(s)!)).toBe(hex(b));
    }
    expect(b64urlDecode("AAA=")).toBeNull();
    expect(b64urlDecode("AA+A")).toBeNull();
    expect(b64urlDecode("A")).toBeNull();
    expect(b64urlDecode("AB")).toBeNull(); // spare bits
    expect(b64urlDecode("AAB")).toBeNull(); // spare bits
    expect(hex(b64urlDecode("AA")!)).toBe("00");
    expect(b64urlDecode("A A=")).toBeNull();
    expect(b64urlDecode("\u00e9AAA")).toBeNull();
    expect(isB64urlBytes("AAAA", 3)).toBe(true);
    expect(isB64urlBytes("AAAA", 2)).toBe(false);
  });
});

describe("ids", () => {
  it("email_hash uses the PA-ACCT1 label; peer id MAC verifies and rejects tampering", async () => {
    const eh = await emailHash("a@b.com");
    const ref = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8("PA-ACCT1\na@b.com")));
    expect(hex(eh)).toBe(hex(ref));
    const acct = await accountId(S.PA_ID_SECRET, eh);
    expect(acct).toHaveLength(12);
    expect(hex(b64urlDecode(acct)!)).toBe(hex((await hmac(S.PA_ID_SECRET, eh)).slice(0, 9)));
    const k = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
    const sp = new Uint8Array((await crypto.subtle.exportKey("raw", k.publicKey)) as ArrayBuffer);
    const ep = sp.slice();
    const id = await peerId(S.PA_ID_SECRET, acct, sp, ep);
    expect(id).toHaveLength(40);
    expect(id.slice(0, 12)).toBe(acct);
    expect(hex(b64urlDecode(id)!.slice(9, 21))).toBe(hex(await keyhash(sp, ep)));
    expect(await checkPeerIdMac(S.PA_ID_SECRET, id)).toBe(true);
    const raw = b64urlDecode(id)!;
    raw[29] ^= 1;
    expect(await checkPeerIdMac(S.PA_ID_SECRET, b64urlEncode(raw))).toBe(false);
    expect(await checkPeerIdMac(S.PA_ID_SECRET, id.slice(0, 39))).toBe(false);
  });
});

describe("ecdsa", () => {
  it("rejects off-curve points and verifies raw r||s", async () => {
    const k = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const raw = new Uint8Array((await crypto.subtle.exportKey("raw", k.publicKey)) as ArrayBuffer);
    const key = await importVerifyKey(raw);
    const data = utf8("hello");
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k.privateKey, data));
    expect(await verifyRaw(key!, sig, data)).toBe(true);
    sig[0] ^= 1;
    expect(await verifyRaw(key!, sig, data)).toBe(false);
    const bad = raw.slice();
    bad[64] ^= 1; // y changed: off curve
    expect(await importVerifyKey(bad)).toBeNull();
    expect(rawPoint(b64urlEncode(raw))).not.toBeNull();
    const c = raw.slice();
    c[0] = 2;
    expect(rawPoint(b64urlEncode(c))).toBeNull();
  });
});

describe("email code", () => {
  it("is 6 Crockford chars from the top 30 bits and accepts O/I/L mapping", async () => {
    const tok = "some.request.token";
    const code = await deriveCode(S.PA_CODE_SECRET, tok);
    const m = await hmac(S.PA_CODE_SECRET, utf8(tok));
    let bits = "";
    for (const b of m.slice(0, 4)) bits += b.toString(2).padStart(8, "0");
    let expectCode = "";
    for (let i = 0; i < 6; i++) expectCode += CROCKFORD[parseInt(bits.slice(i * 5, i * 5 + 5), 2)];
    expect(code).toBe(expectCode);
    expect(normalizeCode("oil0")).toBe("0110");
    expect(await checkCode(S.PA_CODE_SECRET, tok, code.toLowerCase())).toBe(true);
    expect(await checkCode(S.PA_CODE_SECRET, tok + "x", code)).toBe(false);
  });
});

describe("tokens", () => {
  it("MAC over label + body part; tamper and label swap fail", async () => {
    const t = await makeToken(S.PA_TOKEN_SECRET, LABEL_TICKET, { a: "AAAAAAAAAAAA", k: "k", p: "register", x: 1 });
    expect(await openToken(S.PA_TOKEN_SECRET, LABEL_TICKET, t)).toEqual({ a: "AAAAAAAAAAAA", k: "k", p: "register", x: 1 });
    expect(await openToken(S.PA_TOKEN_SECRET, "PA-RT1\n", t)).toBeNull();
    const [b, mac] = t.split(".");
    const forged = b64urlEncode(utf8(JSON.stringify({ a: "AAAAAAAAAAAA", k: "k", p: "delete-account", x: 1 })));
    expect(await openToken(S.PA_TOKEN_SECRET, LABEL_TICKET, forged + "." + mac)).toBeNull();
    expect(await openToken(S.PA_TOKEN_SECRET, LABEL_TICKET, b + "." + mac.slice(0, -2) + "AA")).toBeNull();
    const sealed = await seal(S.PA_TOKEN_SECRET, "refresh-token");
    expect(await unseal(S.PA_TOKEN_SECRET, sealed)).toBe("refresh-token");
    expect(await unseal(S.PA_CODE_SECRET, sealed)).toBeNull();
  });
  it("oauth nonce", async () => {
    const n = await oauthNonce("register", "k");
    const ref = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8("PA-NONCE1\nregister\nk")));
    expect(n).toBe(b64urlEncode(ref));
  });
});

describe("RFC 8291 section 5 example", () => {
  it("produces the published body", async () => {
    const asPriv = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
    const asPub = b64urlDecode("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8")!;
    const uaPub = b64urlDecode("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4")!;
    const jwk = { kty: "EC", crv: "P-256", d: asPriv, x: b64urlEncode(asPub.slice(1, 33)), y: b64urlEncode(asPub.slice(33)) };
    const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const publicKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, true, []);
    const body = await encryptAes128gcm(utf8("When I grow up, I want to be a watermelon"), uaPub, b64urlDecode("BTBZMqHH6r4Tts7J_aSIgg")!, {
      salt: b64urlDecode("DGv6ra1nlYgDCS1FRnbzlw")!,
      asKeyPair: { privateKey, publicKey },
    });
    expect(b64urlEncode(body)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });
});

describe("JWT", () => {
  it("ES256 and RS256 verify with the public key", async () => {
    const k = await vendorKeys();
    const es = await signJwt("ES256", await importEs256Private(k.apnsPem), { alg: "ES256", kid: "K" }, { iss: "T", iat: 1 });
    const [h, c, s] = es.split(".");
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k.apnsPublic, b64urlDecode(s)!, utf8(h + "." + c))).toBe(true);
    expect(decodeJwt(es).claims).toEqual({ iss: "T", iat: 1 });
    const rs = await signJwt("RS256", await importRs256Private(k.fcmPem), { alg: "RS256", typ: "JWT" }, { iss: "x" });
    const [h2, c2, s2] = rs.split(".");
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", k.fcmPublic, b64urlDecode(s2)!, utf8(h2 + "." + c2))).toBe(true);
  });
  it("hex helper sanity", () => {
    expect(hex(unhex("00ff"))).toBe("00ff");
  });
});
