import assert from "node:assert/strict";
import { test } from "node:test";
import { ALLOW_SET } from "../src/core/state.ts";
import { Clock, MockWorker, type Device, device, pairAndApprove, refresh } from "./harness.ts";

// An account with 25 devices: this one and 24 others, all paired and approved.
async function setup() {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const others: Device[] = [];
  for (let i = 0; i < 24; i++) {
    const b = await device(w, clock);
    await pairAndApprove(w, a, b);
    others.push(b);
    clock.t += 120_000;
  }
  await refresh(a);
  return { clock, w, a, others };
}

const last = (w: MockWorker, method: string, path: string) => w.calls.filter((c) => c.method === method && c.path === path).at(-1)!;
const mKeys = (body: unknown) => Object.keys((body as { m: Record<string, string> }).m).sort();

test("25 devices: all 24 others are kept from the list and all 24 allow entries are stored", async () => {
  const { a, others } = await setup();
  const ids = others.map((b) => b.id).sort();
  const peers = (await a.db.peers()).filter((p) => p.pinned && p.ruling === "approved").map((p) => p.id).sort();
  assert.deepEqual(peers, ids);
  assert.deepEqual(([...(a.p.storageLocal.data[ALLOW_SET] as string[])]).sort(), ids);
});

test("25 devices: a send to all 24 others is one call; a synced delete of it is one call", async () => {
  const { w, a, others } = await setup();
  const ids = others.map((b) => b.id).sort();
  const n0 = w.calls.filter((c) => c.path === "/v1/send").length;
  const r = await a.e.send("hello", "auto", "all");
  assert.equal(r.sent, 24);
  assert.equal(w.calls.filter((c) => c.path === "/v1/send").length, n0 + 1);
  assert.deepEqual(mKeys(last(w, "POST", "/v1/send").body), ids);
  const row = (await a.db.history()).find((h) => h.dir === "out")!;
  assert.equal(await a.e.deleteHistory([row.id!]), null);
  assert.equal(w.calls.filter((c) => c.path === "/v1/send").length, n0 + 2);
  assert.deepEqual(mKeys(last(w, "POST", "/v1/send").body), ids);
});

test("25 devices: rename and remove each send one call with a message for all 24 others", async () => {
  const { w, a, others } = await setup();
  const ids = others.map((b) => b.id).sort();
  await a.e.rename("Desk");
  const patch = last(w, "PATCH", "/v1/peers/" + a.id);
  assert.deepEqual(mKeys(patch.body), ids);
  assert.deepEqual(Object.keys((patch.body as { name: Record<string, string> }).name).sort(), ids);
  const x = others[0]!.id;
  await a.e.remove(x);
  assert.equal(w.calls.filter((c) => c.method === "DELETE" && c.path === "/v1/peers/" + x).length, 1);
  assert.deepEqual(mKeys(last(w, "DELETE", "/v1/peers/" + x).body), ids);
});
