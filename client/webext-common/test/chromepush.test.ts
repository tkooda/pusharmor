import assert from "node:assert/strict";
import { test } from "node:test";
import { subscribeRecovering } from "../../chrome/src/platform-chrome.ts";
import { PushRefused } from "../src/platform.ts";

// Chrome-like PushManager: subscribe returns the stored subscription for the same key and
// throws InvalidStateError when a subscription with a different key exists.
class FakePM {
  sub: { endpoint: string; key: string; getKey(): ArrayBuffer; unsubscribe(): Promise<boolean> } | null = null;
  n = 0;
  async getSubscription() {
    return this.sub;
  }
  async subscribe(o: { applicationServerKey: Uint8Array }) {
    const key = Array.from(o.applicationServerKey).join(",");
    if (this.sub && this.sub.key !== key) throw new DOMException("different key", "InvalidStateError");
    if (this.sub) return this.sub;
    const s = {
      endpoint: "https://fcm.googleapis.com/fcm/send/e" + ++this.n,
      key,
      getKey: () => new Uint8Array([1]).buffer,
      unsubscribe: async () => {
        if (this.sub === s) this.sub = null;
        return true;
      },
    };
    this.sub = s;
    return s;
  }
}

test("chrome push: a subscription with another key is dropped and the subscribe succeeds once more", async () => {
  const pm = new FakePM();
  const a = await subscribeRecovering(pm, new Uint8Array([1]), false);
  const b = await subscribeRecovering(pm, new Uint8Array([2]), false);
  assert.notEqual(a.endpoint, b.endpoint);
  assert.equal(pm.sub, b);
});

test("chrome push: fresh asks for a new endpoint, not fresh keeps the current one", async () => {
  const pm = new FakePM();
  const v = new Uint8Array([1]);
  const a = await subscribeRecovering(pm, v, false);
  assert.equal((await subscribeRecovering(pm, v, false)).endpoint, a.endpoint);
  assert.notEqual((await subscribeRecovering(pm, v, true)).endpoint, a.endpoint);
});

test("chrome push: a subscribe the browser refuses is a PushRefused", async () => {
  const pm = new FakePM();
  pm.subscribe = async () => {
    throw new DOMException("Registration failed - push service not available", "AbortError");
  };
  await assert.rejects(subscribeRecovering(pm, new Uint8Array([1]), false), PushRefused);
});
