import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { uiEnv } from "../src/shellkit.ts";
import { saveTextFile, saveViaLink, saveWithPermission } from "../src/model/savefile.ts";
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
  assert.ok(s.endsWith("\u2026"));
});

test("View opens a new tab on the extension read page for the message", async () => {
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

test("Save asks downloads.download for a Save-as dialog with the dated filename, then reports the real path", async () => {
  const calls: { url: string; filename?: string; saveAs?: boolean }[] = [];
  const d = {
    download: async (o: { url: string; filename?: string; saveAs?: boolean }) => (calls.push(o), 7),
    search: async (q: { id: number }) => (q.id === 7 ? [{ filename: "/home/u/Downloads/chosen.txt" }] : []),
  };
  const name = saveFilename(new Date(2026, 9, 26, 7, 33, 20).getTime());
  assert.equal(await saveTextFile(d, "h\u00e9llo\nworld", name), "/home/u/Downloads/chosen.txt");
  assert.equal(calls[0]!.saveAs, true);
  assert.equal(calls[0]!.filename, "2026-10-26_073320_message.txt");
  assert.equal(decodeURIComponent(calls[0]!.url.split(",")[1]!), "h\u00e9llo\nworld");
});

test("Save: cancelling the dialog is silent (null); other failures reject", async () => {
  const cancel = { download: async () => Promise.reject(new Error("Download canceled by the user")), search: async () => [] };
  assert.equal(await saveTextFile(cancel, "x", "f.txt"), null);
  const bad = { download: async () => Promise.reject(new Error("Invalid filename")), search: async () => [] };
  await assert.rejects(saveTextFile(bad, "x", "f.txt"), /Invalid filename/);
  await assert.rejects(saveTextFile(undefined, "x", "f.txt"));
});

test("Save requests the downloads permission first, then saves when granted", async () => {
  const order: string[] = [];
  const perms = { request: async (p: { permissions: string[] }) => (order.push("request:" + p.permissions.join()), true) };
  const d = { download: async () => (order.push("download"), 3), search: async () => [{ filename: "/x/f.txt" }] };
  assert.equal(await saveWithPermission(perms, () => d, "t", "f.txt"), "/x/f.txt");
  assert.deepEqual(order, ["request:downloads", "download"]);
});

test("Save: permission denied rejects with the allow-downloads text and never downloads", async () => {
  let downloaded = false;
  const d = { download: async () => ((downloaded = true), 1), search: async () => [] };
  await assert.rejects(saveWithPermission({ request: async () => false }, () => d, "t", "f.txt"), /DOWNLOADS_DENIED/);
  assert.equal(downloaded, false);
});

test("Save: the downloads API is resolved after the grant", async () => {
  let granted = false;
  const d = { download: async () => 1, search: async () => [{ filename: "p" }] };
  const perms = { request: async () => ((granted = true), true) };
  assert.equal(await saveWithPermission(perms, () => (granted ? d : undefined), "t", "f.txt"), "p");
});

test("Chrome Save clicks a temporary download link with the filename and a text blob, then revokes the URL", async () => {
  const log: string[] = [];
  const a: Record<string, unknown> = { click: () => log.push("click:" + a.download + ":" + a.href) };
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document };
  g.document = { createElement: (t: string) => (log.push("el:" + t), a) };
  const orig = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  let blob: Blob | undefined;
  URL.createObjectURL = (b: Blob | MediaSource) => ((blob = b as Blob), "blob:x");
  URL.revokeObjectURL = (u: string) => void log.push("revoke:" + u);
  try {
    assert.equal(await saveViaLink("h\u00e9llo", "f.txt"), "f.txt");
  } finally {
    g.document = saved.document;
    URL.createObjectURL = orig.create;
    URL.revokeObjectURL = orig.revoke;
  }
  assert.deepEqual(log, ["el:a", "click:f.txt:blob:x", "revoke:blob:x"]);
  assert.equal(blob!.type, "text/plain;charset=utf-8");
  assert.equal(await blob!.text(), "h\u00e9llo");
});

test("Chrome uiEnv saves through the link and never asks for the downloads permission", async () => {
  let asked = false;
  const b = { permissions: { request: async () => ((asked = true), true) }, runtime: { getManifest: () => ({ name: "PushArmor" }) } };
  const g = globalThis as Record<string, unknown>;
  const saved = g.document;
  g.document = { createElement: () => ({ click() {} }) };
  try {
    assert.equal(await uiEnv(b as never, true).saveFile!("t", "f.txt"), "f.txt");
  } finally {
    g.document = saved;
  }
  assert.equal(asked, false);
});
