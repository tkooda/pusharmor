// Several accounts on one device: one is active, the others are archived with their keys,
// devices, history, and settings, and a login for another account switches to it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { ApiError } from "../src/api/client.ts";
import { b64urlEncode } from "../src/crypto/b64url.ts";
import type { Engine } from "../src/core/engine.ts";
import { failText } from "../src/core/failtext.ts";
import { Login, type Purpose, REQUEST_TOKEN } from "../src/core/login.ts";
import { Rpc } from "../src/core/rpc.ts";
import { ALLOW_SET, REG_MARKER, UPDATE_NEEDED } from "../src/core/state.ts";
import { SEND_SEL_KEY } from "../src/model/sendsel.ts";
import { Db, type HistoryRow, newPeerRow, openDb } from "../src/store/db.ts";
import { Clock, FakePlatform, MockWorker, makeEngine } from "./harness.ts";

const ACCT: Record<string, Uint8Array<ArrayBuffer>> = { "a@x.com": new Uint8Array(9).fill(0x11), "b@x.com": new Uint8Array(9).fill(0x22) };
const acctId = (email: string) => b64urlEncode(ACCT[email]!);

/** The mock Worker plus the login routes: each ticket belongs to the account of its email. */
function relay(clock: Clock) {
  const w = new MockWorker(clock);
  const tickets = new Map<string, string>(); // ticket -> email
  let next = 0;
  const issue = (email: string) => {
    const t = "ticket-" + String(++next).padStart(10, "0");
    tickets.set(t, email);
    return t;
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const handle = w.handle.bind(w);
  w.handle = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = typeof init.body === "string" && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (path === "/v1/auth/email") return json(200, { request_token: "rt:" + String(body.email) });
    if (path === "/v1/auth/email/verify") {
      const email = String(body.request_token).slice(3);
      return json(200, { ticket: issue(email), email });
    }
    const email = tickets.get(String(body.ticket ?? ""));
    if (path === "/v1/peers" && init.method === "POST" && email) w.account = ACCT[email]!;
    const m = /^\/v1\/peers\/([^/]+)\/login$/.exec(path);
    if (m && email && !m[1]!.startsWith(acctId(email))) {
      w.calls.push({ method: "POST", path, body, client: null });
      return json(401, { error: "account mismatch", account: acctId(email) });
    }
    return handle(url, init);
  };
  return { w, issue };
}

async function setup() {
  const clock = new Clock();
  const { w, issue } = relay(clock);
  const p = new FakePlatform("chrome", w, clock);
  const factory = new IDBFactory();
  const { e, db } = await makeEngine(p, factory, clock);
  return { clock, w, issue, p, e, db, factory, login: new Login(e), rpc: new Rpc(e) };
}

/** Email login as the page does it: the page's purpose may be stale. */
async function emailLogin(login: Login, email: string, pagePurpose: Purpose) {
  await login.emailStart(email, "ts", pagePurpose);
  return login.emailVerify("ABCDEF");
}

/** The provider window comes back with this redirect. */
function setAuthFlow(p: FakePlatform, f: () => Promise<string | null>) {
  (p as { authFlow: () => Promise<string | null> }).authFlow = f;
}

function row(content: string): HistoryRow {
  return { dir: "in", peer: null, type: "text", content, n: null, pairing_id: null, received: 1, read: true };
}

/** Account rows of every kind, so a switch must carry each one. */
async function addState(e: Engine, db: Db, p: FakePlatform, tag: string) {
  await e.setSettings({ autoOpen: true, historyDays: 7 });
  await db.addHistory(row("hello " + tag));
  await db.put("peers", newPeerRow("PEER" + tag, new Uint8Array(32), new Uint8Array(32), "android", 1));
  await db.setMeta("my_name", "Laptop " + tag);
  await p.storageLocal.set({ ["pair:PEER" + tag]: { role: "N", state: "committed" }, [ALLOW_SET]: ["PEER" + tag], [SEND_SEL_KEY]: ["PEER" + tag] });
}

async function readArchiveSelf(factory: IDBFactory, account: string) {
  const a = new Db(await openDb(factory, "pusharmor-acct-" + account), factory);
  try {
    return await a.self();
  } finally {
    a.db.close();
  }
}

test("email login: A, then B with new keys, then A again brings back A's keys, devices, history, and settings", async () => {
  const { e, db, p, login, factory } = await setup();
  assert.deepEqual(await emailLogin(login, "a@x.com", await login.purpose()), { done: true });
  const a = (await e.self())!;
  assert.ok(a.id.startsWith(acctId("a@x.com")));
  await addState(e, db, p, "A");
  await e.logout();

  // the page still says "login" (A is logged out): the typed address picks a new account
  assert.deepEqual(await emailLogin(login, "b@x.com", "login"), { done: true });
  const b = (await e.self())!;
  assert.ok(b.id.startsWith(acctId("b@x.com")));
  assert.notEqual(b64urlEncode(b.sign_pub), b64urlEncode(a.sign_pub));
  assert.equal(await e.regState(), "registered");
  assert.equal(await e.email(), "b@x.com");
  assert.deepEqual(await db.history(), []);
  assert.equal(await db.peer("PEERA"), undefined);
  assert.equal((await e.settings()).autoOpen, false);
  assert.equal((await p.storageLocal.get(["pair:PEERA"]))["pair:PEERA"], undefined);
  await addState(e, db, p, "B");
  await e.logout();

  // A's address switches back to A at once; its pairing entries come back with it
  await login.emailStart("a@x.com", "ts", "login");
  const local = await p.storageLocal.get(null);
  assert.ok(local["pair:PEERA"]);
  assert.equal(local["pair:PEERB"], undefined);
  assert.deepEqual(local[SEND_SEL_KEY], ["PEERA"]);
  assert.deepEqual((local[REG_MARKER] as { id: string }).id, a.id);
  assert.deepEqual(await login.emailVerify("ABCDEF"), { done: true });
  const back = (await e.self())!;
  assert.equal(back.id, a.id);
  assert.equal(b64urlEncode(back.sign_pub), b64urlEncode(a.sign_pub));
  assert.equal(await e.regState(), "registered");
  assert.deepEqual((await db.history()).map((r) => r.content), ["hello A"]);
  assert.ok(await db.peer("PEERA"));
  assert.equal(await db.peer("PEERB"), undefined);
  assert.equal(await e.myName(), "Laptop A");
  assert.deepEqual(await e.settings(), { showAll: true, autoOpen: true, historyDays: 7, allowContent: true });

  // B is archived intact; A's archive is gone (A is active)
  assert.deepEqual(await e.accounts(), { [acctId("b@x.com")]: "b@x.com" });
  assert.equal((await readArchiveSelf(factory, acctId("b@x.com")))!.id, b.id);
});

test("Google login for another account: the text says so, the device switches, and the next login works", async () => {
  const { e, w, issue, p, rpc } = await setup();
  let next = { ticket: "", email: "" };
  setAuthFlow(p, async () => "https://pusharmor.com/v1/auth/done#ticket=" + next.ticket + "&email=" + next.email);
  const google = async (email: string, purpose: string) => {
    next = { ticket: issue(email), email };
    return rpc.handle({ op: "oauth", args: { provider: "google", purpose } });
  };

  assert.deepEqual(await google("a@x.com", "register"), { ok: true, data: { done: true } });
  const a = (await e.self())!;
  await e.logout();

  // a new account: switch to an empty account, then register with new keys
  assert.deepEqual(await google("b@x.com", "login"), {
    ok: false,
    error: 'Unable to log in with Google.\nThis login is for "b@x.com", not "a@x.com". Log in again to switch to "b@x.com".',
  });
  assert.equal(await e.self(), null);
  assert.deepEqual(await e.accounts(), { [acctId("a@x.com")]: "a@x.com" });
  assert.deepEqual(await google("b@x.com", "login"), { ok: true, data: { done: true } });
  const b = (await e.self())!;
  assert.ok(b.id.startsWith(acctId("b@x.com")));
  await e.logout();

  // an archived account: switch to it, then log in with its own keys
  assert.deepEqual(await google("a@x.com", "login"), {
    ok: false,
    error: 'Unable to log in with Google.\nThis login is for "a@x.com", not "b@x.com". Log in again to switch to "a@x.com".',
  });
  assert.equal((await e.self())!.id, a.id);
  const logins = w.calls.filter((c) => c.path === "/v1/peers/" + a.id + "/login").length;
  assert.deepEqual(await google("a@x.com", "login"), { ok: true, data: { done: true } });
  assert.equal(w.calls.filter((c) => c.path === "/v1/peers/" + a.id + "/login").length, logins + 1);
  assert.equal(await e.regState(), "registered");
  assert.deepEqual(await e.accounts(), { [acctId("b@x.com")]: "b@x.com" });

  // a registration ticket for an archived account brings that account back instead
  await e.logout();
  await e.switchAccount(null);
  assert.deepEqual(await e.accounts(), { [acctId("a@x.com")]: "a@x.com", [acctId("b@x.com")]: "b@x.com" });
  const posts = w.calls.filter((c) => c.method === "POST" && c.path === "/v1/peers").length;
  assert.deepEqual(await google("b@x.com", "register"), {
    ok: false,
    error: 'Unable to log in with Google.\nThis login is for "b@x.com". Log in again to switch to "b@x.com".',
  });
  assert.equal(w.calls.filter((c) => c.method === "POST" && c.path === "/v1/peers").length, posts);
  assert.equal((await e.self())!.id, b.id);
});

test("data in the layout before accounts survives a switch out and back", async () => {
  const { e, db, p, issue, login } = await setup();
  await login.complete("register", issue("a@x.com"), "a@x.com");
  const a = (await e.self())!;
  await addState(e, db, p, "A");
  await db.del("meta", "account"); // written by this version only
  // device rows: the clock offset, the Firefox push setup and web push keys, the update notice
  await db.setMeta("offset_s", 7);
  await db.setMeta("receive_mode", "fallback");
  await db.put("keys", { k: 1 }, "wp");
  await p.storageLocal.set({ [UPDATE_NEEDED]: "0.0.19", theme: "dark" });
  await e.logout();
  const allow = (await p.storageLocal.get([ALLOW_SET]))[ALLOW_SET];

  await e.switchAccount(null);
  assert.equal(await db.self(), undefined);
  assert.equal(await e.regState(), null);
  assert.deepEqual(await db.history(), []);
  assert.deepEqual(await db.peers(), []);
  assert.equal(await db.meta("email"), undefined);
  assert.equal(await db.meta("offset_s"), 7);
  assert.equal(await db.meta("receive_mode"), "fallback");
  assert.deepEqual(await db.get("keys", "wp"), { k: 1 });
  let local = await p.storageLocal.get(null);
  assert.deepEqual(Object.keys(local).sort(), [UPDATE_NEEDED, "theme"].sort());

  await e.switchAccount(acctId("a@x.com"));
  assert.equal((await e.self())!.id, a.id);
  assert.equal(await e.regState(), "logged_out");
  assert.equal(await e.email(), "a@x.com");
  assert.deepEqual((await db.history()).map((r) => r.content), ["hello A"]);
  assert.ok(await db.peer("PEERA"));
  assert.equal((await e.settings()).historyDays, 7);
  assert.equal(await db.meta("offset_s"), 7);
  assert.equal(await db.meta("slot_local"), undefined);
  local = await p.storageLocal.get(null);
  assert.ok(local["pair:PEERA"]);
  assert.deepEqual(local[ALLOW_SET], allow);
  assert.equal((local[REG_MARKER] as { id: string }).id, a.id);
  assert.equal(local.theme, "dark");
  assert.deepEqual(await e.accounts(), {});
});

test("delete account with a login for another account: the text says so and nothing is sent", async () => {
  const { e, w, issue, p, rpc } = await setup();
  await new Login(e).complete("register", issue("a@x.com"), "a@x.com");
  const T2 = 'Unable to delete the account.\nThis login is for "b@x.com". Log in as "a@x.com" to delete its account.';
  await p.storageSession.set({ [REQUEST_TOKEN]: { token: "rt:b@x.com", purpose: "delete-account" } });
  assert.deepEqual(await rpc.handle({ op: "emailVerify", args: { code: "ABCDEF" } }), { ok: false, error: T2 });
  setAuthFlow(p, async () => "https://pusharmor.com/v1/auth/done#ticket=" + issue("b@x.com") + "&email=b@x.com");
  assert.deepEqual(await rpc.handle({ op: "oauth", args: { provider: "google", purpose: "delete-account" } }), { ok: false, error: T2 });
  assert.equal(w.calls.filter((c) => c.path === "/v1/account").length, 0);
  assert.equal(await e.regState(), "registered");
});

test("any other 401 account mismatch says the login is for another account", () => {
  assert.equal(failText("login", new ApiError(401, "account mismatch", {}, null)), "Unable to log in.\nThis login is for another account.");
});
