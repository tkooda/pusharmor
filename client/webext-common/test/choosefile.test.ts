import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { N } from "./fakedom.ts";
import { sendView } from "../src/ui/popup.ts";
import * as F from "../src/model/filerow.ts";
import type { StateView } from "../src/core/rpc.ts";
import type { UiEnv } from "../src/ui/dom.ts";

const all = (n: N): N[] => [n, ...n.kids.flatMap(all)];

test("Send: the file button is a small secondary text button that reads Or choose a file...", async () => {
  assert.equal(F.CHOOSE_FILE, "Or choose a file...");
  const env = {
    inPopup: () => false,
    activeUrl: async () => "",
    call: async (m: { op: string }) => ({ ok: true, data: ({ peers: { peers: [] }, sendSel: [], detect: { type: "text", bytes: 0 } } as Record<string, unknown>)[m.op] }),
  } as unknown as UiEnv;
  const root = new N("div");
  await sendView(env, root as unknown as HTMLElement, { settings: { showAll: false } } as unknown as StateView, "");
  const btn = all(root).find((x) => x.tag === "button" && x.textContent === "Or choose a file...")!;
  assert.equal(btn.attrs.class, "quiet", "a stock text button, not the call to action or a filled pill");
  const css = readFileSync(new URL("../src/ui/style.css", import.meta.url), "utf8");
  assert.match(css, /\.inbtns button\.quiet \{ height: 28px; padding: 0 8px; gap: 5px; font-size: 12px; \}/);
});
