import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { b64urlEncode } from "../src/codec/b64url";
import { probeCode } from "../src/routes/common";
import { pairKey } from "../src/routes/pair";
import { call, initP256, message, newPeer, onVendor, pushFor, randomEmail, row, setAllow, ticketFor, vendorRequests, keys, type Peer } from "./helpers";
import { TEST_SECRETS as S } from "./secrets";

beforeAll(initP256);
const j = (s: unknown) => JSON.parse(s as string);
const ghostOf = (p: Peer) => p.acct + b64urlEncode(crypto.getRandomValues(new Uint8Array(21)));

describe("POST /send", () => {
  it("results in /send order", async () => {
    const email = randomEmail();
    const me = await newPeer(email);
    const ok = await newPeer(email, "iphone");
    const den = await newPeer(email);
    const unap = await newPeer(email);
    const paused = await newPeer(email);
    const gone = await newPeer(email, "chrome", null);
    const up = await newPeer(email, "android", pushFor("android", "unifiedpush"));
    for (const p of [ok, den, paused, gone, up]) await setAllow(p, [me.id]);
    await env.DB.prepare("UPDATE peers SET deny = json_set(deny, '$.\"' || ?1 || '\"', 1) WHERE id = ?2").bind(me.id, den.id).run();
    await env.DB.prepare("UPDATE peers SET paused = 1 WHERE id = ?1").bind(paused.id).run();
    const ghost = ghostOf(me);
    const m: Record<string, string> = {};
    for (const p of [ok, den, unap, paused, gone, up]) m[p.id] = message(512);
    m[ghost] = message(512);
    const r = await call("POST", "/v1/send", { v: 1, m }, { peer: me });
    expect(r.status).toBe(200);
    expect(r.body.r).toEqual({
      [ok.id]: "sent",
      [den.id]: "denied",
      [unap.id]: "unapproved",
      [paused.id]: "paused",
      [gone.id]: "gone",
      [up.id]: "failed",
      [ghost]: "unknown",
    });
    expect(vendorRequests("api.push.apple.com")).toHaveLength(1);
  });

  it("v must be 1; foreign prefix -> 400", async () => {
    const me = await newPeer(randomEmail());
    expect((await call("POST", "/v1/send", { v: 2, m: {} }, { peer: me })).status).toBe(400);
    const other = await newPeer(randomEmail());
    expect((await call("POST", "/v1/send", { v: 1, m: { [other.id]: message(512) } }, { peer: me })).status).toBe(400);
  });

  it("vendor gone writes push NULL (W_GONE); a failing W_GONE still returns results", async () => {
    const email = randomEmail();
    const me = await newPeer(email);
    const x = await newPeer(email, "chrome");
    await setAllow(x, [me.id]);
    onVendor((r) => r.url.startsWith("https://fcm.googleapis.com/fcm/send/"), () => new Response(null, { status: 410 }));
    let r = await call("POST", "/v1/send", { v: 1, m: { [x.id]: message(512) } }, { peer: me });
    expect(r.body.r).toEqual({ [x.id]: "gone" });
    expect((await row(x.id))!.push).toBeNull();
    // Failing write-back: drop the table under the Worker via a broken DB binding.
    const y = await newPeer(email, "chrome");
    await setAllow(y, [me.id]);
    onVendor((rq) => rq.url.startsWith("https://fcm.googleapis.com/fcm/send/"), () => new Response(null, { status: 404 }));
    const base = (await import("./helpers")).testEnv;
    const e = await base();
    const db = e.DB;
    const brokenDb = new Proxy(db, {
      get(t, p) {
        if (p === "batch") return async () => { throw new Error("d1 down"); };
        const v = (t as unknown as Record<string | symbol, unknown>)[p];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    r = await call("POST", "/v1/send", { v: 1, m: { [y.id]: message(512) } }, { peer: me, env: { ...e, DB: brokenDb as D1Database } });
    expect(r.status).toBe(200);
    expect(r.body.r).toEqual({ [y.id]: "gone" });
    expect((await row(y.id))!.push).not.toBeNull();
  });

  it("W_GONE guard keeps a push PATCHed during the send", async () => {
    const email = randomEmail();
    const me = await newPeer(email);
    const x = await newPeer(email, "chrome");
    await setAllow(x, [me.id]);
    const fresh = pushFor("chrome");
    onVendor((r) => r.url.startsWith("https://fcm.googleapis.com/fcm/send/"), async () => {
      await env.DB.prepare("UPDATE peers SET push = ?1 WHERE id = ?2").bind(JSON.stringify(fresh), x.id).run();
      return new Response(null, { status: 410 });
    });
    const r = await call("POST", "/v1/send", { v: 1, m: { [x.id]: message(512) } }, { peer: me });
    expect(r.body.r).toEqual({ [x.id]: "gone" });
    expect(j((await row(x.id))!.push)).toEqual(fresh);
  });

  it("W_SEEN: stale account writes 1 row; fresh 0; bad signature 0", async () => {
    const email = randomEmail();
    const me = await newPeer(email);
    const now = Math.floor(Date.now() / 1000);
    const stale = now - 31 * 86400;
    await env.DB.prepare("UPDATE accounts SET last_seen_month = ?1 WHERE id = ?2").bind(stale, me.acct).run();
    const bad = await call("POST", "/v1/send", { v: 1, m: {} }, { peer: { ...me, sign: (await keys()).sign } });
    expect(bad.status).toBe(401);
    let a = await env.DB.prepare("SELECT last_seen_month AS s FROM accounts WHERE id = ?1").bind(me.acct).first<{ s: number }>();
    expect(a!.s).toBe(stale);
    await call("POST", "/v1/send", { v: 1, m: {} }, { peer: me });
    a = await env.DB.prepare("SELECT last_seen_month AS s FROM accounts WHERE id = ?1").bind(me.acct).first<{ s: number }>();
    expect(a!.s).toBeGreaterThanOrEqual(now);
  });
});

describe("pause / unpause (6.10)", () => {
  it("messages missing names exactly the missing allow id; gate; unpause ticket", async () => {
    const email = randomEmail();
    const a = await newPeer(email);
    const b = await newPeer(email);
    const c = await newPeer(email);
    await setAllow(a, [b.id, c.id]);
    await setAllow(b, [a.id]);
    let r = await call("POST", `/v1/peers/${a.id}/pause`, { m: { [b.id]: message(512) } }, { peer: a });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "messages missing", ids: [c.id] });
    r = await call("POST", `/v1/peers/${a.id}/pause`, { m: { [b.id]: message(512), [c.id]: message(512) } }, { peer: a });
    expect(r.body.r).toEqual({ [b.id]: "sent", [c.id]: "unapproved" });
    expect((await row(a.id))!.paused).toBe(1);
    const fcm = vendorRequests("fcm.googleapis.com").filter((q) => q.url.includes("/v1/projects/"));
    expect(JSON.parse(new TextDecoder().decode(fcm[0].body)).message.android.priority).toBe("NORMAL");
    // Paused gate.
    expect((await call("GET", "/v1/peers", undefined, { peer: a })).body.error).toBe("paused");
    expect((await call("POST", `/v1/peers/${a.id}/pause`, { m: {} }, { peer: a })).body.error).toBe("paused");
    // Unpause: wrong purpose ticket, then right one; missing m.
    const m = { [b.id]: message(512), [c.id]: message(512) };
    r = await call("POST", `/v1/peers/${a.id}/unpause`, { ticket: await ticketFor(email, a.signPub, "register"), m }, { peer: a });
    expect(r.body.error).toBe("invalid ticket");
    r = await call("POST", `/v1/peers/${a.id}/unpause`, { ticket: await ticketFor(email, a.signPub, "unpause"), m: { [b.id]: m[b.id] } }, { peer: a });
    expect(r.body.error).toBe("messages missing");
    r = await call("POST", `/v1/peers/${a.id}/unpause`, { ticket: await ticketFor(email, a.signPub, "unpause"), m }, { peer: a });
    expect(r.status).toBe(200);
    expect((await row(a.id))!.paused).toBe(0);
  });

  it("paused caller may DELETE itself", async () => {
    const email = randomEmail();
    const a = await newPeer(email);
    const b = await newPeer(email);
    await env.DB.prepare("UPDATE peers SET paused = 1 WHERE id = ?1").bind(a.id).run();
    expect((await call("DELETE", "/v1/peers/" + b.id, { m: {} }, { peer: a })).body.error).toBe("paused");
    expect((await call("DELETE", "/v1/peers/" + a.id, { m: {} }, { peer: a })).status).toBe(200);
    expect(await row(a.id)).toBeNull();
  });
});

describe("DELETE /peers/$id", () => {
  it("twice: second call 200, no write; m relayed using pushes read before the delete", async () => {
    const email = randomEmail();
    const a = await newPeer(email);
    const b = await newPeer(email);
    await setAllow(b, [a.id]);
    let r = await call("DELETE", "/v1/peers/" + b.id, { m: { [b.id]: message(512) } }, { peer: a });
    expect(r.body.r).toEqual({ [b.id]: "sent" });
    r = await call("DELETE", "/v1/peers/" + b.id, { m: { [b.id]: message(512) } }, { peer: a });
    expect(r.status).toBe(200);
    expect(r.body.r).toEqual({ [b.id]: "unknown" });
    const other = await newPeer(randomEmail());
    expect((await call("DELETE", "/v1/peers/" + other.id, { m: {} }, { peer: a })).status).toBe(400);
  });
});

describe("DELETE /account (6.5)", () => {
  it("deletes all rows, relays m from the matching row, keeps banned accounts row", async () => {
    const email = randomEmail();
    const a = await newPeer(email);
    const b = await newPeer(email);
    await setAllow(b, [a.id]);
    const ghost = ghostOf(a);
    const body = { ticket: await ticketFor(email, a.signPub, "delete-account"), sign_pub: a.signPub, m: { [b.id]: message(512), [ghost]: message(512) } };
    const r = await call("DELETE", "/v1/account", body, { sign: a.sign });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ r: { [b.id]: "sent", [ghost]: "unknown" }, deleted: 2 });
    expect(await row(a.id)).toBeNull();
    expect(await env.DB.prepare("SELECT * FROM accounts WHERE id = ?1").bind(a.acct).first()).toBeNull();
    // Retry after the rows are gone: nothing relayed, every result unknown.
    const before = vendorRequests().length;
    const r2 = await call("DELETE", "/v1/account", { ...body, ticket: await ticketFor(email, a.signPub, "delete-account") }, { sign: a.sign });
    expect(r2.body).toEqual({ r: { [b.id]: "unknown", [ghost]: "unknown" }, deleted: 0 });
    expect(vendorRequests().length).toBe(before);
  });

  it("throwaway key: m ignored; foreign prefix -> 400; banned row kept", async () => {
    const email = randomEmail();
    const a = await newPeer(email);
    await env.DB.prepare("UPDATE accounts SET status = 'banned' WHERE id = ?1").bind(a.acct).run();
    const k = await keys();
    const other = await newPeer(randomEmail());
    let r = await call("DELETE", "/v1/account", { ticket: await ticketFor(email, k.signPub, "delete-account"), sign_pub: k.signPub, m: { [other.id]: message(512) } }, { sign: k.sign });
    expect(r.status).toBe(400);
    r = await call("DELETE", "/v1/account", { ticket: await ticketFor(email, k.signPub, "delete-account"), sign_pub: k.signPub, m: { [a.id]: message(512) } }, { sign: k.sign });
    expect(r.body).toEqual({ r: { [a.id]: "unknown" }, deleted: 1 });
    expect(await env.DB.prepare("SELECT status FROM accounts WHERE id = ?1").bind(a.acct).first()).toEqual({ status: "banned" });
  });
});

describe("POST /pair/$X (6.7a)", () => {
  it("relays each kind; iPhone gets apns-collapse-id = pk; others none; TTL 2419200", async () => {
    const email = randomEmail();
    const n = await newPeer(email);
    const x = await newPeer(email, "iphone");
    const c = message(366 - 2) + "AA"; // 366 chars
    expect(c).toHaveLength(366);
    for (const k of ["commit", "open"]) {
      const r = await call("POST", "/v1/pair/" + x.id, { k, c }, { peer: n });
      expect(r.body).toEqual({ r: "sent" });
    }
    const apns = vendorRequests("api.push.apple.com");
    expect(apns).toHaveLength(2);
    for (const q of apns) {
      expect(q.headers["apns-collapse-id"]).toBe(await pairKey(n.id, x.id));
      const exp = Number(q.headers["apns-expiration"]);
      expect(exp - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(2419200 - 2);
      expect(exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(2419200);
    }
    const r = await call("POST", "/v1/pair/" + n.id, { k: "reply", c }, { peer: x });
    expect(r.body).toEqual({ r: "sent" });
    const fcm = vendorRequests("fcm.googleapis.com").filter((q) => q.url.includes("/v1/projects/"));
    const body = JSON.parse(new TextDecoder().decode(fcm[0].body));
    expect(body.message.android.ttl).toBe("2419200s");
    expect(body.message.android.priority).toBe("HIGH");
    expect(Object.keys(fcm[0].headers).some((h) => h.includes("collapse"))).toBe(false);
    expect(JSON.stringify(body)).not.toContain("collapse");
  });

  it("reply to an iPhone uses (X, me) order", async () => {
    const email = randomEmail();
    const x = await newPeer(email);
    const n = await newPeer(email, "iphone");
    const c = message(364) + "AA";
    await call("POST", "/v1/pair/" + n.id, { k: "reply", c }, { peer: x });
    expect(vendorRequests("api.push.apple.com")[0].headers["apns-collapse-id"]).toBe(await pairKey(n.id, x.id));
  });

  it("validation and results; same key twice -> 429, other kind passes; nothing written", async () => {
    const email = randomEmail();
    const n = await newPeer(email);
    const x = await newPeer(email);
    const c = message(364) + "AA";
    for (const body of [{ k: "other", c }, { k: "commit", c: c.slice(1) }, { k: "commit", c: c + "A" }]) {
      expect((await call("POST", "/v1/pair/" + x.id, body, { peer: n })).status).toBe(400);
    }
    expect((await call("POST", "/v1/pair/" + n.id, { k: "commit", c }, { peer: n })).status).toBe(400);
    const before = JSON.stringify([await row(n.id), await row(x.id)]);
    expect((await call("POST", "/v1/pair/" + x.id, { k: "commit", c }, { peer: n })).body).toEqual({ r: "sent" });
    expect((await call("POST", "/v1/pair/" + x.id, { k: "commit", c }, { peer: n })).status).toBe(429);
    expect((await call("POST", "/v1/pair/" + x.id, { k: "open", c }, { peer: n })).status).toBe(200);
    expect(JSON.stringify([await row(n.id), await row(x.id)])).toBe(before);
    expect((await call("POST", "/v1/pair/" + ghostOf(n), { k: "commit", c }, { peer: n })).body).toEqual({ r: "unknown" });
    await env.DB.prepare("UPDATE peers SET paused = 1 WHERE id = ?1").bind(x.id).run();
    expect((await call("POST", "/v1/pair/" + x.id, { k: "reply", c }, { peer: n })).body).toEqual({ r: "paused" });
    const y = await newPeer(email, "chrome", null);
    expect((await call("POST", "/v1/pair/" + y.id, { k: "commit", c }, { peer: n })).body).toEqual({ r: "gone" });
    await env.DB.prepare("UPDATE peers SET deny = json_set(deny, '$.\"' || ?1 || '\"', 1) WHERE id = ?2").bind(n.id, y.id).run();
    expect((await call("POST", "/v1/pair/" + y.id, { k: "open", c }, { peer: n })).body).toEqual({ r: "denied" });
  });
});

describe("UnifiedPush probe and confirm (7.6, 6.11)", () => {
  it("probe carries {probe: code}; confirm current and previous window; wrong code; RL_PROBE", async () => {
    const p = await newPeer(randomEmail(), "android", pushFor("android", "unifiedpush"));
    const probes = vendorRequests("up.example.org");
    expect(probes).toHaveLength(1);
    expect(probes[0].headers["content-encoding"]).toBe("aes128gcm");
    const push = j((await row(p.id))!.push);
    const w = Math.floor(Date.now() / 1000 / 300);
    expect((await call("POST", `/v1/peers/${p.id}/confirm`, { code: "A".repeat(22) }, { peer: p })).body.error).toBe("wrong code");
    const old = await probeCode(S.CONFIRM_SECRET, p.id, push, w - 2);
    expect((await call("POST", `/v1/peers/${p.id}/confirm`, { code: old }, { peer: p })).status).toBe(401);
    const prev = await probeCode(S.CONFIRM_SECRET, p.id, push, w - 1);
    const r = await call("POST", `/v1/peers/${p.id}/confirm`, { code: prev }, { peer: p });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({});
    expect(typeof j((await row(p.id))!.push).verified_at).toBe("number");
    // RL_PROBE: 2 per 60 s; the third push change sends no probe and still succeeds.
    for (let i = 0; i < 3; i++) {
      const rr = await call("PATCH", "/v1/peers/" + p.id, { push: pushFor("android", "unifiedpush") }, { peer: p });
      expect(rr.status).toBe(200);
    }
    expect(vendorRequests("up.example.org")).toHaveLength(2);
  });

  it("confirm on a non-type-6 push -> 400", async () => {
    const p = await newPeer(randomEmail());
    expect((await call("POST", `/v1/peers/${p.id}/confirm`, { code: "A".repeat(22) }, { peer: p })).status).toBe(400);
  });
});
