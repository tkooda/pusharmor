// Stored JSON caps and pending expiry (I448).
import { beforeAll, describe, expect, it } from "vitest";
import { PUSH_FAILED_COL } from "../src/db/sql";
import { env } from "cloudflare:test";
import { NAME_JSON_MAX, PENDING_JSON_MAX, PENDING_TTL_S } from "../src/db/sql";
import { expirePending } from "../src/scheduled";
import { Log } from "../src/log";
import { call, initP256, message, newPeer, randomEmail, row, setAllow, testEnv, type Peer } from "./helpers";

beforeAll(initP256);

const j = (s: unknown) => JSON.parse(s as string);
const NOW = Math.floor(Date.now() / 1000);

// The last CREATE TRIGGER statement of the migrations (0005 and 0006 recreate the 0004 trigger),
// up to its END.
function triggerSql(): string {
  const all = env.TEST_MIGRATIONS.flatMap((m) => m.queries).join("\n");
  const t = all.slice(all.lastIndexOf("CREATE TRIGGER peers_json_cap"));
  const end = /\nEND;?/.exec(t)!;
  return t.slice(0, end.index + end[0].length);
}

async function family(n: number): Promise<Peer[]> {
  const email = randomEmail();
  const out: Peer[] = [];
  for (let i = 0; i < n; i++) out.push(await newPeer(email));
  return out;
}

describe("name and pending caps (I448)", () => {
  it("a rename that would grow name past the cap -> 413, row unchanged; a normal one passes", async () => {
    const [a, ...others] = await family(10);
    await setAllow(a, others.map((p) => p.id));
    const big = Object.fromEntries(others.map((p) => [p.id, message(1024)]));
    let r = await call("PATCH", "/v1/peers/" + a.id, { name: big, m: {} }, { peer: a });
    expect(r.status).toBe(413);
    expect(r.body).toEqual({ error: "too large" });
    expect(j((await row(a.id))!.name)).toEqual({});
    const normal = Object.fromEntries(others.map((p) => [p.id, message(400)]));
    r = await call("PATCH", "/v1/peers/" + a.id, { name: normal, m: {} }, { peer: a });
    expect(r.status).toBe(200);
    expect(((await row(a.id))!.name as string).length).toBeLessThanOrEqual(NAME_JSON_MAX);
  });

  it("an approve that would grow pending past the cap -> 413, row unchanged", async () => {
    const [a, b, ...others] = await family(10);
    // Fill a's pending close to the cap with entries for its other peers.
    const per = Math.floor((PENDING_JSON_MAX - 200) / others.length) - 60;
    const fill = Object.fromEntries(others.map((p) => [p.id, [NOW, message(per - (per % 4))]]));
    await env.DB.prepare("UPDATE peers SET pending = ?1 WHERE id = ?2").bind(JSON.stringify(fill), a.id).run();
    const before = (await row(a.id))!;
    const r = await call("POST", "/v1/approve/" + b.id, { c: message(1024), name: message(200) }, { peer: a });
    expect(r.status).toBe(413);
    const after = (await row(a.id))!;
    expect(after.pending).toBe(before.pending);
    expect(after.allow).toBe(before.allow);
  });

  it("a write that shrinks an over-cap row still passes (deny, remove)", async () => {
    const [a, b, c] = await family(3);
    await env.DB.prepare("DROP TRIGGER peers_json_cap").run();
    try {
      const over = { [b.id]: [NOW, message(PENDING_JSON_MAX)], [c.id]: [NOW, message(1024)] };
      await env.DB.prepare("UPDATE peers SET pending = ?1, name = ?2 WHERE id = ?3")
        .bind(JSON.stringify(over), JSON.stringify({ [b.id]: message(NAME_JSON_MAX), [c.id]: message(200) }), a.id)
        .run();
    } finally {
      await env.DB.prepare(triggerSql()).run();
    }
    const r = await call("POST", "/v1/deny/" + c.id, { c: message(512) }, { peer: a });
    expect(r.status).toBe(200);
    expect(Object.keys(j((await row(a.id))!.pending))).toEqual([b.id]);
    expect((await call("DELETE", "/v1/peers/" + b.id, { m: {} }, { peer: a })).status).toBe(200);
    expect(j((await row(a.id))!.pending)).toEqual({});
  });
});

describe("pending entries carry their time and expire (I448)", () => {
  it("approve stores [time, c]; the second approve still gets the first c back", async () => {
    const [a, b] = await family(2);
    const ca = message(1024);
    const cb = message(1024);
    expect((await call("POST", "/v1/approve/" + b.id, { c: ca, name: message(200) }, { peer: a })).body).toEqual({ r: "stored" });
    const pa = j((await row(a.id))!.pending)[b.id];
    expect(Array.isArray(pa) && pa[1] === ca && Math.abs(pa[0] - NOW) < 600).toBe(true);
    expect((await call("POST", "/v1/approve/" + a.id, { c: cb, name: message(200) }, { peer: b })).body).toEqual({ r: "sent", c: ca });
  });

  it("a legacy string entry (written by the previous Worker) is still returned as c", async () => {
    const [a, b] = await family(2);
    const ca = message(1024);
    await env.DB.prepare("UPDATE peers SET allow = ?1, pending = ?2 WHERE id = ?3")
      .bind(JSON.stringify({ [b.id]: 1 }), JSON.stringify({ [b.id]: ca }), a.id)
      .run();
    expect((await call("POST", "/v1/approve/" + a.id, { c: message(1024), name: message(200) }, { peer: b })).body).toEqual({ r: "sent", c: ca });
  });

  it("monthly sweep: drops entries older than the TTL, stamps legacy ones, keeps fresh ones; keyset chunks", async () => {
    const peers = await family(5);
    const [a, b, c, d, e] = peers;
    const old = NOW - PENDING_TTL_S - 10;
    const set = (p: Peer, v: unknown) => env.DB.prepare("UPDATE peers SET pending = ?1 WHERE id = ?2").bind(JSON.stringify(v), p.id).run();
    await set(a, { [b.id]: [old, "AAAA"], [c.id]: [NOW, "BBBB"] });
    await set(b, { [a.id]: "CCCC" });
    await set(c, { [a.id]: [old, "DDDD"] });
    await set(d, { [a.id]: [NOW - 5, "EEEE"] });
    const log = new Log();
    const n = await expirePending(await testEnv(), NOW, log, 2);
    expect(n).toBe(3);
    expect(log.extra.pending_chunks).toBe(3);
    expect(j((await row(a.id))!.pending)).toEqual({ [c.id]: [NOW, "BBBB"] });
    expect(j((await row(b.id))!.pending)).toEqual({ [a.id]: [NOW, "CCCC"] });
    expect(j((await row(c.id))!.pending)).toEqual({});
    expect(j((await row(d.id))!.pending)).toEqual({ [a.id]: [NOW - 5, "EEEE"] });
    expect(j((await row(e.id))!.pending)).toEqual({});
  });
});

describe("migration 0004 on existing rows (I448)", () => {
  it("stamps legacy entries, drops entries of gone peers and oversized JSON", async () => {
    const [a, b, c] = await family(3);
    const ghost = a.acct + "G".repeat(28);
    await env.DB.prepare("DROP TRIGGER peers_json_cap").run();
    const q = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0004"))!.queries;
    try {
      await env.DB.prepare("UPDATE peers SET pending = ?1 WHERE id = ?2").bind(JSON.stringify({ [b.id]: "AAAA", [ghost]: "BBBB" }), a.id).run();
      await env.DB.prepare("UPDATE peers SET pending = ?1, name = ?2 WHERE id = ?3")
        .bind(JSON.stringify({ [a.id]: message(PENDING_JSON_MAX) }), JSON.stringify({ [a.id]: message(NAME_JSON_MAX) }), b.id)
        .run();
      await env.DB.prepare("UPDATE peers SET pending = ?1 WHERE id = ?2").bind(JSON.stringify({ [a.id]: [NOW, "CCCC"] }), c.id).run();
      for (const s of q) await env.DB.prepare(s).run();
    } finally {
      if (!(await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE name = 'peers_json_cap'").first())) {
        await env.DB.prepare(triggerSql()).run();
      }
    }
    const pa = j((await row(a.id))!.pending);
    expect(Object.keys(pa)).toEqual([b.id]);
    expect(pa[b.id][1]).toBe("AAAA");
    expect(typeof pa[b.id][0]).toBe("number");
    expect(j((await row(b.id))!.pending)).toEqual({});
    expect(j((await row(b.id))!.name)).toEqual({});
    expect(j((await row(c.id))!.pending)).toEqual({ [a.id]: [NOW, "CCCC"] });
  });
});

describe("migration 0005 on existing rows", () => {
  it("rebuilds peers: platform iphone -> ios, paused -> logged_out, other columns kept, cap trigger kept", async () => {
    const [a, b] = await family(2);
    const before = await env.DB.prepare("SELECT * FROM peers ORDER BY id").all();
    // Back to the 0001 table (platform 'iphone' allowed) with the 0004 trigger, then seed an old row.
    const q = (prefix: string) => env.TEST_MIGRATIONS.find((m) => m.name.startsWith(prefix))!.queries;
    const create0001 = q("0001").join("\n");
    const peersSql = create0001.slice(create0001.indexOf("CREATE TABLE peers"));
    await env.DB.prepare("DROP TABLE peers").run();
    await env.DB.prepare(peersSql).run();
    for (const r of before.results) {
      const cols = Object.keys(r).filter((k) => k !== PUSH_FAILED_COL && k !== "push_verified_at");
      const oldCols = cols.map((k) => (k === "logged_out" ? "paused" : k));
      await env.DB.prepare(`INSERT INTO peers (${oldCols.join(", ")}) VALUES (${cols.map((_, i) => "?" + (i + 1)).join(", ")})`)
        .bind(...cols.map((k) => (r as Record<string, unknown>)[k])).run();
    }
    await env.DB.prepare("UPDATE peers SET platform = 'iphone', push_type = 2, push = ?1, paused = 1 WHERE id = ?2").bind('{"type":"apns"}', b.id).run();
    await env.DB.prepare(triggerSql()).run();
    for (const s of q("0005")) await env.DB.prepare(s).run();

    expect(await row(a.id)).toMatchObject({ platform: "android", logged_out: 0 });
    expect(await row(b.id)).toMatchObject({ platform: "ios", logged_out: 1, push_type: 2, push: '{"type":"apns"}', sign_pub: b.signPub });
    await expect(env.DB.prepare("UPDATE peers SET platform = 'iphone' WHERE id = ?1").bind(a.id).run()).rejects.toThrow();
    await expect(env.DB.prepare("UPDATE peers SET name = ?1 WHERE id = ?2").bind(JSON.stringify({ x: message(NAME_JSON_MAX) }), a.id).run())
      .rejects.toThrow(/pa-json-cap/);
    for (const s of [...q("0006"), ...q("0007")]) await env.DB.prepare(s).run();
  });
});

describe("migration 0006 on existing rows", () => {
  it("rebuilds peers: platform cli allowed, other columns kept, cap trigger kept", async () => {
    const [a, b] = await family(2);
    await env.DB.prepare("UPDATE peers SET logged_out = 1 WHERE id = ?1").bind(b.id).run();
    const before = await env.DB.prepare("SELECT * FROM peers ORDER BY id").all();
    const q = (prefix: string) => env.TEST_MIGRATIONS.find((m) => m.name.startsWith(prefix))!.queries;
    for (const s of [...q("0006"), ...q("0007")]) await env.DB.prepare(s).run();
    expect((await env.DB.prepare("SELECT * FROM peers ORDER BY id").all()).results).toEqual(before.results);
    expect(await row(b.id)).toMatchObject({ logged_out: 1 });
    await env.DB.prepare("UPDATE peers SET platform = 'cli' WHERE id = ?1").bind(a.id).run();
    await expect(env.DB.prepare("UPDATE peers SET platform = 'linux' WHERE id = ?1").bind(a.id).run()).rejects.toThrow();
    await expect(env.DB.prepare("UPDATE peers SET name = ?1 WHERE id = ?2").bind(JSON.stringify({ x: message(NAME_JSON_MAX) }), a.id).run())
      .rejects.toThrow(/pa-json-cap/);
  });
});

describe("migration 0007 on existing rows", () => {
  it("moves push verified_at to push_verified_at and strips the key; unconfirmed rows keep NULL", async () => {
    const [a, b] = await family(2);
    const q = (prefix: string) => env.TEST_MIGRATIONS.find((m) => m.name.startsWith(prefix))!.queries;
    for (const s of q("0006")) await env.DB.prepare(s).run();
    await env.DB.prepare("UPDATE peers SET push_type = 6, push = ?1 WHERE id = ?2").bind('{"type":"unifiedpush","endpoint":"e","verified_at":77}', a.id).run();
    await env.DB.prepare("UPDATE peers SET push_type = 6, push = ?1 WHERE id = ?2").bind('{"type":"unifiedpush","endpoint":"f"}', b.id).run();
    for (const s of q("0007")) await env.DB.prepare(s).run();
    expect(await row(a.id)).toMatchObject({ push: '{"type":"unifiedpush","endpoint":"e"}', push_verified_at: 77, push_failed_since: null });
    expect(await row(b.id)).toMatchObject({ push: '{"type":"unifiedpush","endpoint":"f"}', push_verified_at: null });
  });
});
