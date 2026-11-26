import { mock, test } from "node:test";
import assert from "node:assert/strict";

// An offscreen document has only the runtime messaging APIs (no getManifest): the
// script must still load and answer the service worker's messages.
test("offscreen document: loads without runtime.getManifest and answers a message", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  type Listener = (msg: unknown, sender: unknown, respond: (r: unknown) => void) => boolean;
  const listeners: Listener[] = [];
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      onMessage: { addListener: (f: Listener) => listeners.push(f) },
      sendMessage: async () => undefined,
    },
  };
  try {
    await import("../../chrome/src/offscreen.ts");
    assert.equal(listeners.length, 1, "the message listener is registered");
    let reply: unknown;
    const async = listeners[0]!({ target: "offscreen", req: { op: "idle" } }, {}, (r) => (reply = r));
    assert.equal(async, false);
    assert.deepEqual(reply, { idle: false });
  } finally {
    mock.timers.reset();
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  }
});
