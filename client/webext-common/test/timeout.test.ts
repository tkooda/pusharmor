// Stalled or offline network: requests time out and the popup never waits on them (I556).
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { Api, ApiError, FETCH_TIMEOUT_MS, errorText } from "../src/api/client.ts";
import { Rpc } from "../src/core/rpc.ts";
import { Clock, MockWorker, device } from "./harness.ts";

/** A fetch that never answers; it rejects only when its signal aborts. */
const stalled = (_i: string, init: RequestInit) =>
  new Promise<Response>((_r, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));

test("popup open returns the local state at once while the network is stalled (I556)", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  a.p.sub = null; // popup open re-subscribes and PATCHes
  const held: (() => void)[] = [];
  const real = a.p.fetch.bind(a.p);
  a.p.fetch = (_i, _init) => new Promise<Response>((_r, reject) => void held.push(() => reject(new Error("offline"))));
  const r = await Promise.race([new Rpc(a.e).handle({ op: "popupOpen" }), new Promise((ok) => setTimeout(() => ok("HUNG"), 1000))]);
  assert.notEqual(r, "HUNG");
  assert.equal((r as { ok: boolean }).ok, true);
  a.p.fetch = real; // let the background work finish
  for (const f of held) f();
});

test("a stalled request is aborted after the timeout and reads as a reachability error (I556)", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let t = 0;
    const api = new Api({ client: "chrome/0.0.19", fetch: stalled, now: () => t, sleep: async (ms) => void (t += ms), getOffset: async () => 0, setOffset: async () => undefined });
    const p = api.call("GET", "/peers", { noRetry: true });
    const seen = p.catch((e: unknown) => e);
    mock.timers.tick(FETCH_TIMEOUT_MS);
    const err = await seen;
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 0);
    assert.equal(errorText(err), "Could not reach the relay server. Check your connection.");
  } finally {
    mock.timers.reset();
  }
});
