import assert from "node:assert/strict";
import { test } from "node:test";
import { N, toastEl } from "./fakedom.ts";
import { historyView, mountPopup } from "../src/ui/popup.ts";
import { memoryThemeStore } from "../src/ui/theme.ts";
import type { UiEnv } from "../src/ui/dom.ts";

const find = (n: N, f: (x: N) => boolean): N | undefined => (f(n) ? n : n.kids.map((k) => find(k, f)).find(Boolean));
const hasClass = (n: N, c: string) => (n.attrs.class ?? "").split(" ").includes(c);
// closest() for the class selectors the row checks (".acts", "button", ...)
const closest = (n: N) => (sel: string) => {
  for (let x: N | null = n; x; x = x.parent) {
    for (const s of sel.split(",").map((t) => t.trim())) if (s.startsWith(".") ? hasClass(x, s.slice(1)) : x.tag === s) return x;
  }
  return null;
};
const click = (on: N, target: N) => {
  for (const f of on.on.click ?? []) f({ target: Object.assign(target, { closest: closest(target) }), preventDefault() {}, stopPropagation() {} });
};

test("a click on a History tile or its sender name never goes to Devices", async () => {
  const opened: string[] = [];
  const row = { id: 7, dir: "in", peer: "p1", sender: "Phone", type: "text", content: "hello", n: 1, pairing_id: null, received: Date.now(), read: false };
  const data: Record<string, unknown> = { historyOpened: null, history: [row], historyRead: null };
  const env = {
    call: async (m: { op: string }) => ({ ok: true, data: data[m.op] }),
    openPage: (hash: string) => void opened.push(hash),
  } as unknown as UiEnv;
  const nav = { toDevices: () => void opened.push("devices"), toSend: () => undefined };
  const root = new N("div");
  await historyView(env, root as unknown as HTMLElement, undefined, nav);
  const tile = find(root, (x) => hasClass(x, "hrow"))!;
  const who = find(tile, (x) => hasClass(x, "who"))!;
  const content = find(tile, (x) => hasClass(x, "content"))!;
  assert.equal(who.tag, "span"); // plain text, not a link
  assert.equal(who.textContent, "Phone");
  assert.deepEqual(who.on, {});
  click(tile, who);
  click(tile, content);
  click(tile, tile);
  assert.deepEqual(opened, []);
  assert.ok(tile.cls.has("sel")); // the tile's own action still runs
});

test("a tap on another History tile expands it and collapses the open one; a second tap collapses it", async () => {
  const msg = (id: number, content: string) => ({ id, dir: "in", peer: "p1", sender: "Phone", type: "text", content, n: 1, pairing_id: null, received: Date.now() - id, read: true });
  const data: Record<string, unknown> = { historyOpened: null, history: [msg(1, "one"), msg(2, "two")], historyRead: null };
  const env = { call: async (m: { op: string }) => ({ ok: true, data: data[m.op] }) } as unknown as UiEnv;
  const root = new N("div");
  await historyView(env, root as unknown as HTMLElement, undefined, { toDevices: () => undefined, toSend: () => undefined });
  const a = find(root, (x) => x.attrs.id === "h-1")!;
  const b = find(root, (x) => x.attrs.id === "h-2")!;
  const open = () => [a, b].filter((t) => t.cls.has("sel")).map((t) => t.attrs.id);
  const who = (t: N) => find(t, (x) => hasClass(x, "who"))!;
  const content = (t: N) => find(t, (x) => hasClass(x, "content"))!;
  click(a, content(a));
  assert.deepEqual(open(), ["h-1"]);
  click(b, content(b)); // the first tap on another tile opens it
  assert.deepEqual(open(), ["h-2"]);
  click(a, who(a)); // also on the sender line
  assert.deepEqual(open(), ["h-1"]);
  click(b, b);
  assert.deepEqual(open(), ["h-2"]);
  click(b, content(b));
  assert.deepEqual(open(), []);
  click(a, a);
  click(a, a);
  assert.deepEqual(open(), []);
});

test("an unknown type row shows the sender, a red x and the update label, and no action buttons", async () => {
  const row = { id: 9, dir: "in", peer: "p1", sender: "Phone", type: "unknown", utype: "future", content: "", n: 1, pairing_id: null, received: Date.now(), read: false, mid: "a1" };
  const data: Record<string, unknown> = { historyOpened: null, history: [row], historyRead: null };
  const env = { call: async (m: { op: string }) => ({ ok: true, data: data[m.op] }) } as unknown as UiEnv;
  const root = new N("div");
  await historyView(env, root as unknown as HTMLElement, undefined, { toDevices: () => undefined, toSend: () => undefined });
  const tile = find(root, (x) => x.attrs.id === "h-9")!;
  assert.equal(find(tile, (x) => hasClass(x, "who"))!.textContent, "Phone");
  assert.ok(tile.cls.has("unread")); // bold like an unread text row
  const content = find(tile, (x) => hasClass(x, "content"))!;
  assert.ok(hasClass(content, "unk"));
  assert.equal(content.textContent, "Unknown message type, please update");
  assert.ok(find(content, (x) => x.tag === "svg"));
  assert.equal(find(tile, (x) => hasClass(x, "acts")), undefined);
  assert.equal(find(tile, (x) => x.tag === "button"), undefined);
});

test("popup open shows the newer version toast when the state says so, then clears it; a mount overtaken first keeps it", async () => {
  let newer = true;
  let shown = 0;
  let hold: Promise<void> | null = null;
  const env = {
    call: async (m: { op: string }) => {
      if (m.op === "newerShown") {
        shown++;
        newer = false;
        return { ok: true, data: null };
      }
      if (m.op !== "popupOpen") return { ok: false, error: "no" };
      if (hold) await hold;
      return { ok: true, data: { updateRequired: true, recheckLocked: false, platform: "chrome", newerSeen: newer || undefined } };
    },
    theme: memoryThemeStore("light"),
  } as unknown as UiEnv;
  // a mount that a newer one overtakes while it waits shows no toast and clears nothing
  let release = () => {};
  hold = new Promise((ok) => (release = ok));
  const first = mountPopup(env, new N("main") as unknown as HTMLElement);
  hold = null;
  const second = mountPopup(env, new N("main") as unknown as HTMLElement);
  await second;
  release();
  await first;
  assert.equal(shown, 1);
  await new Promise((ok) => setTimeout(ok, 70)); // the text goes in after the insert
  assert.equal(find(toastEl()!, (x) => x.attrs.class === "toast-msg")!.textContent, "A device uses a newer version. Update PushArmor");
  assert.equal(newer, false);
  await mountPopup(env, new N("main") as unknown as HTMLElement);
  assert.equal(toastEl(), undefined);
});
