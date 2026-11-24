// File host b2file.pusharmor.com: key pattern, fixed headers, Range, limits, storage errors.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { handle } from "../src/index";
import type { Env } from "../src/env";
import { minuteOf, testing } from "../src/routes/file";
import { storeDeps, type FileStore, type GetResult } from "../src/file/store";
import { testing as logTesting } from "../src/log";
import { captured, countingLimit, freshIp, randBytes, testEnv } from "./helpers";

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
      if (from >= b.length) return "range";
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

function newKey(offsetS = 600): string {
  const m = minuteOf(Math.floor(Date.now() / 1000) + offsetS);
  return "v1/" + m + "/" + hex(8) + "/" + m + "-" + hex(16);
}

function looseEnv(over: Partial<Env> = {}): Promise<Env> {
  return testEnv({ RL_IP: countingLimit(0), RL_DL_IP: countingLimit(1e6), RL_DL_KEY: countingLimit(1e6), ...over });
}

async function get(path: string, o: { env?: Env; method?: string; headers?: Record<string, string>; ip?: string } = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const req = new Request("https://b2file.pusharmor.com" + path, { method: o.method ?? "GET", headers: { "CF-Connecting-IP": o.ip ?? freshIp(), ...o.headers } });
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
    expect((await get("/" + key, { headers: { Range: "bytes=500-" } })).status).toBe(416);
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

  it("GET only: other methods -> 405", async () => {
    const key = newKey();
    for (const method of ["POST", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
      const res = await get("/" + key, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET");
    }
    expect(store.gets).toEqual([]);
  });

  it("per IP 20/min and per key 10/min -> 429 rate limited", async () => {
    const key = newKey();
    store.objects.set(key, randBytes(5));
    const env = await looseEnv({ RL_DL_IP: countingLimit(20), RL_DL_KEY: countingLimit(10) });
    for (let i = 0; i < 10; i++) expect((await get("/" + key, { env })).status).toBe(200);
    const r = await get("/" + key, { env });
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ error: "rate limited" });
    const ip = freshIp();
    const env2 = await looseEnv({ RL_DL_IP: countingLimit(20), RL_DL_KEY: countingLimit(10) });
    for (let i = 0; i < 20; i++) expect((await get("/" + newKey(), { env: env2, ip })).status).toBe(404);
    expect((await get("/" + newKey(), { env: env2, ip })).status).toBe(429);
    expect((env2.RL_DL_IP as ReturnType<typeof countingLimit>).seen[0]).toBe("ip:" + ip);
    expect((env.RL_DL_KEY as ReturnType<typeof countingLimit>).seen[0]).toBe("dl:" + key);
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
});
