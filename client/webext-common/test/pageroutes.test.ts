import assert from "node:assert/strict";
import { test } from "node:test";
import { N } from "./fakedom.ts";
import { mountPage, pageStart } from "../src/ui/page.ts";
import type { UiEnv } from "../src/ui/dom.ts";
import { memoryThemeStore } from "../src/ui/theme.ts";

const find = (n: N, f: (x: N) => boolean): N | undefined => (f(n) ? n : n.kids.map((k) => find(k, f)).find(Boolean));
const state = { reg: "registered", platform: "chrome", updateRequired: false, keysBroken: false, pushIssue: null };
const env = {
  call: async (m: { op: string }) => {
    const data: Record<string, unknown> = { state, popupOpen: state, popupSettled: null, peers: { peers: [{ id: "p1", paired: true }] }, history: [], historyOpened: null };
    return { ok: true, data: data[m.op] ?? null };
  },
  activeUrl: async () => "",
  openPage: () => undefined,
  inPopup: () => false,
  theme: memoryThemeStore("light"),
} as unknown as UiEnv;

async function draw(hash: string): Promise<N> {
  const root = new N("main");
  await mountPage(env, root as unknown as HTMLElement, hash, "chrome-extension://x");
  await new Promise((r) => setTimeout(r, 5)); // the first tab's view draws after the tab bar
  return root;
}

test("every page.html route that is one of the four views shows the tab bar with that tab selected", async () => {
  const cases: [string, string][] = [
    ["", "send"], // a plain open with a completed pairing
    ["#history", "history"],
    ["#history=7", "history"], // a message notification click
    ["#send=hello%20there", "send"], // over-cap send from the page menu
    ["#pair", "peers"],
    ["#peers", "peers"], // Open full view, a device change notice
    ["#peers=p1", "peers"], // a pairing or approval notice
    ["#unknown", "peers"],
  ];
  for (const [hash, tab] of cases) {
    const root = await draw(hash);
    const bar = find(root, (x) => x.attrs.role === "tablist");
    assert.ok(bar, hash + ": tab bar");
    assert.deepEqual(bar.kids.map((b) => b.textContent), ["Send", "History", "Devices", "Settings"], hash);
    assert.deepEqual(bar.kids.filter((b) => b.attrs["aria-selected"] === "true").map((b) => b.dataset.tab), [tab], hash);
  }
});

test("each route passes its target to the view: the message, the device to highlight, the text, Pair a new device", () => {
  assert.deepEqual(pageStart(""), {});
  assert.deepEqual(pageStart("history", "7"), { tab: "history", arg: "7" });
  assert.deepEqual(pageStart("send", "a%20b"), { tab: "send", arg: "a b" });
  assert.deepEqual(pageStart("send", "%E0%A4%A"), { tab: "send", arg: "" });
  assert.deepEqual(pageStart("pair"), { tab: "peers", openPair: true });
  assert.deepEqual(pageStart("peers", "p1"), { tab: "peers", arg: "p1" });
  assert.deepEqual(pageStart("bogus", "x"), { tab: "peers", arg: undefined });
});

test("the message view (View on a long text) stays a single view with its own Close", async () => {
  const root = await draw("#read=7");
  assert.equal(find(root, (x) => x.attrs.role === "tablist"), undefined);
  assert.ok(find(root, (x) => (x.attrs.class ?? "").includes("readview")));
});
