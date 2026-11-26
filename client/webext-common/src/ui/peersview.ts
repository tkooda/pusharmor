// Peers list (popup and the full tab), component-webext section 7 Peers.
import type { PeerView } from "../core/rpc.ts";
import { sortByLabel } from "../model/sendsel.ts";
import { checkName } from "../model/names.ts";
import { STEP } from "../model/busy.ts";
import { b64urlTryDecode } from "../crypto/b64url.ts";
import { ID_LEN, addedDate, deviceId } from "../crypto/labels.ts";
import { T, clickWord, confirmResultText, isNewDeviceLabel } from "../core/texts.ts";
import { type UiEnv, add, busyBar, clear, pairCommandLine, disableFor, greyFor, group, h, overflowMenu, peerStatus, platformLabel, rpc, sh, statusLine } from "./dom.ts";
import { confirmDialog, toast } from "./dialog.ts";
import { devicesArt, icon, platformIcon, shield } from "./icons.ts";

const ACTION_LABEL: Record<string, string> = {
  pair: "Pair",
  deny: "Reject",
  approve: "Codes match",
  reply: "Reply",
  send_again: "Send again",
  try_again: "Try again",
  approve_again: "Send again",
  cancel: "Cancel pairing request",
  remove: "Remove device from account",
  localDelete: "Delete",
};
// Display order of a row's actions: the main action first, the row tools last.
const ACTION_ORDER = ["pair", "approve", "approve_again", "reply", "send_again", "try_again", "deny", "cancel", "localDelete", "remove"];
const ACTION_CLASS: Record<string, string> = { pair: "approve", approve: "approve", reply: "tonal", deny: "reject" };
// Row tools live in the overflow menu.
const MENU = new Set(["remove", "localDelete"]);
const inMenu = (_p: PeerView, a: string): boolean => MENU.has(a);
const rank = (a: string): number => (ACTION_ORDER.indexOf(a) + 1 || ACTION_ORDER.length + 1);
// "NNN-NNN-NNN" of a device id, or null for an id that is not 30 bytes.
const idText = (id: string): string | null => {
  const raw = b64urlTryDecode(id);
  return raw && raw.length === ID_LEN ? deviceId(raw) : null;
};
// Grey ID and Added lines under a device's platform (each left out while unknown).
const idLines = (p: PeerView): HTMLElement[] => {
  const id = idText(p.id);
  return [
    ...(id ? [h("div", { class: "t2" }, "ID: " + id)] : []),
    ...(p.created ? [h("div", { class: "t2" }, "Added: " + addedDate(p.created * 1000))] : []),
  ];
};

/** Refresh stays grey until then, across redraws of the list. */
let refreshUntil = 0;
/** Try again stays grey 10 s after a click, per row, across redraws of the list. */
const tryAgainUntil = new Map<string, number>();
/** the live read of the device list. */
let fpTimer: ReturnType<typeof setInterval> | null = null;
/** Rejected devices stays open across redraws of the list once opened. */
let rejectedOpen = false;

/** The view is gone (a new mount, an account switch): stops the live read and frees Refresh. */
export function resetPeersView(): void {
  if (fpTimer) clearInterval(fpTimer);
  fpTimer = null;
  refreshUntil = 0;
  tryAgainUntil.clear();
  rejectedOpen = false;
}

/** Draws the list again, with focus on that row after an action. */
type Redraw = (focusId?: string) => Promise<void>;

export async function renderPeers(env: UiEnv, root: HTMLElement, full: boolean, highlight?: string, focusId?: string, openPair = false): Promise<void> {
  const data = await rpc<{ self?: { id: string } | null; peers: PeerView[]; allowContent?: boolean }>(env, "peers");
  clear(root);
  // focusId: the list was rebuilt after an action, so put focus back on that row (or the first heading if it is gone).
  const redraw: Redraw = (focusId) => renderPeers(env, root, full, undefined, focusId);
  // rejected devices list only under Rejected devices, until they send a new pairing request or get Pair
  const listed = data.peers.filter((p) => !p.rejected);
  const rejected = sortByLabel(data.peers.filter((p) => p.rejected));
  // a view without a section (an older list): by its state
  const sec = (p: PeerView): string => {
    if (p.section) return p.section;
    if (p.paired) return "paired";
    return p.fingerprint ? "pairing" : "waiting";
  };
  const waiting = sortByLabel(listed.filter((p) => sec(p) === "waiting"));
  const pairing = sortByLabel(listed.filter((p) => sec(p) === "pairing"));
  const paired = sortByLabel(listed.filter((p) => sec(p) === "paired"));
  if (fpTimer) clearInterval(fpTimer);
  fpTimer = null;
  const allow = data.allowContent !== false;
  // a section: its heading, the pairing cards (codes shown), then one group of rows; nothing when empty
  const section = (title: string, peers: PeerView[], first = false): HTMLElement[] => {
    const cards = peers.filter((p) => p.fingerprint);
    const rest = peers.filter((p) => !p.fingerprint);
    if (!peers.length) return [];
    return [sh(title), ...cards.map((p) => pairCard(env, p, redraw)), ...(rest.length ? [group(...rest.map((p) => (first ? peerRow(env, p, redraw) : peerRow(env, p, redraw, allow, data.self?.id))))] : [])];
  };
  if (!data.peers.some((p) => p.paired)) {
    // no paired device yet: the first-pair steps and the devices waiting to pair (live)
    const shown = (p: PeerView) => !p.hidden;
    const fpClick = clickWord(navigator.userAgent).toLowerCase();
    root.append(
      h("h1", { class: "fp-title", tabindex: "-1" }, "Pair your first device"),
      h(
        "ol",
        { class: "grp fp-steps" },
        ...["Install PushArmor on another device.", "Log in with the same account.", "When it shows below, " + fpClick + " Pair, then " + fpClick + " Codes match when the codes match."].map((t, i) =>
          h("li", {}, h("span", { class: "fp-num", "aria-hidden": "true" }, String(i + 1)), h("span", {}, t)),
        ),
      ),
      ...(waiting.some(shown) || pairing.some(shown)
        ? section("Waiting to pair", waiting.filter(shown), true)
        : [sh("Waiting to pair"), group(h("div", { class: "fp-wait", role: "status" }, h("span", { class: "fp-spin", "aria-hidden": "true" }), "Waiting for another device to log in."))]),
      ...section("Pairing", pairing.filter(shown), true),
    );
  } else {
    root.append(...section("Waiting to pair", waiting), ...section("Pairing", pairing), ...section("Paired devices", paired));
    if (!listed.length) {
      root.append(
        h(
          "div",
          { class: "empty peers-empty" },
          devicesArt(120),
          h("div", { class: "e-title" }, "No devices yet"),
          h("p", {}, "Install PushArmor on your other devices and log in with the same account. They show up here, ready to pair."),
        ),
      );
    }
    root.append(pairNew(openPair));
  }
  if (rejected.length) root.append(rejectedSection(env, rejected, redraw));
  // new devices and pairing steps arrive by push into the local list: read it again every few seconds, redraw on a change
  const key = JSON.stringify(data.peers);
  const timer = setInterval(async () => {
    if (!root.isConnected) return void clearInterval(timer);
    try {
      const now = await rpc<{ peers: PeerView[] }>(env, "peers");
      if (JSON.stringify(now.peers) === key || !root.isConnected) return;
      // a redraw would close an open row menu: the next read tries again
      if (root.querySelector(".more .menu")) return;
      const active = document.activeElement as HTMLElement | null;
      const refocus = !active || active === document.body;
      // focus in a row: the same row and control get it back after the redraw
      const row = active?.closest<HTMLElement>('[id^="peer-"]') ?? null;
      const name = (el: Element) => el.getAttribute("aria-label") ?? el.textContent;
      const ctl = row && active !== row ? name(active!) : null;
      await renderPeers(env, root, full);
      if (refocus) root.querySelector<HTMLElement>(".fp-title, .sh")?.focus();
      else if (row) {
        const again = document.getElementById(row.id);
        const same = ctl === null ? undefined : Array.from(again?.querySelectorAll<HTMLElement>("button, input, a, [tabindex]") ?? []).find((el) => name(el) === ctl);
        (same ?? again ?? root.querySelector<HTMLElement>(".fp-title, .sh"))?.focus();
      }
    } catch {
      // the next read tries again
    }
  }, 3000);
  fpTimer = timer;
  if (highlight) {
    const row = document.getElementById("peer-" + highlight);
    row?.scrollIntoView({ block: "center" });
    row?.classList.add("pulse");
  }
  if (focusId !== undefined) (document.getElementById("peer-" + focusId) ?? root.querySelector<HTMLElement>(".sh"))?.focus();
  const refresh = h("button", {}, icon("refresh", 18), h("span", { class: "lbl" }, "Refresh")) as HTMLButtonElement;
  if (refreshUntil > Date.now()) disableFor(refresh, refreshUntil - Date.now());
  const upBar = busyBar(env);
  refresh.addEventListener("click", async () => {
    refreshUntil = Date.now() + 10_000;
    disableFor(refresh, 10_000);
    upBar.start(STEP.updating);
    try {
      await rpc(env, "refresh");
      await renderPeers(env, root, full);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      upBar.stop();
    }
  });
  root.append(h("div", { class: "grow" }), upBar.el, add(h("div", { class: "foot bar" }, refresh), !full && env.inPopup?.() !== false && h("button", { onclick: () => env.openPage("#peers") }, "Open full view")));
}

/** "Pair a new device": pairing starts from Pair on a listed device, so the button shows how to get it listed. */
function pairNew(open = false): HTMLElement {
  const steps = h(
    "ol",
    { class: "howto", id: "pair-howto", hidden: !open },
    h("li", {}, "Install PushArmor on the other device."),
    h("li", {}, "Log in with the same account."),
    h("li", {}, "It appears here. " + clickWord(navigator.userAgent) + " Pair."),
  );
  const btn = h("button", { class: "tonal", "aria-expanded": String(open), "aria-controls": "pair-howto" }, icon("add", 18), "Pair a new device");
  btn.addEventListener("click", () => {
    steps.hidden = !steps.hidden;
    btn.setAttribute("aria-expanded", String(!steps.hidden));
  });
  return h("div", { class: "pairnew" }, btn, steps);
}

/** "Rejected devices": a collapsed section at the bottom of the list; Pair on a row ends the rejection and starts pairing. */
function rejectedSection(env: UiEnv, peers: PeerView[], redraw: Redraw): HTMLElement {
  const d = h("details", { class: "rejected", open: rejectedOpen }, h("summary", { class: "sh" }, "Rejected devices (" + peers.length + ")"), group(...peers.map((p) => peerRow(env, p, redraw))));
  d.addEventListener("toggle", () => {
    rejectedOpen = (d as HTMLDetailsElement).open;
  });
  return d;
}

/** This device (Settings): a plain group row with Rename. */
export function ownCard(env: UiEnv, name: string, platform: string, id: string): HTMLElement {
  const card = h("div", { class: "srow own" });
  const did = idText(id);
  const show = (nm: string, refocus = false) => {
    const edit = h("button", { class: "quiet ib", "aria-label": "Rename", title: "Rename" }, icon("edit", 20));
    edit.addEventListener("click", () => editing(nm));
    card.classList.remove("editing");
    clear(card).append(
      h("div", { class: "hav" }, platformIcon(platform, 20)),
      h("div", { class: "txt" }, h("div", { class: "name" }, nm), ...(did ? [h("div", { class: "t2" }, "Device ID: " + did)] : [])),
      edit,
    );
    if (refocus) edit.focus();
  };
  const editing = (nm: string) => {
    const input = h("input", { value: nm, maxlength: "32", "aria-label": "Name of this device" }) as HTMLInputElement;
    // Enter saves, Esc keeps the old name
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") save.click();
      else if (ev.key === "Escape") show(nm, true);
      else return;
      ev.preventDefault();
    });
    let saving = false; // Enter plus a click must not rename twice
    const save = h("button", {
        onclick: async () => {
          // a name against the rule: say why, the field stays open for a fix
          const typed = checkName(input.value);
          if (typed.error !== null) {
            toast(typed.error, "err");
            input.focus();
            return;
          }
          if (saving) return;
          saving = true;
          try {
            await rpc(env, "rename", { name: typed.name });
            toast("Renamed", "ok");
            show(typed.name, true);
          } catch (e) {
            toast((e as Error).message, "err");
          } finally {
            saving = false;
          }
        },
      }, "Save");
    const cancel = h("button", { class: "quiet", onclick: () => show(nm, true) }, "Cancel");
    clear(card).append(input, cancel, save);
    card.classList.add("editing");
    input.focus();
  };
  show(name);
  return group(card);
}

function actionButton(env: UiEnv, a: string, p: PeerView, redraw: Redraw, cls = ACTION_CLASS[a] ?? "", label?: string): HTMLButtonElement {
  const b = h("button", cls ? { class: cls } : {}, label ?? ACTION_LABEL[a] ?? a) as HTMLButtonElement;
  b.addEventListener("click", () => void act(env, a, p, b, redraw));
  const left = a === "try_again" ? (tryAgainUntil.get(p.id) ?? 0) - Date.now() : 0;
  if (left > 0) disableFor(b, left);
  return b;
}

function menuFor(env: UiEnv, p: PeerView, redraw: Redraw, globalAllow?: boolean): HTMLElement | null {
  const acts = [...p.actions].filter((a) => inMenu(p, a)).sort((x, y) => rank(x) - rank(y));
  // Remove device from account stays last.
  acts.sort((x, y) => Number(x === "remove") - Number(y === "remove"));
  type Item = Parameters<typeof overflowMenu>[1][number];
  const items: Item[] = [];
  if (p.paired && globalAllow !== undefined) {
    const fail = (e: unknown) => toast((e as Error).message, "err");
    // Content in notifications from this device: off and greyed while the global setting is off.
    items.push(
      { label: "Show device on Send screen", checked: !p.hidden, run: () => void rpc(env, "hide", { id: p.id, hidden: !p.hidden }).then(() => redraw()).catch(fail) },
      { label: "Show message content in notifications", checked: globalAllow && p.allowContent !== false, disabled: !globalAllow, run: () => void rpc(env, "allowContent", { id: p.id, allow: p.allowContent === false }).then(() => redraw()).catch(fail) },
    );
  }
  acts.forEach((a, i) => items.push({ label: ACTION_LABEL[a] ?? a, separator: i === 0 && items.length > 0, run: (b) => void act(env, a, p, b, redraw) }));
  if (!items.length) return null;
  return overflowMenu(p.label, items, icon("more", 20));
}

/** Spoken summary of the per-device status icons. */
export function statusLabel(send: boolean, notif: boolean): string {
  return "Send screen " + (send ? "on" : "off") + "; content in notifications " + (notif ? "on" : "off");
}

function statusIcons(p: PeerView, globalAllow: boolean): HTMLElement {
  const one = (name: "send" | "bell", on: boolean) => h("span", { class: "si" + (on ? "" : " off") }, icon(name, 16));
  const send = !p.hidden;
  const notif = globalAllow && p.allowContent !== false;
  return h("span", { class: "stat", role: "img", "aria-label": statusLabel(send, notif) }, one("send", send), one("bell", notif));
}

function peerRow(env: UiEnv, p: PeerView, redraw: Redraw, globalAllow = true, selfId?: string): HTMLElement {
  // a grey status under a full-strength name: logged out, send only, wants to pair again, rejected this device
  const dim = p.greyed !== null && !["logged out", "send only", T.wantsPairAgain, T.rejectedThis].includes(p.greyed);
  const row = h("div", { class: "prow peer" + (dim ? " off" : ""), id: "peer-" + p.id, tabindex: "-1" });
  const col = h("div", { class: "txt" });
  const head = h("div", { class: "t1 name" }, p.label);
  if (p.greyed) head.addEventListener("click", () => void rpc(env, "greyedTap"));
  const sub = h("div", { class: "sub" });
  // the platform line only on paired devices; elsewhere the name or New Firefox device says it
  const info = h("div", { class: "info" }, ...(p.section === "paired" || (!p.section && p.paired) ? [h("div", { class: "t2" }, platformLabel(p.platform))] : []), ...idLines(p));
  const s = peerStatus(p);
  if (s) info.append(h("div", { class: "t2" }, statusLine(s.kind, s.word)));
  else if (p.greyed) info.append(h("div", { class: "t2 line" }, p.greyed));
  for (const l of p.lines) info.append(h("div", { class: "t2 line" }, l));
  if (p.countdown) info.append(h("div", { class: "t2 countdown" }, T.countdownLeft(p.countdown)));
  sub.append(info);
  const pairCmd = selfId && p.platform === "cli" && !p.paired && !p.hidden ? pairCommandLine(p.label, selfId) : null;
  if (p.paired && globalAllow !== undefined) sub.append(statusIcons(p, globalAllow));
  col.append(head, sub);
  if (pairCmd) col.append(pairCmd);
  // Negative actions (Reject, Cancel pairing request) on the left, the main action on the right.
  const neg = (a: string): number => (a === "deny" || a === "cancel" ? 0 : 1);
  const main = [...p.actions].filter((a) => !inMenu(p, a)).sort((x, y) => neg(x) - neg(y) || rank(x) - rank(y));
  // Reject and Pair (or Pair alone) fill the row width, equal halves
  const wide = main.length > 0 && main.every((a) => a === "pair" || a === "deny");
  if (main.length && !wide) col.append(h("div", { class: "actions" }, ...main.map((a) => actionButton(env, a, p, redraw, ACTION_CLASS[a] ?? "quiet"))));
  row.append(h("div", { class: "av" }, platformIcon(p.platform)), col);
  const more = menuFor(env, p, redraw, globalAllow);
  if (more) row.append(more);
  if (wide) row.append(h("div", { class: "pair-acts" }, ...main.map((a) => actionButton(env, a, p, redraw))));
  return row;
}

/** Pairing card title: Pair with new Firefox device, or Awaiting Firefox device's response after Codes match here. */
function pairTitle(p: PeerView): string {
  const named = !isNewDeviceLabel(p.label);
  const who = named ? '"' + p.label + '"' : p.label.replace(/^New /, "");
  if (p.awaiting) return "Awaiting " + who + "'s response";
  return named ? "Pair with " + who : "Pair with new " + who;
}

/** Pairing card with the fingerprint plate (rendered before This device). */
function pairCard(env: UiEnv, p: PeerView, redraw: Redraw): HTMLElement {
  const card = h("div", { class: "pair", id: "peer-" + p.id, tabindex: "-1" });
  const chars = Array.from(p.fingerprint ?? "");
  const head = h(
    "div",
    { class: "pair-head" },
    h("div", { class: "av" }, platformIcon(p.platform)),
    h("div", { class: "txt" }, h("div", { class: "pair-title" }, pairTitle(p)), ...(p.awaiting ? idLines(p).slice(0, 1) : idLines(p))),
  );
  // no more menu while waiting for the other device: Cancel pairing request is on the card
  const more = p.awaiting ? null : menuFor(env, p, redraw);
  if (more) head.append(more);
  card.append(
    head,
    h(
      "div",
      { class: "plate" },
      h("div", { class: "plate-label", "aria-hidden": "true" }, shield(13), T.fingerprint("").trim()),
      h("div", { class: "cells", role: "img", "aria-label": T.fingerprint(chars.join(", ")) }, ...chars.map((c) => h("span", { class: "cell", "aria-hidden": "true" }, c))),
      h("p", {}, "Confirm the other device shows this code."),
    ),
  );
  if (p.pk) void rpc(env, "fingerprintShown", { pk: p.pk }).catch(() => undefined);
  // waiting for the other device: the title says so, no second line
  if (!p.awaiting) for (const l of p.lines) if (!l.startsWith(T.fingerprint("").trim())) card.append(h("div", { class: "t2 line" }, l));
  const main = [...p.actions].filter((a) => !MENU.has(a) && a !== "cancel").sort((x, y) => rank(x) - rank(y));
  // Codes differ left, Codes match right, equal width.
  const order = main.includes("deny") ? ["deny", ...main.filter((a) => a !== "deny")] : main;
  if (order.length) card.append(h("div", { class: "pair-acts" }, ...order.map((a) => actionButton(env, a, p, redraw, ACTION_CLASS[a] ?? "", a === "deny" && p.actions.includes("approve") ? "Codes differ" : undefined))));
  const foot = h("div", { class: "pair-foot" });
  if (p.actions.includes("cancel")) foot.append(actionButton(env, "cancel", p, redraw, ""));
  if (p.countdown) foot.append(h("span", { class: "t2 countdown" }, T.countdownLeft(p.countdown)));
  if (foot.firstChild) card.append(foot);
  return card;
}

async function act(env: UiEnv, a: string, p: PeerView, b: HTMLButtonElement, redraw: Redraw): Promise<void> {
  let msg = "";
  let ok = false;
  if (a === "remove") {
    if (!(await confirmDialog("Remove device?", T.removeConfirm(p.label), "Remove"))) return;
    msg = T.removedDevice(p.label);
    ok = true;
    try {
      await rpc(env, "remove", { id: p.id });
    } catch (e) {
      msg = (e as Error).message;
      ok = false;
    }
    await redraw(p.id);
    return toast(msg, ok ? "ok" : "err");
  }
  const op = a === "send_again" ? "sendAgain" : a === "try_again" ? "tryAgain" : a === "approve_again" ? "approve" : a;
  const args: Record<string, unknown> = { id: p.id };
  if (a === "send_again" || a === "approve_again") greyFor(b, 60_000);
  else if (a === "try_again") {
    tryAgainUntil.set(p.id, Date.now() + 10_000);
    disableFor(b, 10_000);
  } else b.disabled = true; // one request per click; the redraw below replaces the button
  try {
    const r = await rpc<unknown>(env, op, args);
    if (op === "approve" && typeof r === "string" && r !== "stored" && r !== "sent") msg = r === "denied" ? T.declinedBy(p.label) : confirmResultText(p.label, r);
  } catch (e) {
    msg = (e as Error).message;
  }
  await redraw(p.id);
  if (msg) toast(msg, "err");
}
