// Firefox persistent background page entry (MV2). Every listener is
// registered at the top level, synchronously; lazy init runs in handlers.
import { b64urlTryDecode } from "../../webext-common/src/crypto/b64url.ts";
import type { PushFields } from "../../webext-common/src/crypto/labels.ts";
import { MENU_SEL, selectionTitle } from "../../webext-common/src/core/actions.ts";
import { lazyBoot, onMenuClick, onNotificationClick, onRuntimeMessage } from "../../webext-common/src/shellkit.ts";
import type { Req } from "../../webext-common/src/core/rpc.ts";
import { Db, openDb } from "../../webext-common/src/store/db.ts";
import type { WebPushKeys } from "../../webext-common/src/crypto/rfc8291.ts";
import { Autopush, type ApState } from "./autopush/client.ts";
import { fxSubFields, senderAllowed } from "./gate.ts";
import { FWD_URL, SETUP_URL, endpointAllowed, firefoxPlatform } from "./platform-firefox.ts";
import { readForward } from "./sitefwd/fwd.ts";
import { browser } from "./shim.ts";

declare const VAPID_PUBLIC_KEY: string;
const vapid = b64urlTryDecode(VAPID_PUBLIC_KEY) ?? new Uint8Array(0);

let isAndroid = false;
let autopush: Autopush | null = null;
let dbp: Promise<Db> | null = null;
const db = () =>
  (dbp ??= openDb().then(
    (d) => new Db(d),
    (e) => {
      dbp = null; // a failed open is not cached
      throw e;
    },
  ));

const boot = lazyBoot(() => firefoxPlatform({ isAndroid, autopush: () => autopush, db }), vapid);

async function init(): Promise<void> {
  isAndroid = (await browser.runtime.getPlatformInfo()).os === "android";
  const { engine } = await boot();
  if (!isAndroid && !autopush) {
    const d = await db();
    autopush = new Autopush({
      socket: (url) => new WebSocket(url) as unknown as ReturnType<ConstructorParameters<typeof Autopush>[0]["socket"]>,
      vapidPub: vapid,
      loadState: async () => (await d.meta<ApState>("autopush")) ?? { uaid: null, channelID: null, endpoint: null },
      saveState: (s) => d.setMeta("autopush", s),
      loadKeys: async () => (await d.get<WebPushKeys>("keys", "wp")) ?? null,
      saveKeys: (k) => d.put("keys", k, "wp"),
      deliver: (m) => engine.receive(m, "push"),
      onEndpoint: async () => {
        if ((await engine.regState()) === "registered") await engine.pushReconcile(true);
      },
      onMode: async (mode) => {
        await d.setMeta("receive_mode", mode);
        if ((await engine.regState()) === "registered") await engine.pushReconcile(true).catch(() => undefined);
      },
      workerReachable: async () => {
        try {
          await engine.fetchPeersNow();
          return true;
        } catch {
          return false;
        }
      },
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      uuid: () => crypto.randomUUID(),
    });
    await autopush.start();
  }
  await engine.start();
}

let ready = init();
// a failed start is tried again by the next use (message, alarm or push)
const whenReady = () => (ready = ready.catch(() => init()));

// timer drift above 60 s (laptop sleep) or "online": reconnect at once
let lastTick = Date.now();
setInterval(() => {
  const t = Date.now();
  if (t - lastTick > 30_000 + 60_000) autopush?.reconnectNow();
  lastTick = t;
}, 30_000);
addEventListener("online", () => autopush?.reconnectNow());

async function extra(msg: Req): Promise<unknown> {
  await whenReady();
  const { engine } = await boot();
  const a = msg.args ?? {};
  if (msg.op === "fx-sub") {
    const f = fxSubFields(a);
    if (!f) return { ok: false };
    const p: PushFields = { type: "webpush", ...f };
    const k = b64urlTryDecode(p.p256dh);
    const au = b64urlTryDecode(p.auth);
    if (!endpointAllowed(p.endpoint) || !k || k.length !== 65 || !au || au.length !== 16) return { ok: false };
    const d = await db();
    await d.setMeta("fallback_push", p);
    const mode = isAndroid ? "fallback" : ((await d.meta<string>("receive_mode")) ?? "direct");
    if (mode === "fallback" && (await engine.regState()) === "registered") await engine.pushReconcile(true).catch(() => undefined);
    return { ok: true };
  }
  if (msg.op === "fx-msg") {
    await engine.receive(String(a.m ?? ""), "bridge");
    return { ok: true };
  }
  return { ok: false };
}

browser.runtime.onMessage.addListener(
  onRuntimeMessage(boot, (msg, sender) => {
    if (!senderAllowed(msg.op, sender, browser.runtime.id, browser.runtime.getURL(""))) return Promise.resolve({ ok: false });
    if (msg.op === "fx-sub" || msg.op === "fx-msg") return extra(msg);
    return null;
  }),
);
browser.notifications.onClicked.addListener(onNotificationClick(browser, boot));
browser.alarms.onAlarm.addListener((a) => {
  void whenReady().then(boot).then(async ({ engine }) => {
    if (a.name === "fetch") await engine.onFetchAlarm();
    else if (a.name.startsWith("pair:")) {
      const id = a.name.slice(5);
      await engine.sendReply(id);
      await engine.pairSendAgain(id);
    }
  });
});
browser.runtime.onStartup.addListener(() => void whenReady());
browser.runtime.onInstalled.addListener((d) => {
  // the site SW fallback is set up at install, on desktop and on Android
  if (d.reason === "install") void browser.tabs.create({ url: SETUP_URL, active: true });
});
browser.webRequest?.onBeforeRequest.addListener(
  (d) => {
    const r = readForward(d);
    if (r.m !== null) {
      const m = r.m;
      void whenReady().then(boot).then(({ engine }) => engine.receive(m, "push"));
    }
    return r.cancel ? { cancel: true } : {};
  },
  { urls: [FWD_URL] },
  ["blocking", "requestBody"],
);
if (browser.menus) {
  browser.menus.onClicked.addListener(onMenuClick(browser, boot, async (_tab, text) => text));
  browser.menus.onShown.addListener((info) => {
    if (!info.contexts?.includes("selection") || !info.selectionText) return;
    void browser.menus!.update(MENU_SEL, { title: selectionTitle(info.selectionText) }).then(() => browser.menus!.refresh());
  });
}

