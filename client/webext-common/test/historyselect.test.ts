import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { N } from "./fakedom.ts";
import { historyView } from "../src/ui/popup.ts";
import type { UiEnv } from "../src/ui/dom.ts";

const find = (n: N, f: (x: N) => boolean): N | undefined => (f(n) ? n : n.kids.map((k) => find(k, f)).find(Boolean));
const all = (n: N, f: (x: N) => boolean): N[] => [...(f(n) ? [n] : []), ...n.kids.flatMap((k) => all(k, f))];

// Firefox for Android is told apart by its user agent
const ua = (android: boolean) => Object.defineProperty(globalThis, "navigator", { value: { userAgent: android ? "Mozilla/5.0 (Android 14; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0" : "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0" }, configurable: true });

async function mount(android = false) {
  ua(android);
  const msg = (id: number) => ({ id, dir: "in", peer: "p1", sender: "Phone", type: "text", content: "m" + id, n: 1, pairing_id: null, received: Date.now() - id, read: true });
  const data: Record<string, unknown> = { historyOpened: null, history: [1, 2, 3, 4].map(msg) };
  const env = { call: async (m: { op: string }) => ({ ok: true, data: data[m.op] }) } as unknown as UiEnv;
  const root = new N("div");
  await historyView(env, root as unknown as HTMLElement, undefined, { toDevices: () => undefined, toSend: () => undefined });
  const btn = () => find(root, (x) => x.tag === "button" && (x.attrs.class ?? "").includes("hselect"))!;
  const boxes = () => all(root, (x) => x.tag === "input" && x.attrs.class === "hsel");
  const checked = () => all(root, (x) => x.tag === "input" && x.attrs.class === "hsel").map((b) => !!(b as N & { checked: boolean }).checked || "checked" in b.attrs);
  // a click on the row's text, or on its checkbox (box)
  const click = (id: number, mods: Record<string, boolean> = {}, box = false) => {
    const row = find(root, (x) => x.attrs.id === "h-" + id)!;
    const content = find(row, (x) => (x.attrs.class ?? "").includes("content"))!;
    const target = Object.assign(content, { closest: (q: string) => (box && q === "input.hsel" ? content : null) });
    for (const f of row.on.click ?? []) f({ target, preventDefault() {}, stopPropagation() {}, ...mods });
  };
  const longPress = (id: number) => {
    const row = find(root, (x) => x.attrs.id === "h-" + id)!;
    for (const f of row.on.pointerdown ?? []) f({ button: 0, clientX: 10, clientY: 10, offsetX: 5, offsetY: 5, target: { closest: () => null, clientWidth: 300, clientHeight: 60 } });
    mock.timers.tick(600);
  };
  return { root, btn, boxes, checked, click, longPress };
}

test("History has no Select button; on desktop every row shows its checkbox without any action", async () => {
  const v = await mount();
  assert.equal(v.btn(), undefined);
  assert.deepEqual(v.checked(), [false, false, false, false]);
  v.click(2); // a click on the row body opens it and does not toggle
  assert.deepEqual(v.checked(), [false, false, false, false]);
  v.click(2, {}, true);
  assert.deepEqual(v.checked(), [false, true, false, false]);
  v.click(2, {}, true); // empty again: the checkboxes stay
  assert.deepEqual(v.checked(), [false, false, false, false]);
  v.click(3, {}, true);
  (globalThis as unknown as { document: { querySelector: () => null } }).document.querySelector = () => null;
  for (const f of v.root.on.keydown ?? []) f({ key: "Escape" });
  assert.deepEqual(v.checked(), [false, false, false, false]);
});

test("History on Firefox for Android: no checkboxes until a long-press, which checks that row; unchecking every row leaves the mode", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const v = await mount(true);
    assert.equal(v.btn(), undefined);
    assert.equal(v.boxes().length, 0);
    v.click(2); // a tap opens the row
    assert.equal(v.boxes().length, 0);
    v.longPress(3);
    assert.deepEqual(v.checked(), [false, false, true, false]);
    v.click(1); // in the mode a tap toggles
    assert.deepEqual(v.checked(), [true, false, true, false]);
    v.click(1);
    v.click(3);
    assert.equal(v.boxes().length, 0);
    v.longPress(2);
    const sa = find(v.root, (x) => x.tag === "input" && x.attrs.class === "hselall")!;
    assert.ok(find(v.root, (x) => x.tag === "label" && x.attrs.class === "hselallbox" && x.children.includes(sa)));
    for (const f of sa.on.click!) f({}); // some ticked (dash): clears all and leaves the mode
    assert.equal(v.boxes().length, 0);
    assert.equal((sa as N & { hidden?: boolean }).hidden, true);
    v.longPress(2);
    for (const r of [1, 3, 4]) v.click(r);
    assert.deepEqual(v.checked(), [true, true, true, true]);
    for (const f of sa.on.click!) f({}); // all ticked: clears all and leaves the mode
    assert.equal(v.boxes().length, 0);
    assert.equal((sa as N & { hidden?: boolean }).hidden, true);
  } finally {
    mock.timers.reset();
  }
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

test("History select all: empty, dash for some, check for all; a click on the dash clears all, on empty selects all, on check clears all", async () => {
  const v = await mount();
  const sa = () => find(v.root, (x) => x.tag === "input" && x.attrs.class === "hselall") as N & { checked?: boolean; indeterminate?: boolean; hidden?: boolean };
  assert.equal(sa().attrs.type, "checkbox");
  assert.deepEqual([sa().hidden, !!sa().checked, !!sa().indeterminate], [false, false, false]); // always above the top row on desktop
  v.click(2, {}, true);
  assert.deepEqual([!!sa().checked, !!sa().indeterminate], [false, true]);
  for (const f of sa().on.click!) f({});
  assert.deepEqual(v.checked(), [false, false, false, false]); // the checkboxes stay on desktop
  assert.deepEqual([!!sa().checked, !!sa().indeterminate, sa().hidden], [false, false, false]);
  for (const f of sa().on.click!) f({});
  assert.deepEqual(v.checked(), [true, true, true, true]);
  assert.deepEqual([!!sa().checked, !!sa().indeterminate], [true, false]);
  for (const f of sa().on.click!) f({});
  assert.deepEqual(v.checked(), [false, false, false, false]);
  assert.deepEqual([!!sa().checked, !!sa().indeterminate, sa().hidden], [false, false, false]); // it stays on desktop
});

test("History: the multi-select delete confirmation names the devices by the Sync deletions setting", async () => {
  for (const [sync, text] of [[true, "This deletes the selected messages off this and other paired devices."], [false, "This deletes the selected messages off this device."]] as const) {
    const msg = { id: 1, dir: "in", peer: "p1", sender: "Phone", type: "text", content: "m", n: 1, pairing_id: null, received: Date.now(), read: true };
    const data: Record<string, unknown> = { historyOpened: null, history: [msg], getSettings: { syncDeletions: sync } };
    const env = { call: async (m: { op: string }) => ({ ok: true, data: data[m.op] }) } as unknown as UiEnv;
    const root = new N("div");
    ua(false);
    await historyView(env, root as unknown as HTMLElement, undefined, { toDevices: () => undefined, toSend: () => undefined });
    for (const f of find(root, (x) => x.attrs.id === "h-1")!.on.click!) f({ target: Object.assign(find(find(root, (x) => x.attrs.id === "h-1")!, (x) => (x.attrs.class ?? "").includes("content"))!, { closest: (q: string) => (q === "input.hsel" ? {} : null) }), preventDefault() {}, stopPropagation() {} });
    const del = find(root, (x) => x.tag === "button" && (x.attrs.class ?? "").includes("dellight"))!;
    const p = Promise.all(del.on.click!.map((f) => (f as () => Promise<void>)()));
    await new Promise((r) => setImmediate(r));
    const dlg = [...(globalThis as unknown as { document: { body: N } }).document.body.kids].find((k) => k.tag === "dialog")!;
    assert.equal(find(dlg, (x) => x.tag === "p")!.textContent, text);
    void p;
    dlg.remove();
  }
});
