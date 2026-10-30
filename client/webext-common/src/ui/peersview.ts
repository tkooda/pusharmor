// Peers list (popup and the full tab), component-webext section 7 Peers.
import type { PeerView, StateView } from "../core/rpc.ts";
import { T } from "../core/texts.ts";
import { type UiEnv, add, clear, greyFor, group, h, overflowMenu, peerStatus, platformLabel, rpc, sh, statusLine } from "./dom.ts";
import { devicesArt, icon, platformIcon, shield } from "./icons.ts";

const ACTION_LABEL: Record<string, string> = {
  pair: "Pair",
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
const ACTION_ORDER = ["pair", "approve", "approve_again", "reply", "send_again", "deny", "cancel", "localDelete", "remove", "hide", "unhide"];
const ACTION_CLASS: Record<string, string> = { pair: "tonal", approve: "primary", reply: "tonal" };
// Row tools live in the overflow menu.
const MENU = new Set(["remove", "hide", "unhide", "localDelete"]);
const rank = (a: string): number => (ACTION_ORDER.indexOf(a) + 1 || ACTION_ORDER.length + 1);

type Redraw = () => Promise<void>;

export async function renderPeers(env: UiEnv, root: HTMLElement, full: boolean, highlight?: string): Promise<void> {
  const status = h("div", { class: "status" });
  const [data, st] = await Promise.all([
    rpc<{ self: { id: string; name: string } | null; peers: PeerView[] }>(env, "peers"),
    rpc<StateView>(env, "state"),
  ]);
  clear(root);
  const redraw = () => renderPeers(env, root, full);
  const pairing = data.peers.filter((p) => p.fingerprint);
  for (const p of pairing) root.append(pairCard(env, p, status, redraw));
  if (data.self) root.append(sh("This device"), ownCard(env, data.self.name, st.platform, pairing.length > 0, status));
  const rows = data.peers.filter((p) => !p.fingerprint);
  if (rows.length) root.append(sh("Devices"), group(...rows.map((p) => peerRow(env, p, status, redraw))));
  else if (!pairing.length) {
    root.append(
      h(
        "div",
        { class: "empty peers-empty" },
        devicesArt(160),
        h("div", { class: "e-title" }, "No devices yet"),
        h("p", {}, "Install PushArmor on your other devices and sign in with the same account. They show up here, ready to pair."),
      ),
    );
  }
  if (highlight) {
    const row = document.getElementById("peer-" + highlight);
    row?.scrollIntoView({ block: "center" });
    row?.classList.add("pulse");
  }
  const refresh = h("button", { class: "quiet" }, icon("refresh", 18), h("span", { class: "lbl" }, "Refresh")) as HTMLButtonElement;
  refresh.addEventListener("click", async () => {
    greyFor(refresh, 60_000);
    try {
      await rpc(env, "refresh");
      await renderPeers(env, root, full);
    } catch (e) {
      status.textContent = (e as Error).message;
    }
  });
  root.append(status, add(h("div", { class: "foot bar" }, refresh), !full && h("button", { class: "quiet", onclick: () => env.openPage("#peers") }, "Open full view")));
}

/** This device: the navy hero, or the plain variant while a pairing card shows. */
function ownCard(env: UiEnv, name: string, platform: string, plain: boolean, status: HTMLElement): HTMLElement {
  const card = h("div", { class: "own hero" + (plain ? " plain" : "") });
  const show = (nm: string) => {
    const edit = h("button", { class: "quiet ib", "aria-label": "Rename", title: "Rename" }, icon("edit", 20));
    edit.addEventListener("click", () => editing(nm));
    card.classList.remove("editing");
    clear(card).append(
      ...(plain ? [] : [h("span", { class: "wmk", "aria-hidden": "true" }, shield(84))]),
      h("div", { class: "hav" }, platformIcon(platform, 20)),
      h("div", { class: "txt" }, h("div", { class: "t1 name" }, nm), h("div", { class: "t2" }, platformLabel(platform) + ", this device")),
      edit,
    );
  };
  const editing = (nm: string) => {
    const input = h("input", { value: nm, maxlength: "32", "aria-label": "Name of this device" }) as HTMLInputElement;
    clear(card).append(
      input,
      h("button", {
        onclick: async () => {
          try {
            await rpc(env, "rename", { name: input.value });
            status.textContent = "Renamed";
            show(input.value);
          } catch (e) {
            status.textContent = (e as Error).message;
          }
        },
      }, "Rename"),
    );
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
  const items = [...p.actions].filter((a) => MENU.has(a)).sort((x, y) => rank(x) - rank(y));
  if (!items.length) return null;
  return overflowMenu(p.label, items.map((a) => ({ label: ACTION_LABEL[a] ?? a, run: (b) => void act(env, a, p, b, box, status, redraw) })), icon("more", 20));
}

function peerRow(env: UiEnv, p: PeerView, status: HTMLElement, redraw: Redraw): HTMLElement {
  const dim = p.greyed !== null && p.greyed !== "signed out";
  const row = h("div", { class: "prow peer" + (dim ? " off" : ""), id: "peer-" + p.id });
  const col = h("div", { class: "txt" });
  const head = h("div", { class: "t1 name" }, p.label + (p.hidden ? " (hidden)" : ""));
  if (p.greyed) head.addEventListener("click", () => void rpc(env, "greyedTap"));
  col.append(head, h("div", { class: "t2" }, platformLabel(p.platform)));
  const s = peerStatus(p);
  if (s) col.append(h("div", { class: "t2" }, statusLine(s.kind, s.word)));
  else if (p.greyed) col.append(h("div", { class: "t2 line" }, p.greyed));
  for (const l of p.lines) col.append(h("div", { class: "t2 line" }, l));
  if (p.countdown) col.append(h("div", { class: "t2 countdown" }, T.countdownLeft(p.countdown)));
  const main = [...p.actions].filter((a) => !MENU.has(a)).sort((x, y) => rank(x) - rank(y));
  if (main.length) col.append(h("div", { class: "actions" }, ...main.map((a) => actionButton(env, a, p, col, status, redraw, ACTION_CLASS[a] ?? "quiet"))));
  row.append(h("div", { class: "av" }, platformIcon(p.platform)), col);
  const more = menuFor(env, p, col, status, redraw);
  if (more) row.append(more);
  return row;
}

/** Pairing card with the fingerprint plate (rendered before This device). */
function pairCard(env: UiEnv, p: PeerView, status: HTMLElement, redraw: Redraw): HTMLElement {
  const card = h("div", { class: "pair", id: "peer-" + p.id });
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
  if (p.actions.includes("deny") && p.actions.includes("approve")) card.append(h("div", { class: "hint" }, icon("info", 14), "Codes do not match? Tap Deny."));
  const foot = h("div", { class: "pair-foot" });
  if (p.actions.includes("cancel")) foot.append(actionButton(env, "cancel", p, card, status, redraw, ""));
  if (p.countdown) foot.append(h("span", { class: "t2 countdown" }, T.countdownLeft(p.countdown)));
  if (foot.firstChild) card.append(foot);
  return card;
}

async function act(env: UiEnv, a: string, p: PeerView, b: HTMLButtonElement, box: HTMLElement, status: HTMLElement, redraw: Redraw): Promise<void> {
  if (a === "remove") {
    const confirm = h(
      "div",
      { class: "confirm" },
      h("div", {}, T.removeConfirm(p.label)),
      h(
        "div",
        { class: "actions" },
        h("button", {
          class: "danger",
          onclick: async () => {
            try {
              await rpc(env, "remove", { id: p.id });
            } catch (e) {
              status.textContent = (e as Error).message;
            }
            await redraw();
          },
        }, "Remove"),
        h("button", { onclick: () => confirm.remove() }, "Keep"),
      ),
    );
    box.append(confirm);
    return;
  }
  const op = a === "send_again" ? "sendAgain" : a === "approve_again" ? "approve" : a === "unhide" || a === "hide" ? "hide" : a;
  const args: Record<string, unknown> = { id: p.id };
  if (op === "hide") args.hidden = a === "hide";
  if (a === "send_again" || a === "approve_again") greyFor(b, 60_000);
  try {
    const r = await rpc<unknown>(env, op, args);
    if (op === "approve" && typeof r === "string" && r !== "stored" && r !== "sent") status.textContent = r === "denied" ? T.declinedBy(p.label) : "Approve: " + r;
  } catch (e) {
    status.textContent = (e as Error).message;
  }
  await redraw();
}
