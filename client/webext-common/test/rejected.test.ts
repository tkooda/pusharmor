import assert from "node:assert/strict";
import { test } from "node:test";
import { N } from "./fakedom.ts";
import { Rpc, type PeerView } from "../src/core/rpc.ts";
import { getEntry } from "../src/core/state.ts";
import { renderPeers } from "../src/ui/peersview.ts";
import type { UiEnv } from "../src/ui/dom.ts";
import { Clock, MockWorker, deliver, device, refresh } from "./harness.ts";

async function setup() {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const b = await device(w, clock);
  await refresh(a, b);
  return { w, a, b };
}

const rowOf = async (d: { e: ConstructorParameters<typeof Rpc>[0] }, id: string) => (await new Rpc(d.e).peers()).peers.find((v) => v.id === id)!;

test("Reject takes the device out of the list: no Denied line, no Reject again, only Pair", async () => {
  const { a, b } = await setup();
  await b.e.deny(a.id);
  assert.equal((await b.db.peer(a.id))!.ruling, "denied");
  const row = await rowOf(b, a.id);
  assert.equal(row.rejected, true);
  assert.deepEqual(row.actions, ["pair", "remove"]);
  assert.deepEqual(row.lines, []);
});

test("Codes differ on a pairing also takes the device out of the list", async () => {
  const { w, a, b } = await setup();
  await a.e.pairStart(b.id);
  await deliver(w, b);
  await deliver(w, a);
  await deliver(w, b);
  assert.equal((await getEntry(b.p.storageLocal, a.id))!.state, "shown");
  await b.e.deny(a.id);
  const row = await rowOf(b, a.id);
  assert.equal(row.rejected, true);
  assert.ok(!row.actions.includes("deny"));
});

test("a device that rejected this one shows Rejected this device under Waiting to pair, with Reject and Pair", async () => {
  for (const choice of ["pair", "deny"] as const) {
    const { w, a, b } = await setup();
    await a.e.pairStart(b.id);
    await deliver(w, b);
    await deliver(w, a);
    await deliver(w, b);
    await a.e.approve(b.id); // a confirmed the codes
    await b.e.deny(a.id); // b: Codes differ
    await deliver(w, a);
    await a.e.fetchPeersNow();
    const row = await rowOf(a, b.id);
    assert.deepEqual([row.greyed, row.section, row.actions, row.rejected], ["Rejected this device", "waiting", ["deny", "pair", "remove"], undefined]);
    await new Rpc(a.e).handle({ op: choice, args: { id: b.id } });
    if (choice === "pair") {
      // the old pairing is dropped and a new pairing request goes out
      const e = (await getEntry(a.p.storageLocal, b.id))!;
      assert.deepEqual([e.role, e.state], ["N", "committed"]);
      assert.equal((await rowOf(a, b.id)).section, "pairing");
    } else {
      const r = await rowOf(a, b.id);
      assert.equal(r.rejected, true);
      assert.ok(!w.rows.get(a.id)!.allow.has(b.id)); // the old approval is withdrawn
    }
  }
});

test("a Reject the relay server does not take shows why, and the device stays rejected here", async () => {
  const { w, a, b } = await setup();
  w.inject.push({ match: /POST \/v1\/deny\//, status: 503, body: { error: "unavailable" }, times: 9 });
  const r = await new Rpc(b.e).handle({ op: "deny", args: { id: a.id } });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /^Unable to reject New Chrome device\.\n/);
  assert.equal((await b.db.peer(a.id))!.ruling, "denied");
});

test("a new pairing request from a rejected device shows it in the list again", async () => {
  const { w, a, b } = await setup();
  await b.e.deny(a.id);
  await a.e.pairStart(b.id);
  await deliver(w, b);
  assert.equal((await b.db.peer(a.id))!.ruling, "none");
  assert.ok(await getEntry(b.p.storageLocal, a.id));
  const row = await rowOf(b, a.id);
  assert.ok(!row.rejected);
});

const view = (id: string, label: string, extra: Partial<PeerView>): PeerView => ({
  id, label, platform: "android", lines: [], actions: ["remove"], countdown: null, fingerprint: null, pk: null,
  greyed: null, hidden: false, sendable: true, approvesMe: true, paired: true, ...extra,
});

const all = (n: N): N[] => [n, ...n.kids.flatMap(all)];

test("Devices: a rejected device shows only under a collapsed Rejected devices section at the bottom, with Pair", async () => {
  const peers = [view("p1", "Phone", {}), view("r1", "Old tablet", { rejected: true, actions: ["pair", "remove"], approvesMe: false, sendable: false, paired: false })];
  const env = { call: async () => ({ ok: true, data: { peers } }) } as unknown as UiEnv;
  const root = new N("div");
  await renderPeers(env, root as unknown as HTMLElement, false);
  const nodes = all(root);
  assert.deepEqual(nodes.filter((n) => n.attrs.id?.startsWith("peer-")).map((n) => n.attrs.id), ["peer-p1", "peer-r1"]);
  const sec = root.kids.find((n) => n.tag === "details")!;
  assert.ok(sec, "no Rejected devices section");
  assert.equal(sec.attrs.open, undefined, "the section starts collapsed");
  assert.equal(sec.kids[0]!.tag, "summary");
  assert.equal(sec.kids[0]!.textContent, "Rejected devices (1)");
  // after Pair a new device: the bottom of the list
  assert.ok(root.kids.indexOf(sec) > root.kids.findIndex((n) => n.attrs.class === "pairnew"));
  const inSec = all(sec);
  assert.ok(inSec.some((n) => n.attrs.id === "peer-r1"));
  assert.ok(!inSec.some((n) => n.attrs.id === "peer-p1"));
  assert.ok(inSec.some((n) => n.tag === "button" && n.textContent === "Pair"));
  assert.ok(!all(root).filter((n) => !inSec.includes(n)).some((n) => n.textContent === "Old tablet"));
});

test("Devices: sections Waiting to pair, Pairing, Paired devices, then Pair a new device and Rejected devices; empty ones hidden", async () => {
  const peers = [
    view("p1", "Phone", { section: "paired" }),
    view("w1", "New Firefox device", { section: "waiting", actions: ["pair", "deny", "remove"], approvesMe: false, sendable: false, paired: false }),
    view("c1", "Tablet", { section: "pairing", fingerprint: "YSWH", actions: ["approve", "deny", "cancel"], approvesMe: false, sendable: false, paired: false }),
    view("r1", "Old tablet", { rejected: true, actions: ["pair", "remove"], approvesMe: false, sendable: false, paired: false }),
  ];
  const env = { call: async () => ({ ok: true, data: { peers } }) } as unknown as UiEnv;
  const root = new N("div");
  await renderPeers(env, root as unknown as HTMLElement, false);
  const heads = root.kids.filter((n) => n.attrs.class === "sh" || n.attrs.class === "pairnew" || n.tag === "details").map((n) => (n.tag === "details" ? n.kids[0]!.textContent : n.attrs.class === "pairnew" ? "+" : n.textContent));
  assert.deepEqual(heads, ["Waiting to pair", "Pairing", "Paired devices", "+", "Rejected devices (1)"]);
  // Reject and Pair span the row
  const w1 = all(root).find((n) => n.attrs.id === "peer-w1")!;
  const acts = w1.kids.find((n) => n.attrs.class === "pair-acts")!;
  assert.deepEqual(acts.kids.map((n) => n.textContent), ["Reject", "Pair"]);
  // only paired: one section
  const root2 = new N("div");
  await renderPeers({ call: async () => ({ ok: true, data: { peers: [peers[0]] } }) } as unknown as UiEnv, root2 as unknown as HTMLElement, false);
  assert.deepEqual(root2.kids.filter((n) => n.attrs.class === "sh").map((n) => n.textContent), ["Paired devices"]);
});

test("Devices: no rejected device, no Rejected devices section", async () => {
  const peers = [view("p1", "Phone", {})];
  const env = { call: async () => ({ ok: true, data: { peers } }) } as unknown as UiEnv;
  const root = new N("div");
  await renderPeers(env, root as unknown as HTMLElement, false);
  assert.ok(!all(root).some((n) => n.tag === "details" || n.textContent?.startsWith("Rejected devices")));
});

test("both devices rejected each other: Pair under Rejected devices ends the rejection and pairs them", async () => {
  const { w, a, b } = await setup();
  await a.e.deny(b.id);
  await b.e.deny(a.id);
  assert.equal((await rowOf(b, a.id)).rejected, true);
  // Pair on the row runs the pair op, as Pair elsewhere does
  await new Rpc(b.e).handle({ op: "pair", args: { id: a.id } });
  assert.equal((await b.db.peer(a.id))!.ruling, "none");
  assert.ok(!(await rowOf(b, a.id)).rejected);
  await deliver(w, a); // commit -> automatic reply
  assert.equal((await a.db.peer(b.id))!.ruling, "none");
  assert.ok(!(await rowOf(a, b.id)).rejected);
  await deliver(w, b); // reply -> open
  await deliver(w, a); // open -> shown
  const fp = (await b.e.pairRowView(a.id))!.fingerprint;
  assert.ok(fp);
  assert.equal((await a.e.pairRowView(b.id))!.fingerprint, fp);
  await b.e.approve(a.id);
  await a.e.approve(b.id);
  await deliver(w, b);
  await deliver(w, a);
  assert.ok((await rowOf(a, b.id)).paired && (await rowOf(b, a.id)).paired);
});

test("after a Reject the rejected device can pair again: it starts, both approve, then send works", async () => {
  for (const starter of ["rejected"] as const) {
    const { w, a, b } = await setup();
    await b.e.deny(a.id); // b rejected a
    const [n, x] = [a, b];
    await n.e.pairStart(x.id);
    await deliver(w, x); // commit -> automatic reply
    await deliver(w, n); // reply -> open
    await deliver(w, x); // open -> shown
    const fp = (await n.e.pairRowView(x.id))!.fingerprint;
    assert.ok(fp, starter);
    assert.equal((await x.e.pairRowView(n.id))!.fingerprint, fp, starter);
    // the rejected device approves first: stored while b still denies it
    assert.equal(await a.e.approve(b.id), "stored", starter);
    assert.equal(await b.e.approve(a.id), "sent", starter);
    await deliver(w, a);
    assert.equal(w.rows.get(b.id)!.deny.has(a.id), false, starter);
    for (const d of [a, b]) {
      const other = d === a ? b.id : a.id;
      const row = await rowOf(d, other);
      assert.ok(row.paired && !row.rejected, starter);
    }
  }
});
