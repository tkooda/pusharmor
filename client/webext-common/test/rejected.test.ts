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

test("Pair on a rejected device starts a new pairing and shows it in the list again", async () => {
  const { a, b } = await setup();
  await b.e.deny(a.id);
  await b.e.pairStart(a.id);
  assert.equal((await b.db.peer(a.id))!.ruling, "none");
  assert.equal((await getEntry(b.p.storageLocal, a.id))!.role, "N");
  assert.ok(!(await rowOf(b, a.id)).rejected);
});

const view = (id: string, label: string, extra: Partial<PeerView>): PeerView => ({
  id, label, platform: "android", lines: [], actions: ["remove"], countdown: null, fingerprint: null, pk: null,
  greyed: null, hidden: false, sendable: true, approvesMe: true, paired: true, ...extra,
});

const all = (n: N): N[] => [n, ...n.kids.flatMap(all)];

test("Devices: a rejected device is only under Pair a new device, with Pair and no Reject", async () => {
  const peers = [view("p1", "Phone", {}), view("r1", "Old tablet", { rejected: true, actions: ["pair", "remove"], approvesMe: false, sendable: false, paired: false })];
  const env = { call: async () => ({ ok: true, data: { peers } }) } as unknown as UiEnv;
  const root = new N("div");
  await renderPeers(env, root as unknown as HTMLElement, false);
  const nodes = all(root);
  const rej = nodes.find((n) => n.attrs.class === "rejected")!;
  assert.ok(rej, "Pair a new device lists the rejected device");
  assert.ok(nodes.find((n) => n.attrs.class === "pairnew")!.contains(rej));
  const rows = nodes.filter((n) => n.attrs.id?.startsWith("peer-"));
  assert.deepEqual(rows.map((n) => n.attrs.id), ["peer-p1", "peer-r1"]);
  assert.ok(rej.contains(rows[1]!) && !rej.contains(rows[0]!));
  assert.ok(all(rows[1]!).some((n) => n.tag === "button" && n.textContent === "Pair"));
  assert.ok(!nodes.some((n) => n.tag === "button" && n.textContent === "Reject"));
});

test("after a Reject both sides can pair again: either side starts, both approve, then send works", async () => {
  for (const starter of ["rejected", "rejecter"] as const) {
    const { w, a, b } = await setup();
    await b.e.deny(a.id); // b rejected a
    const [n, x] = starter === "rejected" ? [a, b] : [b, a];
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
