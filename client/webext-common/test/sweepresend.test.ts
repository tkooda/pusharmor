import assert from "node:assert/strict";
import { test } from "node:test";
import { getEntry } from "../src/core/state.ts";
import { Clock, MockWorker, deliver, device, refresh } from "./harness.ts";

test("a sweep does not resend a reply that was sent after it read its list", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const b = await device(w, clock);
  await refresh(a, b);
  await a.e.pairStart(b.id);
  w.inject.push({ match: /POST \/v1\/pair\//, status: 503, body: { error: "unavailable" }, times: 3 });
  await deliver(w, b);
  const key = "pair:" + a.id;
  assert.ok((await getEntry(b.p.storageLocal, a.id))!.unsent);
  w.take(a.id);
  const kv = b.p.storageLocal;
  const get = kv.get.bind(kv);
  kv.get = async (keys) => {
    const out = await get(keys);
    if (keys === null) (kv.data[key] as { unsent: boolean }).unsent = false; // an earlier sweep sent it meanwhile
    return out;
  };
  await b.e.sweep();
  kv.get = get;
  assert.equal(w.take(a.id).length, 0);
});
