// "Delete broken keys" checks the keys again first: keys that now pass are kept.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock, MockWorker, device } from "./harness.ts";

test("a stale broken mark with good keys deletes nothing and clears the mark", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const id = a.id;
  await a.db.setMeta("keys_broken", true);
  await a.e.deleteBrokenKeys();
  assert.equal((await a.db.self())!.id, id);
  assert.equal(await a.e.keysBroken(), false);
  assert.equal(await a.e.regState(), "registered");
});
