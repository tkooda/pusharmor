import assert from "node:assert/strict";
import { test } from "node:test";
import { Autopush, type ApState, type SocketLike } from "../../firefox/src/autopush/client.ts";
import type { WebPushKeys } from "../src/crypto/rfc8291.ts";

class FakeSocket implements SocketLike {
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.closed = true;
    this.onclose?.({ code: 1000 });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

function setup() {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let state: ApState = { uaid: null, channelID: null, endpoint: null };
  let keys: WebPushKeys | null = null;
  const modes: string[] = [];
  let reachable: (v: boolean) => void = () => undefined;
  let t = 1_000_000;
  const ap = new Autopush({
    socket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    vapidPub: new Uint8Array(65).fill(4),
    loadState: async () => state,
    saveState: async (s) => {
      state = s;
    },
    loadKeys: async () => keys,
    saveKeys: async (k) => {
      keys = k;
    },
    deliver: async () => undefined,
    onEndpoint: async () => undefined,
    onMode: async (m) => {
      modes.push(m);
    },
    loadMode: async () => "direct",
    workerReachable: () => new Promise<boolean>((r) => (reachable = r)),
    now: () => t,
    setTimer: (fn, ms) => {
      const x = { fn, ms };
      timers.push(x);
      return x;
    },
    clearTimer: (x) => {
      const i = timers.indexOf(x as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
    uuid: () => "chan-1",
  });
  return { ap, sockets, timers, modes, resolveReachable: (v: boolean) => reachable(v), advance: (ms: number) => (t += ms) };
}

// Fail once, wait past the fallback limit, and fail again: failed() now awaits workerReachable.
async function failPastLimit(s: ReturnType<typeof setup>) {
  await s.ap.start();
  s.sockets[0]!.onclose!({ code: 1006 });
  await tick();
  s.advance(31 * 60_000);
  s.timers.pop()!.fn();
  s.sockets[1]!.onclose!({ code: 1006 });
  await tick();
}

test("autopush: stop during the relay server check saves no mode and opens no socket", async () => {
  const s = setup();
  await failPastLimit(s);
  s.ap.stop();
  s.resolveReachable(true);
  await tick();
  assert.deepEqual(s.modes, []);
  assert.equal(s.timers.length, 0);
  const n = s.sockets.length;
  for (const x of s.timers.splice(0)) x.fn();
  assert.equal(s.sockets.length, n);
});

test("autopush: stop during the relay server check arms no retry when the relay server is not reachable", async () => {
  const s = setup();
  await failPastLimit(s);
  s.ap.stop();
  s.resolveReachable(false);
  await tick();
  assert.equal(s.timers.length, 0);
});
