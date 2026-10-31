// Shared wiring for the two shells. The shell passes in its "browser"
// namespace object; nothing here reads a browser global.
import { Api, errorText } from "./api/client.ts";
import { MENU_PAGE, MENU_PARENTS, MENU_SEL, MENU_URL, clickTarget, menuSend } from "./core/actions.ts";
import { Engine, UserError } from "./core/engine.ts";
import { migrateStorage } from "./core/state.ts";
import { Rpc, type Req } from "./core/rpc.ts";
import type { PushFields } from "./crypto/labels.ts";
import type { KV, MenuPeer, Platform } from "./platform.ts";
import type { Browser, MenuInfo, MessageSender, Tab } from "./shim-types.ts";
import { Db, openDb } from "./store/db.ts";
import type { UiEnv } from "./ui/dom.ts";
import { THEME_KEY } from "./ui/theme.ts";

export const ICON = "icons/icon-128.png";

export interface PushHooks {
  pushSubscribe(vapid: Uint8Array, quiet?: boolean): Promise<PushFields>;
  pushCurrent(): Promise<PushFields | null>;
  pushUnsubscribe(): Promise<void>;
}

export function basePlatform(b: Browser, name: "chrome" | "firefox", isAndroid: boolean, push: PushHooks): Platform {
  const kv = (a: Browser["storage"]["local"]): KV => ({
    get: (k) => a.get(k),
    set: (i) => a.set(i),
    remove: (k) => a.remove(k),
  });
  const menus = b.menus ?? b.contextMenus;
  // I557: one rebuild at a time, so two in flight cannot mix their items
  let menuChain: Promise<void> = Promise.resolve();
  return {
    platformName: name,
    appVersion: b.runtime.getManifest().version,
    isAndroid,
    pushSubscribe: (v, quiet) => push.pushSubscribe(v, quiet),
    pushCurrent: () => push.pushCurrent(),
    pushUnsubscribe: () => push.pushUnsubscribe(),
    notify(id, title, body) {
      void b.notifications.clear(id).then(() => b.notifications.create(id, { type: "basic", iconUrl: ICON, title, message: body }));
    },
    clearNotification(id) {
      void b.notifications.clear(id);
    },
    async clearAllNotifications() {
      for (const id of Object.keys(await b.notifications.getAll())) await b.notifications.clear(id);
    },
    async openTab(url, active) {
      const t = await b.tabs.create({ url, active });
      return t.id ?? null;
    },
    showPage(id, hash) {
      void b.tabs.update(id, { url: b.runtime.getURL("page.html" + hash) }).catch(() => undefined);
    },
    async authFlow(url) {
      if (!b.identity) return null;
      // u names this extension's own redirect (public or Beta id); the Worker
      // accepts only an exact entry of its allow-list.
      const u = "&u=" + encodeURIComponent(b.identity.getRedirectURL());
      return b.identity.launchWebAuthFlow({ url: url + u, interactive: true });
    },
    async autoOpenTab(url) {
      if (isAndroid || !b.windows) {
        await b.tabs.create({ url, active: false });
        return true;
      }
      let w: { id?: number };
      try {
        w = await b.windows.getLastFocused({ windowTypes: ["normal"] });
      } catch {
        return false; // no window: notification only
      }
      if (w.id === undefined) return false;
      await b.tabs.create({ url, active: false, windowId: w.id });
      return true;
    },
    menusRebuild(peers: MenuPeer[], showAll: boolean) {
      if (!menus) return;
      menuChain = menuChain
        .then(() => menus.removeAll())
        .then(() => {
          for (const [id, title, ctx] of MENU_PARENTS) {
            menus.create({ id, title, contexts: [ctx] });
            if (showAll) menus.create({ id: id + "|all", parentId: id, title: "All devices", contexts: [ctx] });
            for (const p of peers) menus.create({ id: id + "|" + p.id, parentId: id, title: p.name, contexts: [ctx] });
          }
        })
        .catch(() => undefined);
    },
    setBadge(text) {
      void (b.action ?? b.browserAction)?.setBadgeText({ text });
    },
    storageLocal: kv(b.storage.local),
    storageSession: kv(b.storage.session),
    alarmAt(name, when) {
      b.alarms.create(name, { when });
    },
    clearAlarm(name) {
      void b.alarms.clear(name);
    },
    fetch: (i, init) => fetch(i, init),
    now: () => Date.now(),
  };
}

export interface Booted {
  engine: Engine;
  rpc: Rpc;
}

/** Shown by the UI (with Retry) when the local database cannot be opened. */
export const BOOT_ERROR = "PushArmor could not open its local database. Close this window and try again, or restart the browser.";

/** Lazy init inside handlers (no top-level await in the entry files). */
export function lazyBoot(make: () => Platform, vapid: Uint8Array): () => Promise<Booted> {
  let p: Promise<Booted> | null = null;
  return () => {
    if (!p) {
      p = (async () => {
        const platform = make();
        const idb = await openDb();
        try {
          const db = new Db(idb);
          let offset: number | null = null;
          const api = new Api({
            client: platform.platformName + "/" + platform.appVersion,
            fetch: (i, init) => platform.fetch(i, init),
            now: () => platform.now(),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            getOffset: async () => {
              if (offset === null) offset = (await db.meta<number>("offset_s")) ?? 0;
              return offset;
            },
            setOffset: async (o) => {
              offset = o;
              await db.setMeta("offset_s", o);
            },
          });
          await migrateStorage(platform.storageLocal);
          const engine = new Engine({ platform, db, api, vapidPub: vapid });
          void engine.retryPendingLogout().catch(() => undefined); // background start (Q368)
          return { engine, rpc: new Rpc(engine) };
        } catch (e) {
          idb.close(); // a failed start must not leak the connection (one per Retry)
          throw e;
        }
      })();
      // A failed open (storage blocked, quota, private mode) must not stay cached: the next call tries again.
      p.catch(() => {
        p = null;
      });
    }
    return p;
  };
}

/** runtime.onMessage: {op, args} from UI pages and content scripts. */
export function onRuntimeMessage(boot: () => Promise<Booted>, extra?: (msg: Req, sender: MessageSender) => Promise<unknown> | null) {
  return (msg: unknown, sender: MessageSender, sendResponse: (r: unknown) => void): boolean => {
    const m = msg as Req;
    if (!m || typeof m.op !== "string") return false;
    const ex = extra?.(m, sender);
    if (ex) {
      ex.then(sendResponse, () => sendResponse({ ok: false }));
      return true;
    }
    void boot()
      .then((b) => b.rpc.handle(m, sender.tab?.id))
      .then(sendResponse, () => sendResponse({ ok: false, error: BOOT_ERROR }));
    return true;
  };
}

export function onNotificationClick(b: Browser, boot: () => Promise<Booted>) {
  return (id: string): void => {
    void (async () => {
      const { engine } = await boot();
      const t = await clickTarget(engine, id);
      await b.notifications.clear(id);
      if (!t) return;
      if ("url" in t) await b.tabs.create({ url: t.url, active: true });
      else await b.tabs.create({ url: b.runtime.getURL("page.html" + t.page), active: true });
    })();
  };
}

export function onMenuClick(b: Browser, boot: () => Promise<Booted>, readSelection: (tab: Tab | undefined, text: string) => Promise<string>) {
  return (info: MenuInfo, tab?: Tab): void => {
    void (async () => {
      const [parent, child] = String(info.menuItemId).split("|");
      if (!child) return;
      let text = "";
      if (parent === MENU_URL) text = info.linkUrl ?? "";
      else if (parent === MENU_PAGE) text = info.pageUrl ?? tab?.url ?? "";
      else text = await readSelection(tab, info.selectionText ?? "");
      if (!text) return;
      const { engine } = await boot();
      let r: Awaited<ReturnType<typeof menuSend>>;
      try {
        r = await menuSend(engine, text, child, parent === MENU_SEL);
      } catch (err) {
        // I558: a send that fails (logged out after a wipe) says why
        engine.p.notify("send-result", "PushArmor", err instanceof UserError ? err.message : errorText(err));
        return;
      }
      if (r.overCap !== null) {
        await b.tabs.create({ url: b.runtime.getURL("page.html#send=" + encodeURIComponent(r.overCap)), active: true });
        return;
      }
      if (r.badge) {
        engine.p.setBadge(r.badge);
        setTimeout(() => void engine.updateBadge(), 5000);
      }
      if (r.notice) engine.p.notify("send-result", "PushArmor", r.notice);
    })();
  };
}

/** UiEnv for popup.html and page.html. */
export function uiEnv(b: Browser): UiEnv {
  return {
    call: (req) => b.runtime.sendMessage(req) as Promise<never>,
    async activeUrl() {
      const [t] = await b.tabs.query({ active: true, currentWindow: true });
      return t?.url && /^https?:/i.test(t.url) ? t.url : "";
    },
    openPage(hash) {
      const url = b.runtime.getURL("page.html" + hash);
      return (async () => {
        // An open tab on the same page comes to the front instead of a second copy.
        try {
          const open = (await b.runtime.getContexts?.({ contextTypes: ["TAB"] }))?.find((c) => c.documentUrl === url && c.tabId >= 0);
          if (open) {
            await b.tabs.update(open.tabId, { active: true });
            await b.windows?.update(open.windowId, { focused: true });
            await b.tabs.reload(open.tabId); // a stale page (e.g. the done card) starts over
            return;
          }
        } catch {
          // fall through: open a new tab
        }
        await b.tabs.create({ url, active: true });
      })();
    },
    openUrl(url) {
      void b.tabs.create({ url, active: true });
    },
    async copy(text) {
      await navigator.clipboard.writeText(text);
    },
    beta: b.runtime.getManifest().name === "PushArmor Beta",
    session: {
      get: async (key) => (await b.storage.session.get([key]))[key],
      remove: (key) => b.storage.session.remove([key]),
      watch(key, cb) {
        const f = (ch: Record<string, { newValue?: unknown }>, area: string) => {
          if (area === "session" && key in ch) cb(ch[key]!.newValue);
        };
        b.storage.onChanged.addListener(f);
        return () => b.storage.onChanged.removeListener(f);
      },
    },
    theme: {
      get: async () => (await b.storage.local.get([THEME_KEY]))[THEME_KEY],
      set: (pref) => b.storage.local.set({ [THEME_KEY]: pref }),
      onChange(cb) {
        b.storage.onChanged.addListener((ch, area) => {
          if (area === "local" && THEME_KEY in ch) cb(ch[THEME_KEY]!.newValue);
        });
      },
    },
  };
}
