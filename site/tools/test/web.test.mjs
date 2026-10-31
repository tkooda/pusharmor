// Unit tests for the site scripts: /js/pa-web.js (b64url, PA-REQ1 signing, throwaway key,
// API client with retries and the clock-skew retry) and /js/fx-queue.js (queue rule).
// Run: node --test site/tools/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUB = join(SITE, "public");
vm.runInThisContext(readFileSync(join(PUB, "js", "pa-web.js"), "utf8"), { filename: "pa-web.js" });
vm.runInThisContext(readFileSync(join(PUB, "js", "fx-queue.js"), "utf8"), { filename: "fx-queue.js" });
const PA = globalThis.PA;
const PAQ = globalThis.PAQ;
const subtle = webcrypto.subtle;
const enc = new TextEncoder();

function b64urlDecode(s) {
  return new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
}

async function verify(pubB64, sigB64, bytes) {
  const pub = await subtle.importKey("raw", b64urlDecode(pubB64), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  return subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64urlDecode(sigB64), bytes);
}

test("b64url: RFC 4648 vectors, URL alphabet, no padding", () => {
  const v = [["", ""], ["f", "Zg"], ["fo", "Zm8"], ["foo", "Zm9v"], ["foob", "Zm9vYg"], ["fooba", "Zm9vYmE"], ["foobar", "Zm9vYmFy"]];
  for (const [i, o] of v) assert.equal(PA.b64url(enc.encode(i)), o);
  assert.equal(PA.b64url(new Uint8Array([0xfb, 0xff])), "-_8");
  assert.equal(PA.b64url(new Uint8Array([0xff, 0xfe, 0xfd])), "__79");
});

test("PA-REQ1 signed bytes", () => {
  const body = enc.encode('{"ticket":"t","sign_pub":"p","m":{}}');
  const got = PA.reqSigBytes("DELETE", "/v1/account", "1761300000000", body);
  assert.equal(new TextDecoder().decode(got), 'PA-REQ1\nDELETE\n/v1/account\n1761300000000\n{"ticket":"t","sign_pub":"p","m":{}}');
  assert.equal(new TextDecoder().decode(PA.reqSigBytes("POST", "/v1/x", "1", new Uint8Array(0))), "PA-REQ1\nPOST\n/v1/x\n1\n");
});

test("throwaway key: 65-byte SEC1 pub, k = b64url(sha256(pub bytes)), raw r||s signature", async () => {
  const key = await PA.newKey();
  assert.equal(key.pub.length, 87);
  const raw = b64urlDecode(key.pub);
  assert.equal(raw.length, 65);
  assert.equal(raw[0], 4);
  assert.equal(PA.b64url(raw), key.pub);
  assert.equal(key.k, createHash("sha256").update(raw).digest("base64url"));
  const msg = enc.encode("hello");
  const sig = await PA.sign(key.priv, msg);
  assert.equal(b64urlDecode(sig).length, 64);
  assert.ok(await verify(key.pub, sig, msg));
  assert.ok(!(await verify(key.pub, sig, enc.encode("hellO"))));
});

test("key survives sessionStorage round trip and is removed after load", async () => {
  const store = new Map();
  const storage = { setItem: (k, v) => store.set(k, v), getItem: (k) => store.get(k) ?? null, removeItem: (k) => store.delete(k) };
  const key = await PA.newKey();
  await PA.saveKey(storage, key);
  const back = await PA.loadKey(storage);
  assert.equal(back.pub, key.pub);
  assert.equal(back.k, key.k);
  assert.ok(await verify(key.pub, await PA.sign(back.priv, enc.encode("x")), enc.encode("x")));
  assert.equal(store.size, 0);
  assert.equal(await PA.loadKey(storage), null);
});

// Fake API: replies is a list of {status, body, headers} or "neterr".
function fakeApi(replies, start = 1761300000000) {
  let now = start;
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, at: now });
    const r = replies.shift();
    if (r === "neterr") throw new TypeError("network");
    const h = new Map(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return { status: r.status, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, json: async () => r.body };
  };
  const client = new PA.Client({ fetch, now: () => now, sleep: async (ms) => { now += ms; } });
  return { client, calls, advance: (ms) => { now += ms; }, now: () => now };
}

test("DELETE /v1/account: headers, body, signature; deleted 0", async () => {
  const key = await PA.newKey();
  const api = fakeApi([{ status: 200, body: { r: {}, deleted: 0 }, headers: { "PA-Epoch": 1761300000 } }]);
  const r = await api.client.deleteAccount(key, "TICKET");
  assert.equal(r.status, 200);
  assert.equal(r.data.deleted, 0);
  assert.equal(api.calls.length, 1);
  const c = api.calls[0];
  assert.equal(c.url, "https://api.pusharmor.com/v1/account");
  assert.equal(c.init.method, "DELETE");
  assert.deepEqual(JSON.parse(c.init.body), { ticket: "TICKET", sign_pub: key.pub, m: {} });
  assert.equal(c.init.headers["PA-ID"], undefined);
  assert.match(c.init.headers["PA-Client"], /^web\/\d+\.\d+\.\d+$/);
  assert.equal(c.init.headers["PA-Time"], "1761300000000");
  assert.match(c.init.headers["PA-Time"], /^\d{13}$/);
  const signed = PA.reqSigBytes("DELETE", "/v1/account", c.init.headers["PA-Time"], enc.encode(c.init.body));
  assert.ok(await verify(key.pub, c.init.headers["PA-Sig"], signed));
  assert.equal(PA.TEXT.noPeers, "No devices were found under this address");
});

test("DELETE /v1/account retried after a lost reply is marked unsure", async () => {
  const key = await PA.newKey();
  let api = fakeApi(["neterr", { status: 200, body: { r: {}, deleted: 0 } }]);
  let r = await api.client.deleteAccount(key, "T");
  assert.equal(r.status, 200);
  assert.equal(r.data.deleted, 0);
  assert.equal(r.unsure, true);
  api = fakeApi([{ status: 503, body: {} }, { status: 200, body: { r: {}, deleted: 0 } }]);
  r = await api.client.deleteAccount(key, "T");
  assert.equal(r.unsure, true);
  api = fakeApi([{ status: 200, body: { r: {}, deleted: 0 } }]);
  r = await api.client.deleteAccount(key, "T");
  assert.equal(r.unsure, false);
  const js = readFileSync(join(PUB, "js", "delete-account.js"), "utf8");
  assert.ok(js.includes("r.data.deleted === 0 && !r.unsure ? PA.TEXT.noPeers : PA.TEXT.deleted"));
});

test("clock skew: offset from PA-Epoch (seconds), re-sign, retry once", async () => {
  const key = await PA.newKey();
  const skew = 10 * 60 * 1000;
  const api = fakeApi([
    { status: 401, body: { error: "clock skew" }, headers: { "PA-Epoch": 1761300000 + skew/1000 } },
    { status: 200, body: { r: {}, deleted: 2 }, headers: { "PA-Epoch": 1761300000 + skew/1000 } }
  ]);
  const r = await api.client.deleteAccount(key, "T");
  assert.equal(r.status, 200);
  assert.equal(api.calls.length, 2);
  assert.equal(api.calls[1].init.headers["PA-Time"], String(1761300000000 + skew));
  const c = api.calls[1];
  assert.ok(await verify(key.pub, c.init.headers["PA-Sig"], PA.reqSigBytes("DELETE", "/v1/account", c.init.headers["PA-Time"], enc.encode(c.init.body))));
});

test("HTTP 426 -> Update PushArmor to continue.", async () => {
  const key = await PA.newKey();
  const api = fakeApi([{ status: 426, body: { error: "update required" } }]);
  const r = await api.client.deleteAccount(key, "T");
  assert.equal(r.status, 426);
  assert.equal(PA.errorText(r), "Update PushArmor to continue.");
});

test("second clock skew stops with the clock text", async () => {
  const key = await PA.newKey();
  const skewed = { status: 401, body: { error: "clock skew" }, headers: { "PA-Epoch": 1 } };
  const api = fakeApi([skewed, { ...skewed }]);
  const r = await api.client.deleteAccount(key, "T");
  assert.equal(api.calls.length, 2);
  assert.equal(PA.errorText(r), "This device's clock is off by more than 5 minutes");
});

test("expired or invalid ticket -> Login expired, log in again (WEB6-01)", async () => {
  const key = await PA.newKey();
  for (const e of ["ticket expired", "invalid ticket"]) {
    const api = fakeApi([{ status: 401, body: { error: e } }]);
    const r = await api.client.deleteAccount(key, "T");
    assert.equal(api.calls.length, 1);
    assert.equal(PA.errorText(r), "Login expired, log in again");
  }
});

test("retries: 503 and network errors up to 3, not 502; 429 beyond the 8 s budget not retried", async () => {
  let api = fakeApi([{ status: 503, body: {} }, "neterr", { status: 503, body: {} }, { status: 200, body: { request_token: "rt" } }]);
  let r = await api.client.request("POST", "/v1/auth/email", { email: "a@b.com" }, null);
  assert.equal(r.status, 200);
  assert.equal(api.calls.length, 4);
  assert.equal(api.calls[0].init.headers["PA-Sig"], undefined);

  api = fakeApi([{ status: 503, body: {} }, { status: 503, body: {} }, { status: 503, body: {} }, { status: 503, body: {} }, { status: 200, body: {} }]);
  r = await api.client.request("POST", "/v1/auth/email", {}, null);
  assert.equal(r.status, 503);
  assert.equal(api.calls.length, 4);

  api = fakeApi([{ status: 502, body: { error: "email send failed" } }]);
  r = await api.client.request("POST", "/v1/auth/email", {}, null);
  assert.equal(api.calls.length, 1);
  assert.equal(PA.errorText(r), "Could not send the email, try again");

  api = fakeApi([{ status: 429, body: { error: "rate limited", retry_after: 60 }, headers: { "Retry-After": 60 } }]);
  r = await api.client.request("POST", "/v1/auth/email", {}, null);
  assert.equal(api.calls.length, 1);
  assert.match(PA.errorText(r), /wait 60 s/);

  api = fakeApi([{ status: 429, body: { retry_after: 2 }, headers: { "Retry-After": 2 } }, { status: 200, body: {} }]);
  r = await api.client.request("POST", "/v1/auth/email", {}, null);
  assert.equal(r.status, 200);
  assert.equal(api.calls[1].at - api.calls[0].at, 2000);
});

test("bad email text and ASCII pre-check", () => {
  assert.equal(PA.errorText({ status: 400, data: { error: "bad email" } }), "Only email addresses with plain ASCII characters are supported.");
  assert.equal(PA.isAscii("a@b.com"), true);
  assert.equal(PA.isAscii("a@b" + String.fromCharCode(233) + ".com"), false);
});

test("fx queue: 13 days kept, 15 days dropped, cap 150 drops the oldest", () => {
  const day = 86400000;
  const now = 1761300000000;
  const s = PAQ.select([{ id: 1, received: now - 15 * day }, { id: 2, received: now - 13 * day }], now);
  assert.deepEqual(s.keep.map((e) => e.id), [2]);
  assert.deepEqual(s.drop.map((e) => e.id), [1]);
  const many = Array.from({ length: 160 }, (_, i) => ({ id: i + 1, received: now }));
  const c = PAQ.select(many, now);
  assert.equal(c.keep.length, 150);
  assert.equal(c.keep[0].id, 11);
  assert.deepEqual(c.drop.map((e) => e.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("golden vectors (tests/vectors/golden-v1.json): request_sig (PA-Sig)", async (t) => {
  const p = join(SITE, "..", "tests", "vectors", "golden-v1.json");
  if (!existsSync(p)) { t.skip("tests/vectors/golden-v1.json not present yet"); return; }
  const cases = JSON.parse(readFileSync(p, "utf8")).request_sig.cases;
  assert.ok(cases.length > 0);
  for (const c of cases) {
    const bytes = PA.reqSigBytes(c.method, c.path, c.pa_time, b64urlDecode(c.body));
    assert.deepEqual(Buffer.from(bytes), Buffer.from(b64urlDecode(c.signed_bytes)), c.name + ": signed_bytes");
    assert.ok(await verify(c.sign_pub, c.sig, bytes), c.name + ": sig");
  }
});

test("cli link fragment: r/l map to purposes; d, bad letters and lengths fail", () => {
  const k = "abcdefghijklmnopqrstuv";
  assert.equal(k.length, 22);
  assert.deepEqual(PA.parseCliLink("#r." + k), { purpose: "register", k });
  assert.deepEqual(PA.parseCliLink("#l." + k), { purpose: "login", k });
  assert.equal(PA.parseCliLink("#l.A_-0123456789abcdefghi").k, "A_-0123456789abcdefghi");
  for (const bad of ["", "#", "#d." + k, "#x." + k, "#R." + k, "#l" + k, "#l." + k.slice(1), "#l." + k + "a", "#l.abcdefghijklmnopqrst+v", "l." + k, "#l." + k + "&x=1", null, undefined]) {
    assert.equal(PA.parseCliLink(bad), null, String(bad));
  }
});

test("cli email request body and OAuth start URL", () => {
  const link = PA.parseCliLink("#l.A_-0123456789abcdefghi");
  assert.deepEqual(PA.cliEmailBody("a@b.co", link, "TOK"), { email: "a@b.co", cli_k: "A_-0123456789abcdefghi", purpose: "login", turnstile: "TOK" });
  assert.equal(PA.cliOAuthUrl("google", link), "https://api.pusharmor.com/v1/auth/google?k=A_-0123456789abcdefghi&r=cli&p=login");
  assert.equal(PA.cliOAuthUrl("apple", PA.parseCliLink("#r.A_-0123456789abcdefghi")), "https://api.pusharmor.com/v1/auth/apple?k=A_-0123456789abcdefghi&r=cli&p=register");
});

test("cli result fragment: cli_code + email, errors, junk", () => {
  const code = "0123456789abcdefghijklmnopqrstuvwx";
  assert.equal(code.length, 34);
  assert.deepEqual(PA.parseCliResult("#cli_code=" + code + "&email=a%40b.co"), { code, email: "a@b.co" });
  assert.deepEqual(PA.parseCliResult("#error=cancelled"), { error: "cancelled" });
  assert.deepEqual(PA.parseCliResult("#error=failed"), { error: "failed" });
  assert.deepEqual(PA.parseCliResult("#cli_code=short&email=a%40b.co"), { error: "failed" });
  assert.equal(PA.parseCliResult("#l.abcdefghijklmnopqrstuv"), null);
  assert.equal(PA.parseCliResult(""), null);
});
