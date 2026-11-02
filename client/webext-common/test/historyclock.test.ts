import { test } from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import type { HistoryRow } from "../src/store/db.ts";
import { Clock, FakePlatform, MockWorker, makeEngine } from "./harness.ts";

const HOUR = 3600e3;

function histRow(received: number, content: string): HistoryRow {
  return { dir: "in", peer: null, type: "text", content, n: null, pairing_id: null, received, read: true };
}

test("a clock set back keeps the time of newer History rows", async () => {
  const clock = new Clock();
  const p = new FakePlatform("chrome", new MockWorker(clock), clock);
  const { db } = await makeEngine(p, new IDBFactory(), clock);
  const t0 = clock.t;
  await db.addHistory(histRow(t0 - HOUR, "a"));
  await db.addHistory(histRow(t0, "b"));
  clock.t = t0 - 2 * HOUR; // clock stepped back
  await db.addHistory(histRow(clock.t, "c"));
  const byContent = new Map((await db.history()).map((r) => [r.content, r.received]));
  assert.equal(byContent.get("a"), t0 - HOUR);
  assert.equal(byContent.get("b"), t0);
  assert.equal(byContent.get("c"), t0 - 2 * HOUR);
});

test("a clock set back on a full History keeps newer rows and their time", async () => {
  const clock = new Clock();
  const p = new FakePlatform("chrome", new MockWorker(clock), clock);
  const { db } = await makeEngine(p, new IDBFactory(), clock);
  const t0 = clock.t;
  for (let i = 0; i < 500; i++) await db.put("history", histRow(t0 - 500 * HOUR + i * HOUR, "m" + i));
  clock.t = t0 - 10 * HOUR; // clock stepped back
  await db.addHistory(histRow(clock.t, "new"));
  const rows = await db.history();
  assert.equal(rows.length, 500);
  assert.ok(rows.some((r) => r.content === "new"));
  assert.ok(!rows.some((r) => r.content === "m0"));
  assert.equal(rows.find((r) => r.content === "m499")!.received, t0 - HOUR);
});
