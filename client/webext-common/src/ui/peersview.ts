// Peers list (popup and the full tab), component-webext section 7 Peers.
import type { PeerView } from "../core/rpc.ts";
import { T } from "../core/texts.ts";
import { type UiEnv, add, clear, greyFor, group, h, overflowMenu, peerStatus, platformLabel, rpc, sh, statusLine } from "./dom.ts";
import { devicesArt, icon, platformIcon, shield } from "./icons.ts";

const ACTION_LABEL: Record<string, string> = {
  pair: "Pair",
  pair_again: "Pair again",
  deny: "Deny",
  approve: "Approve",
  reply: "Reply",
  send_again: "Send again",
  approve_again: "Send again",
  cancel: "Cancel pairing",
  remove: "Remove",
  hide: "Hide",
  unhide: "Unhide",
  localDelete: "Delete",
};
// Display order of a row's actions: the main action first, the row tools last.
const ACTION_ORDER = ["pair", "pair_again", "approve", "approve_again", "reply", "send_again", "deny", "cancel", "localDelete", "remove", "hide", "unhide"];
const ACTION_CLASS: Record<string, string> = { pair: "tonal", pair_again: "tonal", approve: "primary", reply: "tonal" };
// Row tools live in the overflow menu.
const MENU = new Set(["remove", "hide", "unhide", "localDelete"]);
// With Pair again on the row, Cancel pairing moves to the overflow menu.
const inMenu = (p: PeerView, a: string): boolean => MENU.has(a) || (a === "cancel" && p.actions.includes("pair_again"));
const rank = (a: string): number => (ACTION_ORDER.indexOf(a) + 1 || ACTION_ORDER.length + 1);

/** I490: Refresh stays grey until then, across redraws of the list. */
let refreshUntil = 0;

/** Draws the list again; a message is announced in the new status region. */
export type Redraw = (message?: string, focusId?: string) => Promise<void>;

export async function renderPeers(env: UiEnv, root: HTMLElement, full: boolean, highlight?: string, message?: string, focusId?: string): Promise<void> {
  const status = h("div", { class: "status", role: "status" });
  const data = await rpc<{ peers: PeerView[] }>(env, "peers");
  clear(root);
  // focusId: the list was rebuilt after an action, so put focus back on that row (or the first heading if it is gone).
  const redraw: Redraw = (msg, focusId) => renderPeers(env, root, full, undefined, msg, focusId);
  const pairing = data.peers.filter((p) => p.fingerprint);
  for (const p of pairing) root.append(pairCard(env, p, status, redraw));
  const rows = data.peers.filter((p) => !p.fingerprint);
  if (rows.length) root.append(sh("Other devices"), group(...rows.map((p) => peerRow(env, p, status, redraw))));
  else if (!pairing.length) {
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
  root.append(pairNew());
  if (highlight) {
    const row = document.getElementById("peer-" + highlight);
    row?.scrollIntoView({ block: "center" });
    row?.classList.add("pulse");
  }
  if (focusId !== undefined) (document.getElementById("peer-" + focusId) ?? root.querySelector<HTMLElement>(".sh"))?.focus();
  const refresh = h("button", {}, icon("refresh", 18), h("span", { class: "lbl" }, "Refresh")) as HTMLButtonElement;
  if (refreshUntil > Date.now()) greyFor(refresh, refreshUntil - Date.now());
  refresh.addEventListener("click", async () => {
    refreshUntil = Date.now() + 60_000;
    greyFor(refresh, 60_000);
    try {
      await rpc(env, "refresh");
      await renderPeers(env, root, full);
    } catch (e) {
      status.textContent = (e as Error).message;
    }
  });
  root.append(status, h("div", { class: "grow" }), add(h("div", { class: "foot bar" }, refresh), !full && h("button", { onclick: () => env.openPage("#peers") }, "Open full view")));
  // Text put in a live region after it is in the page is announced; text present at insert is not.
  if (message) setTimeout(() => (status.textContent = message), 50);
}

/** "Pair a new device": pairing starts from Pair on a listed device, so the button shows how to get it listed. */
function pairNew(): HTMLElement {
  const steps = h(
    "ol",
    { class: "howto", id: "pair-howto", hidden: true },
    h("li", {}, "Install PushArmor on the other device."),
    h("li", {}, "Log in with the same account."),
    h("li", {}, "It appears here. Click Pair."),
  );
  const btn = h("button", { class: "tonal", "aria-expanded": "false", "aria-controls": "pair-howto" }, icon("add", 18), "Pair a new device");
  btn.addEventListener("click", () => {
    steps.hidden = !steps.hidden;
    btn.setAttribute("aria-expanded", String(!steps.hidden));
  });
  return h("div", { class: "pairnew" }, btn, steps);
}

/** This device (Settings): the navy hero with Rename. */
export function ownCard(env: UiEnv, name: string, platform: string, status: HTMLElement): HTMLElement {
  const card = h("div", { class: "own hero" });
  const show = (nm: string, refocus = false) => {
    const edit = h("button", { class: "quiet ib", "aria-label": "Rename", title: "Rename" }, icon("edit", 20));
    edit.addEventListener("click", () => editing(nm));
    card.classList.remove("editing");
    clear(card).append(
      h("span", { class: "wmk", "aria-hidden": "true" }, shield(84)),
      h("div", { class: "hav" }, platformIcon(platform, 20)),
      h("div", { class: "txt" }, h("div", { class: "t1 name" }, nm), h("div", { class: "t2" }, platformLabel(platform) + ", this device")),
      edit,
    );
    if (refocus) edit.focus();
  };
  const editing = (nm: string) => {
    const input = h("input", { value: nm, maxlength: "32", "aria-label": "Name of this device" }) as HTMLInputElement;
    // I487: Enter saves, Esc keeps the old name
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") save.click();
      else if (ev.key === "Escape") show(nm, true);
      else return;
      ev.preventDefault();
    });
    const save = h("button", {
        onclick: async () => {
          try {
            await rpc(env, "rename", { name: input.value });
            status.textContent = "Renamed.";
            show(input.value, true);
          } catch (e) {
            status.textContent = (e as Error).message;
            status.scrollIntoView({ block: "nearest" }); // I567: the line sits below the fold
          }
        },
      }, "Rename");
    clear(card).append(input, save);
    card.classList.add("editing");
    input.focus();
  };
  show(name);
  return card;
}

function actionButton(env: UiEnv, a: string, p: PeerView, box: HTMLElement, status: HTMLElement, redraw: Redraw, cls = ACTION_CLASS[a] ?? ""): HTMLButtonElement {
  const b = h("button", cls ? { class: cls } : {}, ...(a === "approve" ? [icon("check", 18)] : []), ACTION_LABEL[a] ?? a) as HTMLButtonElement;
  b.addEventListener("click", () => void act(env, a, p, b, box, status, redraw));
  return b;
}

function menuFor(env: UiEnv, p: PeerView, box: HTMLElement, status: HTMLElement, redraw: Redraw): HTMLElement | null {
  const items = [...p.actions].filter((a) => inMenu(p, a)).sort((x, y) => rank(x) - rank(y));
  if (!items.length) return null;
  return overflowMenu(p.label, items.map((a) => ({ label: ACTION_LABEL[a] ?? a, run: (b) => void act(env, a, p, b, box, status, redraw) })), icon("more", 20));
}

export function peerRow(env: UiEnv, p: PeerView, status: HTMLElement, redraw: Redraw): HTMLElement {
  const dim = p.greyed !== null && p.greyed !== "logged out" && p.greyed !== "send only";
  const row = h("div", { class: "prow peer" + (dim ? " off" : ""), id: "peer-" + p.id, tabindex: "-1" });
  const col = h("div", { class: "txt" });
  const head = h("div", { class: "t1 name" }, p.label + (p.hidden ? " (hidden)" : ""));
  if (p.greyed) head.addEventListener("click", () => void rpc(env, "greyedTap"));
  col.append(head, h("div", { class: "t2" }, platformLabel(p.platform)));
  const s = peerStatus(p);
  if (s) col.append(h("div", { class: "t2" }, statusLine(s.kind, s.word)));
  else if (p.greyed) col.append(h("div", { class: "t2 line" }, p.greyed));
  for (const l of p.lines) col.append(h("div", { class: "t2 line" }, l));
  if (p.countdown) col.append(h("div", { class: "t2 countdown" }, T.countdownLeft(p.countdown)));
  const main = [...p.actions].filter((a) => !inMenu(p, a)).sort((x, y) => rank(x) - rank(y));
  if (main.length) col.append(h("div", { class: "actions" }, ...main.map((a) => actionButton(env, a, p, col, status, redraw, ACTION_CLASS[a] ?? "quiet"))));
  row.append(h("div", { class: "av" }, platformIcon(p.platform)), col);
  const more = menuFor(env, p, col, status, redraw);
  if (more) row.append(more);
  return row;
}

/** Pairing card with the fingerprint plate (rendered before This device). */
export function pairCard(env: UiEnv, p: PeerView, status: HTMLElement, redraw: Redraw): HTMLElement {
  const card = h("div", { class: "pair", id: "peer-" + p.id, tabindex: "-1" });
  const chars = Array.from(p.fingerprint ?? "");
  const head = h(
    "div",
    { class: "pair-head" },
    h("div", { class: "av" }, platformIcon(p.platform)),
    h("div", { class: "txt" }, h("div", { class: "pair-title" }, 'Pair with new device: "' + p.label + '"'), h("div", { class: "t2" }, platformLabel(p.platform))),
  );
  const more = menuFor(env, p, card, status, redraw);
  if (more) head.append(more);
  card.append(
    head,
    h(
      "div",
      { class: "plate" },
      h("div", { class: "plate-label", "aria-hidden": "true" }, shield(13), T.fingerprint("").trim()),
      h("div", { class: "cells", role: "img", "aria-label": T.fingerprint(chars.join(", ")) }, ...chars.map((c) => h("span", { class: "cell", "aria-hidden": "true" }, c))),
      h("p", {}, 'Verify that "' + p.label + '" shows this same code.'),
    ),
  );
  if (p.pk) void rpc(env, "fingerprintShown", { pk: p.pk }).catch(() => undefined);
  for (const l of p.lines) if (!l.startsWith("Pairing fingerprint")) card.append(h("div", { class: "t2 line" }, l));
  const main = [...p.actions].filter((a) => !MENU.has(a) && a !== "cancel").sort((x, y) => rank(x) - rank(y));
  // Deny left, Approve right, equal width.
  const order = main.includes("deny") ? ["deny", ...main.filter((a) => a !== "deny")] : main;
  if (order.length) card.append(h("div", { class: "pair-acts" }, ...order.map((a) => actionButton(env, a, p, card, status, redraw, a === "deny" ? "danger" : ACTION_CLASS[a] ?? ""))));
  if (p.actions.includes("deny") && p.actions.includes("approve")) card.append(h("div", { class: "hint" }, icon("info", 14), "Codes do not match? Click Deny."));
  const foot = h("div", { class: "pair-foot" });
  if (p.actions.includes("cancel")) foot.append(actionButton(env, "cancel", p, card, status, redraw, ""));
  if (p.countdown) foot.append(h("span", { class: "t2 countdown" }, T.countdownLeft(p.countdown)));
  if (foot.firstChild) card.append(foot);
  return card;
}

async function act(env: UiEnv, a: string, p: PeerView, b: HTMLButtonElement, box: HTMLElement, _status: HTMLElement, redraw: Redraw): Promise<void> {
  let msg = "";
  if (a === "remove") {
    const open = box.querySelector<HTMLElement>(".confirm .keep");
    if (open) return open.focus(); // one confirm per row
    const confirm = h(
      "div",
      { class: "confirm" },
      h("div", {}, T.removeConfirm(p.label)),
      h(
        "div",
        { class: "actions" },
        h("button", { class: "keep", onclick: () => { confirm.remove(); b.focus(); } }, "Keep"),
        h("button", {
          class: "danger",
          onclick: async (ev: Event) => {
            (ev.currentTarget as HTMLButtonElement).disabled = true; // I473: one request per confirm
            let rmsg = "Removed " + p.label + ".";
            try {
              await rpc(env, "remove", { id: p.id });
            } catch (e) {
              rmsg = (e as Error).message;
            }
            await redraw(rmsg, p.id);
          },
        }, "Remove"),
      ),
    );
    // I488: Esc is Keep
    confirm.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      confirm.querySelector<HTMLElement>(".keep")?.click();
    });
    box.append(confirm);
    confirm.querySelector<HTMLElement>(".keep")?.focus(); // the safe choice; the question is read with it
    return;
  }
  const op = a === "pair_again" ? "pairAgain" : a === "send_again" ? "sendAgain" : a === "approve_again" ? "approve" : a === "unhide" || a === "hide" ? "hide" : a;
  const args: Record<string, unknown> = { id: p.id };
  if (op === "hide") args.hidden = a === "hide";
  if (a === "send_again" || a === "approve_again") greyFor(b, 60_000);
  else b.disabled = true; // I473: one request per click; the redraw below replaces the button
  try {
    const r = await rpc<unknown>(env, op, args);
    if (op === "approve" && typeof r === "string" && r !== "stored" && r !== "sent") msg = r === "denied" ? T.declinedBy(p.label) : "Approve: " + r;
  } catch (e) {
    msg = (e as Error).message;
  }
  await redraw(msg, p.id);
}
