// Worker-relevant sections of the shared golden vector file, run through production modules.
import { describe, expect, it } from "vitest";
import golden from "../../../tests/vectors/golden-v1.json";
import { b64urlDecode, b64urlEncode } from "../src/codec/b64url";
import { pushSha256 } from "../src/codec/validate";
import { importEcdhPub, importVerifyKey, rawPoint } from "../src/crypto/ecdsa";
import { accountId, emailHash, keyhash, peerId } from "../src/crypto/ids";
import { keyRef, keyRef16, makeCliCode, openCliCode, oauthNonce } from "../src/crypto/tokens";
import { normalizeEmail } from "../src/auth/normalize";
import { checkSig, checkTime, signedBytes } from "../src/pipeline/signed";
import { pairKey } from "../src/routes/pair";
import { encryptAes128gcm } from "../src/push/rfc8291";
import { call, keys, ticketFor, randomEmail } from "./helpers";
import { TEST_SECRETS as S } from "./secrets";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const G = golden as any;
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const d = (s: string) => b64urlDecode(s)!;

describe("golden: keys and ids", () => {
  it("test PA_ID_SECRET is the golden id_secret", () => {
    expect(S.PA_ID_SECRET).toBe(G.keys.id_secret);
  });
  for (const [name, p] of Object.entries(G.keys.peers) as [string, Record<string, string>][]) {
    it(`peer ${name}: account, keyhash, id`, async () => {
      const acct = await accountId(G.keys.id_secret, await emailHash(normalizeEmail(p.email)));
      expect(acct).toBe(p.account);
      expect(b64urlEncode(await keyhash(d(p.sign_pub), d(p.enc_pub)))).toBe(p.keyhash);
      expect(await peerId(G.keys.id_secret, acct, d(p.sign_pub), d(p.enc_pub))).toBe(p.id);
    });
  }
});

describe("golden: email_hash", () => {
  for (const c of G.email_hash.cases) {
    it(JSON.stringify(c.input), async () => {
      if (c.normalized === null) {
        expect(() => normalizeEmail(c.input)).toThrow();
        return;
      }
      const n = normalizeEmail(c.input);
      expect(n).toBe(c.normalized);
      const eh = await emailHash(n);
      expect(b64urlEncode(eh)).toBe(c.email_hash);
      expect(await accountId(G.keys.id_secret, eh)).toBe(c.account);
    });
  }
});

describe("golden: b64url", () => {
  for (const c of G.b64url.cases) {
    it(JSON.stringify(c.input), () => {
      const r = b64urlDecode(c.input);
      if (c.ok) expect(hex(r!)).toBe(c.hex);
      else expect(r).toBeNull();
    });
  }
});

describe("golden: oauth_nonce, my_push_sha256, pk", () => {
  it("oauth_nonce", async () => {
    for (const c of G.oauth_nonce.cases) {
      const k = await keyRef(d(c.sign_pub));
      expect(k).toBe(c.k);
      expect(await oauthNonce(c.purpose, k)).toBe(c.nonce);
    }
  });
  it("cli_code", async () => {
    for (const c of G.cli_code.cases) {
      const k16 = await keyRef16(d(c.sign_pub));
      expect(k16).toBe(c.k16);
      expect("https://pusharmor.com/auth/cli#" + c.p + "." + k16).toBe(c.link);
      const purpose = c.purpose as "register" | "login";
      expect(await makeCliCode(G.cli_code.token_secret, c.account, k16, purpose, c.window)).toBe(c.code);
      expect(await openCliCode(G.cli_code.token_secret, c.code, k16, purpose, c.window + 1)).toEqual({ a: c.account, w: c.window });
    }
  });
  it("my_push_sha256", async () => {
    for (const c of G.my_push_sha256.cases) expect(await pushSha256(c.push)).toBe(c.my_push_sha256);
  });
  it("pairing pk", async () => {
    const p = G.keys.peers;
    expect(await pairKey(p[G.pairing.N].id, p[G.pairing.X].id)).toBe(G.pairing.pk);
  });
});

describe("golden: request_sig (PA-Sig)", () => {
  for (const c of G.request_sig.cases) {
    it(c.name, async () => {
      const body = d(c.body);
      expect(b64urlEncode(signedBytes(c.method, c.path, c.pa_time, body))).toBe(c.signed_bytes);
      const h = new Headers({ "PA-Sig": c.sig });
      await checkSig(c.sign_pub, h, c.method, c.path, c.pa_time, body);
    });
  }
  for (const c of G.must_fail.cases.filter((x: { kind: string }) => x.kind === "request")) {
    it("must_fail " + c.name, async () => {
      const h = new Headers({ "PA-Sig": c.sig, "PA-Time": c.pa_time });
      const fn = async () => {
        checkTime(h, Number(c.pa_time));
        await checkSig(c.sign_pub, h, c.method, c.path, c.pa_time, d(c.body));
      };
      await expect(fn()).rejects.toThrow();
    });
  }
});

describe("golden: must_fail peer keys the Worker rejects at POST /peers", () => {
  const kinds = ["peer_entry_sign_pub_equals_enc_pub", "peer_entry_point_not_on_curve", "peer_entry_key_64_bytes", "peer_entry_compressed_key"];
  for (const c of G.must_fail.cases.filter((x: { name: string }) => kinds.includes(x.name))) {
    it(c.name, async () => {
      const s = rawPoint(c.sign_pub);
      const e = rawPoint(c.enc_pub);
      const accepted = !!s && !!e && !!(await importVerifyKey(s)) && !!(await importEcdhPub(e)) && c.sign_pub !== c.enc_pub;
      expect(accepted).toBe(false);
    });
  }
  it("POST /peers with golden peer S (sign_pub equal to enc_pub) -> 400", async () => {
    const sPeer = G.keys.peers.S;
    const k = await keys();
    const email = randomEmail();
    const body = { ticket: await ticketFor(email, sPeer.sign_pub, "register"), sign_pub: sPeer.sign_pub, enc_pub: sPeer.enc_pub, platform: "android", push: null };
    const r = await call("POST", "/v1/peers", body, { sign: k.sign });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "bad request" });
  });
});

describe("golden: rfc8291", () => {
  it("body byte for byte", async () => {
    const v = G.rfc8291;
    const asPub = d(v.as_public);
    const jwk = { kty: "EC", crv: "P-256", d: v.as_private, x: b64urlEncode(asPub.slice(1, 33)), y: b64urlEncode(asPub.slice(33)) };
    const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const publicKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, true, []);
    const body = await encryptAes128gcm(d(v.plaintext), d(v.ua_public), d(v.auth_secret), { salt: d(v.salt), asKeyPair: { privateKey, publicKey } });
    expect(b64urlEncode(body)).toBe(v.body);
  });
});
