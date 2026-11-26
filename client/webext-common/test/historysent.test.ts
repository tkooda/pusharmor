import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { N } from "./fakedom.ts";
import { historyView } from "../src/ui/popup.ts";
import { T } from "../src/core/texts.ts";
import { Rpc } from "../src/core/rpc.ts";
import type { UiEnv } from "../src/ui/dom.ts";
import { Clock, MockWorker, device, pairAndApprove } from "./harness.ts";

const find = (n: N, f: (x: N) => boolean): N | undefined => (f(n) ? n : n.kids.map((k) => find(k, f)).find(Boolean));
const hasClass = (n: N, c: string) => (n.attrs.class ?? "").split(" ").includes(c);
const closest = (n: N) => (sel: string) => {
  for (let x: N | null = n; x; x = x.parent) {
    for (const s of sel.split(",").map((t) => t.trim())) if (s.startsWith(".") ? hasClass(x, s.slice(1)) : x.tag === s) return x;
  }
  return null;
};
const click = (on: N, target: N) => {
  for (const f of on.on.click ?? []) f({ target: Object.assign(target, { closest: closest(target) }), preventDefault() {}, stopPropagation() {} });
};
const out = (id: number, targets: string[], results: Record<string, string>, sender = "") =>
  ({ id, dir: "out", peer: null, sender, type: "text", content: "hi " + id, n: null, pairing_id: null, received: Date.now() - id, read: true, targets, results });

async function draw(rows: object[]): Promise<N> {
  const data: Record<string, unknown> = { historyOpened: null, history: rows, historyRead: null };
  const env = { call: async (m: { op: string }) => ({ ok: true, data: data[m.op] }) } as unknown as UiEnv;
  const root = new N("div");
  await historyView(env, root as unknown as HTMLElement, undefined, { toDevices: () => undefined, toSend: () => undefined });
  return root;
}

test("History title of a send to 2+ devices: Sent to N devices when all got it, Sent to S of N devices when some failed; one device unchanged", async () => {
  assert.equal(T.sentTitle(3, 3), "Sent to 3 devices");
  assert.equal(T.sentTitle(2, 2), "Sent to 2 devices");
  assert.equal(T.sentTitle(1, 3), "Sent to 1 of 3 devices");
  assert.equal(T.sentTitle(0, 1), "Sent to 0 of 1 device");
  const root = await draw([out(1, ["a", "b"], { a: "sent", b: "sent" }), out(2, ["a", "b", "c"], { a: "sent", b: "failed", c: "sent" }), out(3, ["a"], { a: "sent" }, "Phone")]);
  const who = (id: number) => find(find(root, (x) => x.attrs.id === "h-" + id)!, (x) => hasClass(x, "who"))!.textContent;
  assert.equal(who(1), "Sent to 2 devices");
  assert.equal(who(2), "Sent to 2 of 3 devices");
  assert.equal(who(3), 'Sent to "Phone"');
});

test("Recipients: a send to 2+ devices lists each device with Sent or Failed, just above the actions; it closes with the row and starts closed", async () => {
  const rows = [
    { ...out(1, ["a", "b"], { a: "sent", b: "failed" }), recipients: [{ name: "Laptop", ok: true }, { name: "Phone (123-456-789)", ok: false }] },
    out(2, ["a"], { a: "sent" }, "Laptop"),
  ];
  const root = await draw(rows);
  const row = find(root, (x) => x.attrs.id === "h-1")!;
  const rc = find(row, (x) => hasClass(x, "rcpt"))!;
  assert.equal(rc.tag, "details"); // its own button (summary) with the expanded or collapsed state, and the stock marker
  assert.ok(!rc.attrs.open);
  assert.equal(rc.kids[0]!.tag, "summary");
  assert.equal(rc.kids[0]!.textContent, "Recipients");
  const items = find(rc, (x) => x.tag === "ul")!.kids.map((li) => li.kids.map((k) => k.textContent));
  assert.deepEqual(items, [["Laptop", "Sent"], ["Phone (123-456-789)", "Failed"]]);
  const col = rc.parent!;
  assert.ok(hasClass(col.kids[col.kids.indexOf(rc) + 1]!, "acts"), "just above the action buttons");
  // a one-device send has none
  assert.equal(find(find(root, (x) => x.attrs.id === "h-2")!, (x) => hasClass(x, "rcpt")), undefined);
  // a tap on Recipients does not collapse the row; a tap elsewhere does, and closes the list
  const content = find(row, (x) => hasClass(x, "content"))!;
  click(row, content);
  assert.ok(row.cls.has("sel"));
  (rc as unknown as { open: boolean }).open = true;
  click(row, rc.kids[0]!);
  assert.ok(row.cls.has("sel"));
  click(row, content);
  assert.ok(!row.cls.has("sel"));
  assert.equal((rc as unknown as { open: boolean }).open, false);
  // another row's select also closes it
  click(row, content);
  (rc as unknown as { open: boolean }).open = true;
  const two = find(root, (x) => x.attrs.id === "h-2")!;
  click(two, find(two, (x) => hasClass(x, "content"))!);
  assert.equal((rc as unknown as { open: boolean }).open, false);
  // shown only on an open row
  const css = readFileSync(new URL("../src/ui/style.css", import.meta.url), "utf8");
  assert.match(css, /\.hrow:not\(\.sel\) \.rcpt \{ display: none; \}/);
});

test("Recipients names: each device of a send to 2+ devices with its name (ID on a clash) and whether it got the message", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const b = await device(w, clock);
  const c = await device(w, clock, "firefox");
  await pairAndApprove(w, a, b);
  await pairAndApprove(w, a, c);
  await a.e.send("hello", "auto", [b.id, c.id]);
  const rows = await new Rpc(a.e).history();
  const r = rows.find((x) => x.dir === "out" && x.type === "text")!;
  assert.deepEqual(r.recipients?.map((x) => [x.name, x.ok]).sort(), [["Chrome", true], ["Firefox", true]]);
  await a.e.send("one", "auto", [b.id]);
  assert.equal((await new Rpc(a.e).history()).find((x) => x.content === "one")!.recipients, undefined);
});

test("History: selecting another row marks the row it closes collapsed for screen readers; focus never shows a collapsed row's actions", async () => {
  const msg = (id: number) => ({ id, dir: "in", peer: "p1", sender: "Phone", type: "text", content: "m" + id, n: 1, pairing_id: null, received: Date.now() - id, read: true });
  const root = await draw([msg(1), msg(2)]);
  const a = find(root, (x) => x.attrs.id === "h-1")!;
  const b = find(root, (x) => x.attrs.id === "h-2")!;
  const content = (t: N) => find(t, (x) => hasClass(x, "content"))!;
  click(a, content(a));
  assert.equal(content(a).attrs["aria-expanded"], "true");
  click(b, content(b));
  assert.equal(content(b).attrs["aria-expanded"], "true");
  assert.equal(content(a).attrs["aria-expanded"], "false");
  const css = readFileSync(new URL("../src/ui/style.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /:focus-within \.acts \{ display: flex/);
});
