// POST /v1/file: check order, PA-FILE1, quota Durable Object, ttl/id/key vectors, refusals.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env as baseEnv, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import vectors from "../../../tests/vectors/file-v1.json";
import pinned from "../routes.json";
import { handle } from "../src/index";
import type { Env } from "../src/env";
import { b64urlDecode, b64urlEncode } from "../src/codec/b64url";
import { sha256 } from "../src/crypto/hash";
import { fileDeleteSignedBytes, fileSignedBytes } from "../src/pipeline/signed";
import { BLOB_OVERHEAD, MAX_FILE, acctHash, fileName, hex, minuteOf, testing, ttlMinutes } from "../src/routes/file";
import { chargeRow, dayOf, MAX_SLOTS, refundRow, type QuotaRow } from "../src/file/quota";
import { testing as logTesting } from "../src/log";
import { storeDeps, type FileStore, type GetResult, type PutResult, type RemoveResult, type Version } from "../src/file/store";
import { captured, countingLimit, dlHeaders, freshIp, initP256, newPeer, randBytes, randomEmail, setAllow, testEnv, type Peer } from "./helpers";
import { TEST_SECRETS as S } from "./secrets";

beforeAll(initP256);

// In-memory object store: checks the declared length and SHA-256 like the real store.
class MemStore implements FileStore {
  objects = new Map<string, Uint8Array>();
  next: PutResult | "throw" | null = null; // forced result for the next put or remove
  calls: string[] = []; // "put", "remove"
  afterRead: (() => void) | null = null; // runs once the body is read
  async put(key: string, body: ReadableStream<Uint8Array>, length: number, sha: Uint8Array): Promise<PutResult> {
    this.calls.push("put");
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    this.afterRead?.();
    const forced = this.next;
    this.next = null;
    if (forced === "throw") throw new Error("store down");
    if (forced) return forced;
    if (bytes.length !== length || b64urlEncode(await sha256(bytes)) !== b64urlEncode(sha)) return "mismatch";
    this.objects.set(key, bytes);
    return "ok";
  }
  async remove(key: string): Promise<RemoveResult> {
    this.calls.push("remove");
    const forced = this.next;
    this.next = null;
    if (forced === "throw") throw new Error("store down");
    if (forced === "cap") return "cap";
    return this.objects.delete(key) ? "ok" : "missing";
  }
  async get(key: string): Promise<GetResult> {
    const b = this.objects.get(key);
    if (!b) return "missing";
    return { status: 200, body: new Response(b).body!, length: b.length, contentRange: null, etag: null };
  }
  listPrefixesPage(): Promise<{ prefixes: string[] }> {
    throw new Error("unused");
  }
  listVersionsPage(): Promise<{ versions: Version[]; more: boolean }> {
    throw new Error("unused");
  }
  listVersions(): Promise<Version[]> {
    throw new Error("unused");
  }
  deleteVersions(): Promise<"ok"> {
    throw new Error("unused");
  }
}

let store: MemStore;
beforeEach(() => {
  store = new MemStore();
  storeDeps.store = () => store;
  testing.reset();
  logTesting.reset();
});
afterEach(() => {
  testing.reset();
});

const sendId = () => b64urlEncode(randBytes(16));

interface Up {
  peer: Peer;
  body?: Uint8Array;
  sid?: string;
  env?: Env;
  headers?: Record<string, string | null>; // null removes a header
  sigLength?: number; // Content-Length value signed, when it differs
}

async function upload(o: Up): Promise<{ status: number; body: Record<string, unknown>; res: Response }> {
  const body = o.body ?? randBytes(100);
  const time = String(Date.now());
  const sha = b64urlEncode(await sha256(body));
  const sid = o.sid ?? sendId();
  const signed = fileSignedBytes(time, o.sigLength ?? body.length, sha, sid);
  const sig = b64urlEncode(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, o.peer.sign.privateKey, signed)));
  const h: Record<string, string> = {
    "CF-Connecting-IP": freshIp(),
    "Content-Type": "application/octet-stream",
    "Content-Length": String(body.length),
    "PA-ID": o.peer.id,
    "PA-Time": time,
    "PA-Client": "cli/0.0.55",
    "PA-File-SHA256": sha,
    "PA-Send-ID": sid,
    "PA-Sig": sig,
  };
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    if (v === null) delete h[k];
    else h[k] = v;
  }
  const req = new Request("https://api.pusharmor.com/v1/file", { method: "POST", headers: h, body });
  const ctx = createExecutionContext();
  const res = await handle(req, o.env ?? (await looseEnv()), ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {}, res };
}

// Rate limits that never trip unless a test sets its own.
function looseEnv(over: Partial<Env> = {}): Promise<Env> {
  return testEnv({ RL_IP: countingLimit(1e6), RL_PEER: countingLimit(1e6), RL_ACCT: countingLimit(1e6), RL_FILE: countingLimit(1e6), ...over });
}

// Sender approved by a second peer of the same account.
async function approvedSender(): Promise<Peer> {
  const email = randomEmail();
  const a = await newPeer(email, "android");
  const b = await newPeer(email, "chrome");
  await setAllow(b, [a.id]);
  return a;
}

async function quotaRow(acct: string): Promise<QuotaRow | undefined> {
  const stub = baseEnv.FILE_QUOTA.get(baseEnv.FILE_QUOTA.idFromName(acct));
  return runInDurableObject(stub, (_i, state) => state.storage.get<QuotaRow>("q"));
}

describe("route", () => {
  it("POST /v1/file is a pinned route", () => {
    expect(pinned.routes).toContain("POST /v1/file");
  });

  it("201 with id, expires, url and quota; the object is stored under the key", async () => {
    const a = await approvedSender();
    const body = randBytes(1000);
    const t0 = Math.floor(Date.now() / 1000);
    const r = await upload({ peer: a, body });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(["expires", "id", "quota", "url"]);
    const exp = r.body.expires as number;
    expect(exp - t0).toBeGreaterThanOrEqual(86400);
    expect(exp - t0).toBeLessThanOrEqual(86401);
    const id = r.body.id as string;
    expect(id).toMatch(/^[0-9]{12}-[0-9a-f]{32}$/);
    expect(id.slice(0, 12)).toBe(minuteOf(exp));
    const key = "v1/" + minuteOf(exp) + "/" + (await acctHash(S.FILE_ACCT_SECRET, a.acct)) + "/" + id;
    expect(r.body.url).toBe("https://b2file.pusharmor.com/" + key);
    expect(store.objects.get(key)).toEqual(body);
    const q = r.body.quota as { day: { used: number; limit: number; resets_at: number }; month: { used: number; limit: number } };
    expect(q.day).toMatchObject({ used: 1, limit: 20 });
    expect(q.day.resets_at % 86400).toBe(0);
    expect(q.month).toMatchObject({ used: 1, limit: 100 });
  });

  it("has no BODY_CAP limit", async () => {
    const a = await approvedSender();
    const r = await upload({ peer: a, body: new Uint8Array(200_000).fill(7) });
    expect(r.status).toBe(201);
  });

  it("other routes keep the BODY_CAP limit", async () => {
    const r = await handle(
      new Request("https://api.pusharmor.com/v1/send", { method: "POST", headers: { "Content-Length": "121741", "CF-Connecting-IP": freshIp() }, body: new Uint8Array(121741).fill(7) }),
      await looseEnv(),
      createExecutionContext(),
    );
    expect(r.status).toBe(413);
  });
});

describe("check 1: Content-Length and headers", () => {
  it("no Content-Length -> 411", async () => {
    const a = await approvedSender();
    const r = await upload({ peer: a, headers: { "Content-Length": null } });
    expect(r.status).toBe(411);
    expect(r.body).toEqual({ error: "length required" });
  });

  it("ttl vector statuses for 413 and 400 (Content-Length checked before anything else)", async () => {
    const a = await approvedSender();
    for (const c of vectors.ttl.cases.filter((x) => x.status !== 201)) {
      const r = await upload({ peer: a, body: new Uint8Array(0), headers: { "Content-Length": String(c.content_length) } });
      expect(r.status, c.name).toBe(c.status);
    }
    expect(MAX_FILE).toBe(vectors.constants.MAX_FILE);
    expect(BLOB_OVERHEAD).toBe(vectors.constants.BLOB_OVERHEAD);
    expect(await quotaRow(a.acct)).toBeUndefined();
  });

  it("PA-Send-ID missing or malformed -> 400", async () => {
    const a = await approvedSender();
    for (const v of [null, "", "short", sendId() + "A", "!".repeat(22), sendId().slice(0, 21) + "B"]) {
      const r = await upload({ peer: a, headers: { "PA-Send-ID": v } });
      expect(r.status, String(v)).toBe(400);
    }
    expect(await quotaRow(a.acct)).toBeUndefined();
  });

  it("PA-File-SHA256 malformed -> 400", async () => {
    const a = await approvedSender();
    const r = await upload({ peer: a, headers: { "PA-File-SHA256": "abc" } });
    expect(r.status).toBe(400);
  });
});

describe("checks 2-6: signature, caller, approval (no charge)", () => {
  it("PA-Sig over another Content-Length -> 401, quota row unchanged", async () => {
    const a = await approvedSender();
    const r = await upload({ peer: a, sigLength: 99 });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: "invalid client signature" });
    expect(await quotaRow(a.acct)).toBeUndefined();
  });

  it("logged out -> 401, quota row unchanged", async () => {
    const a = await approvedSender();
    await baseEnv.DB.prepare("UPDATE peers SET logged_out = 1 WHERE id = ?1").bind(a.id).run();
    const r = await upload({ peer: a });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: "logged out" });
    expect(await quotaRow(a.acct)).toBeUndefined();
  });

  it("not approved by another peer -> 403 unapproved, quota row unchanged", async () => {
    const email = randomEmail();
    const a = await newPeer(email, "android");
    const b = await newPeer(email, "chrome");
    await setAllow(a, [b.id]); // a approves b, nobody approves a
    const r = await upload({ peer: a });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "unapproved" });
    expect(await quotaRow(a.acct)).toBeUndefined();
    expect(captured.some((l) => l.includes('"route":"POST /v1/file"') && l.includes('"status":403'))).toBe(true);
  });

  it("stale PA-Time -> 401 clock skew", async () => {
    const a = await approvedSender();
    const r = await upload({ peer: a, headers: { "PA-Time": String(Date.now() - 400_000) } });
    expect(r.status).toBe(401);
  });
});

describe("check 7: RL_FILE", () => {
  it("5 per minute per device; the 6th is 429 rate limited and not charged", async () => {
    const a = await approvedSender();
    const env = await looseEnv({ RL_FILE: countingLimit(5) });
    const sid = sendId();
    for (let i = 0; i < 5; i++) {
      store.next = "throw";
      expect((await upload({ peer: a, env, sid })).status).toBe(502);
    }
    const r = await upload({ peer: a, env });
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ error: "rate limited" });
    expect((await quotaRow(a.acct))?.day_count).toBe(2); // attempts 1-3 one charge, 4-5 a second
  });
});

describe("check 8: pause vars and storage cap", () => {
  it("vars missing -> 503 files paused with no retry_after; one alert per isolate, then refusal lines", async () => {
    const a = await approvedSender();
    const lines: string[][] = [];
    for (const over of [{ PA_FILE_DAY_LIMIT: undefined }, { PA_FILE_MONTH_LIMIT: "" }, { PA_FILE_DAY_LIMIT: "x1" }]) {
      captured.length = 0;
      const r = await upload({ peer: a, env: await looseEnv(over) });
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ error: "files paused" });
      lines.push(captured.filter((l) => l.includes('"route":"POST /v1/file"')));
    }
    expect(lines[0].some((l) => l.includes('"alert":"files"') && l.includes('"file":"config"'))).toBe(true);
    for (const ls of lines.slice(1)) {
      expect(ls.some((l) => l.includes('"file":"config"'))).toBe(true);
      expect(ls.some((l) => l.includes('"alert"'))).toBe(false);
    }
    expect(await quotaRow(a.acct)).toBeUndefined();
  });

  it("paused refusal lines count toward the per-isolate refusal cap", async () => {
    const a = await approvedSender();
    const env = await looseEnv({ PA_FILE_DAY_LIMIT: "0" });
    captured.length = 0;
    for (let i = 0; i < 12; i++) expect((await upload({ peer: a, env })).status).toBe(503);
    expect(captured.filter((l) => l.includes('"file":"paused"'))).toHaveLength(10);
  });

  it("no storage or a bad FILE_ACCT_SECRET -> 503 files paused with an alert and no charge", async () => {
    const a = await approvedSender();
    storeDeps.store = () => null;
    captured.length = 0;
    const r1 = await upload({ peer: a });
    expect(r1.status).toBe(503);
    expect(r1.body).toEqual({ error: "files paused" });
    expect(captured.some((l) => l.includes('"alert":"files"'))).toBe(true);
    storeDeps.store = () => store;
    testing.reset();
    for (const bad of ["", "short", undefined as unknown as string]) {
      const r = await upload({ peer: a, env: await looseEnv({ FILE_ACCT_SECRET: bad }) });
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ error: "files paused" });
    }
    expect(await quotaRow(a.acct)).toBeUndefined();
  });

  it("a quota var of 0 pauses without an alert", async () => {
    const a = await approvedSender();
    captured.length = 0;
    const r = await upload({ peer: a, env: await looseEnv({ PA_FILE_MONTH_LIMIT: "0" }) });
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: "files paused" });
    expect(captured.some((l) => l.includes('"file":"paused"') && !l.includes('"alert"'))).toBe(true);
    expect(await quotaRow(a.acct)).toBeUndefined();
  });

  it("a storage cap pauses uploads until 00:00 UTC, refused before the charge", async () => {
    const a = await approvedSender();
    store.next = "cap";
    const r1 = await upload({ peer: a });
    expect(r1.status).toBe(503);
    expect(r1.body.error).toBe("files paused");
    const ra = r1.body.retry_after as number;
    const now = Math.floor(Date.now() / 1000);
    expect(now + ra - ((now + ra) % 86400)).toBe(now + ra);
    const r2 = await upload({ peer: a });
    expect(r2.status).toBe(503);
    expect(typeof r2.body.retry_after).toBe("number");
    expect((await quotaRow(a.acct))?.day_count).toBe(1);
  });
});

describe("check 9: quota", () => {
  it("3 failed attempts of one send raise day_count by 1", async () => {
    const a = await approvedSender();
    const sid = sendId();
    for (let i = 0; i < 3; i++) {
      store.next = "throw";
      expect((await upload({ peer: a, sid })).status).toBe(502);
    }
    expect(await quotaRow(a.acct)).toMatchObject({ day_count: 1, month_count: 1, sends: { [a.id]: { send_id: sid, attempts: 3 } } });
  });

  it("send slots are per device: A fails X, B uploads Y, A retries X -> not charged", async () => {
    const email = randomEmail();
    const a = await newPeer(email, "android");
    const b = await newPeer(email, "chrome");
    await setAllow(a, [b.id]);
    await setAllow(b, [a.id]);
    const x = sendId();
    store.next = "throw";
    expect((await upload({ peer: a, sid: x })).status).toBe(502);
    expect((await upload({ peer: b })).status).toBe(201);
    const r = await upload({ peer: a, sid: x });
    expect(r.status).toBe(201);
    expect((r.body.quota as { day: { used: number } }).day.used).toBe(2);
  });

  it("a retry 20 min after the first attempt is not charged", async () => {
    const a = await approvedSender();
    const sid = sendId();
    store.next = "throw";
    expect((await upload({ peer: a, sid })).status).toBe(502);
    const stub = baseEnv.FILE_QUOTA.get(baseEnv.FILE_QUOTA.idFromName(a.acct));
    const r = await stub.charge(a.id, sid, 20, 100, Math.floor(Date.now() / 1000) + 1200);
    expect(r).toMatchObject({ ok: true, charged: false });
    expect(await quotaRow(a.acct)).toMatchObject({ day_count: 1, sends: { [a.id]: { send_id: sid, attempts: 2 } } });
  });

  it("the 4th POST of one id is charged", async () => {
    const a = await approvedSender();
    const sid = sendId();
    for (let i = 0; i < 3; i++) expect((await upload({ peer: a, sid })).status).toBe(201);
    expect((await quotaRow(a.acct))?.day_count).toBe(1);
    const r = await upload({ peer: a, sid });
    expect(r.status).toBe(201);
    expect((r.body.quota as { day: { used: number } }).day.used).toBe(2);
  });

  it("60 POSTs with one id raise day_count by 20", async () => {
    const a = await approvedSender();
    const env = await looseEnv({ PA_FILE_DAY_LIMIT: "1000", PA_FILE_MONTH_LIMIT: "1000" });
    const sid = sendId();
    for (let i = 0; i < 60; i++) expect((await upload({ peer: a, sid, env, body: randBytes(28) })).status).toBe(201);
    expect(await quotaRow(a.acct)).toMatchObject({ day_count: 20, month_count: 20 });
  });

  it("a hash mismatch is charged and never refunded", async () => {
    const a = await approvedSender();
    const r = await upload({ peer: a, headers: { "PA-File-SHA256": b64urlEncode(randBytes(32)) } });
    expect(r.status).toBe(401); // the header is signed
    store.next = "mismatch";
    const r2 = await upload({ peer: a });
    expect(r2.status).toBe(400);
    expect(r2.body).toEqual({ error: "hash mismatch" });
    expect((await quotaRow(a.acct))?.day_count).toBe(1);
  });

  it("over the day limit -> 429 file quota with quota and retry_after; a free retry still passes", async () => {
    const a = await approvedSender();
    const env = await looseEnv({ PA_FILE_DAY_LIMIT: "2" });
    expect((await upload({ peer: a, env })).status).toBe(201);
    const last = sendId();
    expect((await upload({ peer: a, env, sid: last })).status).toBe(201);
    captured.length = 0;
    const r = await upload({ peer: a, env });
    expect(r.status).toBe(429);
    expect(r.body.error).toBe("file quota");
    expect(r.res.headers.get("Retry-After")).toBe(String(r.body.retry_after));
    const q = r.body.quota as { day: { used: number; limit: number; resets_at: number } };
    expect(q.day).toMatchObject({ used: 2, limit: 2 });
    expect(r.body.retry_after).toBe(q.day.resets_at - Math.floor(Date.now() / 1000));
    expect(captured.some((l) => l.includes('"status":429') && l.includes('"error":"file quota"'))).toBe(true);
    expect((await upload({ peer: a, env, sid: last })).status).toBe(201);
  });

  it("logs one line when an upload uses the last of the day", async () => {
    const a = await approvedSender();
    const env = await looseEnv({ PA_FILE_DAY_LIMIT: "1", PA_LOG_SAMPLE: "0" });
    captured.length = 0;
    expect((await upload({ peer: a, env })).status).toBe(201);
    expect(captured.filter((l) => l.includes('"file":"day-cap"'))).toHaveLength(1);
  });

  it("logs both caps when one upload uses the last of the day and of the month", async () => {
    const a = await approvedSender();
    const env = await looseEnv({ PA_FILE_DAY_LIMIT: "1", PA_FILE_MONTH_LIMIT: "1", PA_LOG_SAMPLE: "0" });
    captured.length = 0;
    expect((await upload({ peer: a, env })).status).toBe(201);
    expect(captured.filter((l) => l.includes('"file":"day-cap,month-cap"'))).toHaveLength(1);
  });

  it("Content-Length must be canonical decimal", async () => {
    const a = await approvedSender();
    for (const v of ["0100", "+100", "1e2", "00"]) {
      const r = await upload({ peer: a, headers: { "Content-Length": v } });
      expect(r.status, v).toBe(400);
    }
  });

  it("keeps at most MAX_SLOTS device slots, dropping the oldest", () => {
    expect(MAX_SLOTS).toBe(25);
    let row: QuotaRow | undefined;
    for (let i = 0; i <= MAX_SLOTS; i++) row = chargeRow(row, "dev" + i, "s" + i, 1000, 1000, 1_800_000_000).row!;
    expect(Object.keys(row!.sends)).toHaveLength(MAX_SLOTS);
    expect(row!.sends.dev0).toBeUndefined();
    expect(row!.sends["dev" + MAX_SLOTS]).toEqual({ send_id: "s" + MAX_SLOTS, attempts: 1 });
  });

  it("chargeRow resets counts on a new UTC day and month", () => {
    const t = Date.UTC(2026, 10, 30, 23, 59, 0) / 1000;
    const r1 = chargeRow(undefined, "d", "a", 20, 100, t).row!;
    expect(r1).toMatchObject({ day_count: 1, month_count: 1, sends: { d: { send_id: "a", attempts: 1 } } });
    const r2 = chargeRow(r1, "d", "b", 20, 100, t + 120).row!;
    expect(r2).toMatchObject({ day_count: 1, month_count: 1, month: Date.UTC(2026, 11, 1) / 1000 });
  });
});

async function del(peer: Peer, id: string, o: { env?: Env; signId?: string; unsigned?: boolean } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const time = String(Date.now());
  const sig = b64urlEncode(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, peer.sign.privateKey, fileDeleteSignedBytes(o.signId ?? id, time))));
  const h: Record<string, string> = { "CF-Connecting-IP": freshIp(), "PA-Client": "cli/0.0.55" };
  if (!o.unsigned) Object.assign(h, { "PA-ID": peer.id, "PA-Time": time, "PA-Sig": sig });
  const ctx = createExecutionContext();
  const res = await handle(new Request("https://api.pusharmor.com/v1/file/" + id, { method: "DELETE", headers: h }), o.env ?? (await looseEnv()), ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

const rnd = () => hex(randBytes(16));

describe("storage errors on upload", () => {
  it("a storage error or a broken body -> 502 storage error, no cap remembered", async () => {
    const a = await approvedSender();
    store.next = "throw";
    const r = await upload({ peer: a });
    expect(r).toMatchObject({ status: 502, body: { error: "storage error" } });
    expect((await upload({ peer: a })).status).toBe(201);
  });
});

describe("upload that ends after its own expiry", () => {
  afterEach(() => vi.restoreAllMocks());

  it("deletes the object, refuses with 410 expired, and takes back the charge", async () => {
    const a = await approvedSender();
    const real = Date.now();
    store.afterRead = () => void vi.spyOn(Date, "now").mockReturnValue(real + 86_401_000);
    const r = await upload({ peer: a });
    vi.restoreAllMocks();
    expect(r.status).toBe(410);
    expect(r.body).toEqual({ error: "expired" });
    expect(store.calls).toEqual(["put", "remove"]);
    expect(store.objects.size).toBe(0);
    expect(await quotaRow(a.acct)).toMatchObject({ day_count: 0, month_count: 0 });
  });

  it("a retry of the same PA-Send-ID after a late upload is charged again", async () => {
    const a = await approvedSender();
    const sid = sendId();
    const real = Date.now();
    store.afterRead = () => void vi.spyOn(Date, "now").mockReturnValue(real + 86_401_000);
    expect((await upload({ peer: a, sid })).status).toBe(410);
    vi.restoreAllMocks();
    store.afterRead = null;
    expect((await quotaRow(a.acct))?.sends[a.id]).toBeUndefined();
    expect((await upload({ peer: a, sid })).status).toBe(201);
    expect(await quotaRow(a.acct)).toMatchObject({ day_count: 1, month_count: 1 });
    expect((await quotaRow(a.acct))?.sends[a.id]).toEqual({ send_id: sid, attempts: 1 });
  });

  it("a late free retry drops the slot, so the next retry of that id is charged", async () => {
    const a = await approvedSender();
    const sid = sendId();
    store.next = "mismatch";
    expect((await upload({ peer: a, sid })).status).toBe(400);
    const real = Date.now();
    store.afterRead = () => void vi.spyOn(Date, "now").mockReturnValue(real + 86_401_000);
    expect((await upload({ peer: a, sid })).status).toBe(410);
    vi.restoreAllMocks();
    store.afterRead = null;
    expect(await quotaRow(a.acct)).toMatchObject({ day_count: 1, month_count: 1 });
    expect((await upload({ peer: a, sid })).status).toBe(201);
    expect(await quotaRow(a.acct)).toMatchObject({ day_count: 2, month_count: 2 });
  });

  it("refundRow takes back a charge only in the periods that are still current, and drops only a matching slot", () => {
    const t = 1_800_000_000;
    const row: QuotaRow = { day: dayOf(t), day_count: 2, month: 0, month_count: 5, sends: { d1: { send_id: "s1", attempts: 1 }, d2: { send_id: "s2", attempts: 1 } } };
    expect(refundRow(row, t, "d1", "s1", true)).toEqual({ day: dayOf(t), day_count: 1, month: 0, month_count: 5, sends: { d2: { send_id: "s2", attempts: 1 } } });
    expect(refundRow(row, t, "d1", "sX", true)?.sends).toEqual(row.sends);
    expect(refundRow(row, t, "d1", "s1", false)).toMatchObject({ day_count: 2, sends: { d2: { send_id: "s2", attempts: 1 } } });
    expect(refundRow(row, t - 86400, "d9", "s1", true)).toBeNull();
    expect(refundRow(undefined, t, "d1", "s1", true)).toBeNull();
  });
});

describe("DELETE /v1/file/<id>", () => {
  it("is a pinned route", () => {
    expect(pinned.routes).toContain("DELETE /v1/file/:file");
  });

  it("deletes the caller's object: 200, then 404; no quota refund", async () => {
    const a = await approvedSender();
    const up = await upload({ peer: a });
    expect(up.status).toBe(201);
    const id = up.body.id as string;
    const r = await del(a, id);
    expect(r).toEqual({ status: 200, body: {} });
    expect(store.objects.size).toBe(0);
    expect((await del(a, id)).status).toBe(404);
    expect((await quotaRow(a.acct))?.day_count).toBe(1);
  });

  it("more than 24 h + 1 min ahead or not a real minute -> 404, with no storage call or signature", async () => {
    const a = await approvedSender();
    const now = Math.floor(Date.now() / 1000);
    expect((await del(a, minuteOf(now + 86400 + 180) + "-" + rnd(), { unsigned: true })).status).toBe(404);
    expect((await del(a, "209913310000-" + rnd(), { unsigned: true })).status).toBe(404);
    expect(store.calls).toEqual([]);
    expect((await del(a, minuteOf(now + 86400) + "-" + rnd())).status).toBe(404);
    expect(store.calls).toEqual(["remove"]);
  });

  it("a file still stored after its expiry minute can be deleted: 200, then 404", async () => {
    const a = await approvedSender();
    const m = minuteOf(Math.floor(Date.now() / 1000) - 120);
    const id = m + "-" + rnd();
    store.objects.set("v1/" + m + "/" + (await acctHash(S.FILE_ACCT_SECRET, a.acct)) + "/" + id, randBytes(30));
    expect(await del(a, id)).toEqual({ status: 200, body: {} });
    expect(store.objects.size).toBe(0);
    expect((await del(a, id)).status).toBe(404);
  });

  it("an upload storage cap does not block a delete", async () => {
    const a = await approvedSender();
    store.next = "cap";
    expect((await upload({ peer: a })).status).toBe(503);
    const up = await upload({ peer: a });
    expect(up.status).toBe(503);
    const m = minuteOf(Math.floor(Date.now() / 1000) + 600);
    const id = m + "-" + rnd();
    store.objects.set("v1/" + m + "/" + (await acctHash(S.FILE_ACCT_SECRET, a.acct)) + "/" + id, randBytes(30));
    expect(await del(a, id)).toEqual({ status: 200, body: {} });
  });

  it("a malformed id -> 400", async () => {
    const a = await approvedSender();
    const m = minuteOf(Math.floor(Date.now() / 1000) + 600);
    for (const id of [m + "-" + rnd().toUpperCase(), m + rnd(), m.slice(1) + "-" + rnd(), m + "-" + rnd().slice(1)]) {
      expect((await del(a, id)).status, id).toBe(400);
    }
  });

  it("cannot delete another account's object", async () => {
    const a = await approvedSender();
    const b = await approvedSender();
    const up = await upload({ peer: b });
    expect((await del(a, up.body.id as string)).status).toBe(404);
    expect(store.objects.size).toBe(1);
  });

  it("PA-Sig over another id -> 401 with no storage call", async () => {
    const a = await approvedSender();
    const m = minuteOf(Math.floor(Date.now() / 1000) + 600);
    expect((await del(a, m + "-" + rnd(), { signId: m + "-" + rnd() })).status).toBe(401);
    expect(store.calls).toEqual([]);
  });

  it("counts on the 5 per minute file rate limit with uploads", async () => {
    const a = await approvedSender();
    const env = await looseEnv({ RL_FILE: countingLimit(5) });
    const m = minuteOf(Math.floor(Date.now() / 1000) + 600);
    for (let i = 0; i < 3; i++) expect((await upload({ peer: a, env })).status).toBe(201);
    for (let i = 0; i < 2; i++) expect((await del(a, m + "-" + rnd(), { env })).status).toBe(404);
    const r = await del(a, m + "-" + rnd(), { env });
    expect(r.status).toBe(429);
    expect(r.body.error).toBe("rate limited");
    expect((env.RL_FILE as ReturnType<typeof countingLimit>).seen.every((k) => k === "file:" + a.id)).toBe(true);
  });

  it("a storage error -> 502; a storage cap -> 503 files paused until 00:00 UTC, then uploads are refused with no storage call", async () => {
    const a = await approvedSender();
    const m = minuteOf(Math.floor(Date.now() / 1000) + 600);
    store.next = "throw";
    expect(await del(a, m + "-" + rnd())).toEqual({ status: 502, body: { error: "storage error" } });
    store.next = "cap";
    const r = await del(a, m + "-" + rnd());
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("files paused");
    const now = Math.floor(Date.now() / 1000);
    expect((now + (r.body.retry_after as number)) % 86400).toBe(0);
    store.calls.length = 0;
    expect((await upload({ peer: a })).status).toBe(201);
  });
});

describe("caps per kind", () => {
  it("an upload cap does not block downloads of a stored file", async () => {
    const a = await approvedSender();
    const up = await upload({ peer: a });
    expect(up.status).toBe(201);
    store.next = "cap";
    expect((await upload({ peer: a })).status).toBe(503);
    expect((await upload({ peer: a })).status).toBe(503);
    const ctx = createExecutionContext();
    const url = up.body.url as string;
    const headers = { "CF-Connecting-IP": freshIp(), ...(await dlHeaders(a, new URL(url).pathname)) };
    const res = await handle(new Request(url, { headers }), await looseEnv({ RL_DL_IP: countingLimit(1e6), RL_DL_KEY: countingLimit(1e6), RL_DL_PEER_KEY: countingLimit(1e6), RL_DL_PEER: countingLimit(1e6), RL_DL_ACCT: countingLimit(1e6) }), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
  });
});

describe("vectors (worker_only sections)", () => {
  it("ttl table", () => {
    for (const c of vectors.ttl.cases.filter((x) => x.status === 201)) {
      expect(c.content_length - BLOB_OVERHEAD, c.name).toBe(c.size);
      expect(ttlMinutes(c.size!), c.name).toBe(c.ttl_min);
    }
  });

  it("expires, minute, acct-hash, id, key and url, with the year rollover", async () => {
    for (const c of vectors.key.cases) {
      const exp = c.accept_time + ttlMinutes(c.size) * 60;
      expect(exp, c.name).toBe(c.expires);
      expect(minuteOf(exp), c.name).toBe(c.minute);
      expect(await acctHash(vectors.key.acct_secret, c.account), c.name).toBe(c.acct_hash);
      expect(fileName(c.minute, c.acct_hash, c.rand_hex), c.name).toEqual({ id: c.id, key: c.key, url: c.url });
    }
  });

  it("PA-FILE1 POST signing strings", () => {
    for (const c of vectors.file_sig.cases.filter((x) => x.method === "POST")) {
      const got = fileSignedBytes(c.pa_time, c.content_length!, c.file_sha256!, c.send_id!);
      expect(b64urlEncode(got), c.name).toBe(c.signed_bytes);
    }
    for (const c of vectors.file_sig.cases.filter((x) => x.method === "DELETE")) {
      expect(b64urlEncode(fileDeleteSignedBytes(c.id!, c.pa_time)), c.name).toBe(c.signed_bytes);
    }
    expect(b64urlDecode(vectors.upload_request.signed_bytes)).toEqual(
      fileSignedBytes(vectors.upload_request.headers["PA-Time"], Number(vectors.upload_request.headers["Content-Length"]), vectors.upload_request.headers["PA-File-SHA256"], vectors.upload_request.headers["PA-Send-ID"]),
    );
  });
});
