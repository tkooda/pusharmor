import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { N } from "./fakedom.ts";
import { historyView } from "../src/ui/popup.ts";
import type { UiEnv } from "../src/ui/dom.ts";

const find = (n: N, f: (x: N) => boolean): N | undefined => (f(n) ? n : n.kids.map((k) => find(k, f)).find(Boolean));

async function mount() {
  const msg = { id: 1, dir: "in", peer: "p1", sender: "Phone", type: "text", content: "x".repeat(400), n: 1, pairing_id: null, received: Date.now(), read: true };
  const data: Record<string, unknown> = { historyOpened: null, history: [msg] };
  const env = { call: async (m: { op: string }) => ({ ok: true, data: data[m.op] }) } as unknown as UiEnv;
  const root = new N("div");
  await historyView(env, root as unknown as HTMLElement, undefined, { toDevices: () => undefined, toSend: () => undefined });
  const row = find(root, (x) => x.attrs.id === "h-1")!;
  const checks = () => !!find(root, (x) => x.tag === "input" && x.attrs.class === "hsel");
  const fire = (name: string, ev: Record<string, unknown>) => {
    const target = { closest: () => null, clientWidth: 300, clientHeight: 60, ...((ev.target as object) ?? {}) };
    for (const f of row.on[name] ?? []) f({ button: 0, clientX: 10, clientY: 10, offsetX: 5, offsetY: 5, ...ev, target });
  };
  return { fire, checks };
}

test("long-press selects a row; a scrollbar press, a move, or a scroll during the press does not", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let v = await mount();
    v.fire("pointerdown", {});
    mock.timers.tick(600);
    assert.equal(v.checks(), true, "a plain long-press selects");

    v = await mount();
    v.fire("pointerdown", { offsetX: 300 }); // on the vertical scrollbar
    mock.timers.tick(600);
    assert.equal(v.checks(), false, "vertical scrollbar");

    v = await mount();
    v.fire("pointerdown", { offsetY: 60 }); // on the horizontal scrollbar
    mock.timers.tick(600);
    assert.equal(v.checks(), false, "horizontal scrollbar");

    v = await mount();
    v.fire("pointerdown", {});
    v.fire("pointermove", { clientY: 40 });
    mock.timers.tick(600);
    assert.equal(v.checks(), false, "moved");

    v = await mount();
    v.fire("pointerdown", {});
    v.fire("scroll", {});
    mock.timers.tick(600);
    assert.equal(v.checks(), false, "scrolled");
  } finally {
    mock.timers.reset();
  }
});
