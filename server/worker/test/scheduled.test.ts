import { describe, expect, it } from "vitest";
import { createScheduledController, env } from "cloudflare:test";
import { purge, PURGE_IDLE_S, PURGE_MAX_CHUNKS, scheduled } from "../src/scheduled";
import { Log } from "../src/log";
import { captured, meterD1, testEnv } from "./helpers";

const NOW = Math.floor(Date.now() / 1000);

async function fill(n: number, lastSeen: number, prefix: string, status: string | null = null): Promise<void> {
  await env.DB.prepare(
    `WITH RECURSIVE c(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM c WHERE i < ?1 - 1)
     INSERT INTO accounts (id, created, status, last_seen_month)
     SELECT ?2 || substr('000000000000' || i, -(12 - length(?2))), 1, ?4, ?3 FROM c`,
  )
    .bind(n, prefix, lastSeen, status)
    .run();
}

describe("purge (Q159)", () => {
  it("deletes idle non-banned accounts with their peers, keeps banned and fresh ones", async () => {
    await fill(250, NOW - PURGE_IDLE_S - 10, "I");
    await fill(3, NOW - PURGE_IDLE_S - 10, "B", "banned");
    await fill(3, NOW, "F");
    // One peer row for each of 5 idle accounts.
    await env.DB.prepare(
      `INSERT INTO peers (id, account, sign_pub, enc_pub, platform, created)
       SELECT id || substr('AAAAAAAAAAAAAAAAAAAAAAAAAAAA', 1, 28), id, substr(hex(zeroblob(44)), 1, 87), substr(hex(zeroblob(44)), 1, 87), 'android', 1
       FROM accounts WHERE id LIKE 'I%' ORDER BY id LIMIT 5`,
    ).run();
    const log = new Log();
    const n = await purge(await testEnv(), NOW, log);
    expect(n).toBe(250);
    const left = await env.DB.prepare("SELECT substr(id, 1, 1) AS k, count(*) AS n FROM accounts GROUP BY k ORDER BY k").all();
    expect(left.results).toEqual([{ k: "B", n: 3 }, { k: "F", n: 3 }]);
    const orphans = await env.DB.prepare("SELECT count(*) AS n FROM peers WHERE account NOT IN (SELECT id FROM accounts)").first<{ n: number }>();
    expect(orphans!.n).toBe(0);
    expect(log.extra.purged).toBe(250);
  });

  it("keyset cursor (I448): each chunk starts after the last purged id, no rescans, no empty final chunk", async () => {
    await fill(2000, NOW, "A");
    await fill(250, NOW - PURGE_IDLE_S - 10, "I");
    await fill(2000, NOW, "Z");
    const log = new Log();
    const m = await meterD1(async () => purge(await testEnv(), NOW, log));
    expect(m.result).toBe(250);
    expect(log.extra.chunks).toBe(3);
    // One pass over the table per statement (2 statements per chunk), not one per chunk.
    expect(m.rows_read).toBeLessThan(2 * 4250 + 2000);
    const left = await env.DB.prepare("SELECT count(*) AS n FROM accounts").first<{ n: number }>();
    expect(left!.n).toBe(4000);
  });

  it("cap (I227 07): 60,000 idle accounts -> at most 500 chunks; count logged", async () => {
    await fill(60000, NOW - PURGE_IDLE_S - 10, "C");
    const log = new Log();
    const n = await purge(await testEnv(), NOW, log);
    expect(log.extra.chunks).toBe(PURGE_MAX_CHUNKS);
    expect(n).toBe(50000);
    const left = await env.DB.prepare("SELECT count(*) AS n FROM accounts").first<{ n: number }>();
    expect(left!.n).toBe(10000);
  });
});

describe("scheduled()", () => {
  it("unknown cron logs cron-unknown", async () => {
    const before = captured.length;
    await scheduled(createScheduledController({ cron: "5 5 5 5 5" }), await testEnv());
    expect(captured.slice(before).some((l) => JSON.parse(l).error === "cron-unknown")).toBe(true);
  });
});
