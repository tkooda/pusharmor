import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock, MockWorker, device } from "./harness.ts";

test("push_missing replies do not subscribe fresh again while the relay server refuses the push update and a retry is set", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  w.inject.push({ match: /PATCH \/v1\/peers\//, status: 400, body: { error: "push endpoint not allowed" }, times: 99 });
  w.inject.push({ match: /GET \/v1\/peers$/, status: 200, body: { ...w.listFor(a.id), push_missing: true }, times: 3 });
  a.p.subscribeFresh = [];
  for (let i = 0; i < 3; i++) {
    await a.e.fetchPeersNow().catch(() => undefined);
    clock.t += 61_000;
  }
  assert.deepEqual(a.p.subscribeFresh, [true]);
  assert.ok(a.p.alarms.has("pushretry"));
});
