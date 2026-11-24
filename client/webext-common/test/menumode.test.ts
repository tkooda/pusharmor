import assert from "node:assert/strict";
import { test } from "node:test";
import { MENU_LOGIN, MENU_PAIR } from "../src/core/actions.ts";
import { basePlatform, onMenuClick } from "../src/shellkit.ts";
import { Clock, MockWorker, device, pairAndApprove } from "./harness.ts";

test("context menu mode: Pair a new device with no paired device, the send items once paired, Log in when logged out", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const b = await device(w, clock);
  assert.equal(a.p.menuMode, "pair");
  await pairAndApprove(w, a, b);
  assert.equal(a.p.menuMode, "send");
  await a.e.logoutLocal();
  assert.equal(a.p.menuMode, "login");
  await a.e.wipe();
  assert.equal(a.p.menuMode, "login");
  await a.e.start(); // a start while logged out builds the Log in item too
  assert.equal(a.p.menuMode, "login");
});

function fakeMenus() {
  const items = new Map<string, { title: string; contexts: string[] }>();
  const menus = {
    removeAll: async () => void items.clear(),
    create: (p: { id: string; title: string; contexts: string[] }) => void items.set(p.id, { title: p.title, contexts: p.contexts }),
  };
  return { items, menus };
}

test("context menu: logged out shows only Log in to PushArmor..., no paired device only Pair a new device..., in every context", async () => {
  for (const [mode, id, title] of [["login", MENU_LOGIN, "Log in to PushArmor..."], ["pair", MENU_PAIR, "Pair a new device..."]] as const) {
    const m = fakeMenus();
    const b = { runtime: { getManifest: () => ({ version: "0.0.19" }) }, storage: { local: {}, session: {} }, menus: m.menus };
    basePlatform(b as never, "firefox", false, {} as never).menusRebuild([{ id: "A", name: "One" }], true, mode);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual([...m.items.keys()], [id]);
    assert.equal(m.items.get(id)!.title, title);
    assert.deepEqual(m.items.get(id)!.contexts, ["link", "page", "selection", "image"]);
  }
});

test("context menu Log in and Pair items open the toolbar popup; when it cannot open, the page opens in a tab", async () => {
  for (const [id, hash] of [[MENU_LOGIN, ""], [MENU_PAIR, "#peers"]] as const) {
    for (const canOpen of [true, false]) {
      const log: string[] = [];
      const b = {
        action: { openPopup: async () => (canOpen ? void log.push("popup") : Promise.reject(new Error("no"))) },
        runtime: { getURL: (p: string) => "ext://x/" + p },
        tabs: { create: async (o: { url: string }) => void log.push("tab " + o.url) },
      };
      onMenuClick(b as never, (() => Promise.reject(new Error("no boot"))) as never, async (_t, s) => s)({ menuItemId: id } as never);
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(log, canOpen ? ["popup"] : ["tab ext://x/page.html" + hash]);
    }
  }
});
