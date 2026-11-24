// File cleanup cron, account deletion of files, and /v1/health fields, over the real B2 store
// with an in-memory S3 behind a mocked fetch (paged lists, version deletes).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createScheduledController, env as baseEnv, runInDurableObject } from "cloudflare:test";
import { B2Store } from "../src/file/b2";
import { storeDeps } from "../src/file/store";
import { dayOf, SWEEP_OBJECT, type QuotaRow } from "../src/file/quota";
import { CRON_FILES } from "../src/crons";
import { FILE_GRACE_S, scheduled, sweepFiles } from "../src/scheduled";
import { deleteAccountFiles } from "../src/routes/account";
import { acctHash, minuteOf, minuteStart, testing } from "../src/routes/file";
import { Log } from "../src/log";
import { TEST_SECRETS as S } from "./secrets";
import { call, captured, newPeer, randomEmail, testEnv, ticketFor } from "./helpers";

const CFG = { keyId: "KEYID0001", appKey: "app-key-secret-0001", bucket: "bkt", endpoint: "https://s3.example.test", region: "r1" };

// In-memory S3: keys with versions; ListObjectsV2 with delimiter, ListObjectVersions, DeleteObjects.
class FakeS3 {
  versions = new Map<string, string[]>();
  seen: { method: string; q: URLSearchParams }[] = [];
  fail: ((method: string, q: URLSearchParams) => Response | null) | null = null;
  private n = 0;
  add(key: string, count = 1): void {
    const v = this.versions.get(key) ?? [];
    for (let i = 0; i < count; i++) v.push("ver" + ++this.n);
    this.versions.set(key, v);
  }
  keys(): string[] {
    return [...this.versions.keys()].sort();
  }
  store(): B2Store {
    return new B2Store(CFG, async (url, init) => this.handle(url, init));
  }
  private async handle(url: string, init: RequestInit): Promise<Response> {
    const u = new URL(url);
    const q = u.searchParams;
    const method = init.method ?? "GET";
    this.seen.push({ method, q });
    const forced = this.fail?.(method, q);
    if (forced) return forced;
    if (method === "GET" && q.get("list-type") === "2") {
      const prefix = q.get("prefix") ?? "";
      const all = [...new Set(this.keys().filter((k) => k.startsWith(prefix)).map((k) => prefix + k.slice(prefix.length).split("/")[0] + "/"))].sort();
      const from = Number(q.get("continuation-token") ?? "0");
      const page = all.slice(from, from + 1000);
      const more = from + 1000 < all.length;
      return new Response(
        "<ListBucketResult>" + `<IsTruncated>${more}</IsTruncated>` + (more ? `<NextContinuationToken>${from + 1000}</NextContinuationToken>` : "") + page.map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join("") + "</ListBucketResult>",
      );
    }
    if (method === "GET" && q.has("versions")) {
      const prefix = q.get("prefix") ?? "";
      const flat = this.keys().filter((k) => k.startsWith(prefix)).flatMap((k) => this.versions.get(k)!.map((v) => [k, v] as const));
      let from = 0;
      if (q.has("key-marker")) from = flat.findIndex(([k, v]) => k === q.get("key-marker") && v === q.get("version-id-marker")) + 1;
      const page = flat.slice(from, from + 1000);
      const more = from + 1000 < flat.length;
      const last = page[page.length - 1];
      return new Response(
        "<ListVersionsResult>" + `<IsTruncated>${more}</IsTruncated>` + (more ? `<NextKeyMarker>${last[0]}</NextKeyMarker><NextVersionIdMarker>${last[1]}</NextVersionIdMarker>` : "") + page.map(([k, v]) => `<Version><Key>${k}</Key><VersionId>${v}</VersionId></Version>`).join("") + "</ListVersionsResult>",
      );
    }
    if (method === "POST" && q.has("delete")) {
      const body = new TextDecoder().decode(new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer()));
      for (const m of body.matchAll(/<Object><Key>([^<]*)<\/Key><VersionId>([^<]*)<\/VersionId><\/Object>/g)) {
        const left = (this.versions.get(m[1]) ?? []).filter((v) => v !== m[2]);
        if (left.length) this.versions.set(m[1], left);
        else this.versions.delete(m[1]);
      }
      return new Response("<DeleteResult></DeleteResult>");
    }
    return new Response("<Error><Code>Unexpected</Code></Error>", { status: 500 });
  }
}

const errReply = (status: number, code: string, msg = "x") => new Response(`<Error><Code>${code}</Code><Message>${msg}</Message></Error>`, { status });

let s3: FakeS3;
beforeEach(() => {
  s3 = new FakeS3();
  storeDeps.store = () => s3.store();
  testing.reset();
});
afterEach(() => testing.reset());

const NOW = Math.floor(Date.now() / 1000);
// Folder name for the minute holding unix second t.
const dir = (t: number) => "v1/" + minuteOf(t) + "/";
const fileKey = (t: number, hash = "0123456789abcdef", n = 0) => dir(t) + hash + "/" + minuteOf(t) + "-" + n.toString(16).padStart(32, "0");
const listCalls = () => s3.seen.filter((x) => x.q.get("list-type") === "2").length;

async function lastSweep(): Promise<number | null> {
  return baseEnv.FILE_QUOTA.get(baseEnv.FILE_QUOTA.idFromName(SWEEP_OBJECT)).lastSweep();
}

describe("file cleanup cron", () => {
  it("lists more than 1,000 minute folders over pages and deletes every due one, all versions", async () => {
    const base = NOW - 3 * 86400;
    for (let i = 0; i < 1500; i++) s3.add(fileKey(base + i * 60), 2);
    s3.add(fileKey(NOW + 3600), 1);
    const log = new Log();
    await sweepFiles(await testEnv(), NOW, log, 1e6);
    expect(listCalls()).toBe(2);
    expect(s3.keys()).toEqual([fileKey(NOW + 3600)]);
    expect(log.extra.files_dirs).toBe(1500);
    expect(log.error).toBeUndefined();
  });

  it("deletes a folder exactly when expires + 5 min is reached for its latest possible expires", async () => {
    const m = minuteOf(NOW - 3600);
    const start = minuteStart(m)!;
    const latest = start + 59; // expires are whole seconds within the minute
    const key = fileKey(start);
    s3.add(key);
    await sweepFiles(await testEnv(), latest + FILE_GRACE_S - 1, new Log());
    expect(s3.keys()).toEqual([key]);
    await sweepFiles(await testEnv(), latest + FILE_GRACE_S, new Log());
    expect(s3.keys()).toEqual([]);
  });

  it("two overlapping runs delete everything with no failure logged", async () => {
    for (let i = 0; i < 30; i++) s3.add(fileKey(NOW - 7200 + i * 60, "0123456789abcdef", i), 3);
    const a = new Log();
    const b = new Log();
    const e = await testEnv();
    await Promise.all([sweepFiles(e, NOW, a), sweepFiles(e, NOW, b)]);
    expect(s3.keys()).toEqual([]);
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
  });

  it("a failed delete is logged with the storage error; other folders are still deleted; no last sweep is recorded", async () => {
    const t1 = NOW - 7200;
    const t2 = NOW - 7000;
    s3.add(fileKey(t1));
    s3.add(fileKey(t2));
    let first = true;
    s3.fail = (method) => {
      if (method === "POST" && first) {
        first = false;
        return errReply(500, "InternalError");
      }
      return null;
    };
    const before = await lastSweep();
    const log = new Log();
    log.route = "cron files";
    await sweepFiles(await testEnv(), NOW + 1e5, log);
    expect(log.error).toBe("file-delete-failed");
    expect(log.extra.storage).toBe("500 InternalError");
    expect(log.extra.files_left).toBe(1);
    expect(log.alert()).toBe("cron");
    expect(s3.keys()).toEqual([fileKey(t1)]);
    expect(await lastSweep()).toBe(before);
  });

  it("a storage cap on the list is logged as a failed delete", async () => {
    s3.add(fileKey(NOW - 7200));
    s3.fail = () => errReply(403, "AccessDenied", "Transaction cap exceeded");
    const log = new Log();
    await sweepFiles(await testEnv(), NOW, log);
    expect(log.error).toBe("file-delete-failed");
    expect(log.extra.storage).toBe("cap");
  });

  it("bounded work: a run stops at its call budget, oldest first; the next run finishes and records the time", async () => {
    for (let i = 0; i < 10; i++) s3.add(fileKey(NOW - 7200 + i * 60));
    const log = new Log();
    await sweepFiles(await testEnv(), NOW, log, 5);
    expect(log.extra.files_dirs).toBe(2);
    expect(log.extra.files_left).toBe(8);
    expect(log.error).toBeUndefined();
    expect(s3.keys()[0]).toBe(fileKey(NOW - 7200 + 120));
    await sweepFiles(await testEnv(), NOW + 2, new Log());
    expect(s3.keys()).toEqual([]);
    expect(await lastSweep()).toBe(NOW + 2);
  });

  it("scheduled() runs the cleanup on the 5-minute trigger and logs a line only when a delete failed", async () => {
    s3.add(fileKey(NOW - 7200));
    let before = captured.length;
    await scheduled(createScheduledController({ cron: CRON_FILES }), await testEnv());
    expect(s3.keys()).toEqual([]);
    expect(captured.slice(before).filter((l) => JSON.parse(l).route === "cron files")).toEqual([]);
    s3.add(fileKey(NOW - 7200));
    s3.fail = (method) => (method === "POST" ? errReply(500, "InternalError") : null);
    before = captured.length;
    await scheduled(createScheduledController({ cron: CRON_FILES }), await testEnv());
    const lines = captured.slice(before).map((l) => JSON.parse(l)).filter((l) => l.route === "cron files");
    expect(lines).toEqual([expect.objectContaining({ error: "file-delete-failed", storage: "500 InternalError", alert: "cron" })]);
  });
});

async function setRow(acct: string, day: number): Promise<void> {
  const stub = baseEnv.FILE_QUOTA.get(baseEnv.FILE_QUOTA.idFromName(acct));
  const row: QuotaRow = { day, day_count: 1, month: 0, month_count: 1, sends: {} };
  await runInDurableObject(stub, (_i, state) => state.storage.put("q", row));
}

describe("account deletion of files", () => {
  it("no storage call when the account never uploaded or its last upload day is older than yesterday", async () => {
    const p = await newPeer(randomEmail());
    await deleteAccountFiles(await testEnv(), p.acct, NOW);
    await setRow(p.acct, dayOf(NOW) - 2 * 86400);
    await deleteAccountFiles(await testEnv(), p.acct, NOW);
    expect(s3.seen).toEqual([]);
  });

  it("pages over more than 1,000 folders and deletes only that account's files", async () => {
    const p = await newPeer(randomEmail());
    await setRow(p.acct, dayOf(NOW) - 86400);
    const mine = await acctHash(S.FILE_ACCT_SECRET, p.acct);
    const other = "fedcba9876543210";
    for (let i = 0; i < 1100; i++) s3.add(fileKey(NOW + i * 60, other, i));
    s3.add(fileKey(NOW + 60, mine, 1), 2);
    s3.add(fileKey(NOW + 1099 * 60, mine, 2));
    await deleteAccountFiles(await testEnv(), p.acct, NOW);
    expect(listCalls()).toBe(2);
    expect(s3.keys().filter((k) => k.includes("/" + mine + "/"))).toEqual([]);
    expect(s3.keys()).toHaveLength(1100);
  });

  it("DELETE /v1/account deletes the account's stored files", async () => {
    const email = randomEmail();
    const p = await newPeer(email);
    await setRow(p.acct, dayOf(NOW));
    const key = fileKey(NOW + 600, await acctHash(S.FILE_ACCT_SECRET, p.acct));
    s3.add(key);
    const r = await call("DELETE", "/v1/account", { ticket: await ticketFor(email, p.signPub, "delete-account"), sign_pub: p.signPub, m: {} }, { sign: p.sign });
    expect(r.status).toBe(200);
    expect(s3.keys()).toEqual([]);
  });

  it("a storage failure is logged", async () => {
    const p = await newPeer(randomEmail());
    await setRow(p.acct, dayOf(NOW));
    s3.add(fileKey(NOW + 600, await acctHash(S.FILE_ACCT_SECRET, p.acct)));
    s3.fail = (method) => (method === "POST" ? errReply(500, "InternalError") : null);
    const before = captured.length;
    await deleteAccountFiles(await testEnv(), p.acct, NOW);
    const lines = captured.slice(before).map((l) => JSON.parse(l));
    expect(lines).toContainEqual(expect.objectContaining({ route: "account files", error: "file-delete-failed", storage: "500 InternalError" }));
  });
});

describe("GET /v1/health fields", () => {
  it("status ok, files on or paused, and the last complete cleanup time", async () => {
    const e = await testEnv({ PA_FILE_DAY_LIMIT: "20", PA_FILE_MONTH_LIMIT: "100" });
    const r1 = await call("GET", "/v1/health", undefined, { env: e });
    expect(r1.status).toBe(200);
    expect(Object.keys(r1.body).sort()).toEqual(["files", "last_sweep", "status"]);
    expect(r1.body.status).toBe("ok");
    expect(r1.body.files).toBe("on");
    await sweepFiles(e, NOW + 5, new Log());
    expect((await call("GET", "/v1/health", undefined, { env: e })).body.last_sweep).toBe(NOW + 5);
    const paused = await testEnv({ PA_FILE_DAY_LIMIT: "0", PA_FILE_MONTH_LIMIT: "100" });
    expect((await call("GET", "/v1/health", undefined, { env: paused })).body.files).toBe("paused");
    storeDeps.store = () => null;
    expect((await call("GET", "/v1/health", undefined, { env: e })).body.files).toBe("paused");
  });
});
