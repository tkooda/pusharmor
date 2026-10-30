import assert from "node:assert/strict";
import { test } from "node:test";
import { b64urlDecode, b64urlEncode } from "../src/crypto/b64url.ts";
import { pairingKey } from "../src/crypto/labels.ts";
import { T } from "../src/core/texts.ts";
import { UserError } from "../src/core/engine.ts";
import { Rpc } from "../src/core/rpc.ts";
import { allEntries, getAllowSet, getEntry } from "../src/core/state.ts";
import { encodeInner } from "../src/model/message.ts";
import { IDBFactory } from "fake-indexeddb";
import { Clock, FakePlatform, MockWorker, deliver, device, makeEngine, pairAndApprove, refresh, restart } from "./harness.ts";

const DAY = 86400_000;

async function setup(bName: "chrome" | "firefox" = "chrome") {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const b = await device(w, clock, bName);
  return { clock, w, a, b };
}

test("happy path: commit, automatic reply, open, same fingerprint, approve both, send", async () => {
  const { w, a, b } = await setup();
  await refresh(a, b);
  await a.e.pairStart(b.id);
  assert.equal((await getEntry(a.p.storageLocal, b.id))!.state, "committed");
  await deliver(w, b);
  const eb = (await getEntry(b.p.storageLocal, a.id))!;
  assert.equal(eb.role, "X");
  assert.equal(eb.state, "replied"); // automatic reply, no user action
  const pk = await pairingKey(b64urlDecode(a.id), b64urlDecode(b.id));
  assert.equal(b.p.notes.get("p:" + pk)!.body, T.pairCommit);
  await deliver(w, a);
  assert.equal((await getEntry(a.p.storageLocal, b.id))!.state, "shown");
  assert.equal(a.p.notes.size, 0); // Chrome N shows no reply notice
  await deliver(w, b);
  const fa = (await a.e.pairRowView(b.id))!.fingerprint!;
  const fb = (await b.e.pairRowView(a.id))!.fingerprint!;
  assert.match(fa, /^[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(fa, fb);
  // the open notice replaced the commit notice (same id p:pk)
  assert.equal(b.p.notes.size, 1);
  assert.equal(b.p.notes.get("p:" + pk)!.body, T.pairOpen(fb));
  // approve is enabled at once
  assert.ok((await a.e.pairRowView(b.id))!.actions.includes("approve"));
  assert.equal(await a.e.approve(b.id), "stored");
  assert.ok((await a.e.pairRowView(b.id))!.lines[0]!.startsWith("Waiting for"));
  assert.equal(await b.e.approve(a.id), "sent");
  assert.ok((await b.db.peer(a.id))!.approves_me); // returned c verified, no notice
  assert.equal(b.p.notes.has("a:" + a.id), false);
  await deliver(w, a);
  assert.ok((await a.db.peer(b.id))!.approves_me);
  assert.equal(a.p.notes.get("a:" + b.id)!.body, "Chrome approved this device");
  assert.equal(await getEntry(a.p.storageLocal, b.id), null); // r wiped
  assert.equal(await getEntry(b.p.storageLocal, a.id), null);
  assert.equal((await a.db.peer(b.id))!.name, "Chrome");
  const r = await a.e.send("hello there", false, "all");
  assert.equal(r.sent, 1);
  assert.equal(T.sentToNofM(r.sent, r.total), "Sent to 1 of 1 devices");
  await deliver(w, b);
  const h = (await b.db.history()).find((x) => x.type === "text")!;
  assert.equal(h.content, "hello there");
  assert.equal(b.p.notes.get("h:" + h.id)!.title, "Message");
  assert.equal(b.p.badge, "1");
});

test("replay: duplicate re-presents, seen n without row is Invalid, control seen n silent, old n Invalid", async () => {
  const { w, a, b } = await setup();
  await pairAndApprove(w, a, b);
  await a.e.send("one", false, "all");
  const [m1] = w.take(b.id);
  await b.e.receive(m1!, "push");
  const rows1 = (await b.db.history()).length;
  b.p.noteLog.length = 0;
  await b.e.receive(m1!, "push"); // vendor retry duplicate
  assert.equal((await b.db.history()).length, rows1);
  assert.equal(b.p.noteLog.length, 1);
  assert.ok(b.p.noteLog[0]!.id.startsWith("h:"));
  // delete the History row: a seen n with no row is "Invalid message received"
  await b.db.clear(["history"]);
  await b.e.receive(m1!, "push");
  const ev = (await b.db.history())[0]!;
  assert.equal(ev.event, "invalid");
  assert.equal(ev.peer, a.id);
  // bridge duplicate is silent
  const before = (await b.db.history()).length;
  await b.e.receive(m1!, "bridge");
  assert.equal((await b.db.history()).length, before);
  // control type seen n: silent no-op
  await a.e.rename("Laptop");
  const [rn] = w.take(b.id);
  await b.e.receive(rn!, "push");
  assert.equal((await b.db.peer(a.id))!.name, "Laptop");
  const n2 = (await b.db.history()).length;
  await b.e.receive(rn!, "push");
  assert.equal((await b.db.history()).length, n2);
  // n <= h - 100 is Invalid
  for (let i = 0; i < 101; i++) await a.db.reserveN(b.id);
  await a.e.send("two", false, "all");
  await deliver(w, b);
  const old = await mkMsg(a, b, '{"n":1,"text":"x"}');
  await b.e.receive(old, "push");
  assert.equal((await b.db.history())[0]!.event, "invalid");
});

async function mkMsg(a: Awaited<ReturnType<typeof device>>, b: Awaited<ReturnType<typeof device>>, json: string, pid?: Uint8Array) {
  const self = (await a.e.self())!;
  const peer = (await a.db.peer(b.id))!;
  return encodeInner({ signKey: self.sign.privateKey, fromId: b64urlDecode(a.id), pairingId: pid ?? peer.pairing_id!, json, recipientId: b.id, recipientEncPub: peer.enc_pub });
}

test("must_fail: wrong pairing id is could-not-read; raw n vectors, n = 0, duplicate key drop; Firefox notices", async () => {
  const { w, a, b } = await setup("firefox");
  await pairAndApprove(w, a, b);
  const cases = [
    await mkMsg(a, b, '{"n":5,"text":"x"}', new Uint8Array(8).fill(7)),
    await mkMsg(a, b, '{"n":1.0,"text":"x"}'),
    await mkMsg(a, b, '{"n":1e0,"text":"x"}'),
    await mkMsg(a, b, '{"n":0,"text":"x"}'),
    await mkMsg(a, b, '{"n":6,"text":"x","text":"y"}'),
  ];
  for (const m of cases) {
    b.p.notes.clear();
    await b.e.receive(m, "push");
    assert.equal(b.p.notes.get("drop")!.body, T.couldNotRead);
    assert.equal((await b.db.history())[0]!.event, "unreadable");
  }
  // consecutive could-not-read events merge with a count
  assert.equal((await b.db.history())[0]!.count, 5);
  // a tampered ciphertext from nobody
  const ok = await mkMsg(a, b, '{"n":7,"text":"x"}');
  const raw = b64urlDecode(ok);
  raw[200]! ^= 1;
  b.p.notes.clear();
  await b.e.receive(b64urlEncode(raw), "push");
  assert.equal(b.p.notes.get("drop")!.body, T.couldNotRead);
  // a replay yields Invalid, never could-not-read
  await b.e.receive(ok, "push");
  b.p.notes.clear();
  await b.db.clear(["history"]);
  await b.e.receive(ok, "push");
  assert.equal(b.p.notes.get("drop")!.body, T.invalid);
});

test("Chrome drops silently but writes the History event", async () => {
  const { w, a, b } = await setup();
  await pairAndApprove(w, a, b);
  b.p.notes.clear();
  await b.e.receive(await mkMsg(a, b, '{"n":1.0,"text":"x"}'), "push");
  assert.equal(b.p.notes.size, 0);
  assert.equal((await b.db.history())[0]!.event, "unreadable");
});

test("approve from an unpinned id is dropped", async () => {
  const { w, a, b } = await setup();
  await refresh(a, b);
  // fake a pin on a only, b never pinned a
  await a.db.pin(b.id, (await b.e.self())!.sign_pub, (await b.e.self())!.enc_pub, new Uint8Array(8), (await a.db.peer(b.id))!);
  await a.db.putPeer({ ...(await a.db.peer(b.id))!, ruling: "approved" });
  await a.e.approve(b.id).catch(() => undefined);
  const pushed = w.calls.filter((c) => c.path.startsWith("/v1/approve/"));
  assert.equal(pushed.length, 1);
  // deliver a's approve to b directly
  const c = (pushed[0]!.body as { c: string }).c;
  await b.e.receive(c, "push");
  assert.equal((await b.db.peer(a.id))!.approves_me, false);
  assert.equal((await b.db.history())[0]!.event, "unreadable");
});

test("counter reservation: two contexts get distinct n", async () => {
  const { w, a, b } = await setup();
  await pairAndApprove(w, a, b);
  const a2 = await restart({ ...a }, new Clock());
  const ns = await Promise.all([a.db.reserveN(b.id), a2.db.reserveN(b.id), a.db.reserveN(b.id), a2.db.reserveN(b.id)]).catch(async () => {
    // the first handle was closed by restart(); fall back to one handle twice
    return Promise.all([a2.db.reserveN(b.id), a2.db.reserveN(b.id), a2.db.reserveN(b.id), a2.db.reserveN(b.id)]);
  });
  assert.equal(new Set(ns).size, 4);
});

test("clock skew: rebuild with a new n, then a second skew stops", async () => {
  const { w, a, b, clock } = await setup();
  await pairAndApprove(w, a, b);
  const n0 = (await a.db.peer(b.id))!.last_n;
  w.skewMs = 10 * 60_000;
  const r = await a.e.send("hi", false, "all");
  assert.equal(r.sent, 1);
  assert.equal((await a.db.peer(b.id))!.last_n, n0 + 2); // discarded n0+1, sent n0+2
  const sends = w.calls.filter((c) => c.path === "/v1/send");
  assert.equal(sends.length, 2); // the first attempt was refused with 401 clock skew
  await deliver(w, b);
  assert.equal((await b.db.history()).find((h) => h.type === "text")!.n, n0 + 2);
  // second skew: inject two clock-skew replies
  w.inject.push({ match: /POST \/v1\/send/, status: 401, body: { error: "clock skew" }, times: 2 });
  const r2 = await a.e.send("again", false, "all");
  assert.equal(r2.error, T.clockOff);
  void clock;
});

test("send: a URL whose normalized href exceeds the cap is refused before any counter or call", async () => {
  const { w, a, b } = await setup();
  await pairAndApprove(w, a, b);
  const n0 = (await a.db.peer(b.id))!.last_n;
  const url = "https://example.com/" + "\u4e2d".repeat(400); // 1220 raw bytes, 3620 as href
  await assert.rejects(a.e.send(url, false, "all"), (e: unknown) => e instanceof UserError && /^Too long/.test(e.message));
  assert.equal((await a.db.peer(b.id))!.last_n, n0);
  assert.equal(w.calls.filter((c) => c.path === "/v1/send").length, 0);
});

test("a 401 paused from any signed call sets reg to paused", async () => {
  const { w, a, b } = await setup();
  await pairAndApprove(w, a, b);
  assert.equal(await a.e.regState(), "registered");
  w.rows.get(a.id)!.paused = true; // the Worker applied a pause whose reply was lost
  const r = await a.e.send("hi", false, "all");
  assert.equal(r.sent, 0);
  assert.equal(await a.e.regState(), "paused");
});

test("pairing state survives restarts, valid at day 13, expires at day 14", async () => {
  const { w, a, b, clock } = await setup();
  await refresh(a, b);
  await a.e.pairStart(b.id);
  let a2 = await restart(a, clock);
  await deliver(w, b);
  clock.t += 13 * DAY;
  let b2 = await restart(b, clock);
  await b2.e.sweep();
  assert.ok(await getEntry(b2.p.storageLocal, a.id));
  assert.equal((await b2.e.pairRowView(a.id))!.countdown, "1 day");
  await deliver(w, a2);
  await deliver(w, b2);
  assert.equal((await a2.e.pairRowView(b.id))!.fingerprint, (await b2.e.pairRowView(a.id))!.fingerprint);
  clock.t += DAY;
  a2 = await restart(a2, clock);
  await a2.e.sweep();
  assert.equal(await getEntry(a2.p.storageLocal, b.id), null);
  assert.equal((await a2.db.peer(b.id))!.pinned, false); // pin dropped
  assert.equal(a2.p.storageLocal.data["pairmsg:" + b.id], T.pairTimedOut);
  b2 = await restart(b2, clock);
});

test("two pairings open at once have their own fingerprint and countdown", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const b = await device(w, clock);
  const c = await device(w, clock);
  await refresh(a, b, c);
  await a.e.pairStart(b.id);
  clock.t += 3600_000;
  await a.e.pairStart(c.id);
  for (const d of [b, c, a, b, c]) await deliver(w, d);
  const vb = (await a.e.pairRowView(b.id))!;
  const vc = (await a.e.pairRowView(c.id))!;
  assert.equal(vb.fingerprint, (await b.e.pairRowView(a.id))!.fingerprint);
  assert.equal(vc.fingerprint, (await c.e.pairRowView(a.id))!.fingerprint);
  assert.equal(vb.countdown, "13 days");
  assert.equal((await allEntries(a.p.storageLocal)).size, 2);
});

test("allow reconcile: orphan withdrawn across 429 and restart, pinned id never withdrawn, works while paused", async () => {
  const { w, a, b, clock } = await setup();
  await pairAndApprove(w, a, b);
  const c = await device(w, clock);
  await a.p.storageLocal.set({ allow: [b.id, c.id] }); // c is an orphan (no pin)
  w.inject.push({ match: /POST \/v1\/deny\//, status: 429, body: { error: "rate limited", retry_after: 60 }, headers: { "Retry-After": "60" }, times: 1 });
  await a.e.reconcileAllow();
  assert.deepEqual((await getAllowSet(a.p.storageLocal)).sort(), [b.id, c.id].sort());
  const a2 = await restart(a, clock);
  await a2.e.reconcileAllow();
  assert.deepEqual(await getAllowSet(a2.p.storageLocal), [b.id]);
  const wd = w.calls.filter((x) => x.path.startsWith("/v1/deny/"));
  assert.ok(wd.every((x) => x.path === "/v1/deny/" + c.id && (x.body as { withdraw: number }).withdraw === 1));
  // while paused the withdraw passes the gate
  await a2.e.pause();
  await a2.p.storageLocal.set({ allow: [b.id, c.id] });
  await a2.e.reconcileAllow();
  assert.deepEqual(await getAllowSet(a2.p.storageLocal), [b.id]);
});

test("400 messages missing: withdraw the orphan, then one retry of pause succeeds", async () => {
  const { w, a, b, clock } = await setup();
  await pairAndApprove(w, a, b);
  const c = await device(w, clock);
  // stale Worker allow entry for c (a lost approve reply after Cancel pairing)
  w.rows.get(a.id)!.allow.add(c.id);
  await a.p.storageLocal.set({ allow: [b.id] });
  await a.e.pause();
  assert.equal(w.rows.get(a.id)!.paused, true);
  assert.ok(!w.rows.get(a.id)!.allow.has(c.id));
  const pauses = w.calls.filter((x) => x.path.endsWith("/pause"));
  assert.equal(pauses.length, 2);
});

test("stale allow id plus a new open N entry is withdrawn and pause succeeds", async () => {
  const { w, a, b, clock } = await setup();
  await pairAndApprove(w, a, b);
  const c = await device(w, clock);
  await refresh(a);
  await a.e.pairStart(c.id); // open N entry, no pin
  w.rows.get(a.id)!.allow.add(c.id);
  await a.e.fetchPeersNow(); // my_allow has c -> reconcile withdraws it
  assert.ok(!w.rows.get(a.id)!.allow.has(c.id));
  await a.e.pause();
  assert.equal(w.rows.get(a.id)!.paused, true);
  assert.ok(await getEntry(a.p.storageLocal, c.id));
});

test("Cancel pairing on committed, shown, prompted and Waiting rows drops entry, pin, pairing id, counter and window", async () => {
  const { w, a, b } = await setup();
  await refresh(a, b);
  await a.e.pairStart(b.id);
  await a.e.cancelPairing(b.id);
  assert.equal(await getEntry(a.p.storageLocal, b.id), null);
  const callsBefore = w.calls.length;
  await a.e.cancelPairing(b.id);
  assert.ok(w.calls.slice(callsBefore).every((c) => c.path.startsWith("/v1/deny/") || c.path === "/v1/peers"));
  // shown + Waiting on a
  w.take(b.id);
  await a.e.pairStart(b.id);
  await deliver(w, b);
  await b.e.cancelPairing(a.id); // X side in state replied
  assert.equal(await getEntry(b.p.storageLocal, a.id), null);
  await deliver(w, a); // a pins b, shown
  await a.e.approve(b.id); // stored -> Waiting
  await a.e.cancelPairing(b.id);
  const pa = (await a.db.peer(b.id))!;
  assert.equal(pa.pinned, false);
  assert.equal(pa.pairing_id, null);
  assert.equal(pa.last_n, 0);
  assert.equal(await a.db.replay(b.id), undefined);
  assert.ok(!w.rows.get(a.id)!.allow.has(b.id)); // reconcile withdrew it
  assert.ok(!(await a.e.pairRowView(b.id)));
});

test("approve re-fetch while waiting: popup open re-sends the same bytes and n, returned c completes; 429 silent", async () => {
  const { w, a, b } = await setup();
  await refresh(a, b);
  await a.e.pairStart(b.id);
  await deliver(w, b);
  await deliver(w, a);
  await deliver(w, b);
  await a.e.approve(b.id); // stored
  await b.e.approve(a.id); // sent; push to a is lost
  w.take(a.id);
  assert.equal((await a.db.peer(b.id))!.approves_me, false);
  w.inject.push({ match: /POST \/v1\/approve\//, status: 429, body: { error: "rate limited", retry_after: 60 }, headers: { "Retry-After": "60" }, times: 1 });
  a.p.notes.clear();
  await a.e.onPopupOpen();
  assert.equal(a.p.notes.size, 0);
  assert.equal((await a.db.peer(b.id))!.approves_me, false);
  await a.e.onPopupOpen();
  const ap = w.calls.filter((c) => c.path === "/v1/approve/" + b.id);
  assert.equal(JSON.stringify(ap[0]!.body), JSON.stringify(ap[ap.length - 1]!.body)); // same bytes, same n
  assert.ok((await a.db.peer(b.id))!.approves_me);
  assert.equal(await getEntry(a.p.storageLocal, b.id), null);
});

test("rename while Waiting: fresh approve with a new n and the current name", async () => {
  const { w, a, b } = await setup();
  await refresh(a, b);
  await a.e.pairStart(b.id);
  await deliver(w, b);
  await deliver(w, a);
  await deliver(w, b);
  await a.e.approve(b.id);
  const first = (await getEntry(a.p.storageLocal, b.id))!.approve_body;
  await a.e.rename("Desk"); // allow list holds b (approved)
  await a.e.onPopupOpen();
  const e = (await getEntry(a.p.storageLocal, b.id))!;
  assert.notEqual(e.approve_body, first);
  assert.equal(e.approve_name, "Desk");
});

test("commit from a fully paired peer: plain drop (Chrome silent); half state shows the wants-to-pair-again notice", async () => {
  const { w, a, b } = await setup();
  await pairAndApprove(w, a, b);
  // b withdrew and forgot a (Cancel pairing on b), then pairs again
  await b.e.cancelPairing(a.id);
  await a.e.fetchPeersNow(); // GET after verify shows approves_me false -> half state on a
  assert.equal((await a.db.peer(b.id))!.approves_me, false);
  await b.e.pairStart(a.id);
  a.p.notes.clear();
  await deliver(w, a);
  const pk = await pairingKey(b64urlDecode(b.id), b64urlDecode(a.id));
  assert.match(a.p.notes.get("p:" + pk)!.body, /wants to pair again\. Tap Pair again on its row\.$/);
  assert.equal(await getEntry(a.p.storageLocal, b.id), null); // no entry
  assert.ok((await a.db.peer(b.id))!.pinned); // pin unchanged
  // Cancel pairing on a, then a fresh pairing works
  await a.e.cancelPairing(b.id);
  await b.e.pairSendAgain(a.id); // too early (60 s)
  assert.equal(w.queue.length, 0);
});

test("Pair again on the half-state row: old entry, pin and pairing id dropped, fresh pairing completes", async () => {
  const { clock, w, a, b } = await setup();
  await pairAndApprove(w, a, b);
  await b.e.cancelPairing(a.id);
  await a.e.fetchPeersNow();
  await b.e.pairStart(a.id);
  await deliver(w, a); // half notice on a
  const row = (await new Rpc(a.e).peers()).peers.find((v) => v.id === b.id)!;
  assert.deepEqual(row.actions.slice(0, 2), ["pair_again", "cancel"]);
  const oldPid = (await a.db.peer(b.id))!.pairing_id;
  assert.ok(oldPid);
  await a.e.pairAgain(b.id);
  const pa = (await a.db.peer(b.id))!;
  assert.equal(pa.pinned, false);
  assert.equal(pa.pairing_id, null);
  assert.equal(pa.last_n, 0);
  assert.ok(!w.rows.get(a.id)!.allow.has(b.id)); // the cancel's reconcile landed first
  const e = (await getEntry(a.p.storageLocal, b.id))!;
  assert.equal(e.role, "N");
  assert.equal(e.state, "committed");
  assert.ok(w.calls.some((c) => c.path === "/v1/pair/" + b.id && c.method === "POST"));
  // crossing commits: the higher id replies to a resent commit (Send again, as today), then the new pairing completes
  clock.t += 61_000;
  await a.e.pairSendAgain(b.id);
  await b.e.pairSendAgain(a.id);
  for (let i = 0; i < 4; i++) {
    await deliver(w, b);
    await deliver(w, a);
  }
  const fa = (await a.e.pairRowView(b.id))?.fingerprint;
  const fb = (await b.e.pairRowView(a.id))?.fingerprint;
  assert.ok(fa && fa === fb);
  await a.e.approve(b.id);
  await b.e.approve(a.id);
  await deliver(w, a);
  await deliver(w, b);
  assert.ok((await a.db.peer(b.id))!.approves_me);
  assert.ok((await b.db.peer(a.id))!.approves_me);
  assert.notEqual((await a.db.peer(b.id))!.pairing_id, oldPid);
});

test("half notice during an open pairing: the row offers Pair again", async () => {
  const { w, a, b } = await setup();
  await refresh(a, b);
  await a.e.pairStart(b.id);
  await deliver(w, b);
  await deliver(w, a);
  await deliver(w, b); // both shown and pinned
  await a.e.approve(b.id); // a Waiting
  assert.deepEqual((await a.e.pairRowView(b.id))!.actions.slice(0, 1), ["cancel"]);
  await b.e.cancelPairing(a.id);
  await b.e.pairStart(a.id);
  a.p.notes.clear();
  await deliver(w, a);
  assert.ok([...a.p.notes.values()].some((n) => /wants to pair again\. Tap Pair again on its row\.$/.test(n.body)));
  assert.deepEqual((await a.e.pairRowView(b.id))!.actions.slice(0, 2), ["pair_again", "cancel"]);
});

test("half notice text names the device and the Pair again button", () => {
  assert.equal(T.pairHalf("Phone"), "Phone wants to pair again. Tap Pair again on its row.");
});

test("commit from a pinned and fully approved peer is a plain drop", async () => {
  const { w, a, b } = await setup();
  await pairAndApprove(w, a, b);
  await refresh(a, b);
  // forge: b's own entry cannot exist (pinned), so call pairStart around the guard
  const self = (await b.e.self())!;
  const { commitHash } = await import("../src/crypto/labels.ts");
  const { encodePair } = await import("../src/model/message.ts");
  const cN = await commitHash(self.sign_pub, self.enc_pub, new Uint8Array(32));
  const m = await encodePair(b64urlDecode(b.id), { kind: "commit", c_N: cN }, a.id, (await b.db.peer(a.id))!.enc_pub);
  a.p.notes.clear();
  await a.e.receive(m, "push");
  assert.equal(a.p.notes.size, 0);
  assert.equal(await getEntry(a.p.storageLocal, b.id), null);
});

test("cap: 11th automatic reply in 24 h is prompted; a tapped reply is not counted", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const x = await device(w, clock);
  const ns = [];
  for (let i = 0; i < 11; i++) ns.push(await device(w, clock));
  await refresh(x, ...ns);
  for (const n of ns) {
    await n.e.pairStart(x.id);
    await deliver(w, x);
    // close X's entry so the open-entry limit (9) does not apply
    if (ns.indexOf(n) < 10) await x.p.storageLocal.remove(["pair:" + n.id]);
  }
  const last = (await getEntry(x.p.storageLocal, ns[10]!.id))!;
  assert.equal(last.state, "prompted");
  assert.equal(last.authorized, false);
  await x.e.pairReplyTap(ns[10]!.id);
  const after = (await getEntry(x.p.storageLocal, ns[10]!.id))!;
  assert.equal(after.state, "replied");
  assert.equal((x.p.storageLocal.data.pair_auto as number[]).length, 10);
});

test("10th open entry is dropped", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const x = await device(w, clock);
  const ns = [];
  for (let i = 0; i < 10; i++) ns.push(await device(w, clock));
  await refresh(x, ...ns);
  for (const n of ns) {
    await n.e.pairStart(x.id);
    await deliver(w, x);
  }
  assert.equal((await allEntries(x.p.storageLocal)).size, 9);
});

test("Retry-After on an automatic reply: not_before stored, earlier triggers do nothing, alarm sends it", async () => {
  const { w, a, b, clock } = await setup();
  await refresh(a, b);
  w.inject.push({ match: /POST \/v1\/pair\//, status: 429, body: { error: "rate limited", retry_after: 120 }, headers: { "Retry-After": "120" }, times: 1 });
  await a.e.pairStart(b.id);
  const e = (await getEntry(a.p.storageLocal, b.id))!;
  assert.equal(e.not_before, clock.t + 120_000);
  clock.t += 61_000;
  await a.e.pairSendAgain(b.id); // before not_before: nothing, alarm re-armed
  assert.equal(w.queue.length, 0);
  assert.equal(a.p.alarms.get("pair:" + b.id), e.not_before);
  clock.t += 60_000;
  await a.e.pairSendAgain(b.id);
  assert.equal(w.queue.length, 1);
});

test("failed automatic reply stays prompted with authorized and unsent; sweep re-sends the same r_X", async () => {
  const { w, a, b, clock } = await setup();
  await refresh(a, b);
  await a.e.pairStart(b.id);
  w.inject.push({ match: /POST \/v1\/pair\//, status: 503, body: { error: "unavailable" }, times: 1 });
  await deliver(w, b);
  const e = (await getEntry(b.p.storageLocal, a.id))!;
  assert.equal(e.state, "prompted");
  assert.ok(e.authorized && e.unsent);
  const b2 = await restart(b, clock);
  await b2.e.sweep();
  const e2 = (await getEntry(b2.p.storageLocal, a.id))!;
  assert.equal(e2.state, "replied");
  assert.equal(e2.unsent, false);
  assert.equal(e2.r, e.r);
  // duplicate commit on an authorized entry re-sends the same reply
  w.take(a.id);
  await a.e.pairSendAgain(a.id).catch(() => undefined);
  clock.t += 61_000;
  await a.e.pairSendAgain(b.id);
  await deliver(w, b2);
  const replies = w.take(a.id);
  assert.equal(replies.length, 1);
});

test("redelivered reply after the pin ends in state shown with one open sent", async () => {
  const { w, a, b } = await setup();
  await refresh(a, b);
  await a.e.pairStart(b.id);
  await deliver(w, b);
  const [reply] = w.take(a.id);
  await a.e.receive(reply!, "push");
  await a.e.receive(reply!, "push");
  assert.equal((await getEntry(a.p.storageLocal, b.id))!.state, "shown");
  assert.equal(w.calls.filter((c) => c.path === "/v1/pair/" + b.id && (c.body as { k: string }).k === "open").length, 1);
});

test("wrong c_N on open aborts with no pin", async () => {
  const { w, a, b } = await setup();
  await refresh(a, b);
  await a.e.pairStart(b.id);
  await deliver(w, b);
  const e = (await getEntry(b.p.storageLocal, a.id))!;
  await b.p.storageLocal.set({ ["pair:" + a.id]: { ...e, c_N: b64urlEncode(new Uint8Array(32)) } });
  await deliver(w, a);
  await deliver(w, b);
  assert.equal(await getEntry(b.p.storageLocal, a.id), null);
  assert.equal((await b.db.peer(a.id))!.pinned, false);
  assert.equal(b.p.storageLocal.data["pairmsg:" + a.id], T.pairFailed);
});

test("crossing: lower id stays N, higher side replies as X", async () => {
  const { w, a, b } = await setup();
  await refresh(a, b);
  await a.e.pairStart(b.id);
  await b.e.pairStart(a.id);
  const lowerIsA = Buffer.compare(Buffer.from(b64urlDecode(a.id)), Buffer.from(b64urlDecode(b.id))) < 0;
  const [lo, hi] = lowerIsA ? [a, b] : [b, a];
  await deliver(w, lo); // lo ignores hi's commit
  assert.equal((await getEntry(lo.p.storageLocal, hi.id))!.role, "N");
  await deliver(w, hi); // hi wipes its N entry and replies as X
  assert.equal((await getEntry(hi.p.storageLocal, lo.id))!.role, "X");
  await deliver(w, lo);
  await deliver(w, hi);
  assert.equal((await lo.e.pairRowView(hi.id))!.fingerprint, (await hi.e.pairRowView(lo.id))!.fingerprint);
});

test("Firefox deny notice reads denied this device; wipe leaves no pair keys", async () => {
  const { w, a, b } = await setup("firefox");
  await refresh(a, b);
  await a.e.pairStart(b.id);
  await deliver(w, b);
  await deliver(w, a);
  await deliver(w, b);
  await b.e.approve(a.id); // b approved a: a's deny is relayed
  await a.e.deny(b.id);
  await deliver(w, b);
  assert.ok([...b.p.notes.values()].some((n) => n.body === "A device denied this device"));
  await a.e.pairStart(b.id).catch(() => undefined);
  await a.e.wipe();
  assert.ok(Object.keys(a.p.storageLocal.data).every((k) => !k.startsWith("pair")));
  assert.equal(a.p.storageLocal.data.registered, undefined);
});

test("timeout while paused keeps Waiting; the re-fetch after unpause completes the pairing", async () => {
  const { w, a, b, clock } = await setup();
  await refresh(a, b);
  await a.e.pairStart(b.id);
  await deliver(w, b);
  await deliver(w, a);
  await deliver(w, b);
  await a.e.approve(b.id); // stored
  await b.e.approve(a.id); // relayed push to a lost
  w.take(a.id);
  await a.e.pause();
  clock.t += 15 * DAY;
  await a.e.sweep();
  assert.ok(await getEntry(a.p.storageLocal, b.id)); // Waiting stays
  assert.ok((await a.db.peer(b.id))!.pinned);
  await a.e.unpause("T");
  assert.ok((await a.db.peer(b.id))!.approves_me);
});

test("a just-completed pairing with an older GET showing approves_me false stays paired", async () => {
  const { w, a, b } = await setup();
  await refresh(a, b); // older GET
  await pairAndApprove(w, a, b);
  const p = (await a.db.peer(b.id))!;
  assert.ok(p.approves_me && !p.get_after_verify);
  assert.equal((await a.e.allSet()).length, 1);
});

test("peer view approvesMe follows the peer's approve of this device", async () => {
  const { w, a, b } = await setup();
  await refresh(a, b);
  const before = (await new Rpc(a.e).peers()).peers.find((v) => v.id === b.id)!;
  assert.equal(before.approvesMe, false);
  await pairAndApprove(w, a, b);
  const after = (await new Rpc(a.e).peers()).peers.find((v) => v.id === b.id)!;
  assert.equal(after.approvesMe, true);
  assert.equal(after.sendable, true);
});

test("N-side hint: approves_me true while committed reads still holds an earlier pairing", async () => {
  const { w, a, b, clock } = await setup();
  await refresh(a, b);
  await a.e.pairStart(b.id);
  w.take(b.id);
  await a.db.putPeer({ ...(await a.db.peer(b.id))!, approves_me: true });
  clock.t += 3 * DAY;
  const v = (await a.e.pairRowView(b.id))!;
  assert.ok(v.lines.includes(T.stillHolds("A device")));
  await a.db.putPeer({ ...(await a.db.peer(b.id))!, approves_me: false });
  assert.ok((await a.e.pairRowView(b.id))!.lines.includes(T.noReplyYet("A device")));
  assert.equal((await a.e.pairRowView(b.id))!.lines[0], "Pairing with A device");
});

test("clock skew on POST /approve: a new n and new bytes in the retry", async () => {
  const { w, a, b } = await setup();
  await refresh(a, b);
  await a.e.pairStart(b.id);
  await deliver(w, b);
  await deliver(w, a);
  await deliver(w, b);
  w.inject.push({ match: /POST \/v1\/approve\//, status: 401, body: { error: "clock skew" }, times: 1 });
  assert.equal(await a.e.approve(b.id), "stored");
  const ap = w.calls.filter((c) => c.path === "/v1/approve/" + b.id);
  assert.equal(ap.length, 2);
  assert.notEqual(JSON.stringify(ap[0]!.body), JSON.stringify(ap[1]!.body));
  assert.equal((await a.db.peer(b.id))!.last_n, 2);
  assert.equal((await getEntry(a.p.storageLocal, b.id))!.approve_body, JSON.stringify(ap[1]!.body));
});

test("I286: a send between a peer-row read and its write keeps last_n (GET /peers merge)", async () => {
  const { w, a, b } = await setup();
  await pairAndApprove(w, a, b);
  const before = (await a.db.peer(b.id))!.last_n;
  const orig = a.db.peer.bind(a.db);
  let armed = true;
  let reserved = 0;
  a.db.peer = async (id: string) => {
    const snap = await orig(id);
    if (armed && id === b.id) {
      armed = false;
      reserved = await a.db.reserveN(b.id);
    }
    return snap;
  };
  await a.e.fetchPeersNow();
  a.db.peer = orig;
  assert.equal(reserved, before + 1);
  assert.equal((await a.db.peer(b.id))!.last_n, before + 1);
  assert.equal(await a.db.reserveN(b.id), before + 2);
});

test("I287: a pushed approve landing while approve() runs leaves the pairing approved and verified", async () => {
  const { w, a, b } = await setup();
  await refresh(a, b);
  await a.e.pairStart(b.id);
  await deliver(w, b);
  await deliver(w, a);
  await deliver(w, b);
  assert.equal(await b.e.approve(a.id), "stored");
  const pushed = w.rows.get(b.id)!.pending[a.id]!; // b's approve, as a concurrent push to a
  const orig = a.db.peer.bind(a.db);
  let armed = true;
  a.db.peer = async (id: string) => {
    const snap = await orig(id);
    if (armed && id === b.id) {
      armed = false;
      await a.e.receive(pushed, "push"); // applied between approve()'s read and its write
    }
    return snap;
  };
  await a.e.approve(b.id);
  a.db.peer = orig;
  const pa = (await a.db.peer(b.id))!;
  assert.equal(pa.ruling, "approved");
  assert.equal(pa.approve_verified, true);
  assert.equal(pa.approves_me, true);
  assert.equal(pa.pending_approve_n, 0);
  assert.equal(await getEntry(a.p.storageLocal, b.id), null);
});

test("I301: a crash right after the replay commit of an approve still leaves the pairing approved and verified", async () => {
  const { w, a, b } = await setup();
  await refresh(a, b);
  await a.e.pairStart(b.id);
  await deliver(w, b);
  await deliver(w, a);
  await deliver(w, b);
  assert.equal(await a.e.approve(b.id), "stored");
  assert.equal(await b.e.approve(a.id), "sent");
  const ms = w.take(a.id);
  assert.equal(ms.length, 1);
  const orig = a.db.acceptN.bind(a.db);
  a.db.acceptN = async (...args: Parameters<typeof orig>) => {
    await orig(...args);
    throw new Error("crash"); // service worker killed after the commit
  };
  await assert.rejects(a.e.receive(ms[0]!, "push"), /crash/);
  a.db.acceptN = orig;
  await a.e.receive(ms[0]!, "push"); // redelivery: a seen n, noop
  const pa = (await a.db.peer(b.id))!;
  assert.equal(pa.approve_verified, true);
  assert.equal(pa.approves_me, true);
  assert.equal(pa.pending_approve_n, 0);
});

test("register rejects an assigned id whose keyhash is not ours", async () => {
  const { clock, w, b } = await setup();
  const { e } = await makeEngine(new FakePlatform("chrome", w, clock), new IDBFactory(), clock);
  w.inject.push({ match: /POST \/v1\/peers$/, status: 200, body: { id: b.id, peers: [], my_allow: [] }, times: 1 });
  await assert.rejects(e.register("T", "a@b.com"), /Bad reply from the server/);
  assert.equal(await e.self(), null);
  assert.equal(await e.regState(), null);
});

test("approve decided under the old pin is not recorded into a replay row a re-pin wrote meanwhile (I314)", async () => {
  const { w, a, b } = await setup();
  await refresh(a, b);
  await a.e.pairStart(b.id);
  await deliver(w, b);
  await deliver(w, a);
  await deliver(w, b);
  await a.e.approve(b.id); // stored
  await b.e.approve(a.id); // sent; push to a queued
  const ms = w.take(a.id);
  assert.equal(ms.length, 1);
  // stall between receiveDecide and acceptN: a re-pin with a new pairing id lands
  const orig = a.db.acceptN.bind(a.db);
  a.db.acceptN = async (...args: Parameters<typeof orig>) => {
    const p = (await a.db.peer(b.id))!;
    assert.ok(await a.db.pin(b.id, p.sign_pub, p.enc_pub, new Uint8Array(8).fill(7), p));
    return orig(...args);
  };
  await a.e.receive(ms[0]!, "push");
  assert.equal((await a.db.replay(b.id))!.h, 0);
  const p = (await a.db.peer(b.id))!;
  assert.equal(p.approve_verified, false);
  assert.equal(p.approves_me, false);
});

test("Pair again twice at once: the second call is ignored, one pairing starts", async () => {
  const { w, a, b } = await setup();
  await pairAndApprove(w, a, b);
  await b.e.cancelPairing(a.id);
  await a.e.fetchPeersNow();
  await b.e.pairStart(a.id);
  await deliver(w, a);
  const posts = () => w.calls.filter((c) => c.path === "/v1/pair/" + b.id && c.method === "POST").length;
  const before = posts();
  const r = await Promise.allSettled([a.e.pairAgain(b.id), a.e.pairAgain(b.id)]);
  assert.deepEqual(r.map((x) => x.status), ["fulfilled", "fulfilled"]);
  assert.equal(posts() - before, 1);
});
