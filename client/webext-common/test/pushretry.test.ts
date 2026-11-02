import assert from "node:assert/strict";
import { test } from "node:test";
import { Rpc } from "../src/core/rpc.ts";
import { Clock, MockWorker, device } from "./harness.ts";

test("refused push updates from popup opens do not count toward the relay notice; only the retry alarm does", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  w.inject.push({ match: /PATCH \/v1\/peers\//, status: 400, body: { error: "push endpoint not allowed" }, times: 99 });
  a.p.sub = null;
  const first = clock.t + 30_000;
  for (let i = 0; i < 4; i++) {
    await a.e.onPopupOpen();
    clock.t += 1000;
  }
  assert.equal((await new Rpc(a.e).state()).pushIssue, null);
  assert.equal(a.p.alarms.get("pushretry"), first); // later opens do not move the first retry
  clock.t = first;
  for (const wait of [120_000, 600_000]) {
    a.p.alarms.delete("pushretry");
    await a.e.onPushRetryAlarm();
    assert.equal(a.p.alarms.get("pushretry"), clock.t + wait);
    assert.equal((await new Rpc(a.e).state()).pushIssue, null);
    clock.t += wait;
  }
  a.p.alarms.delete("pushretry");
  await a.e.onPushRetryAlarm();
  assert.equal((await new Rpc(a.e).state()).pushIssue, "relay");
});
