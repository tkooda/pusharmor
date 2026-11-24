import assert from "node:assert/strict";
import { test } from "node:test";
import { Rpc } from "../src/core/rpc.ts";
import { DEL_SPARE, buildJson, delChunks, delFits, encodeInner, newMsgId, parseInnerJson } from "../src/model/message.ts";
import { utf8 } from "../src/crypto/bytes.ts";
import { SEND_CAP } from "../src/model/padding.ts";
import { b64urlDecode } from "../src/crypto/b64url.ts";
import { SERVER_RETRY_DELAYS_MS } from "../src/api/client.ts";
import { Clock, MockWorker, deliver, device, pairAndApprove } from "./harness.ts";

async function setup() {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const b = await device(w, clock);
  await pairAndApprove(w, a, b);
  return { w, a, b };
}

const sends = (w: MockWorker) => w.calls.filter((c) => c.method === "POST" && c.path === "/v1/send").length;
const rows = async (d: { db: { history(): Promise<{ id?: number; dir: string; type: string; content: string; mid?: string | null }[]> } }) =>
  (await d.db.history()).filter((r) => r.type !== "event");

test("message id: parsed when valid, ignored when not; del parses as a known type", () => {
  const p = (s: string) => parseInnerJson(utf8(s));
  assert.deepEqual(p('{"n":3,"id":"abc_-9","text":"x"}'), { n: 3, v: 1, content: { type: "text", value: "x", id: "abc_-9" } });
  assert.deepEqual(p('{"n":3,"id":"a b","text":"x"}'), { n: 3, v: 1, content: { type: "text", value: "x" } });
  assert.deepEqual(p('{"n":3,"id":"' + "a".repeat(65) + '","text":"x"}'), { n: 3, v: 1, content: { type: "text", value: "x" } });
  assert.deepEqual(p('{"n":4,"del":["abc","d-e"]}'), { n: 4, v: 1, content: { type: "del", ids: ["abc", "d-e"] } });
  assert.equal(p('{"n":4,"del":[]}'), null);
  assert.equal(p('{"n":4,"del":["a b"]}'), null);
  assert.match(newMsgId(), /^[A-Za-z0-9_-]{22}$/);
});

test("send stores the id on the out row; the receiver stores it on the in row", async () => {
  const { w, a, b } = await setup();
  await a.e.send("hello", "auto", "all");
  await deliver(w, b);
  const out = (await rows(a)).find((r) => r.dir === "out")!;
  const inn = (await rows(b)).find((r) => r.dir === "in")!;
  assert.match(out.mid!, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(inn.mid, out.mid);
});

test("del removes matching in and out rows and their notifications; the receiver obeys with its own setting off", async () => {
  const { w, a, b } = await setup();
  await b.e.setSettings({ syncDeletions: false });
  await a.e.send("from a", "auto", "all");
  await deliver(w, b);
  await b.e.send("from b", "auto", "all");
  await deliver(w, a);
  await b.e.send("keep", "auto", "all");
  await deliver(w, a);
  const inB = (await rows(b)).find((r) => r.content === "from a")!;
  assert.ok(b.p.notes.has("h:" + inB.id));
  const del = (await rows(a)).filter((r) => r.content !== "keep").map((r) => r.id!);
  assert.deepEqual(await new Rpc(a.e).handle({ op: "historyDelete", args: { ids: del } }), { ok: true, data: null });
  assert.deepEqual((await rows(a)).map((r) => r.content), ["keep"]);
  const before = b.p.notes.size;
  await deliver(w, b);
  assert.deepEqual((await rows(b)).map((r) => r.content), ["keep"]);
  assert.equal(b.p.notes.has("h:" + inB.id), false);
  assert.equal(b.p.notes.size, before - 1); // no new notification
  assert.equal(b.p.badge, "");
});

test("setting off: no del sent; rows without an id: no del sent", async () => {
  const { w, a, b } = await setup();
  await a.e.send("one", "auto", "all");
  await deliver(w, b);
  await a.e.setSettings({ syncDeletions: false });
  const n0 = sends(w);
  await a.e.deleteHistory((await rows(a)).map((r) => r.id!));
  assert.equal(sends(w), n0);
  assert.equal((await rows(a)).length, 0);
  await a.e.setSettings({ syncDeletions: true });
  const old = await a.db.addHistory({ dir: "out", peer: null, type: "text", content: "old", n: null, pairing_id: null, received: 1, read: true });
  await a.e.deleteHistory([old]);
  assert.equal(sends(w), n0);
  assert.equal((await rows(a)).length, 0);
  assert.equal((await rows(b)).length, 1);
});

test("relay server failure: rows kept, struck through with the device named, and the error shown", async () => {
  const { w, a } = await setup();
  await a.e.send("one", "auto", "all");
  w.inject.push({ match: /POST \/v1\/send$/, status: 500, body: { error: "internal" }, times: 99 });
  const ids = (await rows(a)).map((r) => r.id!);
  const r = await new Rpc(a.e).handle({ op: "historyDelete", args: { ids } });
  assert.deepEqual(r, { ok: true, data: 'Unable to delete on "Chrome"\nThe relay server is not working right now. Try again later.' });
  assert.equal((await rows(a)).length, 1);
  const h = (await new Rpc(a.e).handle({ op: "history" })) as { data: { notDeleted?: string[] }[] };
  assert.deepEqual(h.data.map((x) => x.notDeleted), [["Chrome"]]);
});

for (const [len, count] of [[22, 300], [64, 120]] as const) test("a del of " + count + " ids of " + len + " chars is split over several sends, each under the cap", async () => {
  const { w, a, b } = await setup();
  const mids: string[] = [];
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const mid = (newMsgId() + newMsgId() + newMsgId()).slice(0, len);
    mids.push(mid);
    ids.push(await a.db.addHistory({ dir: "out", peer: null, type: "text", content: "x" + i, n: null, pairing_id: null, received: 1000 + i, read: true, mid }));
  }
  const calls = (await delChunks(mids)).length;
  assert.ok(calls >= 2);
  const n0 = sends(w);
  await a.e.deleteHistory(ids);
  assert.equal(sends(w) - n0, calls);
  for (const c of w.calls.filter((c) => c.path === "/v1/send").slice(-calls)) {
    for (const m of Object.values((c.body as { m: Record<string, string> }).m)) assert.ok(m.length <= 3800);
  }
  assert.equal(await deliver(w, b), calls);
  assert.equal((await rows(a)).length, 0);
});

test("partial: chunk 1 ok, chunk 2 relay server failure on every attempt, chunk 3 still sent; only chunk 2 rows kept; one error", async (t) => {
  const { w, a } = await setup();
  const mids: string[] = [];
  const ids: number[] = [];
  for (let i = 0; i < 450; i++) {
    const mid = newMsgId();
    mids.push(mid);
    ids.push(await a.db.addHistory({ dir: "out", peer: null, type: "text", content: "x" + i, n: null, pairing_id: null, received: 1000 + i, read: true, mid }));
  }
  ids.push(await a.db.addHistory({ dir: "out", peer: null, type: "text", content: "noid", n: null, pairing_id: null, received: 1, read: true }));
  // every size check builds the JSON with a new random message id, whose deflated size varies: a fixed id keeps the boundary in place (the chunks are computed again by the send)
  t.mock.method(crypto, "getRandomValues", <T extends ArrayBufferView>(a: T): T => {
    const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    for (let i = 0; i < b.length; i++) b[i] = (i * 151 + 7) & 255;
    return a;
  });
  const chunks = await delChunks(mids);
  assert.ok(chunks.length >= 3);
  const handle = w.handle.bind(w);
  let n = 0;
  w.handle = async (url: string, init: RequestInit) => {
    if (new URL(url).pathname === "/v1/send" && ++n === 2) w.inject.push({ match: /POST \/v1\/send$/, status: 500, body: { error: "internal" }, times: 1 + SERVER_RETRY_DELAYS_MS.length });
    return handle(url, init);
  };
  const r = await new Rpc(a.e).handle({ op: "historyDelete", args: { ids } });
  assert.deepEqual(r, { ok: true, data: 'Unable to delete on "Chrome"\nThe relay server is not working right now. Try again later.' });
  assert.equal(n, chunks.length + SERVER_RETRY_DELAYS_MS.length);
  const left = (await rows(a)).map((r) => r.mid).sort();
  assert.deepEqual(left, [...chunks[1]!].sort());
});

test("relay server ok but one device did not get the del: row kept, notice names it with why", async () => {
  const { w, a, b } = await setup();
  await a.e.send("one", "auto", "all");
  w.inject.push({ match: /POST \/v1\/send$/, status: 200, body: { r: { [b.id]: "logged out" } }, times: 1 });
  const r = await new Rpc(a.e).handle({ op: "historyDelete", args: { ids: (await rows(a)).map((r) => r.id!) } });
  assert.deepEqual(r, { ok: true, data: 'Unable to delete on "Chrome"\nThat device is logged out. Log in on that device to receive messages.' });
  assert.equal((await rows(a)).length, 1);
});

test("relay server ok but two devices did not get the del: row kept, notice names both", async () => {
  const { w, a, b } = await setup();
  const c = await device(w, w.clock);
  await pairAndApprove(w, a, c);
  await a.e.send("one", "auto", "all");
  w.inject.push({ match: /POST \/v1\/send$/, status: 200, body: { r: { [b.id]: "gone", [c.id]: "not listening" } }, times: 1 });
  const r = (await new Rpc(a.e).handle({ op: "historyDelete", args: { ids: (await rows(a)).map((r) => r.id!) } })) as { data: string };
  assert.match(r.data, /^Unable to delete on "[^"]+" and "[^"]+"$/);
  assert.equal((await rows(a)).length, 1);
  const h = (await new Rpc(a.e).handle({ op: "history" })) as { data: { notDeleted?: string[] }[] };
  assert.equal(h.data[0]!.notDeleted!.length, 2);
});

test("every device got the del: rows gone, no notice", async () => {
  const { a } = await setup();
  await a.e.send("one", "auto", "all");
  const r = await new Rpc(a.e).handle({ op: "historyDelete", args: { ids: (await rows(a)).map((r) => r.id!) } });
  assert.deepEqual(r, { ok: true, data: null });
  assert.equal((await rows(a)).length, 0);
});

test("a failed push is resent only to that device; a resend that gets sent leaves no notice", async () => {
  const { w, a, b } = await setup();
  const c = await device(w, w.clock);
  await pairAndApprove(w, a, c);
  await a.e.send("one", "auto", "all");
  w.inject.push({ match: /POST \/v1\/send$/, status: 200, body: { r: { [b.id]: "failed:503", [c.id]: "sent" } }, times: 1 });
  const n0 = sends(w);
  const t0 = w.clock.t;
  const r = await new Rpc(a.e).handle({ op: "historyDelete", args: { ids: (await rows(a)).map((r) => r.id!) } });
  assert.deepEqual(r, { ok: true, data: null });
  assert.equal((await rows(a)).length, 0);
  assert.equal(sends(w) - n0, 2);
  assert.deepEqual(Object.keys((w.calls.at(-1)!.body as { m: Record<string, string> }).m), [b.id]);
  assert.equal(w.clock.t - t0, SERVER_RETRY_DELAYS_MS[0]); // the injected sleep, no real wait
});

test("a push that fails on every attempt is sent 3 times in all, then named in the notice; the row stays", async () => {
  const { w, a, b } = await setup();
  await a.e.send("one", "auto", "all");
  w.inject.push({ match: /POST \/v1\/send$/, status: 200, body: { r: { [b.id]: "failed:503" } }, times: 99 });
  const n0 = sends(w);
  const r = await new Rpc(a.e).handle({ op: "historyDelete", args: { ids: (await rows(a)).map((r) => r.id!) } });
  assert.deepEqual(r, { ok: true, data: 'Unable to delete on "Chrome"\nIts push service did not accept the message. Try again later.' });
  assert.equal(sends(w) - n0, 1 + SERVER_RETRY_DELAYS_MS.length);
  assert.equal((await rows(a)).length, 1);
});

test("a del filled to the max with 22-char ids seals to 3800 chars or less; one more id does not fit", async (t) => {
  const { a, b } = await setup();
  const self = (await a.e.self())!;
  const peer = (await a.db.peer(b.id))!;
  const seal = (ids: string[]) =>
    encodeInner({ signKey: self.sign.privateKey, fromId: b64urlDecode(a.id), pairingId: peer.pairing_id!, json: buildJson(Number.MAX_SAFE_INTEGER, { type: "del", ids }), recipientId: b.id, recipientEncPub: peer.enc_pub });
  const ids = Array.from({ length: 300 }, () => newMsgId());
  // every size check builds the JSON with a new random message id, whose deflated size varies: a fixed id keeps the boundary in place
  t.mock.method(crypto, "getRandomValues", <T extends ArrayBufferView>(a: T): T => {
    const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    for (let i = 0; i < b.length; i++) b[i] = (i * 151 + 7) & 255;
    return a;
  });
  const max = (await delChunks(ids))[0]!.length;
  assert.ok((await seal(ids.slice(0, max))).length <= 3800);
  assert.equal(await delFits(ids.slice(0, max + 1)), false);
});

test("a del that fits the cap only without 8 bytes spare is split", async (t) => {
  assert.equal(DEL_SPARE, 8);
  // every size check builds the JSON with a new random message id, whose deflated size varies: a fixed id keeps the boundary in place
  t.mock.method(crypto, "getRandomValues", <T extends ArrayBufferView>(a: T): T => {
    const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    for (let i = 0; i < b.length; i++) b[i] = (i * 151 + 7) & 255;
    return a;
  });
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const ids = Array.from({ length: 4096 }, (_, i) => abc[i >> 6]! + abc[i & 63]!); // short ids: each adds only a few bytes
  let k = 1;
  while (await delFits(ids.slice(0, k + 1), 0)) k++; // the longest list that fits with no spare
  const at = ids.slice(0, k);
  assert.equal(await delFits(at, DEL_SPARE), false);
  assert.equal((await delChunks(at)).length, 2);
});

test("a max-length message with an id seals to 3800 chars or less, worst-case content", async () => {
  const { a, b } = await setup();
  const self = (await a.e.self())!;
  const peer = (await a.db.peer(b.id))!;
  const rnd = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
  // control chars (escaped as 6-byte \u00XX), random ASCII, and random multi-byte chars
  const gens = [() => String.fromCharCode(rnd(0, 0x1f)), () => String.fromCharCode(rnd(0, 0x7f)), () => String.fromCharCode(rnd(0x800, 0xd7ff))];
  for (const g of gens) {
    let text = "";
    while (utf8(text + "x").length <= SEND_CAP) {
      const ch = g();
      if (utf8(text + ch).length > SEND_CAP) break;
      text += ch;
    }
    for (const type of ["text", "url", "tel"] as const) {
      const json = buildJson(Number.MAX_SAFE_INTEGER, { type, value: text, id: newMsgId() });
      const m = await encodeInner({ signKey: self.sign.privateKey, fromId: b64urlDecode(a.id), pairingId: peer.pairing_id!, json, recipientId: b.id, recipientEncPub: peer.enc_pub });
      assert.ok(m.length <= 3800);
    }
  }
});

test("a row kept for one device: a new delete goes to that device only, then the row is gone", async () => {
  const { w, a, b } = await setup();
  const c = await device(w, w.clock);
  await pairAndApprove(w, a, c);
  await a.e.send("one", "auto", "all");
  w.inject.push({ match: /POST \/v1\/send$/, status: 200, body: { r: { [b.id]: "failed:503", [c.id]: "sent" } }, times: 1 });
  w.inject.push({ match: /POST \/v1\/send$/, status: 200, body: { r: { [b.id]: "failed:503" } }, times: SERVER_RETRY_DELAYS_MS.length });
  const ids = (await rows(a)).map((r) => r.id!);
  await a.e.deleteHistory(ids);
  const kept = (await a.db.history()).filter((r) => r.type !== "event");
  assert.equal(kept.length, 1);
  assert.deepEqual([...kept[0]!.del_req!].sort(), [b.id, c.id].sort());
  assert.deepEqual(kept[0]!.del_ok, [c.id]);
  const n0 = sends(w);
  assert.equal(await a.e.deleteHistory(ids), null);
  assert.equal(sends(w) - n0, 1);
  assert.deepEqual(Object.keys((w.calls.at(-1)!.body as { m: Record<string, string> }).m), [b.id]);
  assert.equal((await rows(a)).length, 0);
});

test("a row kept for a device that then logs out is deleted when History is read", async () => {
  const { w, a, b } = await setup();
  await a.e.send("one", "auto", "all");
  w.inject.push({ match: /POST \/v1\/send$/, status: 500, body: { error: "internal" }, times: 99 });
  await a.e.deleteHistory((await rows(a)).map((r) => r.id!));
  assert.equal((await rows(a)).length, 1);
  await a.db.put("peers", { ...(await a.db.peer(b.id))!, logged_out: true });
  assert.deepEqual((await new Rpc(a.e).handle({ op: "history" })) as { data: unknown[] }, { ok: true, data: [] });
  assert.equal((await rows(a)).length, 0);
});

test("a kept row with Sync deletions off is deleted here at once, with no send", async () => {
  const { w, a } = await setup();
  await a.e.send("one", "auto", "all");
  w.inject.push({ match: /POST \/v1\/send$/, status: 500, body: { error: "internal" }, times: 99 });
  const ids = (await rows(a)).map((r) => r.id!);
  await a.e.deleteHistory(ids);
  await a.e.setSettings({ syncDeletions: false });
  const n0 = w.calls.length;
  assert.equal(await a.e.deleteHistory(ids), null);
  assert.equal(w.calls.length, n0);
  assert.equal((await rows(a)).length, 0);
});

test("a delete in several batches writes its steps for the bar, ending with this device, then clears them", async () => {
  const { w, a } = await setup();
  const ids: number[] = [];
  for (let i = 0; i < 450; i++) ids.push(await a.db.addHistory({ dir: "out", peer: null, type: "text", content: "x" + i, n: null, pairing_id: null, received: 1000 + i, read: true, mid: newMsgId() }));
  const total = (await delChunks((await a.db.history()).map((r) => r.mid!).filter(Boolean))).length;
  const seen: unknown[] = [];
  const set = a.p.storageSession.set.bind(a.p.storageSession);
  a.p.storageSession.set = async (items: Record<string, unknown>) => {
    if ("busy" in items) seen.push(items.busy);
    return set(items);
  };
  let n = 0;
  const handle = w.handle.bind(w);
  w.handle = async (url: string, init: RequestInit) => {
    if (new URL(url).pathname === "/v1/send" && ++n === 1) w.inject.push({ match: /POST \/v1\/send$/, status: 500, body: { error: "internal" }, times: 1 });
    return handle(url, init);
  };
  assert.equal(await a.e.deleteHistory(ids), null);
  const caps = seen.map((b) => (b as { cap: string }).cap);
  // the first call fails once: the API client tries again with the bar held at 0
  assert.deepEqual(caps, [
    "Deleting on your other devices (0 of " + total + ")",
    "Trying again (attempt 2 of 3)",
    ...Array.from({ length: total - 1 }, (_, i) => "Deleting on your other devices (" + (i + 1) + " of " + total + ")"),
    "Deleting on this device",
  ]);
  assert.deepEqual(seen[1], { cap: "Trying again (attempt 2 of 3)", done: 0, total });
  assert.deepEqual(seen.at(-1), { cap: "Deleting on this device", done: total, total });
  assert.equal((await a.p.storageSession.get(["busy"])).busy, undefined);
  assert.equal((await rows(a)).length, 0);
});

test("a delete in one batch writes no steps", async () => {
  const { a } = await setup();
  await a.e.send("one", "auto", "all");
  await a.p.storageSession.remove(["busy"]); // the sign-in steps of the setup
  await a.e.deleteHistory((await rows(a)).map((r) => r.id!));
  assert.equal((await a.p.storageSession.get(["busy"])).busy, undefined);
});

test("log out writes no step of its own; account delete shows only Deleting your account", async () => {
  const caps = async (run: (d: Awaited<ReturnType<typeof setup>>["a"]) => Promise<unknown>) => {
    const { a } = await setup();
    const seen: string[] = [];
    const set = a.p.storageSession.set.bind(a.p.storageSession);
    a.p.storageSession.set = async (items: Record<string, unknown>) => {
      if ("busy" in items) seen.push((items.busy as { cap: string }).cap);
      return set(items);
    };
    await run(a);
    return seen;
  };
  assert.deepEqual(await caps((a) => new Rpc(a.e).handle({ op: "signout" })), []);
  assert.deepEqual(await caps((a) => a.e.deleteAccount("T")), ["Deleting your account"]);
});
