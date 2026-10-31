// Firefox fallback mode without a push subscription: the setup tab (I555).
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
const { firefoxPlatform, SETUP_URL } = await import("../../firefox/src/platform-firefox.ts");

test("fallback without a subscription: setup opens at most once per state change, never when quiet (I555)", async () => {
  const db = new Db(await openDb(new IDBFactory()));
  await db.setMeta("receive_mode", "fallback");
  const p = firefoxPlatform({ isAndroid: false, autopush: () => null, db: async () => db });
  tabs.length = 0;
  await assert.rejects(p.pushSubscribe(new Uint8Array(65), true));
  assert.equal(tabs.length, 0); // quiet (popup open): no tab
  for (let i = 0; i < 3; i++) await assert.rejects(p.pushSubscribe(new Uint8Array(65)));
  assert.deepEqual(tabs, [SETUP_URL]); // once, not on every call
  await p.pushUnsubscribe(); // log out: a new state
  await assert.rejects(p.pushSubscribe(new Uint8Array(65)));
  assert.equal(tabs.length, 2);
});

test("popup open reconciles push quietly; other paths do not (I555)", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock, "firefox");
  const seen: (boolean | undefined)[] = [];
  const orig = FakePlatform.prototype.pushSubscribe;
  a.p.sub = null;
  a.p.pushSubscribe = async function (this: FakePlatform, _v?: Uint8Array, quiet?: boolean) {
    seen.push(quiet);
    return orig.call(this);
  } as never;
  await a.e.onPopupOpen();
  assert.deepEqual(seen, [true]);
  a.p.sub = null;
  await a.e.pushReconcile(true); // push_missing in a signed reply
  assert.deepEqual(seen, [true, false]);
});
