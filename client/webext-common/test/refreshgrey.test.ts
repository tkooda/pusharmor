import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { N } from "./fakedom.ts";
import { renderPeers } from "../src/ui/peersview.ts";
import type { UiEnv } from "../src/ui/dom.ts";

const all = (n: N): N[] => [n, ...n.kids.flatMap(all)];

test("Refresh: after a click it keeps its label and is greyed for 60 s, with no countdown", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  try {
    const ops: string[] = [];
    const env = { call: async (req: { op: string }) => (ops.push(req.op), { ok: true, data: req.op === "peers" ? { peers: [] } : null }) } as unknown as UiEnv;
    const root = new N("div");
    await renderPeers(env, root as unknown as HTMLElement, false);
    const btn = () => all(root).find((n) => n.tag === "button" && n.textContent === "Refresh") as unknown as HTMLButtonElement & N;
    assert.ok(btn() && !btn().disabled);
    for (const f of btn().on.click!) f({});
    for (let i = 0; i < 10 && ops.filter((o) => o === "peers").length < 2; i++) await new Promise((r) => setImmediate(r));
    assert.ok(ops.includes("refresh"));
    // the list was drawn again: the new button is greyed with the plain label
    assert.ok(btn(), "label stays Refresh");
    assert.equal(btn().disabled, true);
    mock.timers.tick(30_000);
    assert.equal(btn().textContent, "Refresh");
    assert.equal(btn().disabled, true);
    mock.timers.tick(30_000);
    assert.equal(btn().disabled, false);
    assert.equal(btn().textContent, "Refresh");
  } finally {
    mock.timers.reset();
  }
});
