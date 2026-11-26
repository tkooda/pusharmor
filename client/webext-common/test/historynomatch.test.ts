import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { N } from "./fakedom.ts";
import { historyView } from "../src/ui/popup.ts";
import { applyFilter, historyChips } from "../src/ui/historyfilter.ts";
import type { UiEnv } from "../src/ui/dom.ts";

const all = (n: N): N[] => [n, ...n.kids.flatMap(all)];
const hasClass = (n: N, c: string) => (n.attrs.class ?? "").split(" ").includes(c);
const inRow = (id: number, peer: string | null, sender: string) => ({ id, dir: "in", peer, sender, type: "text", content: "m" + id, n: 1, pairing_id: null, received: Date.now() - id, read: true });

async function draw(rows: object[], filter?: { key: string; label: string }): Promise<N> {
  const data: Record<string, unknown> = { historyOpened: null, history: rows, historyRead: null, peers: { peers: [] } };
  const env = { call: async (m: { op: string }) => ({ ok: true, data: data[m.op] }) } as unknown as UiEnv;
  const root = new N("div");
  await historyView(env, root as unknown as HTMLElement, undefined, { toDevices: () => undefined, toSend: () => undefined }, filter);
  return root;
}
const texts = (r: N) => all(r).map((n) => n.textContent);
const shown = (r: N) => all(r).filter((n) => hasClass(n, "hrow")).length;

test("History filter: a device or Unknown filter that matches nothing stays on, never All", () => {
  const rows = [{ dir: "in" as const, peer: "A", sender: "Phone" }, { dir: "out" as const, peer: null, sender: "" }];
  assert.deepEqual(applyFilter(rows, "B"), { key: "B", rows: [] });
  assert.deepEqual(applyFilter(rows, "unknown"), { key: "unknown", rows: [] });
  assert.deepEqual(applyFilter(rows, "all").rows, rows, "only All shows every row");
  // the filter in force stays a choice after its last row went, also when one device is left
  assert.deepEqual(historyChips(rows, { key: "B", label: "Laptop" }).map((c) => c.key), ["all", "B"]);
  assert.deepEqual(historyChips(rows, { key: "unknown", label: "Unknown" }).map((c) => c.key), ["all", "unknown"]);
});

test("History: a device filter whose messages were all deleted shows No matching messages, with the filter still chosen", async () => {
  const r = await draw([inRow(1, "A", "Phone"), inRow(2, "A", "Phone")], { key: "B", label: "Laptop" });
  assert.equal(shown(r), 0, "not All");
  const msg = all(r).find((n) => hasClass(n, "nomatch"))!;
  assert.equal(msg.textContent, "No matching messages");
  const sel = all(r).find((n) => n.tag === "select")!;
  assert.deepEqual(sel.kids.map((o) => o.textContent), ["All messages", 'From "Laptop"']);
  assert.equal(sel.kids.find((o) => o.attrs.selected !== undefined)!.textContent, 'From "Laptop"');
  assert.ok(!sel.attrs.hidden);
  const css = readFileSync(new URL("../src/ui/style.css", import.meta.url), "utf8");
  assert.match(css, /\.nomatch \{ padding: 32px 16px; text-align: center; color: var\(--ink2\); \}/);
});

test("History: an Unknown filter whose messages were all deleted shows No matching messages", async () => {
  const r = await draw([inRow(1, "A", "Phone"), inRow(2, "B", "Laptop")], { key: "unknown", label: "Unknown" });
  assert.equal(shown(r), 0);
  assert.ok(texts(r).includes("No matching messages"));
});

test("History: a filter on while the last message of History was deleted shows No matching messages, not the empty History screen", async () => {
  const r = await draw([], { key: "B", label: "Laptop" });
  assert.ok(texts(r).includes("No matching messages"));
  assert.ok(!texts(r).includes("No messages yet"));
  // a plain open of an empty History is unchanged
  assert.ok(texts(await draw([])).includes("No messages yet"));
});

test("History: a delete draws the list again with the filter that was on", () => {
  const pop = readFileSync(new URL("../src/ui/popup.ts", import.meta.url), "utf8");
  assert.match(pop, /await historyView\(env, root, undefined, nav, active\);/);
});
