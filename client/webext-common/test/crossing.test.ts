// Crossing pair commits: any timing of Pair taps on both sides, plus Send again,
// ends at the compare-codes step on both devices. A commit from an unlisted
// sender that arrives while GET /peers cannot run is kept, not dropped.
import assert from "node:assert/strict";
import { test } from "node:test";
import { b64urlDecode } from "../src/crypto/b64url.ts";
import { NET_NOT_BEFORE, getEntry } from "../src/core/state.ts";
import { Clock, type Device, MockWorker, deliver, device, refresh } from "./harness.ts";

const HOUR = 3600_000;

async function setup() {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const b = await device(w, clock, "firefox");
  await refresh(a, b);
  const aLower = Buffer.compare(Buffer.from(b64urlDecode(a.id)), Buffer.from(b64urlDecode(b.id))) < 0;
  const [lo, hi] = aLower ? [a, b] : [b, a];
  return { clock, w, lo, hi };
}

/** Deliver queued pushes both ways until none is left. */
async function settle(w: MockWorker, x: Device, y: Device) {
  for (let i = 0; i < 20; i++) {
    if ((await deliver(w, x)) + (await deliver(w, y)) === 0) return;
  }
  throw new Error("pushes did not settle");
}

/** Both sides at the compare-codes step with the same fingerprint, and no unreadable or failed event. */
async function atCodeCheck(x: Device, y: Device) {
  const ex = (await getEntry(x.p.storageLocal, y.id))!;
  const ey = (await getEntry(y.p.storageLocal, x.id))!;
  assert.equal(ex.state, "shown");
  assert.equal(ey.state, "shown");
  const fx = (await x.e.pairRowView(y.id))!.fingerprint;
  const fy = (await y.e.pairRowView(x.id))!.fingerprint;
  assert.ok(fx && fx === fy);
  for (const d of [x, y]) assert.equal((await d.db.history()).filter((h) => h.type === "event").length, 0);
}

const commitPosts = (w: MockWorker, to: string) => w.calls.filter((c) => c.method === "POST" && c.path === "/v1/pair/" + to && (c.body as { k: string }).k === "commit");

test("crossing: simultaneous taps, all pushes delivered", async () => {
  const { w, lo, hi } = await setup();
  await lo.e.pairStart(hi.id);
  await hi.e.pairStart(lo.id);
  await settle(w, lo, hi);
  await atCodeCheck(lo, hi);
});

test("crossing: lower taps, higher taps before the lower commit is processed", async () => {
  const { w, lo, hi } = await setup();
  await lo.e.pairStart(hi.id);
  await hi.e.pairStart(lo.id);
  await deliver(w, hi); // hi: own N committed, lower commit -> reply as X
  assert.equal((await getEntry(hi.p.storageLocal, lo.id))!.role, "X");
  await settle(w, lo, hi); // lo: crossing re-send, then the reply; hi: duplicate commit re-sends the same reply
  await atCodeCheck(lo, hi);
});

test("crossing: higher taps, then lower taps before the higher commit is processed", async () => {
  const { w, lo, hi } = await setup();
  await hi.e.pairStart(lo.id);
  await lo.e.pairStart(hi.id);
  await deliver(w, lo); // crossing notice and one re-send
  assert.equal(commitPosts(w, hi.id).length, 2);
  await settle(w, lo, hi);
  await atCodeCheck(lo, hi);
});

test("crossing: an hours-old request on the lower side whose commit was lost; the higher side taps Pair", async () => {
  const { clock, w, lo, hi } = await setup();
  await lo.e.pairStart(hi.id);
  w.take(hi.id); // lost
  clock.t += 5 * HOUR;
  await hi.e.pairStart(lo.id);
  await settle(w, lo, hi);
  await atCodeCheck(lo, hi);
});

test("crossing: an hours-old request on the higher side whose commit was lost; the lower side taps Pair", async () => {
  const { clock, w, lo, hi } = await setup();
  await hi.e.pairStart(lo.id);
  w.take(lo.id); // lost
  clock.t += 5 * HOUR;
  await lo.e.pairStart(hi.id);
  await settle(w, lo, hi);
  await atCodeCheck(lo, hi);
});

test("crossing: Send again on both sides during a crossing", async () => {
  const { clock, w, lo, hi } = await setup();
  await lo.e.pairStart(hi.id);
  await hi.e.pairStart(lo.id);
  clock.t += 61_000;
  await lo.e.pairSendAgain(hi.id);
  await hi.e.pairSendAgain(lo.id);
  await settle(w, lo, hi);
  await atCodeCheck(lo, hi);
});

test("crossing: the lost first commit is recovered by the crossing re-send or by Send again", async () => {
  {
    // the lower commit is lost: the crossing re-send brings it to the higher side
    const { w, lo, hi } = await setup();
    await lo.e.pairStart(hi.id);
    await hi.e.pairStart(lo.id);
    w.take(hi.id);
    await settle(w, lo, hi);
    await atCodeCheck(lo, hi);
  }
  {
    // both first commits are lost: Send again on the lower side
    const { clock, w, lo, hi } = await setup();
    await lo.e.pairStart(hi.id);
    await hi.e.pairStart(lo.id);
    w.take(hi.id);
    w.take(lo.id);
    clock.t += 61_000;
    await lo.e.pairSendAgain(hi.id);
    await settle(w, lo, hi);
    await atCodeCheck(lo, hi);
  }
  {
    // both first commits are lost: Send again on the higher side, then the crossing re-send
    const { clock, w, lo, hi } = await setup();
    await lo.e.pairStart(hi.id);
    await hi.e.pairStart(lo.id);
    w.take(hi.id);
    w.take(lo.id);
    clock.t += 61_000;
    await hi.e.pairSendAgain(lo.id);
    await settle(w, lo, hi);
    await atCodeCheck(lo, hi);
  }
});

test("crossing re-send: exactly one commit with the stored bytes, no 60 s wait, a server wait is kept", async () => {
  const { clock, w, lo, hi } = await setup();
  await lo.e.pairStart(hi.id);
  await hi.e.pairStart(lo.id);
  const stored = (await getEntry(lo.p.storageLocal, hi.id))!;
  clock.t += 5_000; // well inside the 60 s Send again wait
  await deliver(w, lo);
  const posts = commitPosts(w, hi.id);
  assert.equal(posts.length, 2);
  assert.equal((posts[1]!.body as { c: string }).c, stored.msg);
  const after = (await getEntry(lo.p.storageLocal, hi.id))!;
  assert.equal(after.state, "committed");
  assert.equal(after.c_N, stored.c_N);
  assert.equal(after.last_send, clock.t);
  assert.equal(after.last_result, "sent");
  // a server wait: no POST, the pair alarm is set
  const nb = clock.t + 120_000;
  await lo.p.storageLocal.set({ ["pair:" + hi.id]: { ...after, not_before: nb } });
  await hi.e.pairStart(lo.id).catch(() => undefined); // hi already holds an entry: no new commit
  w.queue.push({ to: lo.id, m: (await getEntry(hi.p.storageLocal, lo.id))!.msg! });
  await deliver(w, lo);
  assert.equal(commitPosts(w, hi.id).length, 2);
  assert.equal(lo.p.alarms.get("pair:" + hi.id), nb);
});

test("a duplicate reply on an N entry in state shown is ignored", async () => {
  const { w, lo, hi } = await setup();
  await lo.e.pairStart(hi.id);
  await deliver(w, hi); // reply
  const reply = w.take(lo.id)[0]!;
  await lo.e.receive(reply, "push");
  await lo.e.receive(reply, "push");
  const e = (await getEntry(lo.p.storageLocal, hi.id))!;
  assert.equal(e.state, "shown");
  assert.equal(w.calls.filter((c) => c.path === "/v1/pair/" + hi.id && (c.body as { k: string }).k === "open").length, 1);
  assert.equal((await lo.db.history()).filter((h) => h.type === "event").length, 0);
});

/** b registers after a, so a has not listed b: b's commit needs a GET /peers on a. */
async function unlisted() {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const b = await device(w, clock, "firefox");
  assert.ok(!((await a.db.meta<string[]>("listed")) ?? []).includes(b.id));
  return { clock, w, a, b };
}

test("commit from an unlisted sender during a fetch wait is kept and answered after the next fetch", async () => {
  const { clock, w, a, b } = await unlisted();
  await a.p.storageLocal.set({ [NET_NOT_BEFORE]: clock.t + 60_000 });
  await b.e.pairStart(a.id);
  const gets = w.calls.filter((c) => c.method === "GET").length;
  await deliver(w, a);
  assert.equal(w.calls.filter((c) => c.method === "GET").length, gets); // no fetch ran
  assert.equal(await getEntry(a.p.storageLocal, b.id), null);
  assert.equal((await a.db.history()).filter((h) => h.type === "event").length, 0);
  assert.ok(a.p.alarms.has("fetch"));
  clock.t += 61_000;
  await a.e.onFetchAlarm();
  assert.equal((await getEntry(a.p.storageLocal, b.id))!.role, "X");
  await settle(w, a, b);
  await atCodeCheck(a, b);
});

test("commit from an unlisted sender when the fetch fails is kept and answered after the next fetch", async () => {
  const { clock, w, a, b } = await unlisted();
  w.inject.push({ match: /^GET \/v1\/peers$/, status: 500, body: { error: "internal" }, times: 3 });
  await b.e.pairStart(a.id);
  await deliver(w, a);
  assert.equal(await getEntry(a.p.storageLocal, b.id), null);
  assert.equal((await a.db.history()).filter((h) => h.type === "event").length, 0);
  assert.ok(a.p.alarms.has("fetch"));
  clock.t += 61_000;
  await a.e.onFetchAlarm();
  await settle(w, a, b);
  await atCodeCheck(a, b);
});

test("a kept commit whose sender is still not listed after the fetch is dropped then", async () => {
  const { clock, w, a, b } = await unlisted();
  await a.p.storageLocal.set({ [NET_NOT_BEFORE]: clock.t + 60_000 });
  await b.e.pairStart(a.id);
  await deliver(w, a);
  w.rows.delete(b.id);
  clock.t += 61_000;
  await a.e.onFetchAlarm();
  assert.equal(await getEntry(a.p.storageLocal, b.id), null);
  assert.equal((await a.db.history()).filter((h) => h.type === "event" && h.event === "unreadable").length, 1);
  assert.equal((await a.p.storageLocal.get(["pair_held"]))["pair_held"], undefined);
});

const pairPosts = (w: MockWorker, to: string, k: string) => w.calls.filter((c) => c.method === "POST" && c.path === "/v1/pair/" + to && (c.body as { k: string }).k === k).length;

test("popup open: a lost commit, reply, or open is sent again by the waiting side, 60 s after the last send", async () => {
  {
    // N committed, commit lost
    const { clock, w, lo: a, hi: b } = await setup();
    await a.e.pairStart(b.id);
    w.take(b.id);
    await a.e.timeoutCheck();
    assert.equal(pairPosts(w, b.id, "commit"), 1); // inside 60 s: nothing
    clock.t += 61_000;
    await a.e.timeoutCheck();
    assert.equal(pairPosts(w, b.id, "commit"), 2);
    await settle(w, a, b);
    await atCodeCheck(a, b);
  }
  {
    // X replied, reply lost
    const { clock, w, lo: a, hi: b } = await setup();
    await a.e.pairStart(b.id);
    await deliver(w, b);
    w.take(a.id);
    clock.t += 61_000;
    await b.e.timeoutCheck();
    assert.equal(pairPosts(w, a.id, "reply"), 2);
    await settle(w, a, b);
    await atCodeCheck(a, b);
  }
  {
    // N shown, open lost
    const { clock, w, lo: a, hi: b } = await setup();
    await a.e.pairStart(b.id);
    await deliver(w, b);
    await deliver(w, a);
    w.take(b.id);
    clock.t += 61_000;
    await a.e.timeoutCheck();
    assert.equal(pairPosts(w, b.id, "open"), 2);
    await settle(w, a, b);
    await atCodeCheck(a, b);
  }
});
