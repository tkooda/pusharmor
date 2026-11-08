// The email code was accepted but the login then failed: line 1 says the login failed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { Rpc } from "../src/core/rpc.ts";
import { REQUEST_TOKEN } from "../src/core/login.ts";
import { Clock, FakePlatform, MockWorker, device, makeEngine } from "./harness.ts";

const DOWN = "The relay server is not working right now. Try again later.";

async function fresh(w: MockWorker, clock: Clock) {
  const p = new FakePlatform("chrome", w, clock);
  return { e: (await makeEngine(p, new IDBFactory(), clock)).e, p };
}

for (const [purpose, line] of [
  ["register", "Unable to log in."],
  ["login", "Unable to log in."],
  ["delete-account", "Unable to delete the account."],
] as const) {
  test("email code accepted, then the " + purpose + " step fails: " + line, async () => {
    const clock = new Clock();
    const w = new MockWorker(clock);
    // register runs on a new browser; log in and delete run on a registered one
    const { e, p } = purpose === "register" ? await fresh(w, clock) : await device(w, clock);
    const rpc = new Rpc(e);
    await p.storageSession.set({ [REQUEST_TOKEN]: { token: "t", purpose } });
    w.inject.push({ match: /POST \/v1\/auth\/email\/verify$/, status: 200, body: { ticket: "T".repeat(20), email: "a@b.com" }, times: 1 });
    w.inject.push({ match: /./, status: 500, body: { error: "internal" }, times: 99 });
    assert.deepEqual(await rpc.handle({ op: "emailVerify", args: { code: "ABCDEF" } }), { ok: false, error: line + "\n" + DOWN });
  });
}

test("a code the relay server does not take still says Unable to check the code", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const p = new FakePlatform("chrome", w, clock);
  const { e } = await makeEngine(p, new IDBFactory(), clock);
  await p.storageSession.set({ [REQUEST_TOKEN]: { token: "t", purpose: "login" } });
  w.inject.push({ match: /POST \/v1\/auth\/email\/verify$/, status: 500, body: { error: "internal" }, times: 3 });
  const r = await new Rpc(e).handle({ op: "emailVerify", args: { code: "ABCDEF" } });
  assert.deepEqual(r, { ok: false, error: "Unable to check the code.\n" + DOWN });
});
