// In-flight guards, focus kept across the live Devices redraw, screen reader names, touch hover.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { N } from "./fakedom.ts";
import { historyView } from "../src/ui/popup.ts";
import type { UiEnv } from "../src/ui/dom.ts";

const rd = (f: string) => readFileSync(new URL("../src/" + f, import.meta.url), "utf8");
const popup = rd("ui/popup.ts");
const page = rd("ui/page.ts");
const peers = rd("ui/peersview.ts");

const find = (n: N, f: (x: N) => boolean): N | undefined => (f(n) ? n : n.kids.map((k) => find(k, f)).find(Boolean));

test("Continue with Google and Continue with Apple are off while one runs", () => {
  const oauth = page.slice(page.indexOf("const oauth = "), page.indexOf("const title = "));
  assert.match(oauth, /for \(const b of oauthBtns\) b\.disabled = true;\s+oauthBar\.start\(undefined, [^\n]*\);/);
  assert.match(oauth, /finally \{\s+oauthBar\.stop\(\);\s+for \(const b of oauthBtns\) b\.disabled = false;/);
  assert.match(oauth, /const oauthBtns = \[\s+h\("button", \{ type: "button", class: "big google"[^\n]*\n\s+h\("button", \{ type: "button", class: "big apple"/);
  assert.match(page, /\.\.\.oauthBtns,\s+oauthBar\.el,/);
});

test("Log out is off while it runs", () => {
  const out = popup.slice(popup.indexOf("const logOut = "), popup.indexOf('"Log out") as HTMLButtonElement'));
  assert.match(out, /logOut\.disabled = true;\s+outBar\.start\(STEP\.loggingOut\);/);
  assert.match(out, /finally \{\s+outBar\.stop\(\);\s+logOut\.disabled = false;/);
});

test("Settings on Firefox no longer shows the receive mode line; the receive note stays", () => {
  assert.ok(!popup.includes("Receive mode: "));
  assert.ok(popup.includes('ff && st.receiveNote ? h("div", { class: "t2" }, st.receiveNote) : null,'));
});

test("History: the content is a button, and each checkbox is named by its row's sender and content", async () => {
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0" }, configurable: true });
  const msg = (id: number) => ({ id, dir: "in", peer: "p1", sender: "Phone", type: "text", content: "m" + id, n: 1, pairing_id: null, received: Date.now() - id, read: true });
  const data: Record<string, unknown> = { historyOpened: null, history: [1, 2].map(msg) };
  const env = { call: async (m: { op: string }) => ({ ok: true, data: data[m.op] }) } as unknown as UiEnv;
  const root = new N("div");
  await historyView(env, root as unknown as HTMLElement, undefined, { toDevices: () => undefined, toSend: () => undefined });
  for (const id of [1, 2]) {
    const row = find(root, (x) => x.attrs.id === "h-" + id)!;
    const box = find(row, (x) => x.tag === "input" && x.attrs.class === "hsel")!;
    assert.equal(box.attrs["aria-label"], undefined);
    assert.equal(box.attrs["aria-labelledby"], "h-" + id + "-who h-" + id + "-c");
    const who = find(row, (x) => x.attrs.id === "h-" + id + "-who")!;
    assert.equal(who.textContent, "Phone");
    const content = find(row, (x) => x.attrs.id === "h-" + id + "-c")!;
    assert.equal(content.attrs.role, "button");
    assert.equal(content.textContent, "m" + id);
  }
});

test("Devices live redraw: waits while a row menu is open, and gives focus back to the same row and control", () => {
  const tick = peers.slice(peers.indexOf("const timer = setInterval"), peers.indexOf("fpTimer = timer;"));
  assert.match(tick, /if \(root\.querySelector\("\.more \.menu"\)\) return;\s+const active = /);
  assert.ok(tick.indexOf('closest<HTMLElement>(\'[id^="peer-"]\')') < tick.indexOf("await renderPeers"));
  assert.match(tick, /const again = document\.getElementById\(row\.id\);/);
  assert.match(tick, /\(same \?\? again \?\? root\.querySelector<HTMLElement>\("\.fp-title, \.sh"\)\)\?\.focus\(\);/);
});

test("Devices in a full tab has no Open full view button", () => {
  assert.ok(peers.includes('!full && env.inPopup?.() !== false && h("button", { onclick: () => env.openPage("#peers") }, "Open full view")'));
});

test("hover fills apply only where the pointer can hover, so a tap leaves no grey fill", () => {
  const css = rd("ui/style.css");
  assert.ok(css.includes("@media (hover: hover) { button:hover { background: var(--s1); } }"));
  assert.ok(css.includes("@media (hover: hover) { .chip.dchip:hover { background: var(--s1); } }"));
  assert.doesNotMatch(css, /^button:hover \{/m);
  assert.doesNotMatch(css, /^\.chip\.dchip:hover \{/m);
});
