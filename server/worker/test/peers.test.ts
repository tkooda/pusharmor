import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { b64urlEncode } from "../src/codec/b64url";
import { acctOf, call, cliCodeFor, initP256, keys, message, newPeer, pushFor, randomEmail, register, row, setAllow, ticketFor, vendorRequests } from "./helpers";
import { LABEL_TICKET, makeTicket, openToken } from "../src/crypto/tokens";
import { TEST_SECRETS as S } from "./secrets";
import roundSql from "../migrations/0003_round_account_times.sql?raw";

beforeAll(initP256);

describe("POST /peers", () => {
  it("registers a new peer and lists it", async () => {
    const email = randomEmail();
    const { peer, r } = await register(email, "android");
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(peer.id);
    const peers = r.body.peers as Record<string, unknown>[];
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({ id: peer.id, platform: "android", logged_out: false, approves: 0, approved_by: 0, reachable: true, name_for_me: null });
    expect(typeof r.body.my_push_sha256).toBe("string");
    expect(r.body.my_allow).toEqual([]);
    expect(r.body.push_missing).toBeUndefined();
    const acct = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?1").bind(peer.acct).first();
    expect(acct).toMatchObject({ status: null });
  });

  it("push null is accepted with push_missing", async () => {
    const { r } = await register(randomEmail(), "chrome", null);
    expect(r.status).toBe(200);
    expect(r.body.push_missing).toBe(true);
    expect((r.body.peers as { reachable: boolean }[])[0].reachable).toBe(false);
    expect(r.body.my_push_sha256).toBeNull();
  });

  it("platform vs push type mismatch -> 400", async () => {
    const { r } = await register(randomEmail(), "ios", pushFor("android"));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "bad request" });
  });

  it("platform cli: push type 6 or null; other push types -> 400", async () => {
    expect((await register(randomEmail(), "cli", pushFor("cli"))).r.status).toBe(200);
    const { r } = await register(randomEmail(), "cli", null);
    expect(r.status).toBe(200);
    expect((r.body.peers as { platform: string }[])[0].platform).toBe("cli");
    for (const kind of ["android", "ios", "chrome", "firefox"]) {
      expect((await register(randomEmail(), "cli", pushFor(kind))).r.status).toBe(400);
    }
    expect((await register(randomEmail(), "android", pushFor("cli"))).r.status).toBe(200);
  });

  it("sign_pub equal to enc_pub -> 400", async () => {
    const k = await keys();
    const email = randomEmail();
    const body = { ticket: await ticketFor(email, k.signPub, "register"), sign_pub: k.signPub, enc_pub: k.signPub, platform: "android", push: null };
    const r = await call("POST", "/v1/peers", body, { sign: k.sign });
    expect(r.status).toBe(400);
  });

  it("ticket checks: wrong purpose, wrong key, expired", async () => {
    const k = await keys();
    const k2 = await keys();
    const email = randomEmail();
    const base = { sign_pub: k.signPub, enc_pub: k.encPub, platform: "android", push: null };
    let r = await call("POST", "/v1/peers", { ...base, ticket: await ticketFor(email, k.signPub, "login") }, { sign: k.sign });
    expect(r.body.error).toBe("invalid ticket");
    r = await call("POST", "/v1/peers", { ...base, ticket: await ticketFor(email, k2.signPub, "register") }, { sign: k.sign });
    expect(r.body.error).toBe("invalid ticket");
    r = await call("POST", "/v1/peers", { ...base, ticket: await ticketFor(email, k.signPub, "register", -10) }, { sign: k.sign });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("ticket expired");
    r = await call("POST", "/v1/peers", { ...base, ticket: "x.y" }, { sign: k.sign });
    expect(r.body.error).toBe("invalid ticket");
  });

  it("cli code as ticket: current and previous window pass; older -> ticket expired; else bad ticket", async () => {
    const k = await keys();
    const k2 = await keys();
    const email = randomEmail();
    const base = { sign_pub: k.signPub, enc_pub: k.encPub, platform: "cli", push: null };
    const reg = async (ticket: string) => call("POST", "/v1/peers", { ...base, ticket }, { sign: k.sign });
    for (const off of [-2, -7]) {
      const r = await reg(await cliCodeFor(email, k.signPub, "register", off));
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("ticket expired");
    }
    for (const t of [
      await cliCodeFor(email, k.signPub, "register", -8),
      await cliCodeFor(email, k.signPub, "register", 1),
      await cliCodeFor(email, k.signPub, "login"),
      await cliCodeFor(email, k2.signPub, "register"),
      "A".repeat(34),
      "*".repeat(34),
    ]) {
      const r = await reg(t);
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("bad ticket");
    }
    let r = await reg(await cliCodeFor(email, k.signPub, "register", -1));
    expect(r.status).toBe(200);
    expect(r.body.id).toMatch(new RegExp("^" + (await acctOf(email))));
    r = await reg(await cliCodeFor(email, k.signPub, "register"));
    expect(r.status).toBe(200);
  });

  it("bad signature -> 401 invalid client signature", async () => {
    const k = await keys();
    const k2 = await keys();
    const email = randomEmail();
    const body = { ticket: await ticketFor(email, k.signPub, "register"), sign_pub: k.signPub, enc_pub: k.encPub, platform: "android", push: null };
    const r = await call("POST", "/v1/peers", body, { sign: k2.sign });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("invalid client signature");
  });

  it("re-register keeps a confirmed identical push and verified_at; other platform -> 400", async () => {
    const email = randomEmail();
    const k = await keys();
    const push = pushFor("android", "unifiedpush");
    const body = { ticket: await ticketFor(email, k.signPub, "register"), sign_pub: k.signPub, enc_pub: k.encPub, platform: "android", push };
    let r = await call("POST", "/v1/peers", body, { sign: k.sign });
    expect(r.status).toBe(200);
    const id = r.body.id as string;
    await env.DB.prepare("UPDATE peers SET push = json_set(push, '$.verified_at', 123) WHERE id = ?1").bind(id).run();
    r = await call("POST", "/v1/peers", { ...body, ticket: await ticketFor(email, k.signPub, "register") }, { sign: k.sign });
    expect(r.status).toBe(200);
    expect(JSON.parse((await row(id))!.push as string).verified_at).toBe(123);
    r = await call("POST", "/v1/peers", { ...body, platform: "chrome", push: null, ticket: await ticketFor(email, k.signPub, "register") }, { sign: k.sign });
    expect(r.status).toBe(400);
    expect(JSON.parse((await row(id))!.push as string).verified_at).toBe(123);
  });

  it("banned account -> 403 (before peer limit)", async () => {
    const email = randomEmail();
    const p = await newPeer(email);
    await env.DB.prepare("UPDATE accounts SET status = 'banned' WHERE id = ?1").bind(p.acct).run();
    const { r } = await register(email);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "banned" });
  });

  it("peer limit: 11 parallel registrations -> exactly 10 rows; 409 carries ticket and peers; evict works", async () => {
    const email = randomEmail();
    const results = await Promise.all(Array.from({ length: 11 }, () => register(email, "android", null)));
    const ok = results.filter((x) => x.r.status === 200);
    const limit = results.filter((x) => x.r.status === 409);
    expect(ok).toHaveLength(10);
    expect(limit).toHaveLength(1);
    const lr = limit[0].r.body;
    expect(lr.error).toBe("peer limit");
    expect(typeof lr.ticket).toBe("string");
    const lp = lr.peers as Record<string, unknown>[];
    expect(lp).toHaveLength(10);
    expect(Object.keys(lp[0]).sort()).toEqual(["approved_by", "approves", "created", "enc_pub", "id", "logged_out", "platform", "reachable", "sign_pub"]);
    const n = await env.DB.prepare("SELECT count(*) AS n FROM peers WHERE account = ?1").bind(ok[0].peer.acct).first<{ n: number }>();
    expect(n!.n).toBe(10);
    // Retry with evict and the fresh 10-minute ticket.
    const lp0 = limit[0].peer;
    const k = { sign: lp0.sign };
    const body = { ticket: lr.ticket, sign_pub: lp0.signPub, enc_pub: lp0.encPub, platform: "android", push: null, evict: [ok[0].peer.id] };
    const r2 = await call("POST", "/v1/peers", body, k);
    expect(r2.status).toBe(200);
    expect(await row(ok[0].peer.id)).toBeNull();
  });

  it("peer limit: the renewed ticket never outlives 30 minutes from the first ticket", async () => {
    const email = randomEmail();
    for (let i = 0; i < 10; i++) await newPeer(email, "android", null);
    const k = await keys();
    const now = Math.floor(Date.now() / 1000);
    const renew = async (t: string) => {
      const r = await call("POST", "/v1/peers", { ticket: t, sign_pub: k.signPub, enc_pub: k.encPub, platform: "android", push: null }, { sign: k.sign });
      expect(r.body.error).toBe("peer limit");
      return (await openToken(S.PA_TOKEN_SECRET, LABEL_TICKET, r.body.ticket))!;
    };
    // A fresh 120 s ticket: renewal keeps the first issue time and gives the usual 600 s.
    const first = await renew(await ticketFor(email, k.signPub, "register"));
    expect(first.i).toBeGreaterThanOrEqual(now - 2);
    expect(first.x).toBeGreaterThanOrEqual(now + 598);
    // A renewed ticket issued 29 minutes ago: the next one ends 30 minutes after the first.
    const old = { a: first.a as string, k: first.k as string, p: "register" as const, x: now + 60, i: now - 29 * 60 };
    const second = await renew(await makeTicket(S.PA_TOKEN_SECRET, old));
    expect(second.i).toBe(now - 29 * 60);
    expect(second.x).toBe(now + 60);
  });

  it("duplicate concurrent first-time registration of one peer: both 200, one row (I305)", async () => {
    const email = randomEmail();
    const k = await keys();
    const body = { ticket: await ticketFor(email, k.signPub, "register"), sign_pub: k.signPub, enc_pub: k.encPub, platform: "android", push: null };
    const rs = await Promise.all(Array.from({ length: 4 }, () => call("POST", "/v1/peers", body, { sign: k.sign })));
    expect(rs.map((x) => x.status)).toEqual([200, 200, 200, 200]);
    expect(new Set(rs.map((x) => x.body.id)).size).toBe(1);
    const n = await env.DB.prepare("SELECT count(*) AS n FROM peers WHERE id = ?1").bind(rs[0].body.id).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("evict id outside the account or not found -> 400", async () => {
    const email = randomEmail();
    const other = await newPeer(randomEmail());
    let r = (await register(email, "android", null, { evict: [other.id] })).r;
    expect(r.status).toBe(400);
    const p = await newPeer(email);
    const ghost = p.acct + b64urlEncode(crypto.getRandomValues(new Uint8Array(21)));
    r = (await register(email, "android", null, { evict: [ghost] })).r;
    expect(r.status).toBe(400);
  });

  it("id collision is unreachable without a keyhash collision (same keys = re-register)", async () => {
    const email = randomEmail();
    const k = await keys();
    const body = async () => ({ ticket: await ticketFor(email, k.signPub, "register"), sign_pub: k.signPub, enc_pub: k.encPub, platform: "android", push: null });
    expect((await call("POST", "/v1/peers", await body(), { sign: k.sign })).status).toBe(200);
    expect((await call("POST", "/v1/peers", await body(), { sign: k.sign })).status).toBe(200);
  });

  it("last_seen_month (I192): new peer on a stale account writes 1 account row", async () => {
    const email = randomEmail();
    const p = await newPeer(email);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("UPDATE accounts SET last_seen_month = ?1 WHERE id = ?2").bind(now - 40 * 86400, p.acct).run();
    await newPeer(email);
    const a = await env.DB.prepare("SELECT last_seen_month FROM accounts WHERE id = ?1").bind(p.acct).first<{ last_seen_month: number }>();
    expect(a!.last_seen_month).toBe(now - (now % 2592000));
  });

  it("account times are coarse: created to the UTC day, last_seen_month to the 30-day period", async () => {
    const p = await newPeer(randomEmail());
    const now = Math.floor(Date.now() / 1000);
    const a = await env.DB.prepare("SELECT created, last_seen_month FROM accounts WHERE id = ?1").bind(p.acct).first<{ created: number; last_seen_month: number }>();
    expect(a!.created).toBe(now - (now % 86400));
    expect(a!.last_seen_month).toBe(now - (now % 2592000));
  });

  it("migration 0003 rounds stored account times", async () => {
    await env.DB.prepare("INSERT INTO accounts (id, created, status, last_seen_month) VALUES ('ROUNDROUND01', 1761300000, NULL, 1761300123)").run();
    await env.DB.exec(roundSql.replace(/^--.*$/gm, "").replace(/\s+/g, " ").trim());
    const a = await env.DB.prepare("SELECT created, last_seen_month FROM accounts WHERE id = 'ROUNDROUND01'").first<{ created: number; last_seen_month: number }>();
    expect(a).toEqual({ created: 1761264000, last_seen_month: 1759968000 });
  });
});

describe("GET /peers", () => {
  it("lists approves, approved_by, approves_me, denies_me, name_for_me, my_allow", async () => {
    const email = randomEmail();
    const a = await newPeer(email);
    const b = await newPeer(email, "chrome");
    await setAllow(a, [b.id]);
    await env.DB.prepare("UPDATE peers SET name = json_set(name, '$.\"' || ?1 || '\"', 'TkFNRQ'), deny = json_set(deny, '$.\"' || ?1 || '\"', 1) WHERE id = ?2").bind(b.id, a.id).run();
    const r = await call("GET", "/v1/peers", undefined, { peer: b });
    expect(r.status).toBe(200);
    const pa = (r.body.peers as Record<string, unknown>[]).find((x) => x.id === a.id)!;
    expect(pa).toMatchObject({ approves: 1, approves_me: true, denies_me: true, name_for_me: "TkFNRQ" });
    const pb = (r.body.peers as Record<string, unknown>[]).find((x) => x.id === b.id)!;
    expect(pb).toMatchObject({ approved_by: 1, approves: 0 });
    expect(r.body.my_allow).toEqual([]);
    const ra = await call("GET", "/v1/peers", undefined, { peer: a });
    expect(ra.body.my_allow).toEqual([b.id]);
  });

  it("smoke (I270): unsigned GET -> 400 with PA-Epoch-Ms and expose header", async () => {
    const r = await call("GET", "/v1/peers");
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "bad request" });
    expect(r.res.headers.get("PA-Epoch-Ms")).toMatch(/^[0-9]{13}$/);
    expect(r.res.headers.get("Access-Control-Expose-Headers")).toBe("PA-Epoch-Ms");
    expect(r.res.headers.get("Cache-Control")).toBe("no-store");
    expect(r.res.headers.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
  });

  it("removed caller -> 401 unknown peer", async () => {
    const p = await newPeer(randomEmail());
    await env.DB.prepare("DELETE FROM peers WHERE id = ?1").bind(p.id).run();
    const r = await call("GET", "/v1/peers", undefined, { peer: p });
    expect(r.body.error).toBe("unknown peer");
  });
});

describe("PATCH /peers/$id push", () => {
  it("writes push; path id must equal PA-ID; null push -> push_missing", async () => {
    const email = randomEmail();
    const p = await newPeer(email);
    const q = await newPeer(email);
    let r = await call("PATCH", "/v1/peers/" + q.id, { push: pushFor("android") }, { peer: p });
    expect(r.status).toBe(400);
    const push = pushFor("android");
    r = await call("PATCH", "/v1/peers/" + p.id, { push }, { peer: p });
    expect(r.status).toBe(200);
    expect(JSON.parse((await row(p.id))!.push as string)).toEqual(push);
    r = await call("PATCH", "/v1/peers/" + p.id, { push: null }, { peer: p });
    expect(r.body).toEqual({ push_missing: true });
    expect((await row(p.id))!.push_type).toBeNull();
  });

  it("type 6: identical push on a confirmed row -> no write, no probe; unconfirmed -> write and probe", async () => {
    const p = await newPeer(randomEmail(), "android", null);
    const push = pushFor("android", "unifiedpush");
    let r = await call("PATCH", "/v1/peers/" + p.id, { push }, { peer: p });
    expect(r.status).toBe(200);
    expect(vendorRequests("ntfy.sh")).toHaveLength(1);
    r = await call("PATCH", "/v1/peers/" + p.id, { push }, { peer: p });
    expect(vendorRequests("ntfy.sh")).toHaveLength(2);
    await env.DB.prepare("UPDATE peers SET push = json_set(push, '$.verified_at', 5) WHERE id = ?1").bind(p.id).run();
    r = await call("PATCH", "/v1/peers/" + p.id, { push }, { peer: p });
    expect(r.status).toBe(200);
    expect(vendorRequests("ntfy.sh")).toHaveLength(2);
    expect(JSON.parse((await row(p.id))!.push as string).verified_at).toBe(5);
  });

  it("tokens with / or ? are rejected; endpoint not allowed", async () => {
    const p = await newPeer(randomEmail());
    for (const token of ["abc/def", "abc?x", "abc#x"]) {
      const r = await call("PATCH", "/v1/peers/" + p.id, { push: { type: "fcm", token } }, { peer: p });
      expect(r.status).toBe(400);
    }
    const r = await call("PATCH", "/v1/peers/" + p.id, { push: { type: "apns", token: "zz" } }, { peer: p });
    expect(r.status).toBe(400);
    const c = await newPeer(randomEmail(), "chrome");
    const wp = pushFor("chrome");
    for (const endpoint of ["https://evil.example.com/fcm/send/x", "https://fcm.googleapis.com:443/fcm/send/x", "http://fcm.googleapis.com/fcm/send/x", "https://u@fcm.googleapis.com/fcm/send/x", "https://fcm.googleapis.com/other/x"]) {
      const rr = await call("PATCH", "/v1/peers/" + c.id, { push: { ...wp, endpoint } }, { peer: c });
      expect(rr.status).toBe(400);
      expect(rr.body.error).toBe("push endpoint not allowed");
    }
  });

  it("UnifiedPush host rules (I227 05)", async () => {
    const p = await newPeer(randomEmail(), "android", null);
    const up = pushFor("android", "unifiedpush");
    const bad = [
      "https://api.pusharmor.com./x",
      "https://foo.localhost./x",
      "https://a..b.example/x",
      "https://.example.com/x",
      "https://10.0.0.1/x",
      "https://[::1]/x",
      "https://ntfy.sh:8443/x",
      "http://ntfy.sh/x",
      "https://up.example.org/x",
      "https://ntfy.sh.example.org/x",
      "https://sub.ntfy.sh/x",
      "https://x.workers.dev/x",
      "https://printer.local/x",
      "https://svc.internal/x",
      "https://1.0.0.10.in-addr.arpa/x",
      "https://localhost/x",
      "https://intranet/x",
      "https://intranet./x",
    ];
    for (const endpoint of bad) {
      const r = await call("PATCH", "/v1/peers/" + p.id, { push: { ...up, endpoint } }, { peer: p });
      expect(r.status, endpoint).toBe(400);
      expect(r.body.error).toBe("push endpoint not allowed");
    }
    for (const endpoint of ["https://NTFY.sh./x", "https://ntfy.sh:443/x"]) {
      const r = await call("PATCH", "/v1/peers/" + p.id, { push: { ...up, endpoint } }, { peer: p });
      expect(r.status, endpoint).toBe(200);
    }
  });
});

describe("cli push endpoint (Q307)", () => {
  it("only https://<allowed host>/up<12 chars>?up=1", async () => {
    const p = await newPeer(randomEmail(), "cli", null);
    const up = pushFor("cli");
    const t = "AbC-_123xyz9";
    for (const endpoint of [
      `https://ntfy.sh/up${t}`,
      `https://ntfy.sh/up${t}?up=0`,
      `https://ntfy.sh/up${t}?up=1&x=1`,
      `https://ntfy.sh/up${t}1?up=1`,
      `https://ntfy.sh/up${t.slice(1)}?up=1`,
      `https://ntfy.sh/x${t}?up=1`,
      `https://ntfy.sh/up${t.slice(1)}*?up=1`,
      `https://ntfy.sh:443/up${t}?up=1`,
      `https://ntfy.sh/a/up${t}?up=1`,
      `https://up.example.org/up${t}?up=1`,
    ]) {
      const r = await call("PATCH", "/v1/peers/" + p.id, { push: { ...up, endpoint } }, { peer: p });
      expect(r.status, endpoint).toBe(400);
      expect(r.body.error).toBe("push endpoint not allowed");
    }
    let r = await call("PATCH", "/v1/peers/" + p.id, { push: { ...up, endpoint: `https://ntfy.sh/up${t}?up=1` } }, { peer: p });
    expect(r.status).toBe(200);
    r = await call("POST", "/v1/peers", { ticket: await ticketFor(p.email, p.signPub, "register"), sign_pub: p.signPub, enc_pub: p.encPub, platform: "cli", push: pushFor("android", "unifiedpush") }, { sign: p.sign });
    expect(r.body.error).toBe("push endpoint not allowed");
  });
});

describe("pipeline", () => {
  it("PA-Time format and skew", async () => {
    const p = await newPeer(randomEmail());
    let r = await call("GET", "/v1/peers", undefined, { peer: p, time: "0761300000000" });
    expect(r.status).toBe(400);
    r = await call("GET", "/v1/peers", undefined, { peer: p, time: "17613000000001" });
    expect(r.status).toBe(400);
    r = await call("GET", "/v1/peers", undefined, { peer: p, time: String(Date.now() - 301000) });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("clock skew");
    r = await call("GET", "/v1/peers", undefined, { peer: p, time: String(Date.now() - 200000) });
    expect(r.status).toBe(200);
  });

  it("forged PA-ID -> 401 unknown peer with no D1 query", async () => {
    const p = await newPeer(randomEmail());
    const forged = { ...p, id: p.id.slice(0, 30) + "AAAAAAAAAA" };
    const r = await call("GET", "/v1/peers", undefined, { peer: forged });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("unknown peer");
  });

  it("bad signature and missing signature", async () => {
    const p = await newPeer(randomEmail());
    const q = await newPeer(randomEmail());
    let r = await call("GET", "/v1/peers", undefined, { peer: { ...p, sign: q.sign } });
    expect(r.body.error).toBe("invalid client signature");
    r = await call("GET", "/v1/peers", undefined, { peer: p, noSig: true });
    expect(r.body.error).toBe("invalid client signature");
  });

  it("body cap 48000 -> 413; a max-size PATCH rename passes the cap", async () => {
    const p = await newPeer(randomEmail());
    let r = await call("PATCH", "/v1/peers/" + p.id, undefined, { peer: p, rawBody: "x".repeat(48001) });
    expect(r.status).toBe(413);
    const ids = Array.from({ length: 9 }, () => p.acct + b64urlEncode(crypto.getRandomValues(new Uint8Array(21))));
    const name: Record<string, string> = {};
    const m: Record<string, string> = {};
    for (const id of ids) {
      name[id] = message(1024);
      m[id] = message(3800);
    }
    const body = JSON.stringify({ name, m });
    expect(body.length).toBeLessThanOrEqual(48000);
    r = await call("PATCH", "/v1/peers/" + p.id, { name, m }, { peer: p });
    expect(r.status).toBe(200);
  });

  it("3801-char message -> 413; non-canonical b64url -> 400; 10 entries -> 400", async () => {
    const email = randomEmail();
    const p = await newPeer(email);
    const q = await newPeer(email);
    let r = await call("POST", "/v1/send", { v: 1, m: { [q.id]: message(3800) + "A" } }, { peer: p });
    expect(r.status).toBe(413);
    expect(r.body).toEqual({ error: "too large" });
    r = await call("POST", "/v1/send", { v: 1, m: { [q.id]: "AB" } }, { peer: p });
    expect(r.status).toBe(400);
    const m: Record<string, string> = {};
    for (let i = 0; i < 10; i++) m[p.acct + b64urlEncode(crypto.getRandomValues(new Uint8Array(21)))] = message(512);
    r = await call("POST", "/v1/send", { v: 1, m }, { peer: p });
    expect(r.status).toBe(400);
    r = await call("POST", "/v1/send", { v: 1, m: {}, x: 1 }, { peer: p });
    expect(r.status).toBe(400);
    r = await call("POST", "/v1/send", { v: 1, m: { [p.id]: message(512) } }, { peer: p });
    expect(r.status).toBe(400);
    r = await call("POST", "/v1/send", undefined, { peer: p, rawBody: new Uint8Array([0x7b, 0xff, 0x7d]) });
    expect(r.status).toBe(400);
  });

  it("404 and 405", async () => {
    expect((await call("GET", "/v1/nope")).status).toBe(404);
    expect((await call("PUT", "/v1/send")).status).toBe(405);
    expect((await call("POST", "/v1/approve/short", {})).status).toBe(400);
  });
});
