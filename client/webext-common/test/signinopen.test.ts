import assert from "node:assert/strict";
import { test } from "node:test";
import { N } from "./fakedom.ts";
import { uiEnv } from "../src/shellkit.ts";
import { signinCard } from "../src/ui/popup.ts";
import type { StateView } from "../src/core/rpc.ts";
import type { UiEnv } from "../src/ui/dom.ts";

const g = globalThis as unknown as Record<string, unknown>;
const st = { reg: "unregistered" } as unknown as StateView;
const texts = (n: N): string[] => (n.tag === "#text" ? [n.text] : n.kids.flatMap(texts));
const button = (n: N): N => (n.tag === "button" ? n : n.kids.map(button).find(Boolean)!);

function withUa<T>(ua: string, fn: () => T): T {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: ua }, configurable: true });
  try {
    return fn();
  } finally {
    if (saved) Object.defineProperty(globalThis, "navigator", saved);
  }
}

test("inPopup: Android and a popup page shown as a tab are not popups", () => {
  const b = (views: unknown[]) => ({ runtime: { getManifest: () => ({ name: "PushArmor" }) }, extension: { getViews: () => views } }) as never;
  withUa("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0", () => {
    assert.equal(uiEnv(b([globalThis])).inPopup!(), true);
    assert.equal(uiEnv(b([])).inPopup!(), false);
  });
  withUa("Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0", () => {
    assert.equal(uiEnv(b([globalThis])).inPopup!(), false);
  });
});

async function click(inPopup: boolean, open: () => Promise<void>) {
  const log: string[] = [];
  g.location = { assign: (u: string) => void log.push("assign " + u) };
  g.window = { close: () => void log.push("close") };
  const env = { inPopup: () => inPopup, openPage: async (h: string) => (log.push("open " + h), open()) } as unknown as UiEnv;
  try {
    const card = signinCard(env, st, false, false) as unknown as N;
    await button(card).on.click![0]!({});
    return { log, t: texts(card) };
  } finally {
    delete g.location;
    delete g.window;
  }
}

test("Log in outside a real popup (Firefox for Android) opens the login page in place", async () => {
  const { log, t } = await click(false, async () => undefined);
  assert.deepEqual(log, ["assign page.html#login"]);
  assert.ok(!t.includes("Opens in a new tab"));
});

test("Log in in a popup opens a tab and closes; if the tab cannot open, it logs in in place", async () => {
  const ok = await click(true, async () => undefined);
  assert.deepEqual(ok.log, ["open #login", "close"]);
  assert.ok(ok.t.includes("Opens in a new tab"));
  const bad = await click(true, () => Promise.reject(new Error("no tabs")));
  assert.deepEqual(bad.log, ["open #login", "assign page.html#login"]);
});
