import assert from "node:assert/strict";
import { test } from "node:test";
import { lazyBoot, notificationsBlocked, onRuntimeMessage, uiEnv } from "../src/shellkit.ts";

test("openPage: an open tab on the same page is focused and reloaded", async () => {
  const log: string[] = [];
  const url = "chrome-extension://x/page.html#signin";
  const b = {
    runtime: {
      getURL: (p: string) => "chrome-extension://x/" + p,
      getContexts: async () => [{ documentUrl: url, tabId: 7, windowId: 3 }],
      getManifest: () => ({ name: "PushArmor", version: "0.0.19" }),
    },
    tabs: {
      update: async (id: number) => void log.push("update " + id),
      reload: async (id: number) => void log.push("reload " + id),
      create: async () => void log.push("create"),
    },
    windows: { update: async (id: number) => void log.push("window " + id) },
  };
  await uiEnv(b as never).openPage("#signin");
  assert.deepEqual(log, ["update 7", "window 3", "reload 7"]);
});

test("openPage on Firefox for Android: the full screen popup goes to the page itself, no tab opens behind it", async () => {
  const log: string[] = [];
  const g = globalThis as { location?: unknown; navigator?: unknown };
  const savedLoc = Object.getOwnPropertyDescriptor(globalThis, "location");
  const savedNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0" }, configurable: true });
  Object.defineProperty(globalThis, "location", { value: { pathname: "/popup.html", assign: (u: string) => void log.push("assign " + u) }, configurable: true });
  try {
    const b = {
      runtime: { getURL: (p: string) => "moz-extension://x/" + p, getContexts: async () => [], getManifest: () => ({ name: "PushArmor", version: "0.0.19" }) },
      tabs: { create: async () => void log.push("create") },
    };
    await uiEnv(b as never).openPage("#peers");
    assert.deepEqual(log, ["assign moz-extension://x/page.html#peers"]);
  } finally {
    if (savedLoc) Object.defineProperty(globalThis, "location", savedLoc);
    else delete g.location;
    if (savedNav) Object.defineProperty(globalThis, "navigator", savedNav);
  }
});

test("a failed database open does not stick: the next call tries again, the caller gets an error reply", async () => {
  assert.equal(typeof (globalThis as { indexedDB?: unknown }).indexedDB, "undefined"); // node: the open fails
  const boot = lazyBoot(() => ({}) as never, new Uint8Array(0));
  const first = boot();
  await assert.rejects(first);
  const second = boot();
  assert.notEqual(second, first); // a rejected promise is not cached
  await assert.rejects(second);
  const reply = await new Promise<{ ok?: boolean; error?: string }>((resolve) => {
    onRuntimeMessage(boot)({ op: "state" }, {} as never, resolve as never);
  });
  assert.equal(reply.ok, false);
  assert.match(reply.error ?? "", /database/i);
});

test("a start that fails after the database opened closes the connection", async () => {
  const { IDBFactory, IDBDatabase } = await import("fake-indexeddb");
  const g = globalThis as { indexedDB?: unknown };
  const saved = g.indexedDB;
  g.indexedDB = new IDBFactory();
  let closed = 0;
  const orig = IDBDatabase.prototype.close;
  IDBDatabase.prototype.close = function (this: InstanceType<typeof IDBDatabase>) {
    closed++;
    return orig.call(this);
  };
  try {
    const boot = lazyBoot(() => ({ get platformName(): string { throw new Error("boom"); } }) as never, new Uint8Array(0));
    await assert.rejects(boot(), /boom/);
    await assert.rejects(boot(), /boom/);
    assert.equal(closed, 2); // one per failed try
  } finally {
    IDBDatabase.prototype.close = orig;
    g.indexedDB = saved;
  }
});

/** Fake menus API: removeAll settles later (async, as in the browser); a duplicate id is an error. */
function fakeMenus() {
  const items = new Map<string, string>();
  const errors: string[] = [];
  const menus = {
    removeAll: async () => {
      await null;
      items.clear();
    },
    create: (p: { id: string; title: string }) => {
      if (items.has(p.id)) errors.push("duplicate id " + p.id);
      items.set(p.id, p.title);
    },
  };
  return { items, errors, menus };
}

test("context menu rebuilds run one after another: the last list wins, no duplicate ids", async () => {
  const { basePlatform } = await import("../src/shellkit.ts");
  const m = fakeMenus();
  const b = { runtime: { getManifest: () => ({ version: "0.0.19" }) }, storage: { local: {}, session: {} }, menus: m.menus };
  const p = basePlatform(b as never, "firefox", false, {} as never);
  p.menusRebuild([{ id: "A", name: "Old" }], true);
  p.menusRebuild([{ id: "B", name: "New" }], false);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(m.errors, []);
  const ids = [...m.items.keys()];
  assert.ok(!ids.some((id) => id.endsWith("|all") || id.endsWith("|A")));
  assert.ok(ids.some((id) => id.endsWith("|B")));
});

test("context menu offers All devices only when a device is listed", async () => {
  const { basePlatform } = await import("../src/shellkit.ts");
  const m = fakeMenus();
  const b = { runtime: { getManifest: () => ({ version: "0.0.19" }) }, storage: { local: {}, session: {} }, menus: m.menus };
  const p = basePlatform(b as never, "firefox", false, {} as never);
  p.menusRebuild([], true);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(![...m.items.keys()].some((id) => id.endsWith("|all")));
  p.menusRebuild([{ id: "A", name: "One" }], true);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok([...m.items.keys()].some((id) => id.endsWith("|all")));
});

test("a menu click after a wipe shows the error in a notification, no unhandled rejection", async () => {
  const { onMenuClick } = await import("../src/shellkit.ts");
  const { UserError } = await import("../src/core/engine.ts");
  const { T } = await import("../src/core/texts.ts");
  const notes: string[] = [];
  const engine = {
    send: async () => {
      throw new UserError(T.signedOut);
    },
    p: { notify: (id: string, _t: string, body: string) => void notes.push(id + ": " + body), setBadge: () => undefined },
  };
  const rejected: unknown[] = [];
  const onRej = (e: unknown) => void rejected.push(e);
  process.on("unhandledRejection", onRej);
  try {
    onMenuClick({} as never, async () => ({ engine }) as never, async () => "")({ menuItemId: "pa-page|all", pageUrl: "https://example.com/" } as never);
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off("unhandledRejection", onRej);
  }
  assert.deepEqual(rejected, []);
  assert.deepEqual(notes, ["send-result: " + T.signedOut]);
});

test("a huge selection opens the send window with a URL below the browser limit", async () => {
  const { onMenuClick } = await import("../src/shellkit.ts");
  const urls: string[] = [];
  const b = {
    runtime: { getURL: (p: string) => "chrome-extension://x/" + p },
    tabs: { create: async (o: { url: string }) => void urls.push(o.url) },
  };
  const engine = { p: { notify: () => undefined, setBadge: () => undefined } };
  onMenuClick(b as never, async () => ({ engine }) as never, async () => "\u00e9".repeat(400000))({ menuItemId: "pa-sel|all", selectionText: "x" } as never);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(urls.length, 1);
  assert.ok(urls[0]!.length < 2 * 1024 * 1024);
});

test("a selection is re-read in the tab even when it is short", async () => {
  const { readTabSelection } = await import("../src/shellkit.ts");
  const b = { scripting: { executeScript: async () => [{ result: "line one\nline two" }] } };
  assert.equal(await readTabSelection(b as never, { id: 3 } as never, "line one line two"), "line one\nline two");
  const bad = { scripting: { executeScript: async () => Promise.reject(new Error("no access")) } };
  assert.equal(await readTabSelection(bad as never, { id: 3 } as never, "short"), "short");
  assert.equal(await readTabSelection({} as never, { id: 3 } as never, "short"), "short");
});

test("closeTab: the add-on closes its own tab; Firefox for Android goes to the main view when it cannot", async () => {
  const log: string[] = [];
  const g = globalThis as { location?: unknown; navigator?: unknown; window?: unknown };
  const savedLoc = Object.getOwnPropertyDescriptor(globalThis, "location");
  const savedNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const savedWin = Object.getOwnPropertyDescriptor(globalThis, "window");
  const ua = (s: string) => Object.defineProperty(globalThis, "navigator", { value: { userAgent: s }, configurable: true });
  Object.defineProperty(globalThis, "location", { value: { assign: (u: string) => void log.push("assign " + u) }, configurable: true });
  Object.defineProperty(globalThis, "window", { value: { close: () => void log.push("close") }, configurable: true });
  const b = (remove: (id: number) => Promise<void>) =>
    ({ runtime: { getURL: (p: string) => "moz-extension://x/" + p, getManifest: () => ({ name: "PushArmor" }) }, tabs: { getCurrent: async () => ({ id: 9 }), remove } }) as never;
  try {
    ua("Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0");
    await uiEnv(b(async (id) => void log.push("remove " + id))).closeTab!();
    assert.deepEqual(log.splice(0), ["remove 9"]);
    const fail = async () => {
      throw new Error("no");
    };
    await uiEnv(b(fail)).closeTab!();
    assert.deepEqual(log.splice(0), ["close"]);
    ua("Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0");
    await uiEnv(b(fail)).closeTab!();
    assert.deepEqual(log.splice(0), ["assign moz-extension://x/popup.html"]);
  } finally {
    if (savedLoc) Object.defineProperty(globalThis, "location", savedLoc);
    else delete g.location;
    if (savedNav) Object.defineProperty(globalThis, "navigator", savedNav);
    if (savedWin) Object.defineProperty(globalThis, "window", savedWin);
    else delete g.window;
  }
});

test("login page: Close tab and Cancel close the tab through the add-on, not window.close() alone", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../src/ui/page.ts", import.meta.url), "utf8");
  assert.match(page, /onclick: \(\) => void \(env\.closeTab \? env\.closeTab\(\) : window\.close\(\)\) \}, "Close tab"\)/);
  assert.match(page, /onclick: \(\) => void \(env\.closeTab \? env\.closeTab\(\) : window\.close\(\)\) \}, "Cancel"\)/);
});

test("notifications blocked: Chrome asks notifications.getPermissionLevel; Firefox reads the web permission", async () => {
  const level = (v: string) => ({ getPermissionLevel: async () => v });
  assert.equal(await notificationsBlocked(level("denied"), "granted"), true);
  assert.equal(await notificationsBlocked(level("granted"), "denied"), false); // Chrome: the extension level decides
  assert.equal(await notificationsBlocked({ getPermissionLevel: async () => Promise.reject(new Error("x")) }, undefined), false);
  assert.equal(await notificationsBlocked({}, "denied"), true); // Firefox has no getPermissionLevel
  assert.equal(await notificationsBlocked({}, "granted"), false);
  assert.equal(await notificationsBlocked({}, undefined), false);
});
