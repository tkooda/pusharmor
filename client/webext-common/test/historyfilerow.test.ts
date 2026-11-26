import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { N } from "./fakedom.ts";
import { historyView } from "../src/ui/popup.ts";
import type { UiEnv } from "../src/ui/dom.ts";

const g = globalThis as unknown as Record<string, unknown>;
g.requestAnimationFrame ??= () => 0;
g.addEventListener ??= () => undefined;

const find = (n: N, f: (x: N) => boolean): N | undefined => (f(n) ? n : n.kids.map((k) => find(k, f)).find(Boolean));
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
const css = readFileSync(new URL("../src/ui/style.css", import.meta.url), "utf8");
// the texts a row shows: the stylesheet hides class "xd" in a row that is not open
const shown = (row: N): string[] => {
  const out: string[] = [];
  const walk = (n: N) => {
    if (!row.cls.has("sel") && hasClass(n, "xd")) return;
    if (n.tag === "#text" || n.text) out.push(n.tag === "#text" ? n.text : n.text);
    for (const k of n.kids) walk(k);
  };
  walk(row);
  return out.filter((t) => t.trim());
};

const H = 3600;
const file = (name: string, size: number) => ({ url: "https://b2file.pusharmor.com/v1/x", expires: Math.floor(Date.now() / 1000) + 2 * H, key: "k", name, size, sha256: "s" });
const fileRow = (id: number, dir: "in" | "out", name: string, fs: Record<string, unknown> | undefined) =>
  ({ id, dir, peer: "p1", sender: "Phone", type: "file", content: name, file: file(name, 2_100_000), fs, n: 1, pairing_id: null, received: Date.now() - id, read: true, targets: ["p1"], results: { p1: "sent" } });

test("a collapsed History file row shows only the sender line and the file name; its size, type, and expiry show when the row is opened", async () => {
  assert.match(css, /\.hrow:not\(\.sel\) \.xd \{ display: none; \}/);
  const data: Record<string, unknown> = { historyOpened: null, history: [fileRow(1, "in", "report.pdf", {}), fileRow(2, "out", "sent.pdf", undefined), fileRow(3, "in", "bad.pdf", { code: "failed", text: "Download failed" })], historyRead: null };
  const env = { call: async (m: { op: string }) => ({ ok: true, data: data[m.op] }) } as unknown as UiEnv;
  const root = new N("div");
  await historyView(env, root as unknown as HTMLElement, undefined, { toDevices: () => undefined, toSend: () => undefined });
  const rows = [1, 2, 3].map((id) => find(root, (x) => x.attrs.id === "h-" + id)!);
  const detail = (t: string) => t.startsWith("2.1 MB") || t.startsWith("expires in");
  for (const r of rows) assert.deepEqual(shown(r).filter(detail), [], shown(r).join("|"));
  // Download, and the error line, stay visible while collapsed
  assert.ok(shown(rows[0]).includes("Download"), shown(rows[0]).join("|"));
  assert.ok(shown(rows[2]).includes("Download failed") && shown(rows[2]).includes("Download"), shown(rows[2]).join("|"));
  assert.ok(shown(rows[1]).includes("sent.pdf"));
  const content = (r: N) => find(r, (x) => hasClass(x, "content"))!;
  click(rows[0], content(rows[0]));
  assert.deepEqual(shown(rows[0]).filter(detail), ["2.1 MB - PDF", "expires in 2 h"]);
  click(rows[1], content(rows[1]));
  assert.deepEqual(shown(rows[1]).filter(detail), ["2.1 MB - PDF", "expires in 2 h"]);
  assert.deepEqual(shown(rows[0]).filter(detail), []);
  click(rows[2], content(rows[2]));
  assert.deepEqual(shown(rows[2]).filter(detail), ["2.1 MB - PDF", "expires in 2 h"]);
});
