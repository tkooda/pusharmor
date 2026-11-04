import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { clickTarget, historyAt } from "../src/core/actions.ts";
import type { Engine } from "../src/core/engine.ts";
import { onNotificationClick } from "../src/shellkit.ts";
import type { HistoryRow } from "../src/store/db.ts";
import type { Browser } from "../src/shim-types.ts";
import { senderAllowed } from "../../firefox/src/gate.ts";
import { fxShowView } from "../../firefox/src/sitefwd/fwd.ts";

const row = (id: number, o: Partial<HistoryRow> = {}): HistoryRow => ({ id, dir: "in", peer: "p1", type: "text", content: "hello", n: 1, pairing_id: null, received: id, read: false, ...o });

function fakeEngine(rows: HistoryRow[]) {
  const put: HistoryRow[] = [];
  const engine = {
    db: { get: async (_s: string, id: number) => rows.find((r) => r.id === id), put: async (_s: string, r: HistoryRow) => void put.push(r) },
    updateBadge: async () => undefined,
  } as unknown as Engine;
  return { engine, put };
}

test("a message notification click opens the tabs on History at that message; a URL opens the URL", async () => {
  const { engine, put } = fakeEngine([row(7), row(8, { type: "tel", content: "+15550100" }), row(9, { type: "event", event: "logged_out" }), row(10, { type: "url", content: "https://example.com/" })]);
  assert.deepEqual(await clickTarget(engine, "h:7"), { tabs: "popup.html#history=7" });
  assert.deepEqual(await clickTarget(engine, "h:8"), { tabs: "popup.html#history=8" });
  assert.deepEqual(await clickTarget(engine, "h:9"), { tabs: "popup.html#history=9" });
  assert.deepEqual(await clickTarget(engine, "h:10"), { url: "https://example.com/" });
  assert.deepEqual(put.map((r) => [r.id, r.read]), [[7, true], [8, true], [10, true]]); // events keep their state
  assert.equal(await clickTarget(engine, "h:99"), null);
  assert.equal(historyAt(), "popup.html#history");
});

test("Chrome and Firefox open the same tab for a message notification click", async () => {
  const { engine } = fakeEngine([row(7)]);
  const created: string[] = [];
  const cleared: string[] = [];
  const b = {
    notifications: { clear: async (id: string) => void cleared.push(id) },
    tabs: { create: async (p: { url: string }) => void created.push(p.url) },
    runtime: { getURL: (p: string) => "moz-extension://x/" + p },
  } as unknown as Browser;
  onNotificationClick(b, async () => ({ engine }) as never)("h:7");
  for (let i = 0; i < 20 && !created.length; i++) await new Promise((r) => setTimeout(r, 1));
  assert.deepEqual(created, ["moz-extension://x/popup.html#history=7"]);
  assert.deepEqual(cleared, ["h:7"]);
  const rd = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
  assert.match(rd("../../chrome/src/sw.ts"), /notifications\.onClicked\.addListener\(onNotificationClick\(browser, boot\)\)/);
  assert.match(rd("../../firefox/src/background.ts"), /notifications\.onClicked\.addListener\(onNotificationClick\(browser, boot\)\)/);
});

test("the popup opened in a tab as popup.html#history=<id> starts on History at that message", () => {
  const pop = readFileSync(new URL("../src/ui/popup.ts", import.meta.url), "utf8");
  assert.match(pop, /const first: Tab = route === "history" \? "history" :/);
  assert.match(pop, /if \(t === "history"\) ready = historyView\(env, pane, focus, nav\);/);
  assert.match(pop, /void show\(first, false, route === "history" \? at : undefined\)/);
  assert.match(pop, /if \(focus\) document\.getElementById\("h-" \+ focus\)\?\.scrollIntoView/);
});

test("Firefox for Android: /fx/open from the site notification turns into the tabs on History at the newest received message", () => {
  const rows = [row(12, { type: "event", event: "logged_in" }), row(11, { dir: "out" }), row(10), row(9)];
  assert.equal(fxShowView(rows), "popup.html#history=10");
  assert.equal(fxShowView([row(3, { dir: "out" })]), "popup.html#history");
  assert.equal(fxShowView([]), "popup.html#history");
  const id = "pusharmor@example";
  const base = "moz-extension://1111-2222/";
  const site = (path: string) => ({ id, url: "https://pusharmor.com" + path, tab: { id: 7 } });
  assert.equal(senderAllowed("fx-show", site("/fx/open"), id, base), true);
  assert.equal(senderAllowed("fx-show", site("/fx/setup"), id, base), false);
  assert.equal(senderAllowed("fx-show", site("/auth/done"), id, base), false);
  const cs = readFileSync(new URL("../../firefox/src/sitefwd/cs.ts", import.meta.url), "utf8");
  assert.match(cs, /window\.postMessage\(\{ pa: "fx-ready" \}, SITE\);\s*showSoon\(\);/); // nothing waiting: shows after the quiet time
  assert.match(cs, /clearTimeout\(idle\);\s*void relayWake\("fx-msg"/); // a message in flight holds it back
  assert.match(cs, /\.finally\(showSoon\)/);
  assert.match(readFileSync(new URL("../../firefox/src/background.ts", import.meta.url), "utf8"), /tabs\.update\(sender\.tab\.id, \{ url: browser\.runtime\.getURL\(fxShowView\(await engine\.db\.history\(\)\)\) \}\)/);
});
