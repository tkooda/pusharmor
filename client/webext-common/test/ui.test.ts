import assert from "node:assert/strict";
import { test } from "node:test";
import type { PeerView } from "../src/core/rpc.ts";
import { fitMiddle, nextTabIndex, peerStatus, platformLabel, shortTime } from "../src/ui/dom.ts";

const peer = (o: Partial<PeerView>): PeerView => ({
  id: "x", label: "Phone", platform: "android", lines: [], actions: [], countdown: null, fingerprint: null, pk: null,
  greyed: null, hidden: false, sendable: true, approvesMe: true, ...o,
});

test("peer status line by priority, replaced by pairing and note lines", () => {
  assert.deepEqual(peerStatus(peer({ greyed: "(missing)" })), { kind: "off", word: "(missing)" });
  assert.deepEqual(peerStatus(peer({ greyed: "signed out" })), { kind: "off", word: "Signed out" });
  assert.deepEqual(peerStatus(peer({ greyed: "unreachable" })), { kind: "off", word: "Unreachable" });
  assert.deepEqual(peerStatus(peer({})), { kind: "ok", word: "Connected" });
  assert.deepEqual(peerStatus(peer({ approvesMe: false, sendable: false })), { kind: "wait", word: "Has not approved this device" });
  assert.equal(peerStatus(peer({ greyed: "Declined by Phone" })), null); // note line takes its place
  assert.equal(peerStatus(peer({ lines: ["Pairing with Phone"] })), null);
  assert.equal(peerStatus(peer({ fingerprint: "K7QD" })), null);
  assert.equal(platformLabel("iphone"), "iPhone");
  assert.equal(platformLabel("firefox"), "Firefox");
});

test("middle ellipsis keeps head and tail with exactly one ...", () => {
  const url = "https://www.example.com/recipes/2026/10/weeknight-lemon-pasta";
  assert.equal(fitMiddle(url, (s) => s.length <= 80), url);
  const s = fitMiddle(url, (x) => x.length <= 30);
  assert.equal(s.length, 30);
  assert.equal(s.split("...").length, 2);
  assert.ok(s.startsWith("https://www.exampl")); // head two thirds
  assert.ok(s.endsWith("mon-pasta")); // tail one third
  assert.equal(fitMiddle(url, () => false), "...");
});

test("short History time: clock today, Yesterday, else month and day", () => {
  const now = new Date(2026, 9, 29, 15, 0).getTime();
  assert.equal(shortTime(new Date(2026, 9, 29, 9, 24).getTime(), now), new Date(2026, 9, 29, 9, 24).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
  assert.equal(shortTime(new Date(2026, 9, 28, 23, 59).getTime(), now), "Yesterday");
  assert.equal(shortTime(new Date(2026, 9, 1, 8, 0).getTime(), now), new Date(2026, 9, 1).toLocaleDateString([], { month: "short", day: "numeric" }));
});

test("History sender link is a keyboard-operable button with a visible focus ring", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/ui/popup.ts", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/ui/style.css", import.meta.url), "utf8");
  assert.match(src, /h\("button", \{ class: "who peerlink", type: "button" \}/); // native Tab, Enter and Space
  assert.match(src, /who\.addEventListener\("click"/); // click is what Enter and Space fire on a button
  assert.match(css, /^:focus-visible \{ outline: 2px solid/m); // global ring
  assert.doesNotMatch(css, /peerlink[^{]*\{[^}]*outline: ?none/);
});

test("status and error text is announced: live regions and field errors wired to inputs", async () => {
  const { readFileSync } = await import("node:fs");
  const rd = (f: string) => readFileSync(new URL("../src/ui/" + f, import.meta.url), "utf8");
  for (const f of ["popup.ts", "peersview.ts", "page.ts"]) assert.doesNotMatch(rd(f), /class: "status" \}/, f); // every status div has a role
  assert.match(rd("popup.ts"), /class: "result", role: "status"/);
  const page = rd("page.ts");
  assert.match(page, /setAttribute\("role", "alert"\)/); // bad help is an alert
  assert.match(page, /setAttribute\("aria-invalid", "true"\)/);
  assert.match(page, /describe\(email, emailHelp/);
  assert.match(page, /describe\(code, codeHelp/);
  assert.match(page, /setHelp\(emailHelp, bad, true, email\)/);
  assert.match(page, /setHelp\(codeHelp, msg[^\n]*, true, code\)/);
  assert.match(rd("peersview.ts"), /await redraw\(msg\)/); // the message survives the redraw
});

test("tab keys: arrows wrap, Home and End jump, others pass", () => {
  assert.equal(nextTabIndex("ArrowRight", 3, 4), 0);
  assert.equal(nextTabIndex("ArrowRight", 0, 4), 1);
  assert.equal(nextTabIndex("ArrowLeft", 0, 4), 3);
  assert.equal(nextTabIndex("Home", 2, 4), 0);
  assert.equal(nextTabIndex("End", 0, 4), 3);
  assert.equal(nextTabIndex("a", 0, 4), null);
});

test("popup tabs are a full tab widget; headings, main landmark, reduced motion", async () => {
  const { readFileSync } = await import("node:fs");
  const rd = (f: string) => readFileSync(new URL("../src/ui/" + f, import.meta.url), "utf8");
  const pop = rd("popup.ts");
  assert.match(pop, /role: "tabpanel"/);
  assert.match(pop, /"aria-controls": "panel"/);
  assert.match(pop, /"aria-labelledby", "tab-"/);
  assert.match(pop, /setAttribute\("tabindex", on \? "0" : "-1"\)/);
  assert.match(pop, /tabs\.addEventListener\("keydown"/);
  assert.match(rd("dom.ts"), /h\("h2", \{ class: "sh"/);
  for (const f of ["popup.html", "page.html"]) assert.match(rd(f), /<main id="app">/);
  assert.match(rd("style.css"), /prefers-reduced-motion: reduce/);
});

test("focus moves sensibly on view change, dialogs and errors", async () => {
  const { readFileSync } = await import("node:fs");
  const rd = (f: string) => readFileSync(new URL("../src/ui/" + f, import.meta.url), "utf8");
  const page = rd("page.ts");
  assert.match(page, /heading\.focus\(\)/); // done step and limit view
  assert.match(page, /h\("h1", \{ tabindex: "-1" \}/);
  const peers = rd("peersview.ts");
  assert.match(peers, /await redraw\(msg, p\.id\)/); // focus returns to the row after an action
  assert.match(peers, /\.sh"\)\)\?\.focus\(\)/); // or the first heading when the row is gone
  assert.match(peers, /edit\.focus\(\)/); // after Rename
  assert.match(peers, /\.keep"\)\?\.focus\(\)/); // remove confirm
  const pop = rd("popup.ts");
  assert.match(pop, /yes\.focus\(\)/); // delete all history confirm
  assert.match(pop, /"aria-label": "Unread"/);
  assert.match(pop, /content\.addEventListener\("keydown"/); // keyboard marks read
});
