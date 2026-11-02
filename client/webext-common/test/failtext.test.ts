// Error texts: line 1 says what could not be done, line 2 says why and what to do next.
// The same words as Android and iOS; device names in straight double quotes.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { Api, ApiError, FETCH_TIMEOUT_MS } from "../src/api/client.ts";
import { Rpc } from "../src/core/rpc.ts";
import { type Engine, UserError } from "../src/core/engine.ts";
import { failText } from "../src/core/failtext.ts";
import { R, saveFailText, sendResultText } from "../src/core/texts.ts";
import { Clock, FakePlatform, MockWorker, deliver, device, makeEngine, pairAndApprove, refresh } from "./harness.ts";

const api = (status: number, error: string, ra: number | null = null) => new ApiError(status, error, {}, ra);

test("each relay server reply maps to its reason line under the action line", () => {
  const rows: [ApiError, string][] = [
    [api(0, "network"), "The relay server could not be reached. Check your internet connection and try again."],
    [new ApiError(0, "network", {}, null, "offline"), "No internet connection."],
    [new ApiError(0, "network", {}, null, "timeout"), "The relay server did not answer in time. Try again."],
    [api(500, ""), "The relay server is not working right now. Try again later."],
    [api(503, "unavailable"), "The relay server is not working right now. Try again later."],
    [api(502, "bad gateway"), "The relay server is not working right now. Try again later."],
    [api(502, "email send failed"), "The relay server could not send the email. Try again."],
    [api(429, "rate limited", 30), "Too many tries. Try again in 30 seconds."],
    [api(429, "rate limited", 1), "Too many tries. Try again in 1 second."],
    [api(429, "rate limited", 61), "Too many tries. Try again in 2 minutes."],
    [api(429, "rate limited"), "Too many tries. Try again in 60 seconds."],
    [api(426, "update required"), "This version of PushArmor is too old. Update PushArmor to continue."],
    [api(401, "unknown peer"), "This device was removed from the account. Log in again."],
    [api(401, "logged out"), "This device is logged out. Log in to resume."],
    [api(401, "ticket expired"), "The login expired. Log in again."],
    [api(401, "invalid ticket"), "The login link is not valid. Request a new code and try again."],
    [api(401, "bad ticket"), "The login link is not valid. Request a new code and try again."],
    [api(401, "clock skew twice"), "This device's clock is off by more than 5 minutes. Fix the clock and try again."],
    [api(403, "banned"), "This account is blocked."],
    [api(401, "wrong code"), "The code is not correct. Check the newest email from PushArmor and try again."],
    [api(401, "code expired"), "The code expired. Request a new code to continue."],
    [api(403, "turnstile failed"), "The security check did not finish. Try again."],
    [api(400, "bad email"), "Only email addresses with plain ASCII characters are supported."],
    [api(401, "email not verified"), "This Google account has no verified email address."],
    [api(401, "invalid id_token"), "Try again."],
    [api(400, "bad request"), "The relay server did not accept the request. Update PushArmor and try again."],
    [api(404, "not found"), "The relay server did not accept the request. Update PushArmor and try again."],
    [api(405, "method not allowed"), "The relay server did not accept the request. Update PushArmor and try again."],
    [api(401, "invalid client signature"), "The relay server did not accept the request. Update PushArmor and try again."],
    [api(413, "too large"), "The message is longer than 2048 characters."],
    [api(400, "push endpoint not allowed"), "This browser's push service is not supported yet."],
    [api(401, "bad id"), "The relay server did not accept the request. Update PushArmor and try again."],
    [api(418, "teapot"), "Try again."],
  ];
  for (const [e, why] of rows) assert.equal(failText("send", e), "Unable to send.\n" + why, e.message);
  assert.equal(failText("loginGoogle", api(401, "invalid id_token")), "Unable to log in with Google.\nGoogle did not confirm the login. Try again.");
  assert.equal(failText("loginApple", api(401, "invalid id_token")), "Unable to log in with Apple.\nApple did not confirm the login. Try again.");
  // a removal that the check did not confirm is not called a removal
  assert.equal(failText("send", api(401, "unknown peer"), { selfKept: true }), "Unable to send.\nTry again.");
});

test("local failures: keys, storage full, other writes, and an unknown error", () => {
  assert.equal(failText("rename", new DOMException("x", "QuotaExceededError")), "Unable to rename this device.\nStorage is full. Free some space and try again.");
  assert.equal(failText("rename", new DOMException("x", "UnknownError")), "Unable to rename this device.\nPushArmor could not save its data on this device. Restart PushArmor and try again.");
  assert.equal(failText("rename", new DOMException("x", "OperationError")), "Unable to rename this device.\nThis device's security keys cannot be used right now. Restart the device and try again.");
  assert.equal(failText("rename", new Error("boom")), "Unable to rename this device.\nTry again.");
  // a local check that already says what to do keeps its own words
  assert.equal(failText("pair", new UserError("Already paired"), { name: "Laptop" }), "Already paired");
});

test("every action line, with the device name in straight double quotes", () => {
  const e = new Error("x");
  const lines: [Parameters<typeof failText>[0], string][] = [
    ["send", "Unable to send."],
    ["refresh", "Unable to refresh the device list."],
    ["rename", "Unable to rename this device."],
    ["pair", 'Unable to pair with "Lap top".'],
    ["confirm", 'Unable to confirm "Lap top".'],
    ["reject", 'Unable to reject "Lap top".'],
    ["remove", 'Unable to remove "Lap top".'],
    ["evict", "Unable to remove the chosen devices."],
    ["cancel", 'Unable to cancel pairing with "Lap top".'],
    ["logout", "Unable to log out."],
    ["sendCode", "Unable to send the code."],
    ["checkCode", "Unable to check the code."],
    ["login", "Unable to log in."],
    ["loginGoogle", "Unable to log in with Google."],
    ["loginApple", "Unable to log in with Apple."],
    ["deleteHistory", "Unable to delete the history."],
    ["changeSetting", "Unable to change this setting."],
  ];
  for (const [a, line] of lines) assert.equal(failText(a, e, { name: "Lap top" }), line + "\nTry again.");
  for (const v of Object.values(R)) {
    const s = typeof v === "function" ? v("X") : v;
    assert.doesNotMatch(s, /bytes|Worker|peer|ticket/, s);
    assert.match(s, /^[\x20-\x7e]+$/, s);
  }
});

test("save message: denied, full, else a plain retry", () => {
  assert.equal(saveFailText(new Error("FILE_ACCESS_DENIED")), "Unable to save the message.\nPushArmor is not allowed to save there. Choose another location.");
  assert.equal(saveFailText(new Error("FILE_NO_SPACE")), "Unable to save the message.\nStorage is full. Free some space and try again.");
  assert.equal(saveFailText(new Error("downloads unavailable")), "Unable to save the message.\nTry again.");
});

test("one device that did not get a send: two lines each, the name quoted, never first", () => {
  const rows: Record<string, string> = {
    gone: 'Unable to deliver message to "Lap".\nOpen PushArmor on it to resolve.',
    "logged out": 'Unable to send to "Lap".\nThat device is logged out. Log in on that device to receive messages.',
    "not listening": 'Unable to send to "Lap".\nIt is set to send only. It does not receive messages.',
    unapproved: 'Unable to send to "Lap".\nIt is not paired with this device. Pair with it to send it messages.',
    denied: 'Unable to send to "Lap".\nIt isn\'t paired with this device.',
    unknown: 'Unable to send to "Lap".\nIt is no longer on this account.',
    "failed:net": 'Unable to send to "Lap".\nIts push service did not accept the message. Try again later.',
    failed: 'Unable to send to "Lap".\nIt has not finished turning on notifications. Open PushArmor on it.',
    other: 'Unable to send to "Lap".\nIt has not finished turning on notifications. Open PushArmor on it.',
  };
  for (const [w, t] of Object.entries(rows)) assert.equal(sendResultText("Lap", w), t, w);
});

test("no reply: an aborted request reads as a timeout, an offline browser as offline", async () => {
  const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const failing = async () => {
    throw new TypeError("Failed to fetch");
  };
  const mk = (fetch: (i: string, init: RequestInit) => Promise<Response>) =>
    new Api({ client: "chrome/0.0.19", fetch, now: () => 0, sleep: async () => undefined, getOffset: async () => 0, setOffset: async () => undefined });
  try {
    Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true });
    const off = await mk(failing).call("GET", "/peers", { noRetry: true }).catch((e: unknown) => e);
    assert.equal(failText("refresh", off), "Unable to refresh the device list.\nNo internet connection.");
    Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
    const net = await mk(failing).call("GET", "/peers", { noRetry: true }).catch((e: unknown) => e);
    assert.equal(failText("refresh", net), "Unable to refresh the device list.\nThe relay server could not be reached. Check your internet connection and try again.");
  } finally {
    if (nav) Object.defineProperty(globalThis, "navigator", nav);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const stalled = (_i: string, init: RequestInit) =>
      new Promise<Response>((_r, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const p = mk(stalled).call("GET", "/peers", { noRetry: true }).catch((e: unknown) => e);
    mock.timers.tick(FETCH_TIMEOUT_MS);
    assert.equal(failText("refresh", await p), "Unable to refresh the device list.\nThe relay server did not answer in time. Try again.");
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------- per call site

async function paired() {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const b = await device(w, clock, "firefox");
  await pairAndApprove(w, a, b);
  await deliver(w, b);
  const rpc = new Rpc(a.e);
  const nm = (await a.db.peer(b.id))!.name ?? "A device";
  const down = (re: RegExp) => w.inject.push({ match: re, status: 500, body: { error: "internal" }, times: 9 });
  return { clock, w, a, b, rpc, nm, down };
}

const DOWN = "The relay server is not working right now. Try again later.";
const FULL = "Storage is full. Free some space and try again.";
const full = () => {
  throw new DOMException("quota", "QuotaExceededError");
};

async function fails(rpc: Rpc, op: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await rpc.handle({ op, args });
  assert.equal(r.ok, false, op);
  return r.error!;
}

test("each device list action shows its own action line", async () => {
  const { a, b, rpc, nm, down } = await paired();
  down(/GET \/v1\/peers$/);
  assert.equal(await fails(rpc, "refresh"), "Unable to refresh the device list.\n" + DOWN);
  down(/PATCH \/v1\/peers\//);
  assert.equal(await fails(rpc, "rename", { name: "New" }), "Unable to rename this device.\n" + DOWN);
  down(/DELETE \/v1\/peers\//);
  assert.equal(await fails(rpc, "remove", { id: b.id }), 'Unable to remove "' + nm + '".\n' + DOWN);
  const e = a.e as unknown as Record<string, unknown>;
  const stub = async (name: string, op: string, args: Record<string, unknown>, first: string) => {
    const real = e[name];
    e[name] = full;
    try {
      assert.equal(await fails(rpc, op, args), first + "\n" + FULL, op);
    } finally {
      e[name] = real;
    }
  };
  await stub("localDelete", "localDelete", { id: b.id }, 'Unable to remove "' + nm + '".');
  await stub("pairStart", "pair", { id: b.id }, 'Unable to pair with "' + nm + '".');
  await stub("pairAgain", "pairAgain", { id: b.id }, 'Unable to pair with "' + nm + '".');
  await stub("pairSendAgain", "sendAgain", { id: b.id }, 'Unable to pair with "' + nm + '".');
  await stub("pairReplyTap", "reply", { id: b.id }, 'Unable to pair with "' + nm + '".');
  await stub("approve", "approve", { id: b.id }, 'Unable to confirm "' + nm + '".');
  await stub("deny", "deny", { id: b.id }, 'Unable to reject "' + nm + '".');
  await stub("cancelPairing", "cancel", { id: b.id }, 'Unable to cancel pairing with "' + nm + '".');
  await stub("setHidden", "hide", { id: b.id, hidden: true }, "Unable to change this setting.");
  await stub("setAllowContent", "allowContent", { id: b.id, allow: false }, "Unable to change this setting.");
  await stub("setSettings", "settings", { showAll: true }, "Unable to change this setting.");
  await stub("logoutLocal", "signout", {}, "Unable to log out.");
  const db = a.db as unknown as Record<string, unknown>;
  for (const [name, op, args] of [["del", "historyDelete", { ids: [1] }], ["clear", "historyDeleteAll", {}]] as const) {
    const real = db[name];
    db[name] = full;
    try {
      assert.equal(await fails(rpc, op, args), "Unable to delete the history.\n" + FULL, op);
    } finally {
      db[name] = real;
    }
  }
});

test("Codes match that the relay server does not take says Unable to confirm", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const b = await device(w, clock, "firefox");
  await refresh(a, b);
  await a.e.pairStart(b.id);
  await deliver(w, b);
  await deliver(w, a);
  await deliver(w, b);
  const nm = (await new Rpc(a.e).peers()).peers.find((v) => v.id === b.id)!.label;
  w.inject.push({ match: /POST \/v1\/approve\//, status: 500, body: {}, times: 9 });
  assert.equal(await fails(new Rpc(a.e), "approve", { id: b.id }), 'Unable to confirm "' + nm + '".\n' + DOWN);
});

test("send: a failed call, a too long text, and one device that did not get it", async () => {
  const { w, b, rpc, nm, down } = await paired();
  down(/POST \/v1\/send/);
  const r = await rpc.handle({ op: "send", args: { text: "hi", targets: "all" } });
  const d = r.data as { error: string; failures: { text: string }[] };
  assert.equal(d.error, "Unable to send.\n" + DOWN);
  w.inject = [];
  assert.equal(await fails(rpc, "send", { text: "x".repeat(2049) }), "Unable to send.\nThe message is longer than 2048 characters.");
  w.inject.push({ match: /POST \/v1\/send/, status: 200, body: { r: { [b.id]: "failed:net" } }, times: 1 });
  const r2 = (await rpc.handle({ op: "send", args: { text: "hi", targets: "all" } })).data as { failures: { text: string }[] };
  assert.equal(r2.failures[0]!.text, 'Unable to send to "' + nm + '".\nIts push service did not accept the message. Try again later.');
});

test("sign-in steps show their own action lines", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const p = new FakePlatform("chrome", w, clock);
  const { e } = await makeEngine(p, new IDBFactory(), clock);
  const rpc = new Rpc(e);
  assert.equal(await fails(rpc, "emailStart", { email: "\u00e9@b.com", purpose: "register" }), "Unable to send the code.\nOnly email addresses with plain ASCII characters are supported.");
  w.inject.push({ match: /POST \/v1\/auth\/email$/, status: 403, body: { error: "turnstile failed" }, times: 1 });
  assert.equal(await fails(rpc, "emailStart", { email: "a@b.com", purpose: "register" }), "Unable to send the code.\nThe security check did not finish. Try again.");
  assert.equal(await fails(rpc, "emailVerify", { code: "ABCDEF" }), "Unable to check the code.\nThe login expired. Log in again.");
  assert.equal(await fails(rpc, "emailVerify", { code: "" }), "Unable to check the code.\nEnter the 6-character code from the email.");
  p.authFlow = async () => {
    throw new Error("The user did not approve access.");
  };
  assert.equal(await fails(rpc, "oauth", { provider: "google", purpose: "register" }), "Unable to log in with Google.\nThe login window was closed. Try again.");
  assert.equal(await fails(rpc, "oauth", { provider: "apple", purpose: "register" }), "Unable to log in with Apple.\nThe login window was closed. Try again.");
  p.authFlow = (async () => "https://x.chromiumapp.org/#ticket=bad") as never;
  assert.equal(await fails(rpc, "oauth", { provider: "google", purpose: "register" }), "Unable to log in with Google.\nThe login link is not valid. Request a new code and try again.");
  w.inject.push({ match: /POST \/v1\/peers$/, status: 500, body: {}, times: 9 });
  assert.equal(await fails(rpc, "evict", { ticket: "T".repeat(20), evict: ["x"] }), "Unable to remove the chosen devices.\n" + DOWN);
});

test("a menu send that throws shows the two lines in the notification", async () => {
  const { onMenuClick } = await import("../src/shellkit.ts");
  const notes: string[] = [];
  const engine = {
    send: async () => {
      throw new ApiError(503, "unavailable", {}, null);
    },
    p: { notify: (_id: string, _t: string, body: string) => void notes.push(body), setBadge: () => undefined },
  } as unknown as Engine;
  onMenuClick({} as never, async () => ({ engine }) as never, async () => "")({ menuItemId: "pa-page|all", pageUrl: "https://example.com/" } as never);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(notes, ["Unable to send.\n" + DOWN]);
});

test("a Google or Apple login that comes back to the login tab says Unable to log in", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const p = new FakePlatform("firefox", w, clock);
  const { e } = await makeEngine(p, new IDBFactory(), clock);
  const { AUTH_PENDING } = await import("../src/core/login.ts");
  const { AUTH_RESULT } = await import("../src/model/signin.ts");
  await p.storageSession.set({ [AUTH_PENDING]: { tabId: 7, purpose: "register", until: p.now() + 60_000 } });
  const r = await new Rpc(e).handle({ op: "authDone", args: { hash: "ticket=bad" } }, 7);
  const want = "Unable to log in.\nThe login link is not valid. Request a new code and try again.";
  assert.deepEqual(r, { ok: false, error: want });
  assert.equal(((await p.storageSession.get([AUTH_RESULT]))[AUTH_RESULT] as { error: string }).error, want);
});

test("Pair, Codes match, and Codes differ that cannot go on show the action line and why", async () => {
  const { a, b, rpc, nm } = await paired();
  assert.equal(await fails(rpc, "pair", { id: b.id }), 'Unable to pair with "' + nm + '".\nIt is already paired with this device.');
  const clock = new Clock();
  const w = new MockWorker(clock);
  const c = await device(w, clock);
  const d = await device(w, clock, "firefox");
  await refresh(c, d);
  const r2 = new Rpc(c.e);
  const nd = (await r2.peers()).peers.find((v) => v.id === d.id)!.label;
  assert.equal(await fails(r2, "approve", { id: d.id }), 'Unable to confirm "' + nd + '".\nThe pairing with it has not reached the code check. Pair with it again.');
  await c.e.pairStart(d.id);
  assert.equal(await fails(r2, "pair", { id: d.id }), 'Unable to pair with "' + nd + '".\nA pairing with it is already open. Cancel it first.');
  await c.db.updatePeer(d.id, (p) => (p ? { ...p, removed: true } : null));
  await c.p.storageLocal.remove(["pair:" + d.id]);
  assert.equal(await fails(r2, "pair", { id: d.id }), 'Unable to pair with "' + nd + '".\nIt is no longer on this account.');
  assert.equal(await fails(rpc, "deny", { id: "gone" }), 'Unable to reject "A device".\nIt is no longer on this account.');
  void a;
});

test("a request the background does not know, and no reply from it, say what failed and what to do", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const { e } = await makeEngine(new FakePlatform("chrome", w, clock), new IDBFactory(), clock);
  assert.equal(await fails(new Rpc(e), "nosuchop"), "Request failed.\nTry again.");
  const { rpc } = await import("../src/ui/dom.ts");
  const env = { call: async () => undefined } as unknown as Parameters<typeof rpc>[0];
  await assert.rejects(rpc(env, "state"), { message: "Unable to reach PushArmor.\nClose this window, open it again, and try again." });
});

test("a device name that is not allowed says Unable to rename, then the rule", async () => {
  const { rpc } = await paired();
  assert.equal(await fails(rpc, "rename", { name: 'Lap"top' }), "Unable to rename this device.\nUse 1 to 32 plain ASCII characters, with no double quote.");
});

test("a menu send that some devices did not get, with no text back, says so in two lines", async () => {
  const { menuSend } = await import("../src/core/actions.ts");
  const engine = { send: async () => ({ sent: 1, total: 2, failures: [] }) } as unknown as Engine;
  const r = await menuSend(engine, "hi", "all", false);
  assert.equal(r.notice, "Unable to send.\nSome devices did not get the message. Open PushArmor to see which.");
});
