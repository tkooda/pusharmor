// Firefox fallback mode without a push subscription: the setup tab.
import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { Db, openDb } from "../src/store/db.ts";
import { Clock, FakePlatform, MockWorker, device } from "./harness.ts";

const tabs: string[] = [];
(globalThis as { browser?: unknown }).browser = {
  runtime: { getManifest: () => ({ version: "0.0.19" }) },
  storage: { local: {}, session: {} },
  tabs: { create: async (t: { url: string }) => void tabs.push(t.url) },
};
const { firefoxPlatform, openSetup, SETUP_URL } = await import("../../firefox/src/platform-firefox.ts");

test("setup opens in a normal window, never in a private one", async () => {
  const b = (globalThis as unknown as { browser: Record<string, unknown> }).browser;
  const created: { url: string; windowId?: number }[] = [];
  const focused: number[] = [];
  const made: { url: string; incognito?: boolean }[] = [];
  let wins = [{ id: 1, incognito: false, focused: false }, { id: 2, incognito: true, focused: true }];
  const realTabs = b.tabs;
  b.tabs = { create: async (t: { url: string; windowId?: number }) => void created.push(t) };
  b.windows = {
    getAll: async () => wins,
    update: async (id: number) => void focused.push(id),
    create: async (p: { url: string; incognito?: boolean }) => void made.push(p),
  };
  try {
    await openSetup();
    assert.deepEqual(created, [{ url: SETUP_URL, active: true, windowId: 1 }]);
    assert.deepEqual(focused, [1]);
    wins = [{ id: 2, incognito: true, focused: true }]; // only a private window is open
    await openSetup();
    assert.deepEqual(made, [{ url: SETUP_URL, incognito: false, focused: true }]);
    assert.equal(created.length, 1);
  } finally {
    b.tabs = realTabs;
    delete b.windows;
  }
});

test("fallback without a subscription: setup opens at most once per state change, never when quiet", async () => {
  const db = new Db(await openDb(new IDBFactory()));
  await db.setMeta("receive_mode", "fallback");
  const p = firefoxPlatform({ isAndroid: false, autopush: () => null, db: async () => db });
  tabs.length = 0;
  await assert.rejects(p.pushSubscribe(new Uint8Array(65), true));
  assert.equal(tabs.length, 0); // quiet (popup open): no tab
  for (let i = 0; i < 3; i++) await assert.rejects(p.pushSubscribe(new Uint8Array(65)));
  assert.deepEqual(tabs, [SETUP_URL]); // once, not on every call
  await p.pushUnsubscribe(); // log out: a new state
  await db.setMeta("receive_mode", "fallback"); // the next login probes and falls back again
  await assert.rejects(p.pushSubscribe(new Uint8Array(65)));
  assert.equal(tabs.length, 2);
});

test("popup open reconciles push quietly; other paths do not", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock, "firefox");
  const seen: (boolean | undefined)[] = [];
  const orig = FakePlatform.prototype.pushSubscribe;
  a.p.sub = null;
  a.p.pushSubscribe = async function (this: FakePlatform, _v?: Uint8Array, quiet?: boolean) {
    seen.push(quiet);
    return orig.call(this, _v!);
  } as never;
  await a.e.onPopupOpen();
  assert.deepEqual(seen, [true]);
  a.p.sub = null;
  await a.e.pushReconcile(true); // push_missing in a signed reply
  assert.deepEqual(seen, [true, false]);
});

test("log out clears the saved receive mode so the next login takes the direct branch", async () => {
  const db = new Db(await openDb(new IDBFactory()));
  await db.setMeta("receive_mode", "fallback");
  const p = firefoxPlatform({ isAndroid: false, autopush: () => null, db: async () => db });
  await p.pushUnsubscribe();
  assert.equal(await db.meta("receive_mode"), undefined);
});
