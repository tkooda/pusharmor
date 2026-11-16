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
import { type UiEnv, accountLine, add, busyBar, clear, disableFor, failView, group, h, midEllipsis, nextTabIndex, openHref, rpc, sh, shortTime } from "./dom.ts";
import { closeDialogs, confirmDialog, dismissToast, toast } from "./dialog.ts";
import { applyFilter, historyChips } from "./historyfilter.ts";
import { type MsgAction, msgActions, saveFilename } from "../model/msgactions.ts";
import { icon, type IconName, messagesArt, platformIcon } from "./icons.ts";
import { ownCard, renderPeers, resetPeersView } from "./peersview.ts";
import { THEME_CHOICES, parseTheme, setTheme, startTheme } from "./theme.ts";

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
  const menuOver = env.inPopup?.() === true ? menuSendHere(env) : Promise.resolve(null);
  const blocked = env.notificationsBlocked?.().catch(() => false);
  // a failed read keeps Send, the view this open showed before
  const peers = (await rpc<{ peers: PeerView[] }>(env, "peers").catch(() => null))?.peers;
  const off = (await blocked) ? h("div", { class: "setup-bar", role: "status" }, h("span", {}, T.notificationsOff)) : null;
  if (my !== mounts) return;
  const first: Tab = page?.tab ?? (peers ? launchTab(peers) : "send");
  clear(root);
  const body = h("div", { class: "body", id: "panel", role: "tabpanel" });
  const tabs = h("div", { class: "tabs", role: "tablist" });
  const nav: Nav = { toDevices: () => show("peers", true), toSend: () => show("send") };
  // arg: the History message to show, the Devices row to highlight, or the text to send
  const show = (t: Tab, openPair = false, arg?: string) => {
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
    if (t === "send") ready = sendView(env, pane, st, arg, nav);
    if (t === "history") ready = historyView(env, pane, arg, nav);
    if (t === "peers") ready = renderPeers(env, pane, !!page, arg, undefined, openPair);
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
  const shown = show(first, page?.openPair, page?.arg);
  void Promise.all([shown, menuOver]).then(([, over]) => over !== null && my === mounts && show("send", false, over));
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

export async function sendView(env: UiEnv, root: HTMLElement, st: StateView, prefill?: string, nav?: Nav): Promise<void> {
  const field = h("textarea", { rows: "3", "aria-label": "Text to send" }) as HTMLTextAreaElement;
  field.value = prefill ?? (await env.activeUrl().catch(() => ""));
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
  const data = await rpc<{ peers: PeerView[] }>(env, "peers");
  // Like Android: a device that cannot receive right now is a greyed chip, never selected and not counted.
  const sendable = data.peers.filter(canReceiveNow);
  const checks: { id: string; chip: HTMLButtonElement }[] = [];
  const on = (c: HTMLElement) => c.classList.contains("on");
  const remembered = rememberedSelection(await rpc<string[]>(env, "sendSel").catch(() => []), sendable.map((p) => p.id));
  const save = () => void rpc(env, "sendSelSet", { ids: checks.filter((c) => on(c.chip)).map((c) => c.id) }).catch(() => undefined);
  let allChip: HTMLButtonElement | null = null;
  // A toggle chip: platform icon, or a check while selected (CSS); long names end in "...".
  const press = (c: HTMLElement, v: boolean) => {
    c.setAttribute("aria-pressed", String(v));
    c.classList.toggle("on", v);
  };
  const chip = (glyph: Node, name: string, pressed: boolean, dim = false): HTMLButtonElement => {
    const c = h("button", { type: "button", class: "chip dchip" + (dim ? " off" : ""), title: name },
      h("span", { class: "pi" }, glyph), h("span", { class: "ck" }, icon("check", 16)), h("span", { class: "nm" }, name)) as HTMLButtonElement;
    press(c, pressed);
    return c;
  };
  const count = () => checks.filter((c) => on(c.chip)).length;
  const relabel = () => {
    const n = count();
    const one = n === 1 ? sendable.find((p) => p.id === checks.find((c) => on(c.chip))!.id) : undefined;
    if (one) sendLabel.replaceChildren('Send to "', h("span", { class: "who" }, one.label), '"');
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
  const update = async () => {
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
  sendBtn.addEventListener("click", async () => {
    sendBtn.disabled = true;
    const to = allChip && on(allChip) ? "all" : checks.filter((c) => on(c.chip)).map((c) => c.id);
    const names = sendable.filter((p) => to === "all" || to.includes(p.id)).map((p) => p.label);
    const prog = sendProgress(env, sendingCaption(asText.checked ? "text" : lastType, names), STEP.encryptingFor(names), names);
    try {
      let r: SendResult;
      try {
        r = await rpc<SendResult>(env, "send", { text: field.value, asUrl: lastType === "url" && !asText.checked, asText: lastType !== "text" && asText.checked, targets: to });
      } finally {
        prog.close();
      }
      // one device sent to is named
      const one = r.total === 1 && r.sent === 1 && count() === 1 ? sendable.find((p) => p.id === checks.find((c) => on(c.chip))?.id) : undefined;
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
  root.append(field, meta);
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

/** A context menu send this popup took: the Send popup while it runs, then the result as on Send. Text over the limit is returned, not sent. */
async function menuSendHere(env: UiEnv): Promise<string | null> {
  const m = await rpc<{ text: string; child: string; over?: true } | null>(env, "menuSendClaim").catch(() => null);
  if (!m) return null;
  if (m.over) return m.text;
  try {
    const peers = (await rpc<{ peers: PeerView[] }>(env, "peers")).peers;
    const one = peers.find((p) => p.id === m.child);
    const names = m.child === "all" ? peers.filter(canReceiveNow).map((p) => p.label) : one ? [one.label] : [];
    const d = await rpc<{ type: string }>(env, "detect", { text: m.text });
    const prog = sendProgress(env, sendingCaption(d.type, names), STEP.encryptingFor(names), names);
    let r: SendResult;
    try {
      r = await rpc<SendResult>(env, "send", { text: m.text, auto: true, targets: m.child === "all" ? "all" : [m.child] });
    } finally {
      prog.close();
    }
    const total = m.child === "all" ? r.total : 1;
    if (r.error) toast(r.error, "err");
    else if (r.sent < total) toast([T.sentToNofM(r.sent, total), ...r.failures.map((f) => f.text)].join("\n"), "err");
    else window.close();
  } catch (e) {
    toast((e as Error).message, "err");
  }
  return null;
}

/** The Send popup: a modal dialog over the view (the layout stays) with the brand tile, a caption, the bar, and the step line. */
function sendProgress(env: UiEnv, caption: string, first: string, names: string[]): { close: () => void } {
  const bar = h("progress", { max: "100", value: "25" }) as HTMLProgressElement;
  const step = h("div", { class: "dim", role: "status" }, first);
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
    step.textContent = b.cap;
    if (b.done !== undefined && b.total) bar.value = Math.round((b.done / b.total) * 100);
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

export async function historyView(env: UiEnv, root: HTMLElement, focus?: string, nav?: Nav): Promise<void> {
  await rpc(env, "historyOpened");
  const rows = await rpc<(HistoryRow & { sender: string; notDeleted?: string[] })[]>(env, "history");
  let key = "all";
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
  if (!rows.length) {
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
    const opts = historyChips(rows);
    filter.replaceChildren(...opts.map((c) => h("option", { value: c.key, selected: c.key === key }, filterLabel(c.key, c.label))));
    filter.value = key;
    filter.hidden = opts.length < 2;
    clear(list);
    visible = f.rows.flatMap((r) => (r.id === undefined ? [] : [r.id]));
    const now = Date.now();
    for (const r of f.rows) list.append(historyRow(env, r, now, ctl));
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
          try {
            const notice = await rpc<string | null>(env, "historyDelete", { ids });
            if (notice) toast(notice, "err");
          } catch (e) {
            toast((e as Error).message, "err"); // rows whose delete reached the relay server are gone: redraw
          } finally {
            delBar.stop();
          }
          clear(root);
          await historyView(env, root, undefined, nav);
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
    // the checkbox is named by the row's sender and content
    row.prepend(h("input", { type: "checkbox", class: "hsel", "aria-labelledby": labelIds, checked: ctl.has(id) }));
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
  // on desktop only a click on the checkbox toggles
  row.addEventListener("click", (ev: Event) => {
    if (suppress) {
      suppress = false;
      ev.stopPropagation();
      return;
    }
    const e = ev as MouseEvent;
    const mod = e.ctrlKey || e.metaKey;
    const box = !!(ev.target as Element | null)?.closest?.("input.hsel");
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

function historyRow(env: UiEnv, r: HistoryRow & { sender: string; notDeleted?: string[] }, now: number, ctl: SelectCtl): HTMLElement {
  const full = new Date(r.received).toLocaleString();
  const time = h("span", { class: "time", title: full }, shortTime(r.received, now));
  const row = h("div", { class: "hrow", id: "h-" + r.id });
  if (r.type === "event") {
    // Events: a bare glyph, no tile; the sender stays visible when the text lacks it.
    const named = r.event === "denied" || r.event === "logged_out" || r.event === "logged_in";
    const col = h("div", { class: "txt" }, h("div", { class: "hmeta" }, h("span", { class: "who", id: "h-" + r.id + "-who" }, named ? eventText(r) : r.sender), time));
    if (!named) col.append(h("div", { class: "content ev", id: "h-" + r.id + "-c" }, eventText(r)));
    row.classList.add("event");
    row.append(h("div", { class: "av bare" }, icon(r.event === "logged_out" ? "pause" : "info", 18)), col);
    wireSelect(row, r.id ?? 0, ctl, "h-" + r.id + "-who" + (named ? "" : " h-" + r.id + "-c"));
    return row;
  }
  const sent = r.results ? Object.values(r.results).filter((v) => v === "sent").length : (r.targets?.length ?? 0);
  const whoText = r.dir === "out" ? T.sentToNofM(sent, r.targets?.length ?? 0) : r.sender;
  const who = h("span", { class: "who", id: "h-" + r.id + "-who" }, whoText);
  // Sent to one device: name it in quotes; the name truncates inside them (F22).
  if (r.dir === "out" && r.targets?.length === 1 && sent === 1 && r.sender) {
    who.classList.add("one");
    who.title = T.sentToOne(r.sender);
    who.replaceChildren('Sent to "', h("span", { class: "nm" }, r.sender), '"');
  }
  const col = h("div", { class: "txt" }, h("div", { class: "hmeta" }, who, time));
  const one = r.type === "url" || r.type === "tel";
  const content = h("div", { class: "content " + (one ? "one" : "clamp"), id: "h-" + r.id + "-c", role: "button", tabindex: "0" });
  if (r.type === "url") midEllipsis(content, r.content);
  else content.textContent = r.content;
  // a delete that did not reach every device yet: struck through, with the devices under it
  const notDeleted = r.notDeleted?.length ? r.notDeleted : null;
  if (notDeleted) content.classList.add("struck");
  // Unread: bold text, no visible marker (times stay in one column); screen readers hear "Unread".
  if (!r.read) {
    row.classList.add("unread");
    col.append(h("span", { class: "sr", role: "img", "aria-label": "Unread" }));
  }
  // a tap on the selected row (not its buttons) collapses it; another row selects.
  const sync = () => content.setAttribute("aria-expanded", String(row.classList.contains("sel")));
  // an expanded URL row wraps the full URL; collapsed, it goes back to one line with the middle cut
  const select = () => {
    for (const o of Array.from(row.parentElement?.querySelectorAll<HTMLElement>(".hrow.sel") ?? [])) {
      if (o === row) continue;
      o.classList.remove("sel");
      const u = o.querySelector<HTMLElement>(".content[data-full]");
      if (u) midEllipsis(u, u.dataset.full ?? "");
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
    if (t?.closest(".acts")) return;
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
  for (const a of msgActions(r.type)) if (a !== "share" || canShare) main.append(btn[a]());
  acts.append(main);
  col.append(content);
  if (notDeleted) col.append(h("div", { class: "dim" }, notDeletedText(notDeleted)));
  if (r.dir === "out" && r.results) {
    const fails = Object.values(r.results).filter((v) => v !== "sent").length;
    if (fails) col.append(h("div", { class: "dim" }, fails + " not delivered"));
  }
  col.append(acts);
  row.append(h("div", { class: "av" }, icon(r.dir === "in" ? "received" : "sent", 18)), col);
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
  for (const d of [1, 7, 30, 90, 365]) days.append(h("option", { value: String(d), selected: d === s.historyDays }, d + (d === 1 ? " day" : " days")));
  const theme = h("select", { "aria-label": "Theme" }) as HTMLSelectElement;
  const pref = parseTheme(await env.theme.get().catch(() => undefined));
  for (const [v, label] of THEME_CHOICES) theme.append(h("option", { value: v, selected: v === pref }, label));
  theme.addEventListener("change", () => void setTheme(env.theme, parseTheme(theme.value)).catch((e) => toast(failText("changeSetting", e), "err")));
  const values = () => ({ showAll: showAll.checked, autoOpen: autoOpen.checked, allowContent: allowContent.checked, syncDeletions: syncDeletions.checked, historyDays: Number(days.value) });
  // the values last saved: a failed save sets the controls back to them
  let saved = values();
  const save = () => {
    const next = values();
    void rpc(env, "settings", next).then(
      () => void (saved = next),
      (e) => {
        showAll.checked = saved.showAll;
        autoOpen.checked = saved.autoOpen;
        allowContent.checked = saved.allowContent;
        syncDeletions.checked = saved.syncDeletions;
        days.value = String(saved.historyDays);
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
    self && ownCard(env, self.name, st.platform),
    sh("Appearance"),
    group(h("div", { class: "srow" }, h("div", { class: "txt" }, h("div", {}, "Theme"), h("div", { class: "t2" }, "Dark uses a true black background.")), theme)),
    sh("Sending"),
    group(h("label", { class: "srow" }, h("span", {}, 'Show an "All" button when choosing devices'), showAll)),
    // received links on this device
    sh("Receiving"),
    group(h("label", { class: "srow" }, h("span", {}, "Open URLs automatically"), autoOpen), h("label", { class: "srow" }, h("span", {}, "Allow message content in notifications"), allowContent)),
    sh("History"),
    group(
      h("div", { class: "srow" }, h("span", {}, "Delete messages older than"), days),
      h("label", { class: "srow" }, h("div", { class: "txt" }, h("div", {}, "Sync deletions"), h("div", { class: "t2" }, "Deleting on this device will also delete on your other devices.")), syncDeletions),
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
