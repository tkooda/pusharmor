import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { browserDefaultName } from "../src/core/texts.ts";
import { Clock, FakePlatform, MockWorker, makeEngine } from "./harness.ts";

test("a new browser's default name is <Browser> on <OS> from getPlatformInfo; other systems get just the browser", () => {
  assert.equal(browserDefaultName("chrome", "mac"), "Chrome on Mac");
  assert.equal(browserDefaultName("chrome", "win"), "Chrome on Windows");
  assert.equal(browserDefaultName("chrome", "linux"), "Chrome on Linux");
  assert.equal(browserDefaultName("chrome", "cros"), "Chrome on ChromeOS");
  assert.equal(browserDefaultName("firefox", "android"), "Firefox on Android");
  for (const os of ["openbsd", "fuchsia", "other", "", null, undefined]) assert.equal(browserDefaultName("firefox", os), "Firefox");
});

async function fresh(name: "chrome" | "firefox", os: string | null) {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const p = new FakePlatform(name, w, clock);
  if (os !== null) (p as FakePlatform & { platformOs(): Promise<string> }).platformOs = async () => os;
  const { e, db } = await makeEngine(p, new IDBFactory(), clock);
  return { e, db };
}

test("a new setup takes the <Browser> on <OS> default; a device that registered before keeps its name", async () => {
  const a = await fresh("chrome", "mac");
  assert.equal(await a.e.register("T", "a@b.com"), null);
  assert.equal(await a.e.myName(), "Chrome on Mac");
  const b = await fresh("firefox", "android");
  await b.e.register("T", "a@b.com");
  assert.equal(await b.e.myName(), "Firefox on Android");
  // a device set up before this version (no default saved) keeps "Chrome", also when it registers again
  const c = await fresh("chrome", "win");
  await c.e.register("T", "a@b.com");
  await c.db.del("meta", "default_name");
  assert.equal(await c.e.myName(), "Chrome");
  await c.e.register("T", "a@b.com");
  assert.equal(await c.e.myName(), "Chrome");
  // a saved name is never changed
  const d = await fresh("chrome", "linux");
  await d.db.setMeta("my_name", "Work");
  await d.e.register("T", "a@b.com");
  assert.equal(await d.e.myName(), "Work");
});
