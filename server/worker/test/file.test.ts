// POST /v1/file: check order, PA-FILE1, quota Durable Object, ttl/id/key vectors, refusals.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createExecutionContext, env as baseEnv, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import vectors from "../../../tests/vectors/file-v1.json";
import pinned from "../routes.json";
import { handle } from "../src/index";
import type { Env } from "../src/env";
import { b64urlDecode, b64urlEncode } from "../src/codec/b64url";
import { sha256 } from "../src/crypto/hash";
import { fileSignedBytes } from "../src/pipeline/signed";
import { BLOB_OVERHEAD, MAX_FILE, acctHash, fileName, minuteOf, testing, ttlMinutes } from "../src/routes/file";
import { chargeRow, MAX_SLOTS, type QuotaRow } from "../src/file/quota";
import { testing as logTesting } from "../src/log";
import { storeDeps, type FileStore, type PutResult } from "../src/file/store";
import { captured, countingLimit, freshIp, initP256, newPeer, randBytes, randomEmail, setAllow, testEnv, type Peer } from "./helpers";
import { TEST_SECRETS as S } from "./secrets";

beforeAll(initP256);

// In-memory object store: checks the declared length and SHA-256 like the real store.
class MemStore implements FileStore {
  objects = new Map<string, Uint8Array>();
  next: PutResult | "throw" | null = null; // forced result for the next put
  async put(key: string, body: ReadableStream<Uint8Array>, length: number, sha: Uint8Array): Promise<PutResult> {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    const forced = this.next;
    this.next = null;
    if (forced === "throw") throw new Error("store down");
    if (forced) return forced;
    if (bytes.length !== length || b64urlEncode(await sha256(bytes)) !== b64urlEncode(sha)) return "mismatch";
    this.objects.set(key, bytes);
    return "ok";
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

  it("has no 48 KB body cap", async () => {
    const a = await approvedSender();
    const r = await upload({ peer: a, body: new Uint8Array(200_000).fill(7) });
    expect(r.status).toBe(201);
  });

  it("other routes keep the 48 KB cap", async () => {
    const r = await handle(
      new Request("https://api.pusharmor.com/v1/send", { method: "POST", headers: { "Content-Length": "48001", "CF-Connecting-IP": freshIp() }, body: randBytes(48001) }),
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
      expect((await upload({ peer: a, env, sid })).status).toBe(503);
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
      expect((await upload({ peer: a, sid })).status).toBe(503);
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
    expect((await upload({ peer: a, sid: x })).status).toBe(503);
    expect((await upload({ peer: b })).status).toBe(201);
    const r = await upload({ peer: a, sid: x });
    expect(r.status).toBe(201);
    expect((r.body.quota as { day: { used: number } }).day.used).toBe(2);
  });

  it("a retry 20 min after the first attempt is not charged", async () => {
    const a = await approvedSender();
    const sid = sendId();
    store.next = "throw";
    expect((await upload({ peer: a, sid })).status).toBe(503);
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
    expect(b64urlDecode(vectors.upload_request.signed_bytes)).toEqual(
      fileSignedBytes(vectors.upload_request.headers["PA-Time"], Number(vectors.upload_request.headers["Content-Length"]), vectors.upload_request.headers["PA-File-SHA256"], vectors.upload_request.headers["PA-Send-ID"]),
    );
  });
});
