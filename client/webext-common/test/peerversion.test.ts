import assert from "node:assert/strict";
import { test } from "node:test";
import { REPORTED_VERSION } from "../src/core/state.ts";
import { Clock, MockWorker, device } from "./harness.ts";

const gets = (w: MockWorker) => w.calls.filter((c) => c.method === "GET" && c.path === "/v1/peers").length;

test("GET /peers: a peer version is kept; absent or not a string is unknown; the list still merges", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const b = await device(w, clock);
  const c = await device(w, clock);
  const d = await device(w, clock, "firefox");
  const list = w.listFor(a.id);
  list.peers = list.peers.map((p) =>
    p.id === b.id ? { ...p, version: "0.0.54" } : p.id === c.id ? { ...p, version: 54 as unknown as string } : p,
  );
  await a.e.mergePeers(list as unknown as Record<string, unknown>, (await a.e.self())!);
  assert.equal((await a.db.peer(b.id))?.version, "0.0.54");
  assert.equal((await a.db.peer(c.id))?.version, null);
  assert.equal((await a.db.peer(d.id))?.version, null);
  assert.equal((await a.db.peer(d.id))?.platform, "firefox");
});

test("popup open: one GET /peers when the own version changed; stored only after it ran; none when equal", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  await a.p.storageLocal.set({ [REPORTED_VERSION]: "0.0.18" }); // an app update
  w.inject.push({ match: /GET \/v1\/peers$/, status: 500, body: { error: "internal" }, times: 99 });
  const g0 = gets(w);
  await a.e.onPopupOpen();
  assert.ok(gets(w) > g0);
  assert.equal((await a.p.storageLocal.get([REPORTED_VERSION]))[REPORTED_VERSION], "0.0.18");
  w.inject = [];
  clock.t += 3600_001; // past any wait the failure set
  const g1 = gets(w);
  await a.e.onPopupOpen();
  assert.equal(gets(w) - g1, 1);
  assert.equal((await a.p.storageLocal.get([REPORTED_VERSION]))[REPORTED_VERSION], "0.0.19");
  const g2 = gets(w);
  await a.e.onPopupOpen();
  assert.equal(gets(w), g2);
  a.p.appVersion = "0.0.20";
  clock.t += 60_001; // past the 60 s fetch window
  await a.e.onPopupOpen();
  assert.equal(gets(w) - g2, 1);
  assert.equal((await a.p.storageLocal.get([REPORTED_VERSION]))[REPORTED_VERSION], "0.0.20");
});

test("push received: one GET /peers when the own version changed, none when equal; skipped when logged out", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  await a.p.storageLocal.set({ [REPORTED_VERSION]: "0.0.18" }); // an app update
  const check = JSON.stringify({ check: 1 });
  const g0 = gets(w);
  await a.e.receive(check, "push");
  assert.equal(gets(w) - g0, 1);
  assert.equal((await a.p.storageLocal.get([REPORTED_VERSION]))[REPORTED_VERSION], "0.0.19");
  await a.e.receive(check, "push");
  assert.equal(gets(w) - g0, 1);
  await a.db.setMeta("reg", "logged_out");
  a.p.appVersion = "0.0.20";
  await a.e.receive(check, "push");
  assert.equal(gets(w) - g0, 1);
  assert.equal((await a.p.storageLocal.get([REPORTED_VERSION]))[REPORTED_VERSION], "0.0.19");
});

test("a new registration counts as reported: no GET /peers on the next push or popup open", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  assert.equal((await a.p.storageLocal.get([REPORTED_VERSION]))[REPORTED_VERSION], "0.0.19");
  const g0 = gets(w);
  await a.e.receive(JSON.stringify({ check: 1 }), "push");
  await a.e.onPopupOpen();
  assert.equal(gets(w), g0);
});

test("a list that is not from GET /peers (the POST /peers reply) keeps each stored peer version", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const b = await device(w, clock);
  const self = (await a.e.self())!;
  const list = w.listFor(a.id);
  const withVersion = { ...list, peers: list.peers.map((p) => (p.id === b.id ? { ...p, version: "0.0.54" } : p)) };
  await a.e.mergePeers(withVersion as unknown as Record<string, unknown>, self);
  assert.equal((await a.db.peer(b.id))?.version, "0.0.54");
  await a.e.mergePeers(list as unknown as Record<string, unknown>, self, false);
  assert.equal((await a.db.peer(b.id))?.version, "0.0.54");
  await a.e.mergePeers(list as unknown as Record<string, unknown>, self);
  assert.equal((await a.db.peer(b.id))?.version, null);
});

test("a failed version report: no second GET /peers on a push or popup open within 60 s; one after 60 s", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  await a.p.storageLocal.set({ [REPORTED_VERSION]: "0.0.18" }); // an app update
  clock.t += 61_000;
  w.inject.push({ match: /GET \/v1\/peers$/, status: 500, body: { error: "internal" }, times: 99 });
  const check = JSON.stringify({ check: 1 });
  await a.e.receive(check, "push");
  const g1 = gets(w);
  assert.ok(g1 > 0);
  await a.e.receive(check, "push");
  await a.e.onPopupOpen();
  assert.equal(gets(w), g1);
  clock.t += 61_000;
  await a.e.receive(check, "push");
  assert.ok(gets(w) > g1);
});
