import assert from "node:assert/strict";
import { test } from "node:test";
import { lazyBoot, onRuntimeMessage, uiEnv } from "../src/shellkit.ts";

test("openPage: an open tab on the same page is focused and reloaded", async () => {
  const log: string[] = [];
  const url = "chrome-extension://x/page.html#signin";
  const b = {
    runtime: {
      getURL: (p: string) => "chrome-extension://x/" + p,
      getContexts: async () => [{ documentUrl: url, tabId: 7, windowId: 3 }],
      getManifest: () => ({ name: "PushArmor" }),
    },
    tabs: {
      update: async (id: number) => void log.push("update " + id),
      reload: async (id: number) => void log.push("reload " + id),
      create: async () => void log.push("create"),
    },
    windows: { update: async (id: number) => void log.push("window " + id) },
  };
  await uiEnv(b as never).openPage("#signin");
  assert.deepEqual(log, ["update 7", "window 3", "reload 7"]);
});

test("a failed database open does not stick: the next call tries again, the caller gets an error reply", async () => {
  assert.equal(typeof (globalThis as { indexedDB?: unknown }).indexedDB, "undefined"); // node: the open fails
  const boot = lazyBoot(() => ({}) as never, new Uint8Array(0));
  const first = boot();
  await assert.rejects(first);
  const second = boot();
  assert.notEqual(second, first); // a rejected promise is not cached
  await assert.rejects(second);
  const reply = await new Promise<{ ok?: boolean; error?: string }>((resolve) => {
    onRuntimeMessage(boot)({ op: "state" }, {} as never, resolve as never);
  });
  assert.equal(reply.ok, false);
  assert.match(reply.error ?? "", /database/i);
});

test("a start that fails after the database opened closes the connection", async () => {
  const { IDBFactory, IDBDatabase } = await import("fake-indexeddb");
  const g = globalThis as { indexedDB?: unknown };
  const saved = g.indexedDB;
  g.indexedDB = new IDBFactory();
  let closed = 0;
  const orig = IDBDatabase.prototype.close;
  IDBDatabase.prototype.close = function (this: InstanceType<typeof IDBDatabase>) {
    closed++;
    return orig.call(this);
  };
  try {
    const boot = lazyBoot(() => ({ storageLocal: { get: () => Promise.reject(new Error("boom")), set: async () => undefined } }) as never, new Uint8Array(0));
    await assert.rejects(boot(), /boom/);
    await assert.rejects(boot(), /boom/);
    assert.equal(closed, 2); // one per failed try
  } finally {
    IDBDatabase.prototype.close = orig;
    g.indexedDB = saved;
  }
});
