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
