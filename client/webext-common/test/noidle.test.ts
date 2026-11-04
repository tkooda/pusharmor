// No polling: an open Devices view makes no relay server call while it sits idle.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { N } from "./fakedom.ts";
import { Rpc } from "../src/core/rpc.ts";
import type { UiEnv } from "../src/ui/dom.ts";
import { renderPeers } from "../src/ui/peersview.ts";
import { Clock, MockWorker, device, pairAndApprove } from "./harness.ts";

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

test("an open Devices view makes no relay server call over 10 idle minutes", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const b = await device(w, clock);
  await pairAndApprove(w, a, b);
  const rpc = new Rpc(a.e);
  const env = { call: (r: { op: string }) => rpc.handle(r) } as unknown as UiEnv;
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const root = Object.assign(new N("div"), { isConnected: true });
    await renderPeers(env, root as unknown as HTMLElement, true);
    await settle();
    const before = w.calls.length;
    const alarms = new Map(a.p.alarms);
    for (let s = 0; s < 600; s += 3) {
      clock.t += 3000;
      mock.timers.tick(3000);
      await settle();
    }
    assert.deepEqual(w.calls.slice(before), []);
    assert.deepEqual(a.p.alarms, alarms); // and no alarm set for later
    root.isConnected = false;
    mock.timers.tick(3000);
  } finally {
    mock.timers.reset();
  }
});
