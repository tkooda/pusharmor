// "Check again" on the update screen: two clicks at once send one GET /v1/health.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock, MockWorker, device } from "./harness.ts";

test("two checks at once share one GET /v1/health", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const n0 = w.calls.filter((c) => c.path === "/v1/health").length;
  await Promise.all([a.e.recheckUpdate(), a.e.recheckUpdate()]);
  assert.equal(w.calls.filter((c) => c.path === "/v1/health").length - n0, 1);
});
