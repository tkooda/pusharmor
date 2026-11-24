// Shared wiring for the two shells. The shell passes in its "browser"
// namespace object; nothing here reads a browser global.
import { SEND_CAP, utf8Len } from "./model/padding.ts";
import { saveBlobViaLink, saveBlobWithPermission, saveViaLink, saveWithPermission } from "./model/savefile.ts";
import { Api } from "./api/client.ts";
import { MENU_IMG, MENU_PAGE, MENU_PARENTS, MENU_SEL, MENU_SINGLE, MENU_URL, clickTarget, menuSend, type MenuMode } from "./core/actions.ts";
import { Engine, type SendResult } from "./core/engine.ts";
import { failText } from "./core/failtext.ts";
import { Rpc, type Req } from "./core/rpc.ts";
import { R, actionLine } from "./core/texts.ts";
import type { PushFields } from "./crypto/labels.ts";
import type { KV, MenuPeer, Platform } from "./platform.ts";
import type { Browser, MenuInfo, MessageSender, Tab } from "./shim-types.ts";
import { Db, openDb } from "./store/db.ts";
import { FileStore } from "./store/files.ts";
import { type FileEvent, type FileHost, Files } from "./core/files.ts";
import { MAX_FILE } from "./crypto/filecrypt.ts";
import { webImageName } from "./model/filerow.ts";
import { PIECE_RAW, collectImage, pageImageFetch } from "./model/imgfetch.ts";
import type { UiEnv } from "./ui/dom.ts";
import { THEME_KEY } from "./ui/theme.ts";

const ICON = "icons/icon-128.png";

interface PushHooks {
  pushSubscribe(vapid: Uint8Array, quiet?: boolean, fresh?: boolean): Promise<PushFields>;
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
  // one rebuild at a time, so two in flight cannot mix their items
  let menuChain: Promise<void> = Promise.resolve();
  return {
    platformName: name,
    appVersion: b.runtime.getManifest().version,
    isAndroid,
    pushSubscribe: (v, quiet, fresh) => push.pushSubscribe(v, quiet, fresh),
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
    authRedirect() {
      return name === "chrome" && b.identity ? b.identity.getRedirectURL() : null;
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
      await b.tabs.create({ url, active: true, windowId: w.id });
      await b.windows.update(w.id, { focused: true }).catch(() => undefined);
      return true;
    },
    menusRebuild(peers: MenuPeer[], showAll: boolean, mode: MenuMode = "send") {
      if (!menus) return;
      menuChain = menuChain
        .then(() => menus.removeAll())
        .then(() => {
          if (mode !== "send") {
            const [id, title] = MENU_SINGLE[mode];
            menus.create({ id, title, contexts: MENU_PARENTS.map(([, , ctx]) => ctx) });
            return;
          }
          for (const [id, title, ctx] of MENU_PARENTS) {
            menus.create({ id, title, contexts: [ctx] });
            if (showAll && peers.length > 0) menus.create({ id: id + "|all", parentId: id, title: "All devices", contexts: [ctx] });
            // Firefox reads one & as an access key: && shows a plain &
            for (const p of peers) menus.create({ id: id + "|" + p.id, parentId: id, title: name === "firefox" ? p.name.replaceAll("&", "&&") : p.name, contexts: [ctx] });
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

interface Booted {
  engine: Engine;
  rpc: Rpc;
}

/** Shown by the UI (with Retry) when the local database cannot be opened. */
const BOOT_ERROR = "PushArmor could not open its local database. Close this window and try again, or restart the browser.";

/** Where file transfers run (host), and how open views hear of a file row change (tell). */
export interface FileShell {
  host(progress: (id: number, have: number, total: number) => void): FileHost;
  tell(m: FileEvent): void;
}

let fileStoreP: Promise<FileStore> | null = null;
/** The file store, opened once; a failed open is tried again by the next use. */
export function fileStore(): Promise<FileStore> {
  if (!fileStoreP) {
    fileStoreP = FileStore.open();
    fileStoreP.catch(() => (fileStoreP = null));
  }
  return fileStoreP;
}

/** Tells open views (popup, full tab) of a file row change; no open view is not an error. */
export function tellViews(b: Browser): (m: FileEvent) => void {
  return (m) => void b.runtime.sendMessage(m).catch(() => undefined);
}

/** Lazy init inside handlers (no top-level await in the entry files). */
export function lazyBoot(make: () => Platform, vapid: Uint8Array, files?: FileShell): () => Promise<Booted> {
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
          const engine = new Engine({ platform, db, api, vapidPub: vapid });
          if (files) {
            const f: Files = new Files(engine, files.host((id, have, total) => f.progress(id, have, total)), fileStore, files.tell);
            engine.files = f;
          }
          void engine.retryPendingLogout().catch(() => undefined); // background start
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

/** A context menu send the toolbar popup takes over: ready gives the text (over: longer than the limit), or null when there is none to send. */
interface MenuPending {
  ready: Promise<{ text: string; child: string; over?: true } | null>;
  claimed: () => void;
  seen?: true;
}
let menuPending: MenuPending | null = null;
/**
 * A menu send the background took over: the reply for a toolbar popup that took it but started it late, or that
 * asks for it while it still runs (seen: a popup took it, shown: the popup showed its failure, done: it ended).
 */
interface MenuLate {
  text: string;
  child: string;
  seen: boolean;
  shown: boolean;
  done: boolean;
  result: Promise<unknown>;
}
let menuLate: MenuLate | null = null;
/** The menu send whose result a toolbar popup asked for: the popup says when it shows its failure (menuSendShown). */
let menuAsked: { shown: boolean } | null = null;

/** A failed menu send a toolbar popup asked for: the notification, unless the popup shows the failure in 5 s (it can close first). */
function notifyUnlessShown(p: { notify: (id: string, title: string, body: string) => void }, asked: { shown: boolean }, body: string): void {
  setTimeout(() => {
    if (!asked.shown) p.notify("send-result", "PushArmor", body);
  }, 5000);
}

/** The toolbar popup takes the waiting context menu send (once). The background still owns a send until menuSendRun. */
async function claimMenuSend(): Promise<{ text: string; child: string; over?: true } | null> {
  const m = menuPending;
  if (!m) {
    // the background already took it over and still sends it: the popup shows how it goes, as a late popup does
    const l = menuLate;
    if (!l || l.seen || l.done) return null;
    l.seen = true;
    return { text: l.text, child: l.child };
  }
  if (m.seen) return null;
  m.seen = true;
  const d = await m.ready;
  // text over the limit: the popup shows it to edit, nothing is sent
  if (d?.over) {
    if (menuPending === m) menuPending = null;
    m.claimed();
  }
  return d;
}

/** The toolbar popup starts the send it took: it runs here, so a popup that closes cannot lose it. null: the background already sent it. */
async function runMenuSend(): Promise<{ text: string; child: string } | null> {
  const m = menuPending;
  if (!m?.seen) return null;
  menuPending = null;
  m.claimed();
  const d = await m.ready;
  return d && !d.over ? d : null;
}

/** Opens the toolbar popup; false when the browser cannot. Call it before any await (Firefox needs the click). */
function openActionPopup(b: Browser): Promise<boolean> {
  const a = b.action ?? b.browserAction;
  if (!a?.openPopup) return Promise.resolve(false);
  try {
    return a.openPopup().then(() => true, () => false);
  } catch {
    return Promise.resolve(false);
  }
}

/** runtime.onMessage: {op, args} from UI pages and content scripts. */
export function onRuntimeMessage(boot: () => Promise<Booted>, extra?: (msg: Req, sender: MessageSender) => Promise<unknown> | null) {
  return (msg: unknown, sender: MessageSender, sendResponse: (r: unknown) => void): boolean => {
    const m = msg as Req;
    if (!m || typeof m.op !== "string") return false;
    // file host messages: progress goes to the file rows; a beat only keeps this worker running; views take fileEvent
    if (m.op === "fileBeat" || m.op === "fileEvent" || (msg as { target?: unknown }).target === "offscreen") return false;
    if (m.op === "fileProgress") {
      const a = msg as { id?: unknown; have?: unknown; total?: unknown };
      void boot().then((b) => (b.engine.files as Files | null)?.progress(Number(a.id), Number(a.have), Number(a.total)), () => undefined);
      return false;
    }
    if (m.op === "menuSendClaim") {
      claimMenuSend().then((data) => sendResponse({ ok: true, data }), () => sendResponse({ ok: true, data: null }));
      return true;
    }
    if (m.op === "menuSendRun") {
      const late = menuPending?.seen || !menuLate?.seen ? null : menuLate;
      if (late) {
        menuLate = null;
        menuAsked = late;
        void late.result.then(sendResponse);
        return true;
      }
      void runMenuSend()
        .then(async (d) => {
          if (!d) return { ok: true, data: null };
          const { engine, rpc } = await boot();
          const asked = { shown: false };
          menuAsked = asked;
          const res = await rpc.handle({ op: "send", args: { text: d.text, auto: true, targets: d.child === "all" ? "all" : [d.child] } });
          // a failure the popup closed before it showed: the notification the background gives a send it runs
          const r = res.data as SendResult | undefined;
          const total = d.child === "all" ? r?.total ?? 0 : 1;
          const body = !res.ok ? res.error ?? "" : r && (r.error || r.sent < total) ? r.error || r.failures.map((f) => f.text).join("\n") || actionLine("send") + "\n" + R.someNotSent : "";
          if (body) notifyUnlessShown(engine.p, asked, body);
          return res;
        })
        .then(sendResponse, () => sendResponse({ ok: false, error: BOOT_ERROR }));
      return true;
    }
    if (m.op === "menuSendShown") {
      if (menuAsked) menuAsked.shown = true;
      sendResponse({ ok: true, data: null });
      return false;
    }
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
      void engine.files?.catchUp().catch(() => undefined); // open from a notification
      const t = await clickTarget(engine, id);
      await b.notifications.clear(id);
      if (!t) return;
      if ("url" in t) await b.tabs.create({ url: t.url, active: true });
      else await b.tabs.create({ url: b.runtime.getURL("page.html" + t.page), active: true });
    })();
  };
}

/** Re-read the selection in the tab (keeps line breaks, no length cap); on any error keep the click text. */
export async function readTabSelection(b: Browser, tab: Tab | undefined, text: string, frameId?: number): Promise<string> {
  if (tab?.id === undefined || !b.scripting) return text;
  try {
    const target = frameId === undefined ? { tabId: tab.id } : { tabId: tab.id, frameIds: [frameId] };
    const [r] = await b.scripting.executeScript({ target, func: () => String(getSelection() ?? "") });
    return typeof r?.result === "string" && r.result ? r.result : text;
  } catch {
    return text;
  }
}

export function onMenuClick(b: Browser, boot: () => Promise<Booted>, readSelection: (tab: Tab | undefined, text: string, frameId?: number) => Promise<string>) {
  return (info: MenuInfo, tab?: Tab): void => {
    void (async () => {
      const single = Object.values(MENU_SINGLE).find(([id]) => id === info.menuItemId);
      if (single) {
        // the toolbar popup (log in screen, or Devices with no paired device); else the page in a tab
        if (!(await openActionPopup(b))) await b.tabs.create({ url: b.runtime.getURL("page.html" + single[2]), active: true });
        return;
      }
      const [parent, child] = String(info.menuItemId).split("|");
      if (!child) return;
      if (parent === MENU_IMG) return void (await imageSend(b, boot, info, tab, child));
      // the toolbar popup sends it with the same Send popup as its Send screen; if it cannot open
      // or does not take the send in time, the send runs here as before
      const opened = openActionPopup(b);
      menuLate = null;
      let give: (v: { text: string; child: string; over?: true } | null) => void = () => undefined;
      let taken: () => void = () => undefined;
      const claim = new Promise<void>((r) => (taken = r));
      const mine: MenuPending = { ready: new Promise((r) => (give = r)), claimed: () => taken() };
      menuPending = mine;
      const unclaim = () => {
        if (menuPending === mine) menuPending = null;
      };
      let text = "";
      if (parent === MENU_URL) text = info.linkUrl ?? "";
      else if (parent === MENU_PAGE) text = info.pageUrl ?? tab?.url ?? "";
      else {
        text = (await readSelection(tab, info.selectionText ?? "", info.frameId)).slice(0, 200000); // the send window URL stays under 2 MiB
        if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1); // a cut inside a pair would make encodeURIComponent throw
      }
      // text over the limit opens the popup's Send screen with the text to edit
      if (!text) give(null);
      else if (utf8Len(text) > SEND_CAP) give({ text, child, over: true });
      else give({ text, child });
      if (!text) return unclaim();
      if (await opened) {
        let late = false;
        await Promise.race([claim, new Promise<void>((r) => setTimeout(() => ((late = true), r()), 5000))]);
        if (!late) return;
      }
      unclaim();
      // the popup took it but did not start it in time, or asks for it while it runs: it gets this send's result to show
      let tellPopup: (v: unknown) => void = () => undefined;
      const late: MenuLate | null = mine.seen || utf8Len(text) <= SEND_CAP
        ? { text, child, seen: mine.seen === true, shown: false, done: false, result: new Promise((r) => (tellPopup = r)) }
        : null;
      if (late) {
        const reply = tellPopup;
        tellPopup = (v) => {
          late.done = true;
          reply(v);
        };
      }
      menuLate = late;
      // a failure the popup shows is not also a notification; a popup that does not show it in 5 s (closed) gets the notification
      const notifyFail = (p: { notify: (id: string, title: string, body: string) => void }, body: string) => {
        if (!late?.seen) return p.notify("send-result", "PushArmor", body);
        notifyUnlessShown(p, late, body);
      };
      const { engine } = await boot().catch((err: unknown) => {
        tellPopup({ ok: false, error: BOOT_ERROR });
        throw err;
      });
      let r: Awaited<ReturnType<typeof menuSend>>;
      try {
        r = await menuSend(engine, text, child, parent === MENU_SEL);
      } catch (err) {
        // a send that fails (logged out after a wipe) says why
        notifyFail(engine.p, failText("send", err));
        tellPopup({ ok: false, error: failText("send", err) });
        return;
      }
      tellPopup({ ok: true, data: r.result });
      if (r.overCap !== null) {
        await b.tabs.create({ url: b.runtime.getURL("page.html#send=" + encodeURIComponent(r.overCap)), active: true });
        return;
      }
      if (r.badge) {
        engine.p.setBadge(r.badge);
        setTimeout(() => void engine.updateBadge(), 5000);
      }
      if (r.notice) notifyFail(engine.p, r.notice);
    })();
  };
}

/** Injects pageImageFetch into the frame of the clicked image (activeTab): Chrome scripting, Firefox tabs.executeScript. */
async function injectImageFetch(b: Browser, tabId: number, frameId: number | undefined, src: string, port: string): Promise<void> {
  const args: [string, string, number, number] = [src, port, MAX_FILE, PIECE_RAW];
  if (b.scripting) {
    await b.scripting.executeScript({ target: frameId === undefined ? { tabId } : { tabId, frameIds: [frameId] }, func: pageImageFetch, args });
    return;
  }
  if (!b.tabs.executeScript) throw new Error("no script injection");
  await b.tabs.executeScript(tabId, { frameId: frameId ?? 0, code: "(" + pageImageFetch.toString() + ")(" + args.map((a) => JSON.stringify(a)).join(",") + ")" });
}

/**
 * "PushArmor image to": the image's bytes as a file (up to MAX_FILE); with no bytes (the page's server
 * refuses them, or too large) the image URL goes as a URL. The result shows as the badge, a failure as a notification.
 */
async function imageSend(b: Browser, boot: () => Promise<Booted>, info: MenuInfo, tab: Tab | undefined, child: string): Promise<void> {
  const src = info.srcUrl ?? "";
  if (!src) return;
  const { engine } = await boot();
  const targets = child === "all" ? "all" : [child];
  const got = tab?.id === undefined ? null : await collectImage((port) => injectImageFetch(b, tab.id!, info.frameId, src, port));
  let r: SendResult;
  try {
    if (got && engine.files) {
      const name = webImageName(src, got.head, got.type, Math.floor(engine.p.now() / 1000));
      const picked = await (await fileStore()).putPicked(got.blob);
      r = await (engine.files as Files).send(picked, name, got.blob.size, targets);
      if (r.sent === 0) await (await fileStore()).deletePicked(picked).catch(() => undefined);
    } else if (/^https?:/i.test(src)) {
      r = (await menuSend(engine, src, child, false)).result ?? { sent: 0, total: 1, failures: [], error: actionLine("send") + "\n" + R.tooLong };
    } else throw new Error("no image bytes");
  } catch (err) {
    engine.p.notify("send-result", "PushArmor", failText("send", err));
    return;
  }
  const total = child === "all" ? r.total : 1;
  engine.p.setBadge(r.sent + "/" + total);
  setTimeout(() => void engine.updateBadge(), 5000);
  const notice = r.error || r.sent < total ? r.error || r.failures.map((f) => f.text).join("\n") || actionLine("send") + "\n" + R.someNotSent : null;
  if (notice) engine.p.notify("send-result", "PushArmor", notice);
}

/**
 * true while the browser blocks this extension's notifications: notifications.getPermissionLevel
 * (Chrome), else the web Notification permission (Firefox). Neither sees a block in the operating
 * system's notification settings.
 */
export async function notificationsBlocked(n: { getPermissionLevel?(): Promise<string> }, webPermission: string | undefined): Promise<boolean> {
  if (n.getPermissionLevel) return (await n.getPermissionLevel().catch(() => "")) === "denied";
  return webPermission === "denied";
}

/** An image on the clipboard: browsers take PNG, so another type is drawn to PNG first. */
async function copyImage(blob: Blob): Promise<void> {
  let png = blob;
  if (blob.type !== "image/png") {
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext("2d")!.drawImage(bmp, 0, 0);
    bmp.close();
    png = await c.convertToBlob({ type: "image/png" });
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

/** UiEnv for popup.html and page.html. */
export function uiEnv(b: Browser, linkSave = false): UiEnv {
  return {
    call: (req) => b.runtime.sendMessage(req) as Promise<never>,
    async activeUrl() {
      const [t] = await b.tabs.query({ active: true, currentWindow: true });
      return t?.url && /^https?:/i.test(t.url) ? t.url : "";
    },
    openPage(hash) {
      const url = b.runtime.getURL("page.html" + hash);
      return (async () => {
        // Firefox for Android shows the popup full screen and a new tab opens behind it: open the page right here.
        if (/Android/i.test(navigator.userAgent) && globalThis.location?.pathname.endsWith("/popup.html")) {
          location.assign(url);
          return;
        }
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
      // Firefox for Android: as openPage, a new tab would open behind the full screen popup
      if (/Android/i.test(navigator.userAgent) && globalThis.location?.pathname.endsWith("/popup.html")) return location.assign(url);
      void b.tabs.create({ url, active: true });
    },
    async installType() {
      return (await b.management?.getSelf())?.installType;
    },
    inPopup() {
      // Firefox for Android shows the page full screen: a new tab opens behind it and it cannot close itself.
      if (/Android/i.test(navigator.userAgent)) return false;
      const views = b.extension?.getViews?.({ type: "popup" });
      return !views || views.includes(globalThis);
    },
    async closeTab() {
      // window.close() does nothing in a tab that script did not open (a tab the add-on opened, or one that went
      // through the Google login), so the add-on closes its own tab
      try {
        const t = await b.tabs.getCurrent();
        if (t?.id !== undefined) return await b.tabs.remove(t.id);
      } catch {
        // fall through
      }
      // Firefox for Android: a tab that cannot close goes to the add-on's main view
      if (/Android/i.test(navigator.userAgent)) location.assign(b.runtime.getURL("popup.html"));
      else window.close();
    },
    saveFile: (text, filename) =>
      linkSave ? saveViaLink(text, filename) : saveWithPermission(b.permissions, () => b.downloads, text, filename),
    async copy(text) {
      await navigator.clipboard.writeText(text);
    },
    beta: b.runtime.getManifest().name === "PushArmor Beta",
    notificationsBlocked: () => notificationsBlocked(b.notifications, globalThis.Notification?.permission),
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
    files: {
      pick: async (file) => (await fileStore()).putPicked(file),
      drop: async (key) => (await fileStore()).deletePicked(key),
      plain: async (key) => (await fileStore()).plain(key),
      save: (blob, name) => (linkSave ? saveBlobViaLink(blob, name) : saveBlobWithPermission(b.permissions, () => b.downloads, blob, name)),
      copyImage,
      canCopyImage: typeof ClipboardItem === "function" && typeof navigator.clipboard?.write === "function",
      // Firefox desktop closes the toolbar popup when the file dialog opens
      pickInTab: () => !linkSave && !/Android/i.test(navigator.userAgent) && (b.extension?.getViews?.({ type: "popup" }) ?? []).includes(globalThis),
      onEvent(cb) {
        const f = (m: unknown) => {
          const e = m as { op?: unknown; id?: unknown; pct?: unknown } | null;
          if (e?.op === "fileEvent" && typeof e.id === "number") cb(e.id, typeof e.pct === "number" ? e.pct : undefined);
          return false;
        };
        b.runtime.onMessage.addListener(f);
        return () => b.runtime.onMessage.removeListener(f);
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
