import assert from "node:assert/strict";
import { test } from "node:test";
import { body, toastEl, type N } from "./fakedom.ts";
import { PushRefused } from "../src/platform.ts";
import { isCheckPush } from "../src/core/engine.ts";
import { Rpc, type StateView } from "../src/core/rpc.ts";
import { pushIssueText, pushVendor } from "../src/core/texts.ts";
import { showPushIssue } from "../src/ui/popup.ts";
import type { UiEnv } from "../src/ui/dom.ts";
import { Clock, MockWorker, device, refresh } from "./harness.ts";

async function setup() {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  return { w, a, r: new Rpc(a.e) };
}

const state = async (r: Rpc) => (await r.handle({ op: "state" })).data as StateView;
const check = async (r: Rpc) => (await r.handle({ op: "pushCheck" })).data as { result: string; state: StateView };
const FAULT_LINE = "This device cannot receive messages.\nThe relay server cannot reach Google's push service right now. This is not a problem on this device. Try again later.";

test("the test push {\"check\":1} is dropped silently: no history row, no notification", async () => {
  const { a } = await setup();
  assert.ok(isCheckPush('{"check":1}'));
  assert.ok(!isCheckPush('{"check":2}') && !isCheckPush("{") && !isCheckPush("abc"));
  const before = (await a.db.history()).length;
  await a.e.receive('{"check":1}', "push");
  assert.equal((await a.db.history()).length, before);
  assert.equal(a.p.notes.size, 0);
});

test("my_relay_fault in GET /v1/peers shows the relay-side message; absent or false shows none; a local cause comes first", async () => {
  const { w, a, r } = await setup();
  await refresh(a);
  assert.equal((await state(r)).pushIssue, null); // field absent: an older relay server
  w.relayFault = true;
  await refresh(a);
  const st = await state(r);
  assert.equal(st.pushIssue, "fault");
  assert.equal(st.pushVendor, "Google");
  await a.db.setMeta("push_issue", "refused");
  assert.equal((await state(r)).pushIssue, "refused");
  await a.db.del("meta", "push_issue");
  w.relayFault = false;
  await refresh(a);
  assert.equal((await state(r)).pushIssue, null);
});

test("the push service vendor comes from the endpoint host, else from the browser", () => {
  assert.equal(pushVendor("https://fcm.googleapis.com/fcm/send/x", "chrome"), "Google");
  assert.equal(pushVendor("https://updates.push.services.mozilla.com/wpush/v2/x", "firefox"), "Mozilla");
  assert.equal(pushVendor("https://wns2-bn3p.notify.windows.com/w/?token=x", "chrome"), "Microsoft");
  assert.equal(pushVendor(null, "firefox"), "Mozilla");
  assert.equal(pushVendor("not a url", "chrome"), "Google");
  assert.equal(pushIssueText("fault", false, "Google"), FAULT_LINE);
  assert.equal(pushIssueText("fault", false, "Mozilla"), FAULT_LINE.replace("Google", "Mozilla"));
});

test("Check again: one signed POST /v1/peers/:id/check; sent clears the fault, relay sets it", async () => {
  const { w, a, r } = await setup();
  w.relayFault = true;
  await refresh(a);
  w.inject.push({ match: /POST \/v1\/peers\/[^/]+\/check$/, status: 200, body: { result: "relay" }, times: 1 });
  let c = await check(r);
  assert.equal(c.result, "relay");
  assert.ok(w.calls.some((x) => x.method === "POST" && x.path === "/v1/peers/" + a.id + "/check" && JSON.stringify(x.body) === "{}"));
  assert.equal(c.state.pushIssue, "fault");
  w.inject.push({ match: /POST \/v1\/peers\/[^/]+\/check$/, status: 200, body: { result: "sent" }, times: 1 });
  c = await check(r);
  assert.equal(c.result, "sent");
  assert.equal(c.state.pushIssue, null);
  w.inject.push({ match: /POST \/v1\/peers\/[^/]+\/check$/, status: 200, body: { result: "relay" }, times: 1 });
  assert.equal((await check(r)).state.pushIssue, "fault");
});

test("Check again: 429, network errors, none, and unknown words read as failed; the message stays", async () => {
  const { w, a, r } = await setup();
  w.relayFault = true;
  await refresh(a);
  w.inject.push({ match: /POST \/v1\/peers\/[^/]+\/check$/, status: 429, body: { error: "rate limited" }, times: 1 });
  assert.equal((await check(r)).result, "failed");
  for (const res of ["none", "later"]) {
    w.inject.push({ match: /POST \/v1\/peers\/[^/]+\/check$/, status: 200, body: { result: res }, times: 1 });
    const c = await check(r);
    assert.equal(c.result, res === "none" ? "none" : "failed");
    assert.equal(c.state.pushIssue, "fault");
  }
  const real = a.p.fetch;
  a.p.fetch = (u: string, init: RequestInit) => (u.endsWith("/check") ? Promise.reject(new TypeError("offline")) : real(u, init));
  assert.equal((await check(r)).result, "failed");
});

test("Check again: gone subscribes again and sends the new push address; a local cause skips the check", async () => {
  const { w, a, r } = await setup();
  w.relayFault = true;
  await refresh(a);
  const before = a.p.sub!.endpoint;
  w.inject.push({ match: /POST \/v1\/peers\/[^/]+\/check$/, status: 200, body: { result: "gone" }, times: 1 });
  const c = await check(r);
  assert.equal(c.result, "gone");
  assert.notEqual(a.p.sub!.endpoint, before);
  assert.ok(w.calls.some((x) => x.method === "PATCH" && (x.body as { push?: { endpoint?: string } }).push?.endpoint === a.p.sub!.endpoint));
  assert.equal(c.state.pushIssue, null);
  // the browser refuses push: a local cause, shown in place of the check
  a.p.sub = null;
  a.p.pushSubscribe = async () => {
    throw new PushRefused("AbortError");
  };
  const n = w.calls.length;
  const c2 = await check(r);
  assert.equal(c2.result, "local");
  assert.equal(c2.state.pushIssue, "refused");
  assert.ok(!w.calls.slice(n).some((x) => x.path.endsWith("/check")));
});

const all = (n: N): N[] => [n, ...n.kids.flatMap(all)];
const msg = () => all(toastEl()!).find((n) => n.attrs.class === "toast-msg")!.textContent;
const tick = () => new Promise((ok) => setTimeout(ok, 70));

function env(reply: unknown): UiEnv {
  return { call: async (req: { op: string }) => (req.op === "pushCheck" ? { ok: true, data: reply } : { ok: false, error: "no" }) } as unknown as UiEnv;
}

async function clickCheck(): Promise<void> {
  const btn = all(toastEl()!).find((n) => n.tag === "button" && n.textContent === "Check again")!;
  assert.ok(btn, "Check again on the message");
  for (const f of btn.on.click ?? []) f({});
  await tick();
}

test("the message has Check again: sent shows Working. and hides it; failed keeps it with the failure line", async () => {
  const st = { pushIssue: "fault", pushVendor: "Mozilla" } as StateView;
  await showPushIssue(env({ result: "sent", state: { pushIssue: null } }), st);
  await tick();
  assert.equal(msg(), FAULT_LINE.replace("Google", "Mozilla"));
  await clickCheck();
  assert.equal(msg(), "Working.");
  assert.equal(toastEl()!.attrs.class, "toast ok");

  await showPushIssue(env({ result: "failed", state: st }), st);
  await tick();
  await clickCheck();
  assert.equal(msg(), FAULT_LINE.replace("Google", "Mozilla") + "\nUnable to check right now. Try again later.");

  await showPushIssue(env({ result: "relay", state: st }), st);
  await tick();
  await clickCheck();
  assert.equal(msg(), FAULT_LINE.replace("Google", "Mozilla"));
  body.kids = [];
});
