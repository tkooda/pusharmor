// A removal signal (401 "unknown peer", or a remove about this device or a delete
// message) deletes the keys only when one signed GET /v1/peers also answers
// 401 "unknown peer". Any other answer keeps the keys.
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
  const unknown = (re: RegExp, times = 1) => w.inject.push({ match: re, status: 401, body: { error: "unknown peer" }, times });
  return { clock, w, a, b, gets, unknown };
}

test("one 401 unknown peer on send keeps the keys when the check GET lists this device", async () => {
  const { a, gets, unknown } = await setup();
  const id = a.id;
  const g0 = gets();
  unknown(/POST \/v1\/send/);
  const r = await a.e.send("hi", "auto", "all");
  assert.equal(r.sent, 0);
  assert.equal((await a.db.self())!.id, id);
  assert.equal(gets(), g0 + 1);
  assert.equal(await a.db.meta("wipe_check"), undefined);
  assert.equal(await a.e.regState(), "registered");
});

test("a check GET that also answers 401 unknown peer deletes the keys, with one GET only", async () => {
  const { a, gets, unknown } = await setup();
  const g0 = gets();
  unknown(/POST \/v1\/send/);
  unknown(/GET \/v1\/peers$/);
  const r = await a.e.send("hi", "auto", "all");
  assert.equal(r.error, "Unable to send.\nThis device was removed from the account. Log in again.");
  assert.equal(await a.db.self(), undefined);
  assert.equal(await a.db.meta("banner"), T.removed);
  assert.equal(gets(), g0 + 1);
});

test("no reply to the check keeps the keys and checks again at the next start", async () => {
  const { a, gets, unknown } = await setup();
  const fetch = a.p.fetch.bind(a.p);
  a.p.fetch = (u: string, init: RequestInit) => (init.method === "GET" && u.endsWith("/v1/peers") ? Promise.reject(new TypeError("offline")) : fetch(u, init));
  unknown(/POST \/v1\/send/);
  await a.e.send("hi", "auto", "all");
  assert.ok(await a.db.self());
  assert.equal(await a.db.meta("wipe_check"), "removed");
  a.p.fetch = fetch;
  const g0 = gets();
  unknown(/GET \/v1\/peers$/);
  await a.e.start();
  assert.equal(gets(), g0 + 1);
  assert.equal(await a.db.self(), undefined);
  assert.equal(await a.db.meta("banner"), T.removed);
});

test("a 5xx reply to the check keeps the keys; the next popup open checks again and a listed device clears the check", async () => {
  const { w, a, gets, unknown } = await setup();
  unknown(/POST \/v1\/send/);
  w.inject.push({ match: /GET \/v1\/peers$/, status: 500, body: { error: "internal" }, times: 1 });
  await a.e.send("hi", "auto", "all");
  assert.ok(await a.db.self());
  assert.equal(await a.db.meta("wipe_check"), "removed");
  const g0 = gets();
  await a.e.onPopupOpen();
  assert.ok(gets() >= g0 + 1);
  assert.ok(await a.db.self());
  assert.equal(await a.db.meta("wipe_check"), undefined);
});

test("a remove message about this device wipes after the GET confirms; while the relay server still lists it, it is ignored", async () => {
  const { w, a, b, gets } = await setup();
  const row = w.rows.get(a.id)!;
  await b.e.remove(a.id);
  // the relay server still has this device: the message is not acted on
  w.rows.set(a.id, row);
  const msgs = w.take(a.id);
  assert.equal(msgs.length, 1);
  const g0 = gets();
  await a.e.receive(msgs[0]!, "push");
  assert.equal(gets(), g0 + 1);
  assert.ok(await a.db.self());
  assert.equal(await a.db.meta("wipe_check"), undefined);
});

test("a remove message about this device from a real removal wipes it via one GET", async () => {
  const { w, a, b, gets } = await setup();
  await b.e.remove(a.id);
  const g0 = gets();
  assert.equal(await deliver(w, a), 1);
  assert.equal(gets(), g0 + 1);
  assert.equal(await a.db.self(), undefined);
  assert.equal(await a.db.meta("banner"), T.removed);
});

test("a delete message wipes via one GET and says the account was deleted", async () => {
  const { w, a, b, gets } = await setup();
  await b.e.deleteAccount("T");
  const g0 = gets();
  assert.equal(await deliver(w, a), 1);
  assert.equal(gets(), g0 + 1);
  assert.equal(await a.db.self(), undefined);
  assert.equal(await a.db.meta("banner"), T.accountDeleted);
});

test("401 bad id starts no check and keeps the keys", async () => {
  const { w, a, gets } = await setup();
  const g0 = gets();
  w.inject.push({ match: /POST \/v1\/send/, status: 401, body: { error: "bad id" }, times: 1 });
  const r = await a.e.send("hi", "auto", "all");
  assert.equal(r.error, "Unable to send.\nThe relay server did not accept the request. Update PushArmor and try again.");
  assert.equal(gets(), g0);
  assert.ok(await a.db.self());
  assert.equal(await a.db.meta("wipe_check"), undefined);
});

test("two signals at once make one GET, and no push update starts while it runs", async () => {
  const { w, a, gets, unknown } = await setup();
  const fetch = a.p.fetch.bind(a.p);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  a.p.fetch = async (u: string, init: RequestInit) => {
    if (init.method === "GET" && u.endsWith("/v1/peers")) await held;
    return fetch(u, init);
  };
  const g0 = gets();
  unknown(/POST \/v1\/send/, 2);
  unknown(/GET \/v1\/peers$/);
  const both = Promise.all([a.e.send("one", "auto", "all"), a.e.send("two", "auto", "all")]);
  await new Promise((r) => setTimeout(r, 50));
  const patches = w.calls.filter((c) => c.method === "PATCH").length;
  await a.e.pushReconcile(true);
  assert.equal(w.calls.filter((c) => c.method === "PATCH").length, patches);
  release();
  await both;
  assert.equal(gets(), g0 + 1);
  assert.equal(await a.db.self(), undefined);
});

test("a log out answered 401 unknown peer while the check GET lists this device stays pending", async () => {
  const { a, gets, unknown } = await setup();
  const g0 = gets();
  unknown(/POST \/v1\/peers\/[^/]+\/logout/);
  await a.e.logout();
  assert.equal(gets(), g0 + 1);
  assert.ok(await a.db.self());
  assert.equal(await a.db.meta("logout_pending"), true);
});
