import assert from "node:assert/strict";
import { test } from "node:test";
import { Rpc } from "../src/core/rpc.ts";
import { buildJson, delChunks, encodeInner, newMsgId, parseInnerJson } from "../src/model/message.ts";
import { utf8 } from "../src/crypto/bytes.ts";
import { CONTENT_CAP } from "../src/model/padding.ts";
import { b64urlDecode } from "../src/crypto/b64url.ts";
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
  assert.deepEqual(p('{"n":3,"id":"abc_-9","text":"x"}'), { n: 3, content: { type: "text", value: "x", id: "abc_-9" } });
  assert.deepEqual(p('{"n":3,"id":"a b","text":"x"}'), { n: 3, content: { type: "text", value: "x" } });
  assert.deepEqual(p('{"n":3,"id":"' + "a".repeat(65) + '","text":"x"}'), { n: 3, content: { type: "text", value: "x" } });
  assert.deepEqual(p('{"n":4,"del":["abc","d-e"]}'), { n: 4, content: { type: "del", ids: ["abc", "d-e"] } });
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

test("relay server failure: rows kept and the error shown", async () => {
  const { w, a } = await setup();
  await a.e.send("one", "auto", "all");
  w.inject.push({ match: /POST \/v1\/send$/, status: 500, body: { error: "internal" }, times: 99 });
  const ids = (await rows(a)).map((r) => r.id!);
  const r = await new Rpc(a.e).handle({ op: "historyDelete", args: { ids } });
  assert.deepEqual(r, { ok: false, error: "Unable to delete on your other devices.\nThe relay server is not working right now. Try again later." });
  assert.equal((await rows(a)).length, 1);
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

test("delete all with the setting on sends del with every id; a relay server failure keeps the rows", async () => {
  const { w, a, b } = await setup();
  await a.e.send("one", "auto", "all");
  await deliver(w, b);
  await b.e.send("two", "auto", "all");
  await deliver(w, a);
  await a.db.addHistory({ dir: "out", peer: null, type: "text", content: "old", n: null, pairing_id: null, received: 1, read: true });
  w.inject.push({ match: /POST \/v1\/send$/, status: 500, body: { error: "internal" }, times: 99 });
  const r = await new Rpc(a.e).handle({ op: "historyDeleteAll" });
  assert.deepEqual(r, { ok: false, error: "Unable to delete on your other devices.\nThe relay server is not working right now. Try again later." });
  assert.equal((await rows(a)).length, 3);
  w.inject.length = 0;
  const n0 = sends(w);
  assert.deepEqual(await new Rpc(a.e).handle({ op: "historyDeleteAll" }), { ok: true, data: null });
  assert.equal(sends(w) - n0, 1);
  assert.equal((await a.db.history()).length, 0);
  await deliver(w, b);
  assert.equal((await rows(b)).length, 0);
});

test("a del filled to the max with 22-char ids seals to 3800 chars or less; one more id goes past 3800", async () => {
  const { a, b } = await setup();
  const self = (await a.e.self())!;
  const peer = (await a.db.peer(b.id))!;
  const seal = (ids: string[]) =>
    encodeInner({ signKey: self.sign.privateKey, fromId: b64urlDecode(a.id), pairingId: peer.pairing_id!, json: buildJson(Number.MAX_SAFE_INTEGER, { type: "del", ids }), recipientId: b.id, recipientEncPub: peer.enc_pub });
  const ids = Array.from({ length: 300 }, () => newMsgId());
  const max = (await delChunks(ids))[0]!.length;
  assert.ok((await seal(ids.slice(0, max))).length <= 3800);
  await assert.rejects(seal(ids.slice(0, max + 1)), /too large/);
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
    while (utf8(text + "x").length <= CONTENT_CAP) {
      const ch = g();
      if (utf8(text + ch).length > CONTENT_CAP) break;
      text += ch;
    }
    for (const type of ["text", "url", "tel"] as const) {
      const json = buildJson(Number.MAX_SAFE_INTEGER, { type, value: text, id: newMsgId() });
      const m = await encodeInner({ signKey: self.sign.privateKey, fromId: b64urlDecode(a.id), pairingId: peer.pairing_id!, json, recipientId: b.id, recipientEncPub: peer.enc_pub });
      assert.ok(m.length <= 3800);
    }
  }
});
