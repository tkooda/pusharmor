import assert from "node:assert/strict";
import { test } from "node:test";
import { N } from "./fakedom.ts";
import { historyView } from "../src/ui/popup.ts";
import type { UiEnv } from "../src/ui/dom.ts";

const find = (n: N, f: (x: N) => boolean): N | undefined => (f(n) ? n : n.kids.map((k) => find(k, f)).find(Boolean));
const all = (n: N, f: (x: N) => boolean): N[] => [...(f(n) ? [n] : []), ...n.kids.flatMap((k) => all(k, f))];

async function mount() {
  const msg = (id: number) => ({ id, dir: "in", peer: "p1", sender: "Phone", type: "text", content: "m" + id, n: 1, pairing_id: null, received: Date.now() - id, read: true });
  const data: Record<string, unknown> = { historyOpened: null, history: [1, 2, 3, 4].map(msg) };
  const env = { call: async (m: { op: string }) => ({ ok: true, data: data[m.op] }) } as unknown as UiEnv;
  const root = new N("div");
  await historyView(env, root as unknown as HTMLElement, undefined, { toDevices: () => undefined, toSend: () => undefined });
  const btn = () => find(root, (x) => x.tag === "button" && (x.attrs.class ?? "").includes("hselect"))!;
  const boxes = () => all(root, (x) => x.tag === "input" && x.attrs.class === "hsel");
  const checked = () => all(root, (x) => x.tag === "input" && x.attrs.class === "hsel").map((b) => !!(b as N & { checked: boolean }).checked || "checked" in b.attrs);
  const click = (id: number, mods: Record<string, boolean> = {}) => {
    const row = find(root, (x) => x.attrs.id === "h-" + id)!;
    const content = find(row, (x) => (x.attrs.class ?? "").includes("content"))!;
    const target = Object.assign(content, { closest: () => null });
    for (const f of row.on.click ?? []) f({ target, preventDefault() {}, stopPropagation() {}, ...mods });
  };
  return { root, btn, boxes, checked, click };
}

test("History Select button shows checkboxes; Done and Esc leave the mode", async () => {
  const v = await mount();
  assert.equal(v.btn().textContent, "Select");
  assert.equal(v.boxes().length, 0);
  for (const f of v.btn().on.click!) f({});
  assert.equal(v.btn().textContent, "Done");
  assert.equal(v.boxes().length, 4);
  v.click(2);
  v.click(2); // empty again: the mode stays on
  assert.equal(v.boxes().length, 4);
  for (const f of v.btn().on.click!) f({});
  assert.equal(v.btn().textContent, "Select");
  assert.equal(v.boxes().length, 0);
  for (const f of v.btn().on.click!) f({});
  (globalThis as unknown as { document: { querySelector: () => null } }).document.querySelector = () => null;
  for (const f of v.root.on.keydown ?? []) f({ key: "Escape" });
  assert.equal(v.boxes().length, 0);
  assert.equal(v.btn().textContent, "Select");
});

test("History: Ctrl or Cmd + click toggles a row; Shift + click selects a range from the last toggled row", async () => {
  const v = await mount();
  v.click(2, { ctrlKey: true });
  assert.deepEqual(v.checked(), [false, true, false, false]);
  v.click(4, { shiftKey: true });
  assert.deepEqual(v.checked(), [false, true, true, true]);
  v.click(1, { metaKey: true });
  assert.deepEqual(v.checked(), [true, true, true, true]);
  v.click(3, { ctrlKey: true });
  assert.deepEqual(v.checked(), [true, true, false, true]);
});
