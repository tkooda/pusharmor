import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { N } from "./fakedom.ts";
import { historyView, sendView } from "../src/ui/popup.ts";
import type { StateView } from "../src/core/rpc.ts";
import type { UiEnv } from "../src/ui/dom.ts";

const g = globalThis as unknown as Record<string, unknown>;
g.requestAnimationFrame ??= () => 0;
g.addEventListener ??= () => undefined;
const find = (n: N, f: (x: N) => boolean): N | undefined => (f(n) ? n : n.kids.map((k) => find(k, f)).find(Boolean));
const all = (n: N, f: (x: N) => boolean): N[] => [...(f(n) ? [n] : []), ...n.kids.flatMap((k) => all(k, f))];
const hasClass = (n: N, c: string) => n.cls.has(c) || (n.attrs.class ?? "").split(" ").includes(c);
const css = readFileSync(new URL("../src/ui/style.css", import.meta.url), "utf8");
const ID = " (123-456-789)";
// a label that cuts at its end: only the name part cuts; the ID is its own part that never shrinks
const parts = (el: N) => (hasClass(el, "idl") ? [find(el, (x) => hasClass(x, "nmx"))?.textContent, find(el, (x) => hasClass(x, "nid"))?.textContent] : [el.textContent]);

test("a name with its ID cuts only the name where a line ends in an ellipsis; the ID stays whole", async () => {
  assert.match(css, /\.idl > \.nmx \{ overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; \}/);
  assert.match(css, /\.idl > \.nid \{ flex: none; white-space: pre; \}/);
  // History: a received row's sender line, a row sent to one device, an event line
  const row = (id: number, x: Record<string, unknown>) => ({ id, dir: "in", peer: "p1", sender: "Phone" + ID, type: "text", content: "m" + id, n: 1, pairing_id: null, received: Date.now() - id, read: true, ...x });
  const hist = [row(1, {}), row(2, { dir: "out", peer: null, targets: ["p1"], results: { p1: "sent" } }), row(3, { type: "event", event: "logged_out" }), row(4, { sender: "Laptop" })];
  const env = { call: async (m: { op: string }) => ({ ok: true, data: ({ historyOpened: null, history: hist } as Record<string, unknown>)[m.op] }) } as unknown as UiEnv;
  const root = new N("div");
  await historyView(env, root as unknown as HTMLElement, undefined, { toDevices: () => undefined, toSend: () => undefined });
  const who = (id: number) => find(root, (x) => x.attrs.id === "h-" + id + "-who")!;
  assert.deepEqual(parts(who(1)), ["Phone", ID]);
  assert.deepEqual(parts(find(who(2), (x) => hasClass(x, "nm"))!), ["Phone", ID]);
  assert.equal(who(2).textContent, 'Sent to "Phone' + ID + '"');
  assert.deepEqual(parts(who(3)), ['"Phone', ID + '" logged out.']);
  assert.deepEqual(parts(who(4)), ["Laptop"]);
  // Send: the device chip and Send to "Name (ID)"
  const peer = { id: "p1", label: "Phone", chip: "Phone" + ID, platform: "android", lines: [], actions: [], countdown: null, fingerprint: null, pk: null, greyed: null, hidden: false, sendable: true, approvesMe: true, paired: true };
  (globalThis as unknown as { window: unknown }).window = { close: () => undefined };
  const senv = {
    inPopup: () => true,
    activeUrl: async () => "",
    call: async (m: { op: string }) => ({ ok: true, data: ({ peers: { peers: [peer] }, sendSel: ["p1"], sendSelSet: null, detect: { type: "text", bytes: 0 } } as Record<string, unknown>)[m.op] }),
  } as unknown as UiEnv;
  const s = new N("div");
  await sendView(senv, s as unknown as HTMLElement, { settings: { showAll: false } } as unknown as StateView, "");
  const chips = all(s, (x) => hasClass(x, "dchip")).map((c) => find(c, (x) => hasClass(x, "nm"))!);
  assert.deepEqual(chips.map(parts), [["Phone", ID]]);
  const label = find(s, (x) => hasClass(x, "lbl"))!;
  assert.equal(label.textContent, 'Send to "Phone' + ID + '"');
  assert.deepEqual(parts(find(label, (x) => hasClass(x, "who"))!), ["Phone", ID]);
});
