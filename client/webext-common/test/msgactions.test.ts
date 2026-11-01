import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { uiEnv } from "../src/shellkit.ts";
import { ellipsize, msgActions, saveFilename } from "../src/model/msgactions.ts";

test("action order by message type", () => {
  assert.deepEqual(msgActions("url"), ["copy", "open", "share"]);
  assert.deepEqual(msgActions("tel"), ["copy", "open", "share"]);
  assert.deepEqual(msgActions("text"), ["read", "copy", "share", "save"]);
});

test("save filename uses local time", () => {
  assert.equal(saveFilename(new Date(2026, 9, 26, 7, 33, 20).getTime()), "2026-10-26_073320_message.txt");
  assert.equal(saveFilename(new Date(2026, 0, 2, 13, 4, 5).getTime()), "2026-01-02_130405_message.txt");
});

test("ellipsize cuts with an ellipsis only when long", () => {
  assert.equal(ellipsize("abc", 120), "abc");
  assert.equal(ellipsize("x".repeat(120), 120), "x".repeat(120));
  const s = ellipsize("x".repeat(121), 120);
  assert.equal(s.length, 120);
  assert.ok(s.endsWith("…"));
});

test("Read opens a new tab on the extension read page for the message", async () => {
  const created: { url: string; active: boolean }[] = [];
  const b = {
    runtime: { getURL: (p: string) => "chrome-extension://x/" + p, getContexts: async () => [], getManifest: () => ({ name: "PushArmor" }) },
    tabs: { create: async (o: { url: string; active: boolean }) => void created.push(o) },
  };
  await uiEnv(b as never).openPage("#read=42");
  assert.deepEqual(created, [{ url: "chrome-extension://x/page.html#read=42", active: true }]);
});

test("the read page has only an X that closes the tab", () => {
  const page = readFileSync(new URL("../src/ui/page.ts", import.meta.url), "utf8");
  const view = page.slice(page.indexOf("async function readView"));
  assert.match(view, /class: "quiet ib readx"[^\n]*onclick: close/);
  assert.match(view, /window\.close\(\)/);
  assert.equal((view.slice(0, view.indexOf("\n}\n")).match(/h\("button"/g) ?? []).length, 1);
});
