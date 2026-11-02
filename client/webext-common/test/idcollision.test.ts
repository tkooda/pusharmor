import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { b64urlEncode } from "../src/crypto/b64url.ts";
import { ActionError, failText } from "../src/core/failtext.ts";
import { Login } from "../src/core/login.ts";
import { Rpc } from "../src/core/rpc.ts";
import { Clock, FakePlatform, MockWorker, makeEngine } from "./harness.ts";

// A 409 id collision: the ticket is bound to the key it was issued for, so it is never sent
// again; new keys are made and the login starts again for a fresh ticket.
test("id collision makes new keys and asks for a new ticket instead of resending the old one", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const bound = new Map<string, string>(); // ticket -> sign_pub it was issued for
  let collide = 1;
  let posts = 0;
  const handle = w.handle.bind(w);
  w.handle = async (url: string, init: RequestInit) => {
    if (new URL(url).pathname === "/v1/peers" && init.method === "POST") {
      posts++;
      const b = JSON.parse(init.body as string) as { ticket: string; sign_pub: string };
      if (bound.get(b.ticket) !== b.sign_pub) return new Response(JSON.stringify({ error: "invalid ticket" }), { status: 401 });
      if (collide-- > 0) return new Response(JSON.stringify({ error: "id collision" }), { status: 409 });
    }
    return handle(url, init);
  };
  const { e } = await makeEngine(new FakePlatform("chrome", w, clock), new IDBFactory(), clock);
  const login = new Login(e);
  const k1 = await e.signInKeys(); // what the email or Google step does before the ticket
  bound.set("ticket-one-0123456789", b64urlEncode(k1.sign_pub));
  const err = await login.complete("register", "ticket-one-0123456789", "a@b.com").then(
    () => assert.fail("expected a failure"),
    (x: unknown) => x,
  );
  assert.equal(failText("login", new ActionError("login", err)), "Unable to log in.\nTry again.");
  assert.equal(posts, 1); // the ticket is not sent again
  const k2 = (await e.db.self())!;
  assert.equal(k2.id, "");
  assert.notEqual(b64urlEncode(k2.sign_pub), b64urlEncode(k1.sign_pub));
  // the next login gets a ticket for the new keys and registers
  assert.equal(b64urlEncode((await e.signInKeys()).sign_pub), b64urlEncode(k2.sign_pub));
  bound.set("ticket-two-0123456789", b64urlEncode(k2.sign_pub));
  assert.deepEqual(await login.complete("register", "ticket-two-0123456789", "a@b.com"), { done: true });
  assert.equal(await e.regState(), "registered");
});

// The page starts the login again at its first step on a collision (the old ticket and the code
// are bound to the old keys); the reply carries that as a flag, the text stays "Try again."
test("id collision: the reply says Try again and asks the page to start the login again", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const handle = w.handle.bind(w);
  w.handle = async (url: string, init: RequestInit) => {
    if (new URL(url).pathname === "/v1/peers" && init.method === "POST") return new Response(JSON.stringify({ error: "id collision" }), { status: 409 });
    return handle(url, init);
  };
  const { e } = await makeEngine(new FakePlatform("chrome", w, clock), new IDBFactory(), clock);
  await e.signInKeys();
  const r = await new Rpc(e).handle({ op: "evict", args: { ticket: "ticket-one-0123456789", evict: ["x"] } });
  assert.deepEqual(r, { ok: false, error: "Unable to remove the chosen devices.\nTry again.", restart: true });
});
