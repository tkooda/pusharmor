// A failed device action names the device the same way its row in the list does.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Rpc } from "../src/core/rpc.ts";
import { Clock, MockWorker, deliver, device, pairAndApprove } from "./harness.ts";

test("a failed action on a device with no name uses the row label in line 1", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const b = await device(w, clock, "firefox");
  await pairAndApprove(w, a, b);
  await deliver(w, b);
  const row = (await a.db.peer(b.id))!;
  const db = a.db as unknown as Record<string, unknown>;
  db.peer = async () => ({ ...row, name: null });
  (a.e as unknown as Record<string, unknown>).pairStart = async () => {
    throw new DOMException("quota", "QuotaExceededError");
  };
  const label = "Firefox, added " + new Date(row.created * 1000).toISOString().slice(0, 10);
  const r = await new Rpc(a.e).handle({ op: "pair", args: { id: b.id } });
  assert.equal(r.error, 'Unable to pair with "' + label + '".\nStorage is full. Free some space and try again.');
});
