// The fetch alarm also runs a stored removal check: one signed GET /v1/peers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { T } from "../src/core/texts.ts";
import { Clock, MockWorker, deliver, device, pairAndApprove } from "./harness.ts";

async function setup() {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const b = await device(w, clock, "firefox");
  await pairAndApprove(w, a, b);
  await deliver(w, b);
  const gets = () => w.calls.filter((c) => c.method === "GET" && c.path === "/v1/peers").length;
  return { w, a, gets };
}

test("the fetch alarm deletes the keys when the stored check GET answers 401 unknown peer again", async () => {
  const { w, a, gets } = await setup();
  await a.db.setMeta("wipe_check", "removed");
  const g0 = gets();
  w.inject.push({ match: /GET \/v1\/peers$/, status: 401, body: { error: "unknown peer" }, times: 1 });
  await a.e.onFetchAlarm();
  assert.equal(gets(), g0 + 1);
  assert.equal(await a.db.self(), undefined);
  assert.equal(await a.db.meta("banner"), T.removed);
});

test("the fetch alarm keeps the keys and clears the check when the GET lists this device", async () => {
  const { a, gets } = await setup();
  const id = a.id;
  await a.db.setMeta("wipe_check", "removed");
  const g0 = gets();
  await a.e.onFetchAlarm();
  assert.equal(gets(), g0 + 1);
  assert.equal((await a.db.self())!.id, id);
  assert.equal(await a.db.meta("wipe_check"), undefined);
});

test("the fetch alarm keeps the keys and the check when the GET fails", async () => {
  const { w, a, gets } = await setup();
  await a.db.setMeta("wipe_check", "removed");
  const g0 = gets();
  w.inject.push({ match: /GET \/v1\/peers$/, status: 500, body: { error: "internal" }, times: 1 });
  await a.e.onFetchAlarm();
  assert.equal(gets(), g0 + 1);
  assert.ok(await a.db.self());
  assert.equal(await a.db.meta("wipe_check"), "removed");
});
