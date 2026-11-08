// No reply: a pairing step the other device did not answer within 2 minutes shows an error with Try again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { T } from "../src/core/texts.ts";
import { Rpc } from "../src/core/rpc.ts";
import { getEntry } from "../src/core/state.ts";
import { NO_REPLY_MS } from "../src/model/pairdecide.ts";
import { Clock, MockWorker, deliver, device, refresh, restart } from "./harness.ts";

const posts = (w: MockWorker, to: string, k: string) => w.calls.filter((c) => c.method === "POST" && c.path === "/v1/pair/" + to && (c.body as { k: string }).k === k).length;

async function setup() {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const b = await device(w, clock);
  await refresh(a, b);
  return { clock, w, a, b };
}

const row = async (d: { e: unknown }, id: string) => (await new Rpc(d.e as never).peers()).peers.find((p) => p.id === id)!;

test("no reply: N committed is plain waiting at 1:59, the error at 2:00, also after a restart", async () => {
  const { w, a, b, clock } = await setup();
  await a.e.pairStart(b.id);
  w.take(b.id); // the commit never reaches the other device
  const label = (await row(a, b.id)).label;
  clock.t += NO_REPLY_MS - 1000;
  let v = await row(a, b.id);
  assert.equal(v.lines[0], T.pairingWith(label));
  assert.ok(!v.actions.includes("try_again"));
  clock.t += 1000;
  v = await row(a, b.id);
  assert.deepEqual(v.lines, ['No reply from "' + label + '"', "Check that notifications are on for PushArmor on both devices, then try again"]);
  assert.ok(v.actions.includes("try_again") && !v.actions.includes("send_again"));
  const a2 = await restart(a, clock);
  assert.deepEqual((await row(a2, b.id)).lines, v.lines);
});

test("no reply: X replied shows the error at 2:00 after the automatic reply", async () => {
  const { w, a, b, clock } = await setup();
  await a.e.pairStart(b.id);
  await deliver(w, b);
  w.take(a.id); // the reply never reaches N
  assert.equal((await getEntry(b.p.storageLocal, a.id))!.state, "replied");
  clock.t += NO_REPLY_MS - 1000;
  assert.deepEqual((await row(b, a.id)).lines, [T.pairing]);
  clock.t += 1000;
  const v = await row(b, a.id);
  assert.equal(v.lines.length, 2);
  assert.match(v.lines[0]!, /^No reply from ".+"$/);
  assert.ok(v.actions.includes("try_again"));
});

test("Try again: resends inside the 60 s Send again wait, starts a new window, row back to waiting", async () => {
  const { w, a, b, clock } = await setup();
  await a.e.pairStart(b.id);
  w.take(b.id);
  clock.t += NO_REPLY_MS - 30_000;
  await a.e.resendWaiting(); // automatic resend: last send now 30 s before the error
  clock.t += 30_000;
  assert.ok((await row(a, b.id)).actions.includes("try_again")); // the automatic resend kept the window
  const before = posts(w, b.id, "commit");
  assert.equal((await new Rpc(a.e).handle({ op: "tryAgain", args: { id: b.id } })).ok, true);
  assert.equal(posts(w, b.id, "commit"), before + 1);
  assert.equal((await getEntry(a.p.storageLocal, b.id))!.wait_from, clock.t);
  const v = await row(a, b.id);
  assert.ok(v.lines[0]!.startsWith("Pairing with"));
  assert.ok(!v.actions.includes("try_again"));
  clock.t += NO_REPLY_MS;
  assert.ok((await row(a, b.id)).actions.includes("try_again"));
});

test("Try again on X replied sends the stored reply again", async () => {
  const { w, a, b, clock } = await setup();
  await a.e.pairStart(b.id);
  await deliver(w, b);
  w.take(a.id);
  clock.t += NO_REPLY_MS;
  const before = posts(w, a.id, "reply");
  await b.e.pairTryAgain(a.id);
  assert.equal(posts(w, a.id, "reply"), before + 1);
  assert.deepEqual((await row(b, a.id)).lines, [T.pairing]);
});

test("still holds an earlier pairing keeps precedence over no reply", async () => {
  const { w, a, b, clock } = await setup();
  await a.e.pairStart(b.id);
  w.take(b.id);
  await a.db.put("peers", { ...(await a.db.peer(b.id))!, approves_me: true });
  clock.t += NO_REPLY_MS;
  const v = (await a.e.pairRowView(b.id))!;
  assert.ok(v.lines[0]!.startsWith("Pairing with"));
  assert.ok(v.actions.includes("send_again") && !v.actions.includes("try_again"));
});
