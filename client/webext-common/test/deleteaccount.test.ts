// A failed account deletion says so on line 1, whichever way the user confirmed it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { Rpc } from "../src/core/rpc.ts";
import { AUTH_PENDING, REQUEST_TOKEN } from "../src/core/login.ts";
import { AUTH_RESULT } from "../src/model/signin.ts";
import { Clock, FakePlatform, MockWorker, makeEngine } from "./harness.ts";

const LINE = "Unable to delete the account.";
const DOWN = "The relay server is not working right now. Try again later.";
const BAD_LINK = "The login link is not valid. Request a new code and try again.";

async function setup(platform: "chrome" | "firefox") {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const p = new FakePlatform(platform, w, clock);
  const { e } = await makeEngine(p, new IDBFactory(), clock);
  return { w, p, rpc: new Rpc(e) };
}

test("delete account by email code: a failed check says Unable to delete the account", async () => {
  const { w, p, rpc } = await setup("chrome");
  await p.storageSession.set({ [REQUEST_TOKEN]: { token: "t", purpose: "delete-account" } });
  w.inject.push({ match: /POST \/v1\/auth\/email\/verify$/, status: 500, body: { error: "internal" }, times: 1 });
  assert.deepEqual(await rpc.handle({ op: "emailVerify", args: { code: "ABCDEF" } }), { ok: false, error: LINE + "\n" + DOWN });
});

test("delete account by Google or Apple: a failed login says Unable to delete the account", async () => {
  const { p, rpc } = await setup("chrome");
  p.authFlow = async () => {
    throw new Error("The user did not approve access.");
  };
  for (const provider of ["google", "apple"]) {
    const r = await rpc.handle({ op: "oauth", args: { provider, purpose: "delete-account" } });
    assert.deepEqual(r, { ok: false, error: LINE + "\nThe login window was closed. Try again." }, provider);
  }
});

test("delete account by Google or Apple in the login tab: the result says Unable to delete the account", async () => {
  const { p, rpc } = await setup("firefox");
  await p.storageSession.set({ [AUTH_PENDING]: { tabId: 7, purpose: "delete-account", until: p.now() + 60_000 } });
  const r = await rpc.handle({ op: "authDone", args: { hash: "ticket=bad" } }, 7);
  assert.deepEqual(r, { ok: false, error: LINE + "\n" + BAD_LINK });
  assert.equal(((await p.storageSession.get([AUTH_RESULT]))[AUTH_RESULT] as { error: string }).error, LINE + "\n" + BAD_LINK);
});
