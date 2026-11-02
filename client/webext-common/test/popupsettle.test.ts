import assert from "node:assert/strict";
import { test } from "node:test";
import { body, toastEl } from "./fakedom.ts";
import { PushRefused } from "../src/platform.ts";
import { Rpc, type StateView } from "../src/core/rpc.ts";
import { toast } from "../src/ui/dialog.ts";
import { settlePushIssue } from "../src/ui/popup.ts";
import type { UiEnv } from "../src/ui/dom.ts";
import { Clock, MockWorker, device } from "./harness.ts";

const issue = async (r: Rpc, op: string) => ((await r.handle({ op })).data as StateView).pushIssue;

test("the popup gets the push notice of this open's push check: it goes once the push update works", async () => {
  const clock = new Clock();
  const a = await device(new MockWorker(clock), clock);
  await a.db.setMeta("push_issue", "relay");
  await a.db.setMeta("push_fail", 3);
  const r = new Rpc(a.e);
  assert.equal(await issue(r, "popupOpen"), "relay"); // drawn at once from the local state
  assert.equal(await issue(r, "popupSettled"), null);
});

test("the popup gets the push notice of this open's push check: it shows when the browser refuses push", async () => {
  const clock = new Clock();
  const a = await device(new MockWorker(clock), clock);
  a.p.sub = null;
  a.p.pushSubscribe = async () => {
    throw new PushRefused("AbortError");
  };
  const r = new Rpc(a.e);
  assert.equal(await issue(r, "popupOpen"), null);
  assert.equal(await issue(r, "popupSettled"), "refused");
});

function env(after: Partial<StateView> | null): UiEnv {
  return { call: async (req: { op: string }) => (req.op === "popupSettled" ? { ok: true, data: after } : { ok: false, error: "no" }) } as unknown as UiEnv;
}

test("the popup takes away or shows the push notice when the push check changed it", async () => {
  toast("old notice", "err", true);
  assert.ok(toastEl());
  await settlePushIssue(env({ pushIssue: null }), { pushIssue: "relay" } as StateView);
  assert.equal(toastEl(), undefined);
  await settlePushIssue(env({ pushIssue: "refused" }), { pushIssue: null } as StateView);
  assert.ok(toastEl());
  body.kids = [];
});
