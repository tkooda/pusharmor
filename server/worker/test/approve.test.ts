import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { b64urlEncode } from "../src/codec/b64url";
import { call, countingLimit, initP256, message, newPeer, randomEmail, row, setAllow, testEnv, vendorRequests, type Peer } from "./helpers";

beforeAll(initP256);

async function pairOf(platformB = "android"): Promise<[Peer, Peer]> {
  const email = randomEmail();
  return [await newPeer(email), await newPeer(email, platformB)];
}

const j = (s: unknown) => JSON.parse(s as string);

describe("POST /approve/$X (Q180 B, I230)", () => {
  it("first approve stored, second relays and returns c", async () => {
    const [a, b] = await pairOf();
    const ca = message(1024);
    const cb = message(1024);
    let r = await call("POST", "/v1/approve/" + b.id, { c: ca, name: message(200) }, { peer: a });
    expect(r.body).toEqual({ r: "stored" });
    expect(j((await row(a.id))!.pending)[b.id][1]).toBe(ca);
    expect(vendorRequests()).toHaveLength(0);
    r = await call("POST", "/v1/approve/" + a.id, { c: cb, name: message(200) }, { peer: b });
    expect(r.body).toEqual({ r: "sent", c: ca });
    expect(j((await row(b.id))!.pending)[a.id][1]).toBe(cb);
    const fcm = vendorRequests("fcm.googleapis.com");
    expect(fcm).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(fcm[0].body)).message.data.m).toBe(cb);
    // Re-sent approve (I265): same reply.
    // RL_PAIR: 1 per 60 s per key, counted by a stub (the binding window can roll over mid-test, I364).
    const rl = countingLimit(1);
    const e = await testEnv({ RL_PAIR: rl });
    const r2 = await call("POST", "/v1/approve/" + a.id, { c: cb, name: message(200) }, { peer: b, ip: "10.9.9.9", env: e });
    const r3 = await call("POST", "/v1/approve/" + a.id, { c: cb, name: message(200) }, { peer: b, ip: "10.9.9.9", env: e });
    expect([r2.status, r3.status]).toEqual([200, 429]);
    expect(rl.seen).toEqual(Array(2).fill("id:" + b.id + a.id));
  });

  it("approve after X denied -> denied, nothing stored", async () => {
    const [a, b] = await pairOf();
    await env.DB.prepare("UPDATE peers SET deny = json_set(deny, '$.\"' || ?1 || '\"', 1) WHERE id = ?2").bind(a.id, b.id).run();
    const r = await call("POST", "/v1/approve/" + b.id, { c: message(1024), name: message(200) }, { peer: a });
    expect(r.body).toEqual({ r: "denied" });
    expect(j((await row(a.id))!.allow)).toEqual({});
  });

  it("X unknown, self and foreign prefix", async () => {
    const [a] = await pairOf();
    const ghost = a.acct + b64urlEncode(crypto.getRandomValues(new Uint8Array(21)));
    let r = await call("POST", "/v1/approve/" + ghost, { c: message(1024), name: message(200) }, { peer: a });
    expect(r.body).toEqual({ r: "unknown" });
    r = await call("POST", "/v1/approve/" + a.id, { c: message(1024), name: message(200) }, { peer: a });
    expect(r.status).toBe(400);
    const other = await newPeer(randomEmail());
    r = await call("POST", "/v1/approve/" + other.id, { c: message(1024), name: message(200) }, { peer: a });
    expect(r.status).toBe(400);
  });

  it("second approve to a logged-out X -> logged out with c; push NULL -> gone", async () => {
    const [a, b] = await pairOf();
    const ca = message(1024);
    await call("POST", "/v1/approve/" + b.id, { c: ca, name: message(200) }, { peer: a });
    await env.DB.prepare("UPDATE peers SET logged_out = 1 WHERE id = ?1").bind(a.id).run();
    let r = await call("POST", "/v1/approve/" + a.id, { c: message(1024), name: message(200) }, { peer: b });
    expect(r.body).toEqual({ r: "logged out", c: ca });
    const [x, y] = await pairOf();
    await call("POST", "/v1/approve/" + y.id, { c: message(1024), name: message(200) }, { peer: x });
    await env.DB.prepare("UPDATE peers SET push = NULL, push_type = NULL WHERE id = ?1").bind(x.id).run();
    r = await call("POST", "/v1/approve/" + x.id, { c: message(1024), name: message(200) }, { peer: y });
    expect(r.body.r).toBe("gone");
  });

  it("two parallel first approves -> one stored, one relay with c", async () => {
    const [a, b] = await pairOf();
    const [r1, r2] = await Promise.all([
      call("POST", "/v1/approve/" + b.id, { c: message(1024), name: message(200) }, { peer: a }),
      call("POST", "/v1/approve/" + a.id, { c: message(1024), name: message(200) }, { peer: b }),
    ]);
    const rs = [r1.body.r, r2.body.r].sort();
    expect(rs).toEqual(["sent", "stored"]);
    expect([r1.body.c, r2.body.c].filter(Boolean)).toHaveLength(1);
  });

  it("pending pruned only once the peer row is gone; DELETE /peers removes it everywhere", async () => {
    const email = randomEmail();
    const a = await newPeer(email);
    const b = await newPeer(email);
    const c = await newPeer(email);
    await call("POST", "/v1/approve/" + b.id, { c: message(1024), name: message(200) }, { peer: a });
    await call("POST", "/v1/approve/" + c.id, { c: message(1024), name: message(200) }, { peer: a });
    expect(Object.keys(j((await row(a.id))!.pending)).sort()).toEqual([b.id, c.id].sort());
    // Delete c's row behind the Worker's back: the next approve UPDATE drops pending[c].
    await env.DB.prepare("DELETE FROM peers WHERE id = ?1").bind(c.id).run();
    const d = await newPeer(email);
    await call("POST", "/v1/approve/" + d.id, { c: message(1024), name: message(200) }, { peer: a });
    expect(Object.keys(j((await row(a.id))!.pending)).sort()).toEqual([b.id, d.id].sort());
    // DELETE /peers/b prunes b from a's allow, name and pending.
    const r = await call("DELETE", "/v1/peers/" + b.id, { m: {} }, { peer: d });
    expect(r.status).toBe(200);
    const ar = (await row(a.id))!;
    expect(j(ar.pending)[b.id]).toBeUndefined();
    expect(j(ar.allow)[b.id]).toBeUndefined();
    expect(j(ar.name)[b.id]).toBeUndefined();
  });
});

describe("POST /deny/$X", () => {
  it("deny after approve passes (own key); two denies -> 429; deny clears pending, sets deny", async () => {
    const [a, b] = await pairOf();
    await call("POST", "/v1/approve/" + b.id, { c: message(1024), name: message(200) }, { peer: a });
    let r = await call("POST", "/v1/deny/" + b.id, { c: message(512) }, { peer: a });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ r: "unapproved" });
    const ar = (await row(a.id))!;
    expect(j(ar.deny)).toEqual({ [b.id]: 1 });
    expect(j(ar.pending)).toEqual({});
    expect(j(ar.allow)).toEqual({});
    r = await call("POST", "/v1/deny/" + b.id, { c: message(512) }, { peer: a });
    expect(r.status).toBe(429);
    expect(r.res.headers.get("Retry-After")).toBe("60");
    expect(r.body).toEqual({ error: "rate limited", retry_after: 60 });
  });

  it("deny relays only when X's allow has me, NORMAL priority", async () => {
    const [a, b] = await pairOf();
    await setAllow(b, [a.id]);
    const r = await call("POST", "/v1/deny/" + b.id, { c: message(512) }, { peer: a });
    expect(r.body).toEqual({ r: "sent" });
    const fcm = vendorRequests("fcm.googleapis.com");
    expect(JSON.parse(new TextDecoder().decode(fcm[0].body)).message.android.priority).toBe("NORMAL");
  });

  it("X denies me -> denied; X logged out -> logged out", async () => {
    const [a, b] = await pairOf();
    await env.DB.prepare("UPDATE peers SET deny = json_set(deny, '$.\"' || ?1 || '\"', 1) WHERE id = ?2").bind(a.id, b.id).run();
    expect((await call("POST", "/v1/deny/" + b.id, { c: message(512) }, { peer: a })).body).toEqual({ r: "denied" });
    const [x, y] = await pairOf();
    await setAllow(y, [x.id]);
    await env.DB.prepare("UPDATE peers SET logged_out = 1 WHERE id = ?1").bind(y.id).run();
    expect((await call("POST", "/v1/deny/" + y.id, { c: message(512) }, { peer: x })).body).toEqual({ r: "logged out" });
  });
});

describe("withdraw (I264, I278)", () => {
  it("removes allow, name, pending; no deny; no relay; unapproved; key spent", async () => {
    const [a, b] = await pairOf();
    await setAllow(b, [a.id]);
    await call("POST", "/v1/approve/" + b.id, { c: message(1024), name: message(200) }, { peer: a });
    const before = vendorRequests().length;
    let r = await call("POST", "/v1/deny/" + b.id, { withdraw: 1 }, { peer: a });
    expect(r.body).toEqual({ r: "unapproved" });
    const ar = (await row(a.id))!;
    expect(j(ar.allow)).toEqual({});
    expect(j(ar.name)).toEqual({});
    expect(j(ar.pending)).toEqual({});
    expect(j(ar.deny)).toEqual({});
    expect(vendorRequests().length).toBe(before);
    r = await call("POST", "/v1/deny/" + b.id, { withdraw: 1 }, { peer: a });
    expect(r.status).toBe(429);
  });

  it("invalid shapes -> 400", async () => {
    const [a, b] = await pairOf();
    for (const body of [{ withdraw: 2 }, { withdraw: 1, c: message(512) }, {}, { withdraw: true }, { withdraw: "1" }]) {
      const r = await call("POST", "/v1/deny/" + b.id, body, { peer: a });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    const other = await newPeer(randomEmail());
    expect((await call("POST", "/v1/deny/" + other.id, { withdraw: 1 }, { peer: a })).status).toBe(400);
    expect((await call("POST", "/v1/deny/" + a.id, { withdraw: 1 }, { peer: a })).status).toBe(400);
    expect((await call("POST", "/v1/deny/not-an-id", { withdraw: 1 }, { peer: a })).status).toBe(400);
  });

  it("logged-out caller: withdraw passes, deny with c gets 401 logged out; never-approved and removed X -> unapproved", async () => {
    const [a, b] = await pairOf();
    await env.DB.prepare("UPDATE peers SET logged_out = 1 WHERE id = ?1").bind(a.id).run();
    let r = await call("POST", "/v1/deny/" + b.id, { c: message(512) }, { peer: a });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("logged out");
    const before = JSON.stringify(await row(a.id));
    r = await call("POST", "/v1/deny/" + b.id, { withdraw: 1 }, { peer: a });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ r: "unapproved" });
    expect(JSON.stringify(await row(a.id))).toBe(before);
    const ghost = a.acct + b64urlEncode(crypto.getRandomValues(new Uint8Array(21)));
    r = await call("POST", "/v1/deny/" + ghost, { withdraw: 1 }, { peer: a });
    expect(r.body).toEqual({ r: "unapproved" });
  });
});

describe("concurrent delete (I253)", () => {
  it("rename with a name key for a missing (pruned) peer: key skipped, 200", async () => {
    const [a, b] = await pairOf();
    const ghost = a.acct + b64urlEncode(crypto.getRandomValues(new Uint8Array(21)));
    await setAllow(a, [b.id, ghost]);
    const r = await call("PATCH", "/v1/peers/" + a.id, { name: { [ghost]: message(200) }, m: {} }, { peer: a });
    expect(r.status).toBe(400); // in my_allow but row gone: EXISTS guard -> 400, nothing written
    expect(j((await row(a.id))!.name)).toEqual({});
    const r2 = await call("PATCH", "/v1/peers/" + a.id, { name: { [b.id]: "TkFNRQ" }, m: { [b.id]: message(512) } }, { peer: a });
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual({ r: { [b.id]: "unapproved" } });
    expect(j((await row(a.id))!.name)).toEqual({ [b.id]: "TkFNRQ" });
  });

  it("rename key not in my_allow is skipped (I277)", async () => {
    const [a, b] = await pairOf();
    const r = await call("PATCH", "/v1/peers/" + a.id, { name: { [b.id]: "TkFNRQ" }, m: {} }, { peer: a });
    expect(r.status).toBe(200);
    expect(j((await row(a.id))!.name)).toEqual({});
  });
});

describe("races (I253, I274, I265)", () => {
  async function racingEnv(before: () => Promise<void>) {
    const e = await (await import("./helpers")).testEnv();
    const db = e.DB;
    let fired = false;
    const proxy = new Proxy(db, {
      get(t, p) {
        if (p === "batch")
          return async (stmts: D1PreparedStatement[]) => {
            if (!fired) {
              fired = true;
              await before();
            }
            return t.batch(stmts);
          };
        const v = (t as unknown as Record<string | symbol, unknown>)[p];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    return { ...e, DB: proxy as D1Database };
  }

  it("X deleted between Q_CTX and the write: approve and deny reply unknown, nothing written", async () => {
    for (const path of ["approve", "deny"]) {
      const [a, b] = await pairOf();
      const e = await racingEnv(async () => {
        await env.DB.prepare("DELETE FROM peers WHERE id = ?1").bind(b.id).run();
      });
      const body = path === "approve" ? { c: message(1024), name: message(200) } : { c: message(512) };
      const r = await call("POST", `/v1/${path}/` + b.id, body, { peer: a, env: e });
      expect(r.body).toEqual({ r: "unknown" });
      const ar = (await row(a.id))!;
      for (const col of ["allow", "deny", "name", "pending"]) expect(j(ar[col])).toEqual({});
    }
  });

  it("caller removed between Q_CTX and the write -> 401 unknown peer", async () => {
    for (const path of ["approve", "deny"]) {
      const [a, b] = await pairOf();
      const e = await racingEnv(async () => {
        await env.DB.prepare("DELETE FROM peers WHERE id = ?1").bind(a.id).run();
      });
      const body = path === "approve" ? { c: message(1024), name: message(200) } : { c: message(512) };
      const r = await call("POST", `/v1/${path}/` + b.id, body, { peer: a, env: e });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("unknown peer");
    }
  });

  it("rename vs concurrent delete of a named peer -> 400, nothing written", async () => {
    const [a, b] = await pairOf();
    await setAllow(a, [b.id]);
    const e = await racingEnv(async () => {
      await env.DB.prepare("DELETE FROM peers WHERE id = ?1").bind(b.id).run();
    });
    const r = await call("PATCH", "/v1/peers/" + a.id, { name: { [b.id]: "TkFNRQ" }, m: {} }, { peer: a, env: e });
    expect(r.status).toBe(400);
    expect(j((await row(a.id))!.name)).toEqual({});
  });

  it("re-sent identical approve (I265): same c stored, relayed again, same reply", async () => {
    const [a, b] = await pairOf();
    const ca = message(1024);
    await call("POST", "/v1/approve/" + b.id, { c: ca, name: message(200) }, { peer: a });
    const e = { ...(await (await import("./helpers")).testEnv()), RL_PAIR: { limit: async () => ({ success: true }) } };
    const body = { c: message(1024), name: message(200) };
    const r1 = await call("POST", "/v1/approve/" + a.id, body, { peer: b, env: e });
    const r2 = await call("POST", "/v1/approve/" + a.id, body, { peer: b, env: e });
    expect(r1.body).toEqual({ r: "sent", c: ca });
    expect(r2.body).toEqual(r1.body);
    expect(j((await row(b.id))!.pending)[a.id][1]).toBe(body.c);
    expect(vendorRequests("fcm.googleapis.com").filter((x) => x.url.includes("/v1/projects/"))).toHaveLength(2);
  });
});
