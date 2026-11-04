// History holds no device status rows: logged in, logged out, and rejected show as notifications only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Rpc } from "../src/core/rpc.ts";
import type { HistoryRow } from "../src/store/db.ts";
import { Clock, MockWorker, deliver, device, pairAndApprove } from "./harness.ts";

test("History lists no device status: a reject stores no row, and a stored status row stays unlisted", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const b = await device(w, clock);
  await pairAndApprove(w, a, b);
  await b.e.deny(a.id);
  await deliver(w, a);
  assert.deepEqual((await a.db.history()).filter((r) => r.type === "event"), []);
  // a row an older version stored: kept in the database, left out of the list
  await a.db.addHistory({ dir: "in", peer: b.id, peer_name: null, type: "event", event: "logged_out", content: "", n: null, pairing_id: null, received: clock.t, read: true, count: 1 } as HistoryRow);
  await a.db.addHistory({ dir: "in", peer: b.id, peer_name: null, type: "text", content: "hi", n: 9, pairing_id: null, received: clock.t + 1, read: true } as HistoryRow);
  const listed = await new Rpc(a.e).history();
  assert.deepEqual(listed.map((r) => r.type), ["text"]);
  assert.equal((await a.db.history()).filter((r) => r.type === "event").length, 1);
});

test("a device status notice opens Devices at that device, since History has no row for it", async () => {
  const { clickTarget } = await import("../src/core/actions.ts");
  const clock = new Clock();
  const a = await device(new MockWorker(clock), clock);
  assert.deepEqual(await clickTarget(a.e, "d:abc"), { page: "#peers=abc" });
});
