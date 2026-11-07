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

test("an account switch draws the popup again on the start page, a plain login change keeps the page start", async () => {
  const { AUTH_CHANGED } = await import("../src/model/signin.ts");
  let fire: ((v: unknown) => void) | null = null;
  const starts: string[] = [];
  const env = {
    call: (op: string) => {
      if (op === "popupOpen") starts.push("open");
      return new Promise(() => undefined);
    },
    theme: { get: () => new Promise(() => undefined), onChange() {} },
    session: { watch: (k: string, cb: (v: unknown) => void) => ((fire = k === AUTH_CHANGED ? cb : fire), () => undefined) },
  } as unknown as UiEnv;
  const page = { tab: "history", arg: "42" } as const;
  void mountPopup(env, new N("div") as unknown as HTMLElement, page);
  const { lastPageForTest } = await import("../src/ui/popup.ts");
  fire!("1:1");
  assert.deepEqual(lastPageForTest(), page);
  fire!("2:2:switched");
  assert.equal(lastPageForTest(), undefined);
});
