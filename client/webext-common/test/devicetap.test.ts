import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { N } from "./fakedom.ts";
import { renderPeers } from "../src/ui/peersview.ts";
import { sendView } from "../src/ui/popup.ts";
import { detectType } from "../src/model/detect.ts";
import type { StateView } from "../src/core/rpc.ts";
import type { UiEnv } from "../src/ui/dom.ts";

const all = (n: N): N[] => [n, ...n.kids.flatMap(all)];
const find = (n: N, f: (x: N) => boolean): N | undefined => all(n).find(f);
const hasClass = (n: N, c: string) => n.cls.has(c) || (n.attrs.class ?? "").split(" ").includes(c);
const closest = (n: N) => (sel: string) => {
  for (let x: N | null = n; x; x = x.parent) {
    for (const s of sel.split(",").map((t) => t.trim())) if (s.startsWith(".") ? hasClass(x, s.slice(1)) : x.tag === s) return x;
  }
  return null;
};
const click = (on: N, target: N) => {
  for (const f of on.on.click ?? []) f({ target: Object.assign(target, { closest: closest(target) }), preventDefault() {}, stopPropagation() {} });
};
const peer = (over: object) => ({ id: "p1", label: "Phone", platform: "android", lines: [], actions: [], countdown: null, fingerprint: null, pk: null, greyed: null, hidden: false, sendable: true, approvesMe: true, paired: true, section: "paired", ...over });
const tick = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

async function draw(peers: object[], toSend?: (id: string) => void): Promise<N> {
  const env = { call: async () => ({ ok: true, data: { self: { id: "me", name: "Me" }, peers } }) } as unknown as UiEnv;
  const root = new N("div");
  await renderPeers(env, root as unknown as HTMLElement, false, undefined, undefined, false, toSend);
  return root;
}

test("Devices: a paired device's status icons sit at the right end of its status line, wrapping only when they do not fit", async () => {
  const r = await draw([peer({})]);
  const stat = find(r, (x) => hasClass(x, "stat"))!;
  const line = stat.parent!;
  assert.ok(hasClass(line, "sline"), "on the status line");
  assert.ok(line.textContent.startsWith("Paired"));
  const css = readFileSync(new URL("../src/ui/style.css", import.meta.url), "utf8");
  assert.match(css, /\.sline \{ display: flex; flex-wrap: wrap;[^}]*\}/);
  assert.match(css, /\.sline \.stat \{ margin-left: auto; \}/);
});

test("Devices: a tap on a paired device card opens Send with that device; buttons and devices not paired do not", async () => {
  const opened: string[] = [];
  const r = await draw([peer({}), peer({ id: "p2", label: "Tablet", paired: false, section: "waiting", approvesMe: false, actions: ["pair", "deny"] })], (id) => void opened.push(id));
  const card = find(r, (x) => x.attrs.id === "peer-p1")!;
  click(card, find(card, (x) => hasClass(x, "name"))!);
  assert.deepEqual(opened, ["p1"]);
  click(card, find(card, (x) => x.tag === "button")!); // the More menu button
  assert.deepEqual(opened, ["p1"]);
  const other = find(r, (x) => x.attrs.id === "peer-p2")!;
  assert.deepEqual(other.on.click ?? [], []);
});

async function mountSend(sel: string[], pick: string, hold: boolean, result = { sent: 1, total: 1, failures: [] }) {
  const saves: unknown[] = [];
  (globalThis as unknown as { window: unknown }).window = { close: () => undefined };
  const peers = [peer({}), peer({ id: "p2", label: "Tablet" }), peer({ id: "p3", label: "Laptop" })];
  const env = {
    inPopup: () => false,
    activeUrl: async () => "",
    call: async (m: { op: string; args?: Record<string, unknown> }) => {
      if (m.op === "sendSelSet") saves.push(m.args!.ids);
      const text = String(m.args?.text ?? "");
      const data: Record<string, unknown> = { peers: { peers }, sendSel: sel, sendSelSet: null, detect: { type: detectType(text), bytes: text.length }, send: result };
      return { ok: true, data: data[m.op] };
    },
  } as unknown as UiEnv;
  const root = new N("div");
  await sendView(env, root as unknown as HTMLElement, { settings: { showAll: true } } as unknown as StateView, "", undefined, pick, hold);
  const chips = () => find(root, (x) => x.attrs.class === "dchips")!.kids;
  const on = () => chips().filter((c) => c.classList.contains("on")).map((c) => c.attrs.title);
  const field = find(root, (x) => x.tag === "textarea") as N & { value: string };
  const sendBtn = find(root, (x) => x.tag === "button" && (x.attrs.class ?? "").includes("primary"))!;
  const send = async (text: string) => {
    field.value = text;
    for (const f of field.on.input!) f({});
    await tick();
    for (const f of sendBtn.on.click!) f({});
    await tick();
  };
  const tap = (title: string) => {
    for (const f of chips().find((c) => c.attrs.title === title)!.on.click!) f({});
  };
  return { on, saves, send, tap };
}

test("Send from a device card: only that device's chip is selected; the saved selection changes only when a send goes", async () => {
  const v = await mountSend(["p2", "p3"], "p1", true);
  assert.deepEqual(v.on(), ["Phone"]);
  v.tap("Tablet");
  await tick();
  assert.deepEqual(v.saves, [], "a chip change is not saved");
  await v.send("hello");
  assert.deepEqual(v.saves, [["p1", "p2"]], "a send that went saves the selection");
  // a send that went to no device saves nothing
  const w = await mountSend(["p2"], "p1", true, { sent: 0, total: 1, failures: [{ id: "p1", result: "failed", text: "x" }] } as never);
  await w.send("hello");
  assert.deepEqual(w.saves, []);
  // a normal open keeps the saved selection, and a chip change saves at once
  const n = await mountSend(["p2", "p3"], undefined as unknown as string, false);
  assert.deepEqual(n.on(), ["Laptop", "Tablet"]);
  n.tap("Phone");
  await tick();
  assert.equal(n.saves.length, 1);
});
