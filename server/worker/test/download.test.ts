// File host b2file.pusharmor.com: key pattern, signed GET, fixed headers, Range, limits, storage errors.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import vectors from "../../../tests/vectors/file-v1.json";
import { handle } from "../src/index";
import type { Env } from "../src/env";
import { b64urlEncode } from "../src/codec/b64url";
import { checkKeyhash, checkSig, downloadSignedBytes } from "../src/pipeline/signed";
import { peerId } from "../src/crypto/ids";
import { acctHash, minuteOf, testing } from "../src/routes/file";
import { storeDeps, type FileStore, type GetResult } from "../src/file/store";
import { testing as logTesting } from "../src/log";
import { captured, countingLimit, dlHeaders, freshIp, keys, randBytes, testEnv } from "./helpers";
import { TEST_SECRETS as S } from "./secrets";

interface Device {
  id: string;
  acct: string;
  hash: string;
  sign: CryptoKeyPair;
  signPub: string;
  encPub: string;
}

// A device of a fresh account (no D1 row: the file host never reads one).
async function device(acct = b64urlEncode(randBytes(9))): Promise<Device> {
  const k = await keys();
  return { id: await peerId(S.PA_ID_SECRET, acct, k.signRaw, k.encRaw), acct, hash: await acctHash(S.FILE_ACCT_SECRET, acct), sign: k.sign, signPub: k.signPub, encPub: k.encPub };
}

let dev: Device;
beforeAll(async () => {
  dev = await device();
});

class GetStore {
  objects = new Map<string, Uint8Array>();
  gets: { key: string; range: string | null }[] = [];
  next: "cap" | "throw" | null = null;
  async get(key: string, range: string | null): Promise<GetResult> {
    this.gets.push({ key, range });
    const forced = this.next;
    this.next = null;
    if (forced === "throw") throw new Error("store down");
    if (forced === "cap") return "cap";
    const b = this.objects.get(key);
    if (!b) return "missing";
    const m = range ? /^bytes=([0-9]+)-([0-9]*)$/.exec(range) : null;
    if (m) {
      const from = Number(m[1]);
      const to = m[2] === "" ? b.length - 1 : Math.min(Number(m[2]), b.length - 1);
      if (from >= b.length) return { status: 416, size: b.length };
      const part = b.slice(from, to + 1);
      return { status: 206, body: new Response(part).body!, length: part.length, contentRange: `bytes ${from}-${to}/${b.length}`, etag: '"e1"' };
    }
    return { status: 200, body: new Response(b).body!, length: b.length, contentRange: null, etag: '"e1"' };
  }
}

let store: GetStore;
beforeEach(() => {
  store = new GetStore();
  storeDeps.store = () => store as unknown as FileStore;
  testing.reset();
  logTesting.reset();
});
afterEach(() => testing.reset());

const hex = (n: number) => Array.from(randBytes(n), (x) => x.toString(16).padStart(2, "0")).join("");

function newKey(offsetS = 600, hash = dev.hash): string {
  const m = minuteOf(Math.floor(Date.now() / 1000) + offsetS);
  return "v1/" + m + "/" + hash + "/" + m + "-" + hex(16);
}

// D1 is never touched on the file host: any use of the DB binding throws.
const noDb = new Proxy({} as D1Database, {
  get() {
    throw new Error("DB used on the file host");
  },
});

function looseEnv(over: Partial<Env> = {}): Promise<Env> {
  const n = () => countingLimit(1e6);
  return testEnv({ DB: noDb, RL_IP: countingLimit(0), RL_DL_IP: n(), RL_DL_KEY: n(), RL_DL_PEER_KEY: n(), RL_DL_PEER: n(), RL_DL_ACCT: n(), ...over });
}

// Signed by `signer` (default: dev) unless `signer` is null.
async function get(path: string, o: { env?: Env; method?: string; headers?: Record<string, string>; ip?: string; signer?: Device | null; time?: string } = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const signer = o.signer === undefined ? dev : o.signer;
  const sig = signer ? await dlHeaders(signer, path, o.time) : {};
  const req = new Request("https://b2file.pusharmor.com" + path, { method: o.method ?? "GET", headers: { "CF-Connecting-IP": o.ip ?? freshIp(), ...sig, ...o.headers } });
  const res = await handle(req, o.env ?? (await looseEnv()), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const FIXED = {
  "content-type": "application/octet-stream",
  "x-content-type-options": "nosniff",
  "content-disposition": 'attachment; filename="file.bin"',
  "content-security-policy": "default-src 'none'; sandbox",
  "cross-origin-resource-policy": "cross-origin",
  "access-control-allow-origin": "*",
  "referrer-policy": "no-referrer",
  "accept-ranges": "bytes",
  "access-control-expose-headers": "Content-Range, ETag",
  etag: '"e1"',
  "cache-control": "no-store",
};

describe("file host", () => {
  it("every 200 carries exactly the fixed headers and the stored bytes (API rate limit not used)", async () => {
    const key = newKey();
    const bytes = randBytes(300);
    store.objects.set(key, bytes);
    const res = await get("/" + key);
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers)).toEqual(FIXED);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(store.gets).toEqual([{ key, range: null }]);
  });

  it("logs one line per GET with the bytes served", async () => {
    const key = newKey();
    store.objects.set(key, randBytes(123));
    captured.length = 0;
    await (await get("/" + key)).arrayBuffer();
    const lines = captured.filter((l) => l.includes('"route":"GET file"'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ status: 200, bytes: 123 });
  });

  it("serves a file after its expiry minute while it exists; 404 once deleted", async () => {
    const key = newKey(-600);
    store.objects.set(key, randBytes(10));
    expect((await get("/" + key)).status).toBe(200);
    store.objects.clear();
    const res = await get("/" + key);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("one byte range -> 206 with Content-Range; several ranges -> 200 full body", async () => {
    const key = newKey();
    const bytes = randBytes(100);
    store.objects.set(key, bytes);
    const r1 = await get("/" + key, { headers: { Range: "bytes=10-19" } });
    expect(r1.status).toBe(206);
    expect(r1.headers.get("Content-Range")).toBe("bytes 10-19/100");
    expect(new Uint8Array(await r1.arrayBuffer())).toEqual(bytes.slice(10, 20));
    const r2 = await get("/" + key, { headers: { Range: "bytes=0-1,5-6" } });
    expect(r2.status).toBe(200);
    expect(r2.headers.get("Content-Range")).toBeNull();
    expect(new Uint8Array(await r2.arrayBuffer())).toEqual(bytes);
    expect(store.gets.map((g) => g.range)).toEqual(["bytes=10-19", null]);
    const r3 = await get("/" + key, { headers: { Range: "bytes=500-" } });
    expect(r3.status).toBe(416);
    expect(r3.headers.get("Content-Range")).toBe("bytes */100");
    expect(r3.headers.get("Cache-Control")).toBe("no-store");
  });

  it("206 is never cached; a reversed range (bytes=5-2) is not passed on: 200 full body", async () => {
    const key = newKey();
    const bytes = randBytes(50);
    store.objects.set(key, bytes);
    const r1 = await get("/" + key, { headers: { Range: "bytes=0-9" } });
    expect(r1.status).toBe(206);
    expect(r1.headers.get("Cache-Control")).toBe("no-store");
    const r2 = await get("/" + key, { headers: { Range: "bytes=5-2" } });
    expect(r2.status).toBe(200);
    expect(new Uint8Array(await r2.arrayBuffer())).toEqual(bytes);
    expect(store.gets.map((g) => g.range)).toEqual(["bytes=0-9", null]);
  });

  it("a key minute more than 24 h + 5 min behind -> 404 with no storage call", async () => {
    const now = Math.floor(Date.now() / 1000);
    const old = minuteOf(now - 86400 - 300 - 120);
    const res = await get(`/v1/${old}/${hex(8)}/${old}-${hex(16)}`);
    expect(res.status).toBe(404);
    expect(store.gets).toEqual([]);
    const recent = minuteOf(now - 86400 + 120);
    expect((await get(`/v1/${recent}/${dev.hash}/${recent}-${hex(16)}`)).status).toBe(404);
    expect(store.gets).toHaveLength(1);
  });

  it("an unexpected error -> 503 unavailable with the error header set", async () => {
    storeDeps.store = () => {
      throw new Error("boom");
    };
    const res = await get("/" + newKey());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("refuses paths off the key pattern, query strings and far-future minutes with no storage call", async () => {
    const m = minuteOf(Math.floor(Date.now() / 1000) + 600);
    const m2 = minuteOf(Math.floor(Date.now() / 1000) + 1200);
    const h = hex(8);
    const id = hex(16);
    const far = minuteOf(Math.floor(Date.now() / 1000) + 86400 + 180);
    const cases = [
      `/v1/${m}/${h}/${m2}-${id}`, // minute fields differ
      `/v1/${m}/${h.toUpperCase()}/${m}-${id}`,
      `/v1/${m}/${h}/${m}-${id.toUpperCase()}`,
      `/v1/${m}/${h.slice(1)}/${m}-${id}`,
      `/v1/${m}/${h}/${m}-${id}/`,
      `/v1/${m}/${h}/${m}-${id}/x`,
      `/v1/${m}/${h}/${m}_${id}`,
      `/v1//${m}/${h}/${m}-${id}`,
      `/${m}/${h}/${m}-${id}`,
      `/v1/${far}/${h}/${far}-${id}`,
      `/v1/209913310000/${h}/209913310000-${id}`,
      `/v1/${m}/${h}/${m}-${id}?`,
      `/v1/${m}/${h}/${m}-${id}?x=1`,
      "/",
      "/v1/file",
    ];
    for (const p of cases) {
      const res = await get(p);
      expect(res.status, p).toBe(404);
      expect(await res.json(), p).toEqual({ error: "not found" });
    }
    const v2 = await get(`/v2/${m}/${h}/${m}-${id}`);
    expect(v2.status).toBe(404);
    expect(await v2.json()).toEqual({ error: "update required" });
    expect(store.gets).toEqual([]);
  });

  it("a CORS preflight -> 204 allowing GET with the signed download headers, no storage call", async () => {
    const res = await get("/" + newKey(), { method: "OPTIONS", signer: null, headers: { Origin: "chrome-extension://abc", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "pa-id,pa-time,pa-sig,pa-sign-pub,pa-enc-pub" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("PA-ID, PA-Time, PA-Sig, PA-Sign-Pub, PA-Enc-Pub, Range");
    expect(store.gets).toEqual([]);
  });

  it("GET only: other methods -> 405", async () => {
    const key = newKey();
    for (const method of ["POST", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
      const res = await get("/" + key, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET");
    }
    expect(store.gets).toEqual([]);
  });

  it("per IP 60/min and per key 30/min -> 429 rate limited", async () => {
    const key = newKey();
    store.objects.set(key, randBytes(5));
    const env = await looseEnv({ RL_DL_IP: countingLimit(60), RL_DL_KEY: countingLimit(30) });
    for (let i = 0; i < 30; i++) expect((await get("/" + key, { env, signer: await device(dev.acct) })).status).toBe(200);
    const r = await get("/" + key, { env, signer: await device(dev.acct) });
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ error: "rate limited" });
    const ip = freshIp();
    const env2 = await looseEnv({ RL_DL_IP: countingLimit(60), RL_DL_KEY: countingLimit(30) });
    for (let i = 0; i < 60; i++) expect((await get("/" + newKey(), { env: env2, ip })).status).toBe(404);
    expect((await get("/" + newKey(), { env: env2, ip })).status).toBe(429);
    expect((env2.RL_DL_IP as ReturnType<typeof countingLimit>).seen[0]).toBe("ip:" + ip);
    expect((env.RL_DL_KEY as ReturnType<typeof countingLimit>).seen[0]).toBe("dl:" + key);
  });

  it("per device per key 5/min, per device 30/min, per account 120/min -> 429 with retry_after", async () => {
    const key = newKey();
    store.objects.set(key, randBytes(5));
    const env = await looseEnv({ RL_DL_PEER_KEY: countingLimit(5) });
    for (let i = 0; i < 5; i++) expect((await get("/" + key, { env })).status).toBe(200);
    const r1 = await get("/" + key, { env });
    expect(r1.status).toBe(429);
    expect(await r1.json()).toMatchObject({ error: "rate limited", retry_after: expect.any(Number) });
    expect((env.RL_DL_PEER_KEY as ReturnType<typeof countingLimit>).seen[0]).toBe("dl:" + dev.id + ":" + key);
    expect((await get("/" + key, { env, signer: await device(dev.acct) })).status).toBe(200);

    const env2 = await looseEnv({ RL_DL_PEER: countingLimit(30) });
    for (let i = 0; i < 30; i++) expect((await get("/" + newKey(), { env: env2 })).status).toBe(404);
    const r2 = await get("/" + key, { env: env2 });
    expect(r2.status).toBe(429);
    expect(await r2.json()).toMatchObject({ error: "rate limited", retry_after: expect.any(Number) });
    expect((env2.RL_DL_PEER as ReturnType<typeof countingLimit>).seen[0]).toBe("id:" + dev.id);
    expect((await get("/" + key, { env: env2, signer: await device(dev.acct) })).status).toBe(200);

    const env3 = await looseEnv({ RL_DL_ACCT: countingLimit(120) });
    for (let i = 0; i < 120; i++) expect((await get("/" + newKey(), { env: env3, signer: await device(dev.acct) })).status).toBe(404);
    const r3 = await get("/" + key, { env: env3, signer: await device(dev.acct) });
    expect(r3.status).toBe(429);
    expect(await r3.json()).toMatchObject({ error: "rate limited", retry_after: expect.any(Number) });
    expect((env3.RL_DL_ACCT as ReturnType<typeof countingLimit>).seen[0]).toBe("acct:" + dev.acct);
    const other = await device();
    store.objects.set(newKey(600, other.hash), randBytes(1));
    const okey = [...store.objects.keys()].pop()!;
    expect((await get("/" + okey, { env: env3, signer: other })).status).toBe(200);
  });

  it("a storage error -> 502", async () => {
    store.next = "throw";
    const res = await get("/" + newKey());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "storage error" });
  });

  it("a storage cap -> 503 files paused with retry_after to 00:00 UTC, remembered with no storage call", async () => {
    store.next = "cap";
    const r1 = await get("/" + newKey());
    expect(r1.status).toBe(503);
    const b = (await r1.json()) as { error: string; retry_after: number };
    expect(b.error).toBe("files paused");
    expect((Math.floor(Date.now() / 1000) + b.retry_after) % 86400).toBe(0);
    store.gets.length = 0;
    const r2 = await get("/" + newKey());
    expect(r2.status).toBe(503);
    expect(store.gets).toEqual([]);
  });

  it("no storage configured -> 503 files paused", async () => {
    storeDeps.store = () => null;
    const res = await get("/" + newKey());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "files paused" });
  });

  it("unsigned, a missing or bad PA-Sig, or a missing PA-ID -> 401 with no storage call and no limit charged", async () => {
    const key = newKey();
    store.objects.set(key, randBytes(5));
    const env = await looseEnv();
    const h = await dlHeaders(dev, "/" + key);
    const bad = await dlHeaders(dev, "/" + newKey());
    const cases: [Device | null, Record<string, string>][] = [
      [dev, { "PA-Sig": bad["PA-Sig"] }],
      [dev, { "PA-Sig": "x".repeat(86) }],
      [null, { "PA-ID": h["PA-ID"], "PA-Time": h["PA-Time"], "PA-Sign-Pub": dev.signPub, "PA-Enc-Pub": dev.encPub }],
      [null, { "PA-Time": h["PA-Time"], "PA-Sig": h["PA-Sig"], "PA-Sign-Pub": dev.signPub, "PA-Enc-Pub": dev.encPub }],
    ];
    for (const [signer, headers] of cases) {
      const res = await get("/" + key, { env, signer, headers });
      expect(res.status, JSON.stringify(Object.keys(headers))).toBe(401);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    }
    expect(store.gets).toEqual([]);
    for (const b of ["RL_DL_PEER", "RL_DL_ACCT", "RL_DL_PEER_KEY", "RL_DL_KEY"] as const) expect((env[b] as ReturnType<typeof countingLimit>).seen, b).toEqual([]);
  });

  it("keys that do not match the PA-ID keyhash -> 401 invalid client signature", async () => {
    const key = newKey();
    store.objects.set(key, randBytes(5));
    const other = await device(dev.acct);
    // Signed by `other` and sending its keys, but with dev's PA-ID.
    const h = await dlHeaders(other, "/" + key);
    const swaps: Record<string, string>[] = [{ "PA-ID": dev.id }, { "PA-ID": dev.id, "PA-Enc-Pub": dev.encPub }, { "PA-Sign-Pub": "" }, { "PA-Enc-Pub": "x" }];
    for (const headers of swaps) {
      const res = await get("/" + key, { signer: null, headers: { ...h, ...headers } });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid client signature" });
    }
    expect(store.gets).toEqual([]);
  });

  it("a device of another account -> 403 wrong account, before the per-file limits, no storage call", async () => {
    const key = newKey();
    store.objects.set(key, randBytes(5));
    const env = await looseEnv();
    const res = await get("/" + key, { env, signer: await device() });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "wrong account" });
    expect(store.gets).toEqual([]);
    expect((env.RL_DL_KEY as ReturnType<typeof countingLimit>).seen).toEqual([]);
    expect((env.RL_DL_PEER_KEY as ReturnType<typeof countingLimit>).seen).toEqual([]);
  });

  it("a stale or future PA-Time -> 401 clock skew; none -> 400", async () => {
    const key = newKey();
    store.objects.set(key, randBytes(5));
    for (const t of [Date.now() - 301_000, Date.now() + 301_000]) {
      const res = await get("/" + key, { time: String(t) });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "clock skew" });
      expect(res.headers.get("PA-Epoch")).toMatch(/^[0-9]{10}$/);
      expect(Math.abs(Number(res.headers.get("PA-Epoch")) - Date.now() / 1000)).toBeLessThan(5);
      expect(res.headers.get("Access-Control-Expose-Headers")).toBe("PA-Epoch");
    }
    const h = await dlHeaders(dev, "/" + key);
    delete h["PA-Time"];
    expect((await get("/" + key, { signer: null, headers: h })).status).toBe(400);
    expect(store.gets).toEqual([]);
  });

  it("a signature over another path or time does not serve; a valid one does with no D1 access", async () => {
    const key = newKey();
    store.objects.set(key, randBytes(5));
    const t = String(Date.now());
    const h = await dlHeaders(dev, "/" + key, t);
    expect((await get("/" + key, { signer: null, headers: { ...h, "PA-Time": String(Number(t) + 1) } })).status).toBe(401);
    const res = await get("/" + key, { env: await looseEnv(), signer: null, headers: { ...h, Range: "bytes=0-1" } });
    expect(res.status).toBe(206);
  });
});

describe("vectors (download_sig)", () => {
  it("PA-DL1 signing strings, keyhash and signatures", async () => {
    expect(vectors.download_sig.cases.length).toBeGreaterThan(0);
    for (const c of vectors.download_sig.cases) {
      const signed = downloadSignedBytes(c.path, c.pa_time);
      expect(new TextDecoder().decode(signed), c.name).toBe(c.signed_text);
      expect(b64urlEncode(signed), c.name).toBe(c.signed_bytes);
      expect(new URL(c.url).pathname, c.name).toBe(c.path);
      const h = new Headers(c.headers);
      await checkKeyhash(h.get("PA-ID")!, h.get("PA-Sign-Pub")!, h.get("PA-Enc-Pub")!);
      const p = checkSig(h.get("PA-Sign-Pub")!, h, c.method, c.path, c.pa_time, new Uint8Array(0), signed);
      if (c.verifies) await p;
      else await expect(p, c.name).rejects.toMatchObject({ status: 401, word: "invalid client signature" });
    }
  });
});
