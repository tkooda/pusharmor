import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { Rpc } from "../src/core/rpc.ts";
import { knownChromeId } from "../src/model/signin.ts";
import { Clock, FakePlatform, MockWorker, makeEngine } from "./harness.ts";

const LINES = "Google login is not available in this copy of PushArmor\nUse email login, or install PushArmor from the Chrome Web Store or GitHub";

test("Chrome: a copy with an unknown extension id shows why Google login is off and never starts the flow", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const p = new FakePlatform("chrome", w, clock);
  const { e } = await makeEngine(p, new IDBFactory(), clock);
  const rpc = new Rpc(e);
  let flows = 0;
  p.authFlow = async () => {
    flows++;
    throw new Error("The user did not approve access.");
  };
  p.chromeIdKnown = false;
  const r = await rpc.handle({ op: "oauth", args: { provider: "google", purpose: "register" } });
  assert.deepEqual([r.ok, r.error], [false, LINES]);
  assert.equal(flows, 0);
  await rpc.handle({ op: "oauth", args: { provider: "apple", purpose: "register" } });
  assert.equal(flows, 1); // Apple is not changed
  p.chromeIdKnown = true;
  await rpc.handle({ op: "oauth", args: { provider: "google", purpose: "register" } });
  assert.equal(flows, 2);
});

test("Chrome: the known ids are the public and Beta store ids from release/public.json, put in by the build", () => {
  const pub = JSON.parse(readFileSync(new URL("../../../release/public.json", import.meta.url), "utf8"));
  const known = [pub.google_chrome_extension_id, pub.google_chrome_beta_extension_id];
  assert.equal(knownChromeId("eglfppbcdpmgpnckkgcjcmmbknjgeihd", known), true);
  assert.equal(knownChromeId(pub.google_chrome_beta_extension_id, known), true);
  assert.equal(knownChromeId("abcdefghijklmnopabcdefghijklmnop", known), false);
  assert.match(readFileSync(new URL("../build.mjs", import.meta.url), "utf8"), /CHROME_EXTENSION_IDS: JSON\.stringify\(\["google_chrome_extension_id", "google_chrome_beta_extension_id"\]\.map\(value\)/);
  assert.match(readFileSync(new URL("../../chrome/src/platform-chrome.ts", import.meta.url), "utf8"), /p\.chromeIdKnown = knownChromeId\(browser\.runtime\.id, CHROME_EXTENSION_IDS\);/);
});

test("Chrome: a redirect URL a Chromium build rewrote stops Google and Apple login before the flow; the normal form passes", async () => {
  const { chromiumRedirectOk } = await import("../src/model/signin.ts");
  const good = "https://eglfppbcdpmgpnckkgcjcmmbknjgeihd.chromiumapp.org/";
  const bad = "https://eglfppbcdpmgpnckkgcjcmmbknjgeihd.ch40m1umapp.qjz9zk/";
  assert.equal(chromiumRedirectOk(good), true);
  for (const u of [bad, "http://eglfppbcdpmgpnckkgcjcmmbknjgeihd.chromiumapp.org/", "https://eglfppbcdpmgpnckkgcjcmmbknjgeihz.chromiumapp.org/", good + "x"]) assert.equal(chromiumRedirectOk(u), false, u);
  const clock = new Clock();
  const w = new MockWorker(clock);
  const p = new FakePlatform("chrome", w, clock);
  const { e } = await makeEngine(p, new IDBFactory(), clock);
  const rpc = new Rpc(e);
  let flows = 0;
  p.authFlow = async () => {
    flows++;
    throw new Error("The user did not approve access.");
  };
  let redirect = bad;
  (p as unknown as { authRedirect: () => string }).authRedirect = () => redirect;
  p.chromeIdKnown = false; // the rewritten host is the reason given, not the extension id
  let r = await rpc.handle({ op: "oauth", args: { provider: "google", purpose: "register" } });
  assert.deepEqual([r.ok, r.error], [false, "Google login is not available in this browser\nUse email login"]);
  r = await rpc.handle({ op: "oauth", args: { provider: "apple", purpose: "register" } });
  assert.deepEqual([r.ok, r.error], [false, "Apple login is not available in this browser\nUse email login"]);
  assert.equal(flows, 0);
  redirect = good; // the normal form: an unknown id still gets its own text, Apple starts
  r = await rpc.handle({ op: "oauth", args: { provider: "google", purpose: "register" } });
  assert.deepEqual([r.ok, r.error], [false, LINES]);
  await rpc.handle({ op: "oauth", args: { provider: "apple", purpose: "register" } });
  assert.equal(flows, 1);
});
