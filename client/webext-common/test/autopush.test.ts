import assert from "node:assert/strict";
import { test } from "node:test";
import { Autopush, type ApState, type SocketLike } from "../../firefox/src/autopush/client.ts";
import { b64urlEncode } from "../src/crypto/b64url.ts";
import { buf, concat } from "../src/crypto/bytes.ts";
import { rfc8291Derive, type WebPushKeys } from "../src/crypto/rfc8291.ts";

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
  async rx(f: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(f) });
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function encrypt(k: WebPushKeys, text: string): Promise<string> {
  const as = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: k.ecdh.publicKey }, as.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const d = await rfc8291Derive(ecdh, k.auth, k.p256dh, asPub, salt);
  const key = await crypto.subtle.importKey("raw", buf(d.cek), "AES-GCM", false, ["encrypt"]);
  const pt = concat(new TextEncoder().encode(text), new Uint8Array([2]));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(d.nonce) }, key, buf(pt)));
  return b64urlEncode(concat(salt, new Uint8Array([0, 0, 16, 0, 65]), asPub, ct));
}

function setup() {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let state: ApState = { uaid: null, channelID: null, endpoint: null };
  let keys: WebPushKeys | null = null;
  const delivered: string[] = [];
  const endpoints: string[] = [];
  const modes: string[] = [];
  let t = 1_000_000;
  let n = 0;
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
    deliver: async (m) => {
      delivered.push(m);
    },
    onEndpoint: async (p) => {
      endpoints.push(p.endpoint);
    },
    onMode: async (m) => {
      modes.push(m);
    },
    workerReachable: async () => true,
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
    uuid: () => "chan-" + ++n,
  });
  return { ap, sockets, timers, delivered, endpoints, modes, keys: () => keys!, advance: (ms: number) => (t += ms) };
}

test("autopush: hello, register, notification decrypt and ack, dedupe, decrypt error 101, unknown channel", async () => {
  const s = setup();
  await s.ap.start();
  const ws = s.sockets[0]!;
  ws.onopen!();
  assert.deepEqual(ws.sent[0], { messageType: "hello", uaid: "", channelIDs: [], use_webpush: true, broadcasts: {} });
  await ws.rx({ messageType: "hello", status: 200, uaid: "U1" });
  assert.equal(ws.sent[1]!.messageType, "register");
  assert.equal(ws.sent[1]!.key, b64urlEncode(new Uint8Array(65).fill(4)));
  // an endpoint that is not key-bound (/wpush/v1/) is registered again
  await ws.rx({ messageType: "register", status: 200, channelID: "chan-1", pushEndpoint: "https://updates.push.services.mozilla.com/wpush/v1/x" });
  assert.equal(ws.sent[2]!.messageType, "register");
  await ws.rx({ messageType: "register", status: 200, channelID: "chan-2", pushEndpoint: "https://updates.push.services.mozilla.com/wpush/v2/x" });
  assert.deepEqual(s.endpoints, ["https://updates.push.services.mozilla.com/wpush/v2/x"]);
  const data = await encrypt(s.keys(), "M-STRING");
  await ws.rx({ messageType: "notification", channelID: "chan-2", version: "v1", data, headers: { encoding: "aes128gcm" } });
  assert.deepEqual(s.delivered, ["M-STRING"]);
  assert.deepEqual(ws.sent.at(-1), { messageType: "ack", updates: [{ channelID: "chan-2", version: "v1", code: 100 }] });
  await ws.rx({ messageType: "notification", channelID: "chan-2", version: "v1", data, headers: {} });
  assert.equal(s.delivered.length, 1); // dedupe on version
  await ws.rx({ messageType: "notification", channelID: "chan-2", version: "v2", data: data.slice(0, -4) + "AAAA", headers: {} });
  assert.deepEqual(ws.sent.at(-1), { messageType: "ack", updates: [{ channelID: "chan-2", version: "v2", code: 101 }] });
  await ws.rx({ messageType: "notification", channelID: "other", version: "v3", data, headers: {} });
  assert.deepEqual(ws.sent.slice(-2), [
    { messageType: "ack", updates: [{ channelID: "other", version: "v3", code: 100 }] },
    { messageType: "unregister", channelID: "other" },
  ]);
});

test("autopush: backoff 5 s * 2^k, fallback after 30 min of failures, 4774 switches at once", async () => {
  const s = setup();
  await s.ap.start();
  s.sockets[0]!.onclose!({ code: 1006 });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(s.timers.at(-1)!.ms, 5000);
  s.timers.pop()!.fn();
  s.sockets[1]!.onclose!({ code: 1006 });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(s.timers.at(-1)!.ms, 10000);
  s.advance(31 * 60_000);
  s.timers.pop()!.fn();
  s.sockets[2]!.onclose!({ code: 1006 });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(s.modes, ["fallback"]);
  // hourly probe: a good hello switches back to direct
  assert.equal(s.timers.at(-1)!.ms, 60 * 60_000);
  s.timers.pop()!.fn();
  const probe = s.sockets[3]!;
  probe.onopen!();
  await probe.rx({ messageType: "hello", status: 200, uaid: "U9" });
  assert.deepEqual(s.modes, ["fallback", "direct"]);

  const s2 = setup();
  await s2.ap.start();
  s2.sockets[0]!.onclose!({ code: 4774 });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(s2.modes, ["fallback"]);
});
