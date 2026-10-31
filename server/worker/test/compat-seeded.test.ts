import { beforeAll, describe, expect, it } from "vitest";
import { createScheduledController, env } from "cloudflare:test";
import { scheduled } from "../src/scheduled";
import { call, initP256, message, newPeer, randomEmail, row, testEnv } from "./helpers";

// Migrations compat (I449): rows in the current production format, written straight to the D1
// after all migrations, then read by the Worker. worker.yml (migrations-compat) also copies
// this file into the previous worker/v tag and runs it there with the current migrations, so a
// migration or row format that the previous Worker cannot read fails CI before a deploy. Use
// only long-standing helpers and routes here: the file must run against the previous tree.
// Migration 0005 (paused -> logged_out, platform 'iphone' -> 'ios') breaks this expectation on
// purpose for a previous Worker below 0.0.19; worker.yml skips the job until then.

beforeAll(initP256);

const j = (s: unknown) => JSON.parse(s as string);
const DAY = 86400;

describe("seeded production rows", () => {
  it("approve reads [t, c] and legacy string pending entries; the monthly cron expires and stamps them", async () => {
    const email = randomEmail();
    const a = await newPeer(email);
    const b = await newPeer(email);
    const c = await newPeer(email);
    const d = await newPeer(email);
    const now = Math.floor(Date.now() / 1000);
    const cb = message(1024);
    const cc = message(1024);
    // a approved b (entry since 0004: [time, c]), c (legacy string entry) and d (expired entry).
    const ids = [b.id, c.id, d.id];
    const allow = Object.fromEntries(ids.map((x) => [x, 1]));
    const name = Object.fromEntries(ids.map((x) => [x, message(200)]));
    const pending = { [b.id]: [now - 60, cb], [c.id]: cc, [d.id]: [now - 40 * DAY, message(1024)] };
    await env.DB.prepare("UPDATE peers SET allow = ?1, name = ?2, pending = ?3 WHERE id = ?4")
      .bind(JSON.stringify(allow), JSON.stringify(name), JSON.stringify(pending), a.id).run();

    let r = await call("POST", "/v1/approve/" + a.id, { c: message(1024), name: message(200) }, { peer: b });
    expect(r.body).toEqual({ r: "sent", c: cb });
    r = await call("POST", "/v1/approve/" + a.id, { c: message(1024), name: message(200) }, { peer: c });
    expect(r.body).toEqual({ r: "sent", c: cc });

    await scheduled(createScheduledController({ cron: "0 3 1 * *" }), await testEnv());
    const p = j((await row(a.id))!.pending);
    expect(Object.keys(p).sort()).toEqual([b.id, c.id].sort());
    expect(p[b.id]).toEqual([now - 60, cb]);
    expect(p[c.id][1]).toBe(cc);
    expect(p[c.id][0]).toBeGreaterThanOrEqual(now);
  });
});
