// Chrome MV3 service worker entry. Every listener is registered at the top
// level, synchronously; lazy init runs inside the handlers (section 3).
import { b64urlTryDecode } from "../../webext-common/src/crypto/b64url.ts";
import { lazyBoot, onMenuClick, onNotificationClick, onRuntimeMessage } from "../../webext-common/src/shellkit.ts";
import { chromePlatform } from "./platform-chrome.ts";
import { browser } from "./shim.ts";

declare const VAPID_PUBLIC_KEY: string;

interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface PushEvent extends ExtendableEvent {
  data: { text(): string } | null;
}

/**
 * OnClickData.selectionText cap: not yet measured (device checklist,
 * section 11). A selection at least this long is re-read in the tab.
 */
const SELECTION_TEXT_CAP = 4096;

const vapid = b64urlTryDecode(VAPID_PUBLIC_KEY) ?? new Uint8Array(0);
const boot = lazyBoot(chromePlatform, vapid);
const sw = globalThis as unknown as { addEventListener(t: string, f: (e: Event) => void): void };

sw.addEventListener("push", (ev) => {
  const e = ev as PushEvent;
  const m = e.data ? e.data.text() : "";
  e.waitUntil(
    boot().then(async ({ engine }) => {
      await engine.receive(m, "push");
      await engine.pushReconcile().catch(() => undefined);
    }),
  );
});

sw.addEventListener("pushsubscriptionchange", (ev) => {
  (ev as ExtendableEvent).waitUntil(boot().then(({ engine }) => engine.pushReconcile(true)));
});

browser.runtime.onMessage.addListener(onRuntimeMessage(boot));
browser.notifications.onClicked.addListener(onNotificationClick(browser, boot));
browser.alarms.onAlarm.addListener((a) => {
  void boot().then(async ({ engine }) => {
    if (a.name === "fetch") await engine.onFetchAlarm();
    else if (a.name.startsWith("pair:")) {
      const id = a.name.slice(5);
      await engine.sendReply(id);
      await engine.pairSendAgain(id);
    }
  });
});
browser.runtime.onStartup.addListener(() => {
  void boot().then(({ engine }) => engine.start());
});
browser.runtime.onInstalled.addListener(() => {
  void boot().then(({ engine }) => engine.start());
});
browser.contextMenus?.onClicked.addListener(
  onMenuClick(browser, boot, async (tab, text) => {
    // a selection whose length equals the platform cap is read in full (activeTab on the click)
    if (tab?.id === undefined || !browser.scripting || text.length < SELECTION_TEXT_CAP) return text;
    try {
      const [r] = await browser.scripting.executeScript({ target: { tabId: tab.id }, func: () => String(getSelection() ?? "") });
      return typeof r?.result === "string" && r.result ? r.result : text;
    } catch {
      return text;
    }
  }),
);
