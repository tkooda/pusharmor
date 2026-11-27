// Toolbar popup: Send, History, Peers, Settings (component-webext section 7).
import type { PeerView, StateView } from "../core/rpc.ts";
import type { SendResult } from "../core/engine.ts";
import { failText } from "../core/failtext.ts";
import { R, T, greyedText, notDeletedText, pushIssueText, quoted, saveFailText } from "../core/texts.ts";
import { BUSY, STEP, readBusy, sendingCaption } from "../model/busy.ts";
import { canReceiveNow, rememberedSelection, sendCountLabel, sendDisabled, sendToHeader, showAllChip, showCounter, sortByLabel } from "../model/sendsel.ts";
import { isLikelyUrl, sentLength } from "../model/sendurl.ts";
import { AUTH_CHANGED, AUTH_SWITCHED, type Restore } from "../model/signin.ts";
import type { HistoryRow } from "../store/db.ts";
import { type UiEnv, accountLine, add, busyBar, clear, disableFor, failView, group, h, idLabel, midEllipsis, nextTabIndex, openHref, rpc, sh, shortTime } from "./dom.ts";
import { closeDialogs, confirmDialog, dismissToast, toast } from "./dialog.ts";
import { type Chip, applyFilter, historyChips } from "./historyfilter.ts";
import { type MsgAction, msgActions, saveFilename } from "../model/msgactions.ts";
import { icon, type IconName, messagesArt, platformIcon } from "./icons.ts";
import { ownCard, renderPeers, resetPeersView } from "./peersview.ts";
import { THEME_CHOICES, parseTheme, setTheme, startTheme } from "./theme.ts";
import * as F from "../model/filerow.ts";
import { cutFileName } from "../model/filename.ts";
import { storageFullText } from "../model/filerules.ts";
import { PICKER_SIZES } from "../model/filerules.ts";
import { fileKey } from "../core/files.ts";

const CAP = 2000;
type Tab = "send" | "history" | "peers" | "settings";

/** Wordmark "PushArmor" plus the Beta badge in the Beta build. */
export function wordmark(env: UiEnv, size: number): HTMLElement {
  const wm = h("span", { class: "wm", style: "font-size:" + size + "px" }, h("span", { class: "p" }, "Push"), h("span", { class: "a" }, "Armor"));
  return add(h("span", { class: "brand" }, wm), env.beta && h("span", { class: "beta" }, "Beta"));
}

/** The view a plain open starts on: Send once a pairing is complete, else Devices. */
export function launchTab(peers: PeerView[]): "send" | "peers" {
  return peers.some((p) => p.paired) ? "send" : "peers";
}

/** Counts mounts: a mount that a newer one overtook while it waited stops before it draws. */
let mounts = 0;
let watching = false;

/**
 * The full view in page.html: the same tabs as the popup, starting on tab (default: as a plain
 * open), with arg as the History message, the Devices row, or the Send text, and openPair for
 * Pair a new device.
 */
export interface PageStart {
  tab?: Tab;
  arg?: string;
  openPair?: boolean;
}

/** The latest start a page asked for: a login change draws the view again with it. */
let lastPage: PageStart | undefined;

export async function mountPopup(env: UiEnv, root: HTMLElement, page?: PageStart): Promise<void> {
  lastPage = page;
  const again = () => mountPopup(env, root, page);
  dismissToast(); // a message that stays belongs to the view drawn before
  closeDialogs(); // so does a question about a device or message of that view
  resetPeersView();
  // not a real popup (Firefox for Android shows it full screen): the screen sets the size
  document.body.classList.toggle("full", env.inPopup?.() === false);
  const my = ++mounts;
  if (!watching && env.session !== undefined) {
    // a login state change (here, in a tab, or from the relay server) shows the matching view
    watching = true;
    env.session?.watch(AUTH_CHANGED, (v) => {
      if (typeof v === "string" && v.endsWith(AUTH_SWITCHED)) lastPage = undefined; // the old account's tab and item do not apply
      void mountPopup(env, root, lastPage);
    });
  }
  let st: StateView;
  try {
    [st] = await Promise.all([rpc<StateView>(env, "popupOpen"), startTheme(env.theme)]);
  } catch (e) {
    if (my === mounts) failView(root, (e as Error).message, () => void again());
    return;
  }
  if (my !== mounts) return;
  if (st.newerSeen) {
    toast(T.newerVersion, "info");
    void rpc(env, "newerShown").catch(() => undefined); // cleared only once shown: shown once
  }
  if (st.updateRequired) {
    clear(root).append(updateCard(env, st.recheckLocked, () => void again(), st.platform));
    root.querySelector<HTMLElement>("button.primary")?.focus(); // start on the one action
    return;
  }
  if (st.keysBroken) {
    clear(root).append(keysCard(env, () => void again()));
    root.querySelector<HTMLElement>("button.primary")?.focus();
    return;
  }
  if (st.reg !== "registered") {
    const going = (await rpc<Restore | null>(env, "signinProgress").catch(() => null))?.step === "code";
    if (my !== mounts) return;
    // logged out has no tabs; the gear opens Settings (the ones that need no account)
    const panel = h("div", { class: "body", id: "panel" }, signinCard(env, st, going, false));
    const gear = h("button", { class: "quiet ib gear", "aria-label": "Settings", title: "Settings", "aria-pressed": "false" }, icon("settings", 20)) as HTMLButtonElement;
    gear.addEventListener("click", () => {
      const open = gear.getAttribute("aria-pressed") !== "true";
      gear.setAttribute("aria-pressed", String(open));
      if (open) void settingsView(env, clear(panel), st, again);
      else clear(panel).append(signinCard(env, st, going, false));
    });
    clear(root).append(h("div", { class: "top" }, h("div", { class: "head" }, gear)), panel);
    root.querySelector<HTMLElement>("button.primary")?.focus();
    return;
  }
  // a context menu send opened this popup: it runs here with the Send popup; text over the limit opens Send to edit it
  const menu = env.inPopup?.() === true ? rpc<{ text: string; child: string; over?: true } | null>(env, "menuSendClaim").catch(() => null) : Promise.resolve(null);
  void menu.then((m) => {
    if (m && !m.over) void menuSendHere(env, m);
  });
  const blocked = env.notificationsBlocked?.().catch(() => false);
  // a failed read keeps Send, the view this open showed before
  const peers = (await rpc<{ peers: PeerView[] }>(env, "peers").catch(() => null))?.peers;
  const off = (await blocked) ? h("div", { class: "setup-bar", role: "status" }, h("span", {}, T.notificationsOff)) : null;
  // text over the limit: the popup opens on Send with it, and the view does not change after
  const took = await menu;
  const over = took?.over ? took : null;
  if (my !== mounts) return;
  const first: Tab = over ? "send" : page?.tab ?? (peers ? launchTab(peers) : "send");
  clear(root);
  const body = h("div", { class: "body", id: "panel", role: "tabpanel" });
  const tabs = h("div", { class: "tabs", role: "tablist" });
  const nav: Nav = { toDevices: () => show("peers", true), toSend: () => show("send") };
  // arg: the History message to show, the Devices row to highlight, or the text to send
  // hold: a one-off pick (a tap on a device card) that is saved as the default selection only by a send that went
  const show = (t: Tab, openPair = false, arg?: string, pick?: string, hold = false) => {
    for (const b of Array.from(tabs.children)) {
      const on = (b as HTMLElement).dataset.tab === t;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
      b.setAttribute("tabindex", on ? "0" : "-1"); // roving: one tab stop, arrows move within
      if (on) body.setAttribute("aria-labelledby", "tab-" + t);
    }
    // each view renders into its own pane; a stale view (earlier tab, still awaiting) appends to a detached pane
    const pane = h("div", { class: "pane" });
    clear(body);
    body.scrollTop = 0; // only the content area scrolls; each tab starts at its top
    body.append(pane);
    // a view that takes longer than a moment shows a loading line in the content area
    const wait = h("div", { class: "loading", role: "status" }, "Loading...");
    const slow = setTimeout(() => pane.isConnected && !pane.firstChild && body.prepend(wait), 150);
    let ready: Promise<unknown> = Promise.resolve();
    if (t === "send") ready = sendView(env, pane, st, arg, nav, pick, hold);
    if (t === "history") ready = historyView(env, pane, arg, nav);
    if (t === "peers") ready = renderPeers(env, pane, !!page, arg, undefined, openPair, (id) => void show("send", false, undefined, id, true));
    if (t === "settings") ready = settingsView(env, pane, st, again);
    // a view that fails shows the error with Retry in place of an empty pane
    return ready.catch((e) => pane.isConnected && failView(pane, (e as Error).message, () => show(t))).finally(() => {
      clearTimeout(slow);
      wait.remove();
    });
  };
  for (const [t, label] of [["send", "Send"], ["history", "History"], ["peers", "Devices"], ["settings", "Settings"]] as [Tab, string][]) {
    const b = h("button", { role: "tab", id: "tab-" + t, "aria-controls": "panel", onclick: () => show(t) }, label);
    b.dataset.tab = t;
    tabs.append(b);
  }
  tabs.addEventListener("keydown", (ev: KeyboardEvent) => {
    const all = Array.from(tabs.children) as HTMLElement[];
    const to = nextTabIndex(ev.key, all.indexOf(document.activeElement as HTMLElement), all.length);
    if (to === null || !all[to]) return;
    ev.preventDefault();
    all[to].focus();
    show(all[to].dataset.tab as Tab);
  });
  const top = h("div", { class: "top" }, h("div", { class: "head" }, h("img", { src: "icons/icon-32.png", width: "24", height: "24", alt: "" }), wordmark(env, 16)), setupBar(env, st), off, tabs);
  root.append(top, body);
  // after the first view is drawn, so the message keeps clear of its footer
  const shown = over ? show("send", false, over.text, over.child === "all" ? undefined : over.child) : show(first, page?.openPair, page?.arg);
  void shown
    .then(() => showPushIssue(env, st, () => my === mounts))
    .then(() => settlePushIssue(env, st, () => my === mounts));
}

/** After the popup open's network work: show, change, or take away the message drawn from the local state. */
export async function settlePushIssue(env: UiEnv, st: StateView, live: () => boolean = () => true): Promise<void> {
  const after = await rpc<StateView | null>(env, "popupSettled").catch(() => null);
  if (!after || !live() || after.pushIssue === st.pushIssue) return;
  if (!after.pushIssue) dismissToast();
  else await showPushIssue(env, after, live);
}

/**
 * While this browser cannot receive, an error that stays until its Close button; it comes back on the next open.
 * Check again: local causes, then one test push from the relay server. note: a line added below.
 */
export async function showPushIssue(env: UiEnv, st: StateView, live: () => boolean = () => true, note = ""): Promise<void> {
  if (!st.pushIssue) return;
  let brave = false;
  try {
    // Brave answers only in a page, never in the service worker
    brave = (await (navigator as unknown as { brave?: { isBrave?: () => Promise<boolean> } }).brave?.isBrave?.()) === true;
  } catch {
    brave = false;
  }
  const msg = pushIssueText(st.pushIssue, brave, st.pushVendor) + (note ? "\n" + note : "");
  if (live()) {
    toast(msg, "err", true, { label: "Check again", run: (b) => void checkPushAgain(env, st, b) });
    // Check again stays grey for 10 s after each tap, also in the toast drawn again
    const left = checkAgainUntil - Date.now();
    const again = document.querySelector<HTMLButtonElement>(".toast .act");
    if (left > 0 && again) disableFor(again, left);
  }
}

/** Check again is greyed until then. */
let checkAgainUntil = 0;

async function checkPushAgain(env: UiEnv, st: StateView, b: HTMLButtonElement): Promise<void> {
  checkAgainUntil = Date.now() + 10_000;
  disableFor(b, 10_000);
  const r = await rpc<{ result: string; state: StateView }>(env, "pushCheck").catch(() => null);
  if (r?.result === "sent") return toast(T.pushWorking, "ok");
  // every other result keeps the message (gone: the push address is new, but no test push arrived yet)
  const now = r?.state.pushIssue ? r.state : st;
  const note = !r || r.result === "unable" ? T.pushCheckFailed : r.result === "none" ? "" : T.pushStillCannot;
  await showPushIssue(env, now, () => true, note);
}

/** Firefox setup is not finished; the setup tab opens only from this button, never on popup open. */
function setupBar(env: UiEnv, st: StateView): HTMLElement | null {
  if (st.platform !== "firefox" || !st.setupNeeded) return null;
  return h(
    "div",
    { class: "setup-bar", role: "status" },
    h("span", {}, "Finish Firefox setup so this device can receive messages."),
    h("button", { onclick: () => void env.call({ op: "fx-open-setup" }) }, "Finish Firefox setup"),
  );
}

const DOWNLOAD_URL = "https://pusharmor.com/download";
const STORE_URL = {
  chrome: "https://chromewebstore.google.com/detail/pusharmor/eglfppbcdpmgpnckkgcjcmmbknjgeihd",
  firefox: "https://addons.mozilla.org/firefox/addon/pusharmor/",
};

/** Where Update goes: the store listing for a store install (management installType "normal"), else the download page. */
export function updateUrl(installType: string | undefined, platform: string): string {
  if (installType !== "normal") return DOWNLOAD_URL;
  return platform === "chrome" || platform === "firefox" ? STORE_URL[platform] : DOWNLOAD_URL;
}

/**
 * HTTP 426: this version no longer works with the relay server. "Check again"
 * asks once (then greyed for an hour); again() draws the view after the check.
 */
export function updateCard(env: UiEnv, locked: boolean, again: () => void, platform: string): HTMLElement {
  const check = h("button", { class: "big", disabled: locked }, locked ? "Try again later." : "Check again") as HTMLButtonElement;
  check.addEventListener("click", async () => {
    if (check.disabled) return;
    check.disabled = true;
    check.textContent = "Try again later.";
    await rpc(env, "recheck").catch(() => undefined);
    again();
  });
  return h(
    "div",
    { class: "signin", role: "alert" },
    h("img", { src: "icons/icon-128.png", width: "64", height: "64", alt: "", class: "big-tile" }),
    wordmark(env, 24),
    h("h1", { class: "banner" }, "Unable to connect."),
    h("p", { class: "slogan" }, R.tooOld),
    h("div", { class: "btns" }, check, h("button", { class: "primary big", onclick: async () => env.openUrl(updateUrl(await env.installType?.().catch(() => undefined), platform)) }, "Update")),
  );
}

/**
 * The saved keys failed the local check. Retry checks again on this device only; Delete broken
 * keys asks first, then deletes them. again() draws the view after either.
 */
export function keysCard(env: UiEnv, again: () => void): HTMLElement {
  const del = h("button", { class: "big danger" }, "Delete broken keys") as HTMLButtonElement;
  del.addEventListener("click", async () => {
    if (!(await confirmDialog(T.keysDeleteTitle, T.keysDeleteBody, "Delete"))) return;
    try {
      await rpc(env, "keysDelete");
    } catch (e) {
      toast((e as Error).message, "err");
      return;
    }
    again();
  });
  const retry = h("button", { class: "primary big" }, "Retry") as HTMLButtonElement;
  retry.addEventListener("click", async () => {
    await rpc(env, "keysRetry").catch(() => undefined);
    again();
  });
  return h(
    "div",
    { class: "signin", role: "alert" },
    h("img", { src: "icons/icon-128.png", width: "64", height: "64", alt: "", class: "big-tile" }),
    wordmark(env, 24),
    h("h1", { class: "banner" }, T.keysBrokenTitle),
    h("p", { class: "slogan" }, T.keysBrokenBody),
    h("div", { class: "btns" }, del, retry),
  );
}

/** Logged out: the log in prompt (popup, and the full tab's account views). going: a code was sent. */
export function signinCard(env: UiEnv, st: StateView, going: boolean, inTab: boolean): HTMLElement {
  const popup = env.inPopup?.() ?? true;
  const head = going ? "Check your email for your code" : st.reg === "logged_out" ? T.signedOut : st.banner ?? "Log in to use PushArmor";
  return h(
    "div",
    { class: "signin" },
    h("img", { src: "icons/icon-128.png", width: "64", height: "64", alt: "", class: "big-tile" }),
    wordmark(env, 24),
    h("div", { class: "banner" }, head),
    h("p", { class: "slogan" }, "Send the page you are on to your other devices in one click."),
    h("button", {
      class: "primary big",
      onclick: async () => {
        if (inTab) {
          location.hash = "#login";
          return;
        }
        if (!popup) {
          location.assign("page.html#login"); // not a real popup: log in right here
          return;
        }
        try {
          await env.openPage("#login");
        } catch {
          location.assign("page.html#login"); // no new tab: log in right here
          return;
        }
        window.close();
      },
    }, going ? "Continue logging in" : "Log in"),
    inTab || !popup ? null : h("div", { class: "opens" }, icon("open", 16), "Opens in a new tab"),
    h("p", { class: "e2e" }, icon("lock", 20), h("span", {}, "All of your data is always end-to-end encrypted, and can never be read by our relay server or anyone else.")),
    st.platform === "firefox" && st.receiveNote ? h("div", { class: "dim" }, st.receiveNote) : null,
  );
}

const TYPE_ICON: Record<string, IconName> = { url: "link", tel: "call", text: "notes" };

/** where an empty screen's button leads (the popup switches tab, the full tab sets its hash). */
export interface Nav {
  toDevices(): void;
  toSend(): void;
}

/** A call to action under an empty state: a line of text and a normal button. */
function cta(text: string, label: string, go: () => void): HTMLElement {
  return h("div", { class: "cta" }, h("p", {}, text), h("button", { class: "tonal", onclick: go }, label));
}

/** The icon of a file kind (from the extension). */
export function fileIcon(name: string): IconName {
  const k = F.kind(name);
  return k === "text" ? "notes" : k === "other" ? "file" : k;
}

/** A pasted or dropped file while the message box holds text: one type per message. */
const DROP_CLEAR = "Clear the message to add a file";

export async function sendView(env: UiEnv, root: HTMLElement, st: StateView, prefill?: string, nav?: Nav, pick?: string, hold = false): Promise<void> {
  const field = h("textarea", { rows: "3", "aria-label": "Text to send", placeholder: env.files ? F.PLACEHOLDER : "" }) as HTMLTextAreaElement;
  // the box opens empty; "Page URL" fills it with the current page's URL on request
  field.value = prefill ?? "";
  const pageHref = await env.activeUrl().catch(() => "");
  const pageBtn = h("button", { type: "button", class: "inb" }, icon("link", 16), F.PAGE_URL) as HTMLButtonElement;
  const fileBtn = h("button", { type: "button", class: "quiet" }, icon("attach", 16), F.CHOOSE_FILE) as HTMLButtonElement;
  const fileInput = h("input", { type: "file", hidden: true, "aria-hidden": "true", tabindex: "-1" }) as HTMLInputElement;
  const box = h("div", { class: "compose" }, field, h("div", { class: "inbtns" }, pageBtn, fileBtn));
  const card = h("div", { class: "filecard", hidden: true });
  // the chosen file replaces the box; pickedKey: its stored copy, kept for a new try of the same file
  let chosen: File | null = null;
  let pickedKey: string | null = null;
  let sending = false;
  const caption = h("span", { class: "caption" });
  const counter = h("span", { class: "counter" });
  const asText = h("input", { type: "checkbox" }) as HTMLInputElement;
  const asTextRow = h("label", { class: "astext" }, asText, h("span", {}, "Send as text"));
  // the caption always shows; the "Send as text" row only when a URL or a phone number is detected
  const meta = h("div", { class: "meta" }, caption, asTextRow, counter);
  // the detected type the "Send as text" override belongs to: a change of type clears the override
  let lastType = "text";
  const sendLabel = h("span", { class: "lbl" }, "Send");
  const sendBtn = h("button", { class: "primary big" }, icon("send", 18), sendLabel) as HTMLButtonElement;
  const head = sh("");
  const chips = h("div", { class: "dchips" });
  const got = await rpc<{ peers: PeerView[] }>(env, "peers");
  // chips and Send to show the name-only label: with the ID when two devices share a name
  const data = { ...got, peers: got.peers.map((p) => ({ ...p, label: p.chip ?? p.label })) };
  // Like Android: a device that cannot receive right now is a greyed chip, never selected and not counted.
  const sendable = data.peers.filter(canReceiveNow);
  const checks: { id: string; chip: HTMLButtonElement }[] = [];
  const on = (c: HTMLElement) => c.classList.contains("on");
  const saved = rememberedSelection(await rpc<string[]>(env, "sendSel").catch(() => []), sendable.map((p) => p.id));
  // a device named by the right-click menu is selected instead of the remembered ones (not saved until the chips change)
  // a device card tap (hold) selects only that device, and nothing when it cannot receive now
  const remembered = hold ? sendable.filter((p) => p.id === pick).map((p) => p.id) : pick !== undefined && sendable.some((p) => p.id === pick) ? [pick] : saved;
  const keep = () => rpc(env, "sendSelSet", { ids: checks.filter((c) => on(c.chip)).map((c) => c.id) }).catch(() => undefined);
  // held: chip changes are not saved until a send goes to a device; that send saves the selection as the default
  const save = () => void (hold ? undefined : keep());
  const sent = async (r: SendResult | null) => {
    if (!hold || !r || r.sent === 0) return;
    hold = false;
    await keep();
  };
  let allChip: HTMLButtonElement | null = null;
  // A toggle chip: platform icon, or a check while selected (CSS); long names end in "...".
  const press = (c: HTMLElement, v: boolean) => {
    c.setAttribute("aria-pressed", String(v));
    c.classList.toggle("on", v);
  };
  const chip = (glyph: Node, name: string, pressed: boolean, dim = false): HTMLButtonElement => {
    const c = h("button", { type: "button", class: "chip dchip" + (dim ? " off" : ""), title: name },
      h("span", { class: "pi" }, glyph), h("span", { class: "ck" }, icon("check", 16)), idLabel(h("span", { class: "nm" }), name)) as HTMLButtonElement;
    press(c, pressed);
    return c;
  };
  const count = () => checks.filter((c) => on(c.chip)).length;
  const relabel = () => {
    const n = count();
    const one = n === 1 ? sendable.find((p) => p.id === checks.find((c) => on(c.chip))!.id) : undefined;
    if (one) sendLabel.replaceChildren('Send to "', idLabel(h("span", { class: "who" }), one.label), '"');
    else sendLabel.textContent = sendCountLabel(n);
    head.textContent = sendToHeader(n, sendable.length);
    void update();
  };
  const withAll = showAllChip(st.settings.showAll, sendable.length);
  if (withAll) {
    allChip = chip(icon("devices", 16), "All", remembered === null || remembered.length === sendable.length);
    allChip.addEventListener("click", () => {
      const v = !on(allChip!);
      press(allChip!, v);
      for (const c of checks) press(c.chip, v);
      relabel();
      save();
    });
    chips.append(allChip);
  }
  // "All" sends to every sendable peer, so its chips show selected; deselecting one leaves "All".
  // With one device it is preselected (no "All" chip).
  for (const p of sortByLabel(sendable)) {
    const pressed = remembered ? remembered.includes(p.id) : allChip !== null || sendable.length === 1;
    const c = chip(platformIcon(p.platform, 16), p.label, pressed);
    c.addEventListener("click", () => {
      press(c, !on(c));
      if (allChip) press(allChip, checks.every((x) => on(x.chip)));
      relabel();
      save();
    });
    checks.push({ id: p.id, chip: c });
    chips.append(c);
  }
  for (const p of sortByLabel(data.peers.filter((x) => !canReceiveNow(x) && x.greyed && !x.hidden))) {
    const c = chip(platformIcon(p.platform, 16), p.label, false, true);
    c.classList.add("greyed");
    c.setAttribute("aria-disabled", "true");
    c.removeAttribute("aria-pressed");
    c.title = greyedText(p.label, p.greyed ?? "");
    c.addEventListener("click", () => {
      toast(c.title, "err");
      void rpc(env, "greyedTap");
    });
    chips.append(c);
  }
  const dropPicked = () => {
    if (pickedKey) void env.files?.drop(pickedKey).catch(() => undefined);
    pickedKey = null;
  };
  const drawCard = () => {
    box.hidden = chosen !== null;
    card.hidden = chosen === null;
    if (!chosen) return clear(card);
    const nm = h("div", { class: "fname" });
    const remove = h("button", { type: "button", class: "icon-btn", "aria-label": F.REMOVE_FILE, title: F.REMOVE_FILE }, icon("close", 18));
    remove.addEventListener("click", () => {
      chosen = null;
      dropPicked();
      drawCard();
      void update();
      field.focus();
    });
    card.replaceChildren(h("div", { class: "av ftile" }, icon(fileIcon(chosen.name), 22)), h("div", { class: "txt" }, nm, h("div", { class: "dim" }, F.sizeText(chosen.size))), remove);
    midEllipsis(nm, chosen.name);
  };
  const take = (f: File) => {
    const tooBig = F.pickCheck(f.name, f.size);
    if (tooBig) return toast(tooBig, "err");
    dropPicked();
    chosen = f;
    drawCard();
    void update();
  };
  pageBtn.addEventListener("click", () => {
    field.value = pageHref;
    field.focus();
    void update();
  });
  fileBtn.addEventListener("click", () => {
    // Firefox desktop closes the toolbar popup when the file dialog opens: the picker is in a tab
    if (env.files?.pickInTab()) return void env.openPage("#send=");
    fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    fileInput.value = "";
    if (f) take(f);
  });
  field.addEventListener("paste", (ev: ClipboardEvent) => {
    // text on the clipboard pastes as text; an image only when the clipboard has no text
    if (ev.clipboardData?.getData("text/plain")) return;
    const f = Array.from(ev.clipboardData?.files ?? []).find((x) => x.type.startsWith("image/"));
    if (!f || !env.files) return;
    ev.preventDefault();
    if (field.value) return toast(F.PASTE_IMAGE_CLEAR, "err");
    take(f);
  });
  box.addEventListener("dragover", (ev: DragEvent) => {
    if (env.files && ev.dataTransfer?.types.includes("Files")) ev.preventDefault();
  });
  box.addEventListener("drop", (ev: DragEvent) => {
    const f = ev.dataTransfer?.files?.[0];
    if (!f || !env.files) return;
    ev.preventDefault();
    if (field.value) return toast(f.type.startsWith("image/") ? F.PASTE_IMAGE_CLEAR : DROP_CLEAR, "err");
    take(f);
  });
  // a picked copy that was never sent goes with the popup (a send in flight keeps it: the background uses it)
  globalThis.addEventListener?.("pagehide", () => {
    if (!sending) dropPicked();
  });
  const update = async () => {
    if (chosen) {
      clear(caption);
      caption.hidden = false;
      caption.append(icon("file", 16), F.WILL_SEND_FILE);
      asTextRow.hidden = true;
      counter.textContent = "";
      sendBtn.disabled = count() === 0 || sending;
      return;
    }
    const empty = field.value === "";
    pageBtn.hidden = !empty || !pageHref;
    fileBtn.hidden = !empty || !env.files;
    // "Will be sent as text" shows once the box has content
    caption.hidden = empty;
    const d = await rpc<{ type: string; bytes: number }>(env, "detect", { text: field.value });
    // a URL wins over a phone number
    const found = isLikelyUrl(field.value) ? "url" : d.type === "tel" ? "tel" : "text";
    if (found !== lastType) asText.checked = false;
    lastType = found;
    const over = found !== "text" && asText.checked;
    const type = over ? "text" : found;
    clear(caption);
    caption.append(icon(TYPE_ICON[type] ?? "notes", 16), T.typeCaption(type));
    asTextRow.hidden = found === "text";
    // a URL also counts as sent, with "https://" when it has none (the background checks both)
    const bytes = type === "url" ? Math.max(d.bytes, sentLength(field.value, true)) : d.bytes;
    counter.textContent = !showCounter(bytes, CAP) ? "" : bytes > CAP ? T.tooLong(bytes) : T.counter(bytes);
    sendBtn.disabled = sendDisabled(bytes, CAP, count());
  };
  field.addEventListener("input", () => void update());
  asText.addEventListener("change", () => void update());
  const sendFile = async (f: File, to: string[] | "all", names: string[]): Promise<SendResult | null> => {
    const prog = sendProgress(env, sendingCaption("file", names, f.name), STEP.encryptingFor(names), names, true);
    try {
      if (!pickedKey) {
        try {
          pickedKey = await env.files!.pick(f);
        } catch (e) {
          toast((e as { name?: string } | null)?.name === "QuotaExceededError" ? storageFullText("upload", f.name) : F.unreadable(f.name), "err");
          return null;
        }
      }
      return await rpc<SendResult>(env, "sendFile", { picked: pickedKey, name: f.name, size: f.size, targets: to, shown: checks.map((c) => c.id) });
    } finally {
      prog.close();
    }
  };
  sendBtn.addEventListener("click", async () => {
    sendBtn.disabled = true;
    const to = allChip && on(allChip) ? "all" : checks.filter((c) => on(c.chip)).map((c) => c.id);
    const names = sendable.filter((p) => to === "all" || to.includes(p.id)).map((p) => p.label);
    if (chosen) {
      sending = true;
      try {
        const r = await sendFile(chosen, to, names);
        await sent(r);
        const pickedKeyOf = pickedKey;
        if (r) {
          const one = (r.all ?? r.total) === 1 && r.sent === 1 && count() === 1 ? sendable.find((p) => p.id === checks.find((c) => on(c.chip))?.id) : undefined;
          if (r.sent > 0) {
            chosen = null; // the background dropped the picked copy
            pickedKey = null;
            drawCard();
          }
          // a failure shown here is not also a notification from the background
          if ((r.error || r.failures.length) && pickedKeyOf) void rpc(env, "fileSendShown", { picked: pickedKeyOf }).catch(() => undefined);
          if (r.error) toast(r.error, "err");
          else if (r.failures.length) toast([T.sentToNofM(r.sent, r.total), ...r.failures.map((f) => f.text)].join("\n"), "err");
          else if (env.inPopup?.() === true) return window.close();
          else toast(one ? T.messageSentToOne(one.label) : T.messageSentToN(r.sent), "ok");
        }
      } catch (e) {
        toast((e as Error).message, "err");
      } finally {
        sending = false;
      }
      return void (await update());
    }
    const prog = sendProgress(env, sendingCaption(asText.checked ? "text" : lastType, names), STEP.encryptingFor(names), names);
    try {
      let r: SendResult;
      try {
        r = await rpc<SendResult>(env, "send", { text: field.value, asUrl: lastType === "url" && !asText.checked, asText: lastType !== "text" && asText.checked, targets: to, shown: checks.map((c) => c.id) });
      } finally {
        prog.close();
      }
      await sent(r);
      // one device sent to is named
      const one = (r.all ?? r.total) === 1 && r.sent === 1 && count() === 1 ? sendable.find((p) => p.id === checks.find((c) => on(c.chip))?.id) : undefined;
      if (r.sent > 0) field.value = ""; // a message sent to any device is not kept; one sent to none stays to send again
      if (r.error) toast(r.error, "err");
      else if (r.failures.length) toast([T.sentToNofM(r.sent, r.total), ...r.failures.map((f) => f.text)].join("\n"), "err");
      else {
        asText.checked = false; // the override is for this send only
        // the toolbar popup closes; the full tab and Firefox for Android show the toast
        if (env.inPopup?.() === true) return window.close();
        toast(one ? T.messageSentToOne(one.label) : T.messageSentToN(r.sent), "ok");
      }
    } catch (e) {
      toast((e as Error).message, "err");
    }
    await update();
  });
  root.append(box, card, fileInput, meta);
  // every device is greyed: say why Send is off
  const none = !sendable.length && chips.childElementCount ? h("p", { class: "dim nosend", role: "status" }, "Unable to send.\nNo device can receive messages right now.") : null;
  const noPair = nav && !data.peers.some((p) => p.paired) ? cta("Pair your first device to start sending.", "Pair a device", nav.toDevices) : null;
  // Like iOS: the free space sits under the field, so the chips sit just above Send.
  root.append(h("div", { class: "grow" }), head, chips, ...(none ? [none] : []), ...(noPair ? [noPair] : []), h("div", { class: "foot send-foot" }, sendBtn));
  relabel();
  // desktop toolbar popup: ready to type; Firefox for Android (full screen) would pop up the keyboard
  if (env.inPopup?.() === true) field.focus();
  await update();
}

/** A context menu send this popup took: the Send popup while it runs, then the result as on Send. */
async function menuSendHere(env: UiEnv, m: { text: string; child: string }): Promise<void> {
  // the send starts first and runs in the background, so a popup that closes cannot lose it; the names come after
  const sending = rpc<SendResult | null>(env, "menuSendRun");
  try {
    const peers = ((await rpc<{ peers: PeerView[] }>(env, "peers").catch(() => null))?.peers ?? []).map((p) => ({ ...p, label: p.chip ?? p.label }));
    const one = peers.find((p) => p.id === m.child);
    const names = m.child === "all" ? peers.filter(canReceiveNow).map((p) => p.label) : one ? [one.label] : [];
    const d = await rpc<{ type: string }>(env, "detect", { text: m.text }).catch(() => ({ type: "text" }));
    const prog = sendProgress(env, sendingCaption(d.type, names), STEP.encryptingFor(names), names);
    let r: SendResult | null;
    try {
      r = await sending;
    } finally {
      prog.close();
    }
    // the background sent it (the popup was late) and shows how it went
    if (!r) {
      window.close();
      return;
    }
    const total = m.child === "all" ? r.total : 1;
    // the popup shows the failure, so the background does not also notify it
    if (r.error || r.sent < total) void rpc(env, "menuSendShown").catch(() => undefined);
    if (r.error) toast(r.error, "err");
    else if (r.sent < total) toast([T.sentToNofM(r.sent, total), ...r.failures.map((f) => f.text)].join("\n"), "err");
    else window.close();
  } catch (e) {
    void rpc(env, "menuSendShown").catch(() => undefined);
    toast((e as Error).message, "err");
  }
}

/**
 * The Send popup: a modal dialog over the view (the layout stays) with the brand tile, a caption, the bar, and the step line.
 * spin: it opens on a spinner (a file is encrypted in one step); a step with done and total shows the bar.
 */
export function sendProgress(env: UiEnv, caption: string, first: string, names: string[], spin = false): { close: () => void } {
  const bar = h("progress", { max: "100", value: spin ? "0" : "25" }) as HTMLProgressElement;
  const wheel = h("span", { class: "fp-spin", "aria-hidden": "true" });
  const text = h("span", {}, first);
  const step = h("div", { class: "dim busy-cap", role: "status" }, wheel, text);
  bar.hidden = spin;
  wheel.hidden = !spin;
  const dlg = h("dialog", { class: "dlg sendprog", "aria-label": "Sending" },
    h("div", { class: "sendprog-head" }, h("img", { src: "icons/icon-128.png", width: "40", height: "40", alt: "", class: "tile big-tile" }), h("span", {}, caption)),
    ...(names.length > 1 ? [h("ul", {}, ...names.map((n) => h("li", {}, n)))] : []),
    bar,
    step,
  ) as HTMLDialogElement;
  // Esc must not dismiss it: the send runs on
  dlg.addEventListener("cancel", (ev) => ev.preventDefault());
  const unwatch = env.session?.watch(BUSY, (v) => {
    const b = readBusy(v);
    if (!b) return;
    text.textContent = b.cap;
    if (b.done === undefined || !b.total) return;
    // the first step with a count ends the spinner; the bar then stays
    bar.hidden = false;
    wheel.hidden = true;
    // the bar never goes back (the message steps after a file upload start again at a quarter)
    bar.value = Math.max(bar.value, Math.round((b.done / b.total) * 100));
  });
  document.body.append(dlg);
  dlg.showModal();
  return {
    close: () => {
      unwatch?.();
      bar.value = 100;
      dlg.close();
      dlg.remove();
    },
  };
}

/** filter0: the filter in force when the view draws again (after a delete); a plain open starts on All. */
export async function historyView(env: UiEnv, root: HTMLElement, focus?: string, nav?: Nav, filter0?: Chip): Promise<void> {
  await rpc(env, "historyOpened");
  let rows = await rpc<HistRow[]>(env, "history");
  let key = filter0?.key ?? "all";
  // the filter in force, kept as a choice after its last row goes
  let active: Chip | undefined = filter0;
  // desktop: every row always shows its checkbox, so the mode is always on (even when empty).
  // Firefox for Android: long-press (or Shift+Enter) starts multi-select; null means the mode is off.
  const always = !/Android/i.test(navigator.userAgent);
  let picked: Set<number> | null = always ? new Set() : null;
  let anchor: number | null = null; // the last toggled row: Shift+click selects the range from it
  let visible: number[] = [];
  let focusId: number | null = null;
  const bar = h("div", { class: "hselbar", hidden: true });
  const ctl: SelectCtl = {
    always,
    on: () => picked !== null,
    has: (id) => picked?.has(id) ?? false,
    start: (id) => {
      picked = new Set([id]);
      anchor = focusId = id;
      draw();
    },
    toggle: (id) => {
      if (!picked) return;
      if (!picked.delete(id)) picked.add(id);
      if (!picked.size && !always) picked = null;
      anchor = focusId = id;
      draw();
    },
    range: (id) => {
      const a = anchor === null ? -1 : visible.indexOf(anchor);
      const b = visible.indexOf(id);
      if (a < 0 || b < 0) return picked ? ctl.toggle(id) : ctl.start(id);
      picked ??= new Set();
      for (const x of visible.slice(Math.min(a, b), Math.max(a, b) + 1)) picked.add(x);
      focusId = id;
      draw();
    },
    exit: () => {
      picked = always ? new Set() : null;
      anchor = null;
      draw();
    },
  };
  if (!rows.length && key === "all") {
    root.append(
      h(
        "div",
        { class: "empty" },
        messagesArt(),
        h("div", { class: "e-title" }, "No messages yet"),
        h("p", {}, "Messages you send or receive show here."),
      ),
      ...(nav
        ? [(await rpc<{ peers: PeerView[] }>(env, "peers")).peers.some((p) => p.paired)
            ? cta("", "Send a message", nav.toSend)
            : cta("Pair your first device to start sending.", "Pair a device", nav.toDevices)]
        : []),
      h("div", { class: "grow" }),
    );
    return;
  }
  // The filter is a native select; it shows only when there is more than All to pick.
  const filter = h("select", { "aria-label": "Show messages" }) as HTMLSelectElement;
  // select all, in the checkbox column: none, some (dash), or all of the shown rows; a click selects all when none
  // is selected, else clears all (Firefox for Android then leaves select mode)
  const selAll = h("input", { type: "checkbox", class: "hselall", "aria-label": "Select all messages", hidden: true }) as HTMLInputElement;
  selAll.addEventListener("click", () => {
    const some = visible.some((id) => picked?.has(id));
    picked = !some ? new Set(visible) : always ? new Set() : null;
    draw();
  });
  const selAllBox = h("label", { class: "hselallbox" }, selAll);
  const filterRow = h("div", { class: "hfilter" }, selAllBox, filter);
  // a delete in several batches shows its steps above the list
  const delBar = busyBar(env);
  const list = group();
  list.classList.add("hist-list");
  const draw = () => {
    const f = applyFilter(rows, key);
    key = f.key;
    const opts = historyChips(rows, active);
    active = opts.find((c) => c.key === key);
    filter.replaceChildren(...opts.map((c) => h("option", { value: c.key, selected: c.key === key }, filterLabel(c.key, c.label))));
    filter.value = key;
    filter.hidden = opts.length < 2;
    // a redrawn row keeps its open or closed state (a check or uncheck must not open or close any row)
    const prev = new Map(Array.from(list.children, (e) => [e.id, e as HTMLElement]));
    clear(list);
    visible = f.rows.flatMap((r) => (r.id === undefined ? [] : [r.id]));
    const now = Date.now();
    for (const r of f.rows) list.append(historyRow(env, r, now, ctl, prev.get("h-" + r.id)));
    // a filter that matches nothing stays on and says so; only All shows every message
    if (!f.rows.length) list.append(h("div", { class: "nomatch", role: "status" }, "No matching messages"));
    const n = visible.filter((id) => picked?.has(id)).length;
    selAll.hidden = !picked;
    selAllBox.hidden = !picked;
    selAll.checked = n > 0 && n === visible.length;
    selAll.indeterminate = n > 0 && n < visible.length;
    drawBar();
    if (focusId !== null) document.getElementById("h-" + focusId)?.querySelector<HTMLElement>("input.hsel, .content")?.focus();
    focusId = null;
  };
  const drawBar = () => {
    bar.hidden = !picked?.size;
    clear(bar);
    if (!picked?.size) return;
    const n = picked.size;
    bar.append(
      h("button", {
        type: "button",
        class: "dellight",
        onclick: async () => {
          const ids = [...(picked ?? [])];
          const title = ids.length === 1 ? "Delete 1 message?" : "Delete " + ids.length + " messages?";
          const sync = (await rpc<{ syncDeletions: boolean }>(env, "getSettings")).syncDeletions;
          if (!(await confirmDialog(title, "This deletes the selected messages off " + (sync ? "this and other paired devices." : "this device."), "Delete"))) return;
          delBar.start(); // shows only when the background sends steps (several batches)
          let files = false;
          try {
            const notice = await rpc<string | null>(env, "historyDelete", { ids });
            if (notice) toast(notice, "err");
            else files = true;
          } catch (e) {
            toast((e as Error).message, "err"); // rows whose delete reached the relay server are gone: redraw
          } finally {
            delBar.stop();
          }
          clear(root);
          await historyView(env, root, undefined, nav, active);
          // the relay server file deletes finish after the list updates
          if (files) {
            const notice = await rpc<string | null>(env, "historyDeleteFiles").catch(() => null);
            if (notice) toast(notice, "err");
          }
        },
      }, "Delete " + n + " selected"),
    );
  };
  root.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && picked && !document.querySelector("dialog[open]")) ctl.exit();
  });
  filter.addEventListener("change", () => {
    key = filter.value;
    draw();
  });
  draw();
  root.append(filterRow, bar, delBar.el, list, h("div", { class: "grow" }));
  if (focus) document.getElementById("h-" + focus)?.scrollIntoView({ block: "center" });
  // files: a row redraws when its state changes; downloaded files decrypt only while History shows
  const needsDecrypt = (r: HistRow) => r.type === "file" && !!r.fs?.got && !r.fs.plain;
  const stop = env.files?.onEvent((id, pct) => {
    if (!list.isConnected) return stop?.();
    const bar = list.querySelector<HTMLProgressElement>('progress[data-file="' + id + '"]');
    if (pct !== undefined && bar) {
      bar.value = pct;
      const label = bar.previousElementSibling?.querySelector("span");
      if (label) label.textContent = "Downloading " + pct + "%";
      return;
    }
    void rpc<HistRow[]>(env, "history").then((next) => {
      if (!list.isConnected) return;
      rows = next;
      const r = rows.find((x) => x.id === id);
      const old = document.getElementById("h-" + id);
      if (r && old && (applyFilter(rows, key).rows as HistRow[]).includes(r)) {
        old.replaceWith(historyRow(env, r, Date.now(), ctl, old));
      }
      if (r && needsDecrypt(r)) void decryptRows(env);
    }, () => undefined);
  });
  if (rows.some(needsDecrypt) || rows.some((r) => r.fs?.mark)) void decryptRows(env);
}

function filterLabel(key: string, label: string): string {
  return key === "all" ? "All messages" : key === "unknown" ? T.unknownSender : "From " + quoted(label);
}

function eventText(r: HistoryRow & { sender: string }): string {
  const nm = r.sender;
  const count = r.count && r.count > 1 ? " (" + r.count + ")" : "";
  switch (r.event) {
    case "denied":
      return T.denied(nm);
    case "logged_out":
      return T.loggedOutRecv(nm);
    case "logged_in":
      return T.loggedInRecv(nm);
    default:
      return T.unreadable + count;
  }
}

type SelectCtl = { always: boolean; on: () => boolean; has: (id: number) => boolean; start: (id: number) => void; toggle: (id: number) => void; range: (id: number) => void; exit: () => void };
const LONG_PRESS_MS = 500;
// when the last long-press fired: a touch long-press also fires contextmenu (Firefox for Android), on the redrawn row
let longPressAt = -Infinity;

/** the checkbox, the long-press and right-click starts, and the tap that toggles while the mode is on. */
function wireSelect(row: HTMLElement, id: number, ctl: SelectCtl, labelIds: string): void {
  if (ctl.on()) {
    row.classList.add(ctl.always ? "hck" : "msel");
    // the checkbox is named by the row's sender and content; a click anywhere in its column toggles it
    row.prepend(h("span", { class: "hselcell" }, h("input", { type: "checkbox", class: "hsel", "aria-labelledby": labelIds, checked: ctl.has(id) })));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let suppress = false;
  let x = 0;
  let y = 0;
  const stop = () => clearTimeout(timer);
  row.addEventListener("pointerdown", (ev: PointerEvent) => {
    suppress = false;
    const t = ev.target as HTMLElement;
    if (ev.button !== 0 || t.closest("button")) return;
    // a press on a scrollbar (past the content box of the element) is a scroll drag, never a long-press
    if (ev.offsetX >= t.clientWidth || ev.offsetY >= t.clientHeight) return;
    x = ev.clientX;
    y = ev.clientY;
    timer = setTimeout(() => {
      suppress = true;
      longPressAt = Date.now();
      if (ctl.on()) ctl.toggle(id);
      else ctl.start(id);
    }, LONG_PRESS_MS);
  });
  row.addEventListener("pointermove", (ev: PointerEvent) => {
    if (Math.abs(ev.clientX - x) > 8 || Math.abs(ev.clientY - y) > 8) stop();
  });
  for (const t of ["pointerup", "pointercancel", "pointerleave"]) row.addEventListener(t, stop);
  // scroll events do not bubble: capture them, so a scroll during the press cancels it
  row.addEventListener("scroll", stop, true);
  row.addEventListener("contextmenu", (ev: Event) => {
    ev.preventDefault();
    // the same press must not toggle twice: cancel a pending long-press, skip one that just fired
    stop();
    if (Date.now() - longPressAt < 1000) return;
    if (ctl.on()) ctl.toggle(id);
    else ctl.start(id);
  });
  // capture: while the mode is on (Firefox for Android), a tap toggles and never expands the row or reaches its buttons;
  // on desktop only a click in the checkbox column toggles
  row.addEventListener("click", (ev: Event) => {
    if (suppress) {
      suppress = false;
      ev.stopPropagation();
      return;
    }
    const e = ev as MouseEvent;
    const mod = e.ctrlKey || e.metaKey;
    const box = !!(ev.target as Element | null)?.closest?.(".hselcell");
    if (!(ctl.on() && (!ctl.always || box)) && !mod && !e.shiftKey) return;
    // Ctrl (Cmd on a Mac) + click toggles a row; Shift + click selects the range from the last toggled row
    ev.preventDefault();
    ev.stopPropagation();
    if (e.shiftKey && !mod) ctl.range(id);
    else if (ctl.on()) ctl.toggle(id);
    else ctl.start(id);
  }, true);
}

/** the browser's Save-as dialog, then a toast that stays with the saved path. */
function saveText(env: UiEnv, text: string, ms: number): void {
  env.saveFile(text, saveFilename(ms)).then(
    (path) => {
      if (path !== null) toast('Message saved to "' + path + '"', "ok", true);
    },
    (e: unknown) => toast(saveFailText(e), "err"),
  );
}

/** A History row as the background lists it: a file row also has its download percent and whether its decrypted file is here. */
export type HistRow = HistoryRow & { sender: string; notDeleted?: string[]; pct?: number; here?: boolean; recipients?: { name: string; ok: boolean }[] };

/** Full-window image view: the image fits; a click toggles its real size (scroll to move); Esc or Close ends it. */
function viewImage(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const img = h("img", { src: url, alt: name, class: "fit" }) as HTMLImageElement;
  const pane = h("div", { class: "vpane" }, img);
  const dlg = h("dialog", { class: "viewer", "aria-label": name },
    h("div", { class: "vbar" }, h("span", { class: "vname" }, name), h("button", { type: "button", class: "icon-btn", "aria-label": "Close", title: "Close", onclick: () => dlg.close() }, icon("close", 20))),
    pane,
  ) as HTMLDialogElement;
  img.addEventListener("click", () => img.classList.toggle("fit"));
  dlg.addEventListener("close", () => {
    URL.revokeObjectURL(url);
    dlg.remove();
  });
  document.body.append(dlg);
  dlg.showModal();
}

/** The decrypted file of a row, or null with the row's "Removed from this device" toast. */
async function plainOf(env: UiEnv, r: HistRow): Promise<Blob | null> {
  const b = await env.files?.plain(fileKey(r.id ?? 0)).catch(() => null);
  if (!b) toast(F.REMOVED, "err");
  return b ?? null;
}

/**
 * The lines under a file row's name: size and type, then its state with Download or Decrypt; a sent file
 * shows the states of a received one once its copy was kept here (or could not be), else when it expires.
 */
function fileLines(env: UiEnv, r: HistRow, nowMs: number, row: HTMLElement): HTMLElement[] {
  const f = r.file!;
  const nowSec = Math.floor(nowMs / 1000);
  // size and type and the expiry (class "xd") show only while the row is open
  const out = [h("div", { class: "dim xd" }, F.detail(r.content, f.size))];
  if (r.dir === "out" && !r.fs) return [...out, h("div", { class: "dim xd" }, F.expiresText(f.expires, nowSec))];
  const st = F.fileRowStatus(r.fs ?? {}, r.pct !== undefined, r.pct ?? 0, r.here === true, f.expires, nowSec);
  const line = (glyph: IconName, text: string, cls: string) => h("div", { class: "fline " + cls }, icon(glyph, 16), h("span", {}, text));
  const button = (label: string, glyph: IconName, run: () => void, expires: string | null) =>
    h("div", { class: "fbtn" }, h("button", { type: "button", class: "ac", onclick: run }, icon(glyph, 15), label), expires ? h("span", { class: "dim xd" }, expires) : null);
  const download = () => void rpc(env, "fileDownload", { id: r.id }).catch((e: unknown) => toast((e as Error).message, "err"));
  switch (st.k) {
    case "pending":
      out.push(button("Download", "download", download, st.expires));
      break;
    case "downloading":
      out.push(line("download", "Downloading " + st.pct + "%", "dim"), h("progress", { max: "100", value: String(st.pct), class: "fprog", "data-file": String(r.id), "aria-label": "Downloading " + r.content }));
      break;
    case "decrypting":
      // a decrypt is one step with nothing to count: a spinner, not a bar
      out.push(h("div", { class: "fline dim" }, h("span", { class: "fp-spin", role: "status", "aria-label": "Decrypting " + r.content })));
      break;
    case "failed":
      out.push(line(st.grey ? "info" : "error", st.text, st.grey ? "dim" : "bad"));
      if (st.download) out.push(button("Download", "download", download, st.expires));
      break;
    case "memory":
      out.push(line("error", F.NO_MEMORY, "bad"), button("Decrypt", "lock", () => void decryptRows(env, r.id ?? null), null));
      break;
    case "undecrypted":
      out.push(line("error", st.text, "bad"), button("Decrypt", "lock", () => void decryptRows(env, r.id ?? null), null));
      break;
    case "expired":
      row.classList.add("faded");
      out.push(line("schedule", F.EXPIRED, "dim"));
      break;
    case "ready":
      if (F.previewMissing(r.content, r.fs ?? {})) out.push(h("div", { class: "dim" }, F.PREVIEW_NA));
      break;
  }
  return out;
}

/** The buttons of a decrypted (or sent) file kept here: View (images), Copy (images, where the clipboard takes them), Save. */
function fileButtons(env: UiEnv, r: HistRow): HTMLElement[] {
  if (!r.fs?.plain || r.here !== true) return [];
  const name = r.content;
  const btn: Record<"view" | "copy" | "save", () => HTMLElement> = {
    view: () => h("button", { class: "ac", onclick: async () => { const b = await plainOf(env, r); if (b) viewImage(b, name); } }, icon("image", 15), "View"),
    copy: () =>
      h("button", {
        class: "ac",
        onclick: async () => {
          const b = await plainOf(env, r);
          if (!b) return;
          try {
            await env.files!.copyImage(b);
          } catch {
            return toast('Unable to copy "' + cutFileName(name) + '"', "err");
          }
          toast(T.copied, "ok");
        },
      }, icon("copy", 15), "Copy"),
    save: () =>
      h("button", {
        class: "ac",
        // save() is the first call in the click: Firefox asks for the downloads permission before any await
        onclick: () =>
          void env.files!.save(r.id ?? 0, name).then(
            (path) => {
              if (path !== null) toast(F.saved(name), "ok", true);
            },
            (e: unknown) => toast((e as Error)?.message === "MISSING" ? F.REMOVED : saveFailText(e, name), "err"),
          ),
      }, icon("save", 15), "Save"),
  };
  return F.fileActions(r.fs, env.files?.canCopyImage === true).map((a) => btn[a]());
}

/** Decrypts the downloaded files while History shows (id: the Decrypt button of that row); a file short of memory gets a toast. */
let decrypting: Promise<void> | null = null;
let decryptAgain = false;
async function decryptRows(env: UiEnv, id: number | null = null): Promise<void> {
  if (decrypting && id === null) {
    decryptAgain = true;
    return decrypting;
  }
  decrypting = (async () => {
    do {
      decryptAgain = false;
      const short = await rpc<string[]>(env, "filesDecrypt", id === null ? {} : { id }).catch(() => [] as string[]);
      id = null;
      if (short.length) toast(short.map(F.noMemoryToast).join("\n"), "err");
    } while (decryptAgain);
  })().finally(() => (decrypting = null));
  return decrypting;
}

/** Each History row's own collapse, for a row that another row's select closes. */
const unselects = new WeakMap<HTMLElement, () => void>();

/** A History row; a row redrawn in place of `prev` keeps its open or closed state, its cut name, and its bold (unread) look. */
function historyRow(env: UiEnv, r: HistRow, now: number, ctl: SelectCtl, prev?: HTMLElement): HTMLElement {
  const full = new Date(r.received).toLocaleString();
  const time = h("span", { class: "time", title: full }, shortTime(r.received, now));
  const row = h("div", { class: "hrow", id: "h-" + r.id });
  if (r.type === "event") {
    // Events: a bare glyph, no tile; the sender stays visible when the text lacks it.
    const named = r.event === "denied" || r.event === "logged_out" || r.event === "logged_in";
    const col = h("div", { class: "txt" }, h("div", { class: "hmeta" }, idLabel(h("span", { class: "who", id: "h-" + r.id + "-who" }), named ? eventText(r) : r.sender), time));
    if (!named) col.append(h("div", { class: "content ev", id: "h-" + r.id + "-c" }, eventText(r)));
    row.classList.add("event");
    row.append(h("div", { class: "av bare" }, icon(r.event === "logged_out" ? "pause" : "info", 18)), col);
    wireSelect(row, r.id ?? 0, ctl, "h-" + r.id + "-who" + (named ? "" : " h-" + r.id + "-c"));
    return row;
  }
  const sent = r.results ? Object.values(r.results).filter((v) => v === "sent").length : (r.targets?.length ?? 0);
  const whoText = r.dir === "out" ? T.sentTitle(sent, r.targets?.length ?? 0) : r.sender;
  const who = idLabel(h("span", { class: "who", id: "h-" + r.id + "-who" }), whoText);
  // Sent to one device: name it in quotes; the name truncates inside them (F22).
  if (r.dir === "out" && r.targets?.length === 1 && sent === 1 && r.sender) {
    who.classList.add("one");
    who.title = T.sentToOne(r.sender);
    who.replaceChildren('Sent to "', idLabel(h("span", { class: "nm" }), r.sender), '"');
  }
  const col = h("div", { class: "txt" }, h("div", { class: "hmeta" }, who, time));
  const isFile = r.type === "file" && !!r.file;
  const one = r.type === "url" || r.type === "tel" || isFile;
  const content = h("div", { class: "content " + (one ? "one" : r.type === "unknown" ? "unk" : "clamp"), id: "h-" + r.id + "-c", role: "button", tabindex: "0" });
  if (r.type === "url" || isFile) midEllipsis(content, r.content);
  else if (r.type === "unknown") {
    // a content message of a type this version does not know: a red x and the label, no actions
    content.replaceChildren(icon("cancel", 16), T.unknownType);
  } else content.textContent = r.content;
  // a delete that did not reach every device yet: struck through, with the devices under it
  const notDeleted = r.notDeleted?.length ? r.notDeleted : null;
  if (notDeleted) content.classList.add("struck");
  // Unread: bold text, no visible marker (times stay in one column); screen readers hear "Unread".
  if (prev ? prev.classList.contains("unread") : !r.read) {
    row.classList.add("unread");
    col.append(h("span", { class: "sr", role: "img", "aria-label": "Unread" }));
  }
  // a send to 2+ devices: Recipients opens a list of the devices with Sent or Failed; it starts closed
  const rcpt = r.recipients && r.recipients.length >= 2
    ? h("details", { class: "rcpt" }, h("summary", {}, "Recipients"),
        h("ul", { class: "rcpt-list" }, ...r.recipients.map((x) => h("li", {}, idLabel(h("span", { class: "rn" }), x.name), h("span", { class: "rs" }, x.ok ? "Sent" : "Failed")))))
    : null;
  // a tap on the selected row (not its buttons) collapses it; another row selects.
  const sync = () => {
    content.setAttribute("aria-expanded", String(row.classList.contains("sel")));
    if (rcpt && !row.classList.contains("sel")) (rcpt as HTMLDetailsElement).open = false;
  };
  // an expanded URL row wraps the full URL; collapsed, it goes back to one line with the middle cut
  const select = () => {
    for (const o of Array.from(row.parentElement?.querySelectorAll<HTMLElement>(".hrow.sel") ?? [])) {
      if (o === row) continue;
      o.classList.remove("sel");
      const u = o.querySelector<HTMLElement>(".content[data-full]");
      if (u) midEllipsis(u, u.dataset.full ?? "");
      unselects.get(o)?.();
    }
    row.classList.remove("closed");
    row.classList.add("sel");
    if (r.type === "url") {
      content.classList.remove("mid");
      content.textContent = r.content;
    }
    sync();
  };
  const collapse = () => {
    row.classList.remove("sel");
    row.classList.add("closed");
    if (r.type === "url") midEllipsis(content, r.content);
    sync();
  };
  const markRead = () => {
    if (row.classList.contains("sel")) return collapse();
    void rpc(env, "historyRead", { id: r.id });
    row.querySelector(".sr")?.remove();
    row.classList.remove("unread");
    select();
  };
  unselects.set(row, sync);
  if (prev?.classList.contains("closed")) row.classList.add("closed");
  if (prev?.classList.contains("sel")) select();
  // the name as the replaced row cut it, until the next fit
  const was = prev?.querySelector<HTMLElement>(".content[data-full]");
  if (was && content.dataset.full === was.dataset.full && !(r.type === "url" && row.classList.contains("sel"))) content.textContent = was.textContent;
  sync();
  content.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    if (ev.shiftKey && ev.key === "Enter") return ctl.on() ? ctl.toggle(r.id ?? 0) : ctl.start(r.id ?? 0);
    if (ctl.on() && !ctl.always) return ctl.toggle(r.id ?? 0);
    markRead();
  });
  row.addEventListener("click", (ev: Event) => {
    const t = ev.target as Element | null;
    if (t?.closest(".acts, .rcpt, .hselcell")) return;
    if (t?.closest(".content") || row.classList.contains("sel")) markRead();
    else select();
  });
  // URL or phone number: Copy, Open, Share. Text: Read, Copy, Share, Save.
  const acts = h("div", { class: "actions acts" });
  const canShare = typeof navigator.share === "function";
  const btn: Record<MsgAction, () => HTMLElement> = {
    copy: () => h("button", { class: "ac", onclick: () => void copyText(env, r.content) }, icon("copy", 15), "Copy"),
    open: () => h("button", { class: "ac", onclick: () => env.openUrl(openHref(r.type, r.content)) }, icon("open", 15), "Open"),
    share: () => h("button", { class: "ac", onclick: () => void navigator.share({ [r.type === "url" ? "url" : "text"]: r.content }).catch(() => undefined) }, icon("share", 15), "Share"),
    read: () => h("button", { class: "ac", onclick: () => void env.openPage("#read=" + r.id) }, icon("read", 15), "View"),
    save: () => h("button", { class: "ac", onclick: () => saveText(env, r.content, r.received) }, icon("save", 15), "Save"),
  };
  // the actions share one equal-width row.
  const main = h("div", { class: "acts-row" });
  if (isFile) main.append(...fileButtons(env, r));
  else for (const a of msgActions(r.type)) if (a !== "share" || canShare) main.append(btn[a]());
  acts.append(main);
  col.append(content);
  if (isFile) col.append(...fileLines(env, r, now, row));
  if (notDeleted) col.append(h("div", { class: "dim" }, notDeletedText(notDeleted)));
  if (r.dir === "out" && r.results) {
    const fails = Object.values(r.results).filter((v) => v !== "sent").length;
    if (fails) col.append(h("div", { class: "dim" }, fails + " not delivered"));
  }
  if (rcpt) col.append(rcpt);
  if (r.type !== "unknown" && (!isFile || main.childElementCount)) col.append(acts);
  row.append(h("div", { class: "av" }, icon(isFile ? fileIcon(r.content) : r.dir === "in" ? "received" : "sent", 18)), col);
  wireSelect(row, r.id ?? 0, ctl, "h-" + r.id + "-who h-" + r.id + "-c");
  return row;
}

async function settingsView(env: UiEnv, root: HTMLElement, st: StateView, reload: () => Promise<void>): Promise<void> {
  const s = st.settings;
  const showAll = h("input", { type: "checkbox", role: "switch", checked: s.showAll }) as HTMLInputElement;
  const autoOpen = h("input", { type: "checkbox", role: "switch", checked: s.autoOpen }) as HTMLInputElement;
  const allowContent = h("input", { type: "checkbox", role: "switch", checked: s.allowContent }) as HTMLInputElement;
  const syncDeletions = h("input", { type: "checkbox", role: "switch", checked: s.syncDeletions }) as HTMLInputElement;
  const days = h("select", { "aria-label": "Delete messages older than" }) as HTMLSelectElement;
  for (const d of [1, 7, 14, 30, 90, 180, 365]) days.append(h("option", { value: String(d), selected: d === s.historyDays }, d + (d === 1 ? " day" : " days")));
  // files: one auto-download picker, and the storage limit (choices that fit this browser's quota)
  const fileAuto = h("select", { "aria-label": F.AUTO_TITLE }) as HTMLSelectElement;
  for (const v of PICKER_SIZES) fileAuto.append(h("option", { value: String(v), selected: v === F.pickerValue(s.fileAuto) }, F.pickerLabel(v)));
  const store = await rpc<{ options: number[]; limit: number }>(env, "fileStorage").catch(() => ({ options: [...F.STORAGE_SIZES], limit: F.DEFAULT_STORAGE }));
  const fileStorage = h("select", { "aria-label": F.STORAGE_TITLE }) as HTMLSelectElement;
  for (const v of store.options) fileStorage.append(h("option", { value: String(v), selected: v === store.limit }, F.storageLabel(v)));
  const theme = h("select", { "aria-label": "Theme" }) as HTMLSelectElement;
  const pref = parseTheme(await env.theme.get().catch(() => undefined));
  for (const [v, label] of THEME_CHOICES) theme.append(h("option", { value: v, selected: v === pref }, label));
  theme.addEventListener("change", () => void setTheme(env.theme, parseTheme(theme.value)).catch((e) => toast(failText("changeSetting", e), "err")));
  const values = () => ({ showAll: showAll.checked, autoOpen: autoOpen.checked, allowContent: allowContent.checked, syncDeletions: syncDeletions.checked, historyDays: Number(days.value), fileAuto: Number(fileAuto.value), fileStorage: Number(fileStorage.value) });
  // the values last saved: a failed save sets the controls back to them
  let saved = values();
  const save = () => {
    const next = values();
    // only the setting that changed is written
    const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => saved[k as keyof typeof saved] !== v));
    void rpc(env, "settings", changed).then(
      () => void (saved = next),
      (e) => {
        showAll.checked = saved.showAll;
        autoOpen.checked = saved.autoOpen;
        allowContent.checked = saved.allowContent;
        syncDeletions.checked = saved.syncDeletions;
        days.value = String(saved.historyDays);
        fileAuto.value = String(saved.fileAuto);
        fileStorage.value = String(saved.fileStorage);
        // the reply already reads "Unable to change this setting." and why
        toast((e as Error).message, "err");
      },
    );
  };
  showAll.addEventListener("change", save);
  autoOpen.addEventListener("change", save);
  allowContent.addEventListener("change", save);
  syncDeletions.addEventListener("change", save);
  days.addEventListener("change", save);
  fileAuto.addEventListener("change", save);
  fileStorage.addEventListener("change", save);
  // logged out, the settings that need an account (device name, Log out, Delete account) are not offered
  const loggedIn = st.reg === "registered";
  const self = loggedIn ? (await rpc<{ self: { id: string; name: string } | null }>(env, "peers").catch(() => null))?.self ?? null : null;
  const ff = st.platform === "firefox";
  const acct = add(
    h("div", { class: "txt" }),
    // "Logged in as" dim, the email on its own line (long ones end in "...")
    ...(accountLine(st) ? [h("div", { class: "t2" }, "Logged in as"), h("div", { class: "t1 email", title: st.email ?? "" }, st.email ?? "")] : []),
    ff && st.receiveNote ? h("div", { class: "t2" }, st.receiveNote) : null,
  );
  const acctRow = acct.childNodes.length ? h("div", { class: "srow acct" }, acct) : null;
  const outBar = busyBar(env);
  const logOut = h("button", {
    onclick: async () => {
      logOut.disabled = true;
      outBar.start(STEP.loggingOut);
      try {
        await rpc(env, "signout");
        // the logout is done: read the state again, which shows the logged-out view
        await reload();
      } catch (e) {
        toast((e as Error).message, "err");
      } finally {
        outBar.stop();
        logOut.disabled = false;
      }
    },
  }, "Log out") as HTMLButtonElement;
  const delAcct = async () => {
    if (await confirmDialog("Delete account?", "You must log in again to confirm. This cannot be undone.", "Log in to delete")) env.openPage("#login=delete-account");
  };
  const btns = h("div", { class: "btns" }, h("button", { class: "danger", onclick: () => void delAcct() }, "Delete account"), logOut);
  add(
    root,
    self && sh("Device name"),
    self && ownCard(env, self.name, st.platform, self.id),
    sh("Appearance"),
    group(h("div", { class: "srow" }, h("div", { class: "txt" }, h("div", {}, "Theme"), h("div", { class: "t2" }, "Dark uses a true black background.")), theme)),
    sh("Sending"),
    group(h("label", { class: "srow nowrap" }, h("span", {}, 'Show an "All" button when choosing devices'), showAll)),
    // received links on this device
    sh("Receiving"),
    group(h("label", { class: "srow" }, h("span", {}, "Open URLs automatically"), autoOpen), h("label", { class: "srow" }, h("span", {}, "Allow message content in notifications"), allowContent)),
    sh("Files"),
    h("p", { class: "t2 shelp" }, F.HELPER),
    group(
      h("div", { class: "srow fpick" }, h("span", {}, F.AUTO_TITLE), fileAuto),
      h("div", { class: "srow fpick" }, h("div", { class: "txt" }, h("div", {}, F.STORAGE_TITLE), h("div", { class: "t2" }, F.STORAGE_HELPER)), fileStorage),
    ),
    sh("History"),
    group(
      h("div", { class: "srow" }, h("span", {}, "Delete messages older than"), days),
      h("label", { class: "srow" }, h("div", { class: "txt" }, h("div", {}, "Sync deletions"), h("div", { class: "t2" }, "Manually deleting on this device will also delete on your other devices.")), syncDeletions),
    ),
    ...(loggedIn ? [sh("Account"), group(acctRow, h("div", { class: "srow acct-acts" }, btns)), outBar.el] : []),
    h("div", { class: "grow" }),
    versionButton(env, st.version),
  );
}

/** Copies text, then says Copied, or how to copy by hand when the clipboard write fails. */
export async function copyText(env: UiEnv, text: string): Promise<void> {
  try {
    await env.copy(text);
  } catch {
    return toast(T.copyFailed, "err");
  }
  toast(T.copied, "ok");
}

/** The bottom line of Settings: "Version X.Y.Z"; a click copies X.Y.Z. */
export function versionButton(env: UiEnv, version: string): HTMLElement {
  return h("button", { type: "button", class: "quiet t2 version", "aria-label": "Copy version " + version, onclick: () => void copyText(env, version) }, "Version " + version);
}

/** For tests: the start a login change would draw again with. */
export function lastPageForTest(): PageStart | undefined {
  return lastPage;
}
