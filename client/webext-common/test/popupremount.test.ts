import assert from "node:assert/strict";
import { test } from "node:test";
import { N, toastEl } from "./fakedom.ts";
import { toast } from "../src/ui/dialog.ts";
import { mountPopup } from "../src/ui/popup.ts";
import type { UiEnv } from "../src/ui/dom.ts";

test("drawing the popup again (log out, a login change) takes away a message that stays", async () => {
  toast("This browser cannot receive messages.", "err", true);
  assert.ok(toastEl());
  const env = { call: () => new Promise(() => undefined), theme: { get: () => new Promise(() => undefined), onChange() {} } } as unknown as UiEnv;
  void mountPopup(env, new N("div") as unknown as HTMLElement);
  assert.equal(toastEl(), undefined);
});

test("drawing the popup again (an account switch) cancels an open confirm dialog of the view drawn before", async () => {
  const proto = N.prototype as unknown as { showModal?: () => void; close?: (v: string) => void; returnValue?: string };
  const seen: string[] = [];
  proto.showModal = function () {};
  proto.close = function (this: N, v: string) {
    seen.push(v);
    (this as unknown as { fire?: (t: string) => void }).fire?.("close");
  };
  const { confirmDialog } = await import("../src/ui/dialog.ts");
  void confirmDialog("Remove?", 'Remove "Phone"?', "Remove");
  const env = { call: () => new Promise(() => undefined), theme: { get: () => new Promise(() => undefined), onChange() {} } } as unknown as UiEnv;
  void mountPopup(env, new N("div") as unknown as HTMLElement);
  assert.deepEqual(seen, [""]);
});
