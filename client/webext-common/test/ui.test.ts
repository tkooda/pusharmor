import assert from "node:assert/strict";
import { test } from "node:test";
import type { PeerView } from "../src/core/rpc.ts";
import { fitMiddle, peerStatus, platformLabel, shortTime } from "../src/ui/dom.ts";

const peer = (o: Partial<PeerView>): PeerView => ({
  id: "x", label: "Phone", platform: "android", lines: [], actions: [], countdown: null, fingerprint: null, pk: null,
  greyed: null, hidden: false, sendable: true, approvesMe: true, ...o,
});

test("peer status line by priority, replaced by pairing and note lines", () => {
  assert.deepEqual(peerStatus(peer({ greyed: "(missing)" })), { kind: "off", word: "(missing)" });
  assert.deepEqual(peerStatus(peer({ greyed: "signed out" })), { kind: "off", word: "Signed out" });
  assert.deepEqual(peerStatus(peer({ greyed: "unreachable" })), { kind: "off", word: "Unreachable" });
  assert.deepEqual(peerStatus(peer({})), { kind: "ok", word: "Approves this device" });
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
