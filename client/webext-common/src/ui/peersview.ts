// Peers list (popup and the full tab), component-webext section 7 Peers.
import type { PeerView } from "../core/rpc.ts";
import { T } from "../core/texts.ts";
import { type UiEnv, add, clear, greyFor, h, rpc } from "./dom.ts";

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

export async function renderPeers(env: UiEnv, root: HTMLElement, full: boolean, highlight?: string): Promise<void> {
  const status = h("div", { class: "status" });
  const data = await rpc<{ self: { id: string; name: string } | null; peers: PeerView[] }>(env, "peers");
  clear(root);
  if (data.self) {
    const name = h("input", { value: data.self.name, maxlength: "32", "aria-label": "Name of this device" }) as HTMLInputElement;
    root.append(
      h(
        "div",
        { class: "row own" },
        h("div", { class: "label" }, "This device"),
        name,
        h("button", {
          onclick: async () => {
            try {
              await rpc(env, "rename", { name: name.value });
              status.textContent = "Renamed";
            } catch (e) {
              status.textContent = (e as Error).message;
            }
          },
        }, "Rename"),
      ),
    );
  }
  for (const p of data.peers) {
    const row = h("div", { class: "row peer" + (p.greyed ? " greyed" : ""), id: "peer-" + p.id });
    const head = h("div", { class: "label" }, p.label + (p.hidden ? " (hidden)" : ""));
    if (p.greyed) {
      head.append(h("span", { class: "dim" }, " " + p.greyed));
      head.addEventListener("click", () => void rpc(env, "greyedTap"));
    }
    row.append(head);
    if (p.fingerprint) {
      row.append(h("div", { class: "fp" }, T.fingerprint(p.fingerprint)));
      if (p.pk) void rpc(env, "fingerprintShown", { pk: p.pk }).catch(() => undefined);
    }
    for (const l of p.lines) if (!l.startsWith("Pairing fingerprint")) row.append(h("div", { class: "line" }, l));
    if (p.countdown) row.append(h("div", { class: "dim" }, p.countdown));
    const acts = h("div", { class: "actions" });
    for (const a of p.actions) {
      const b = h("button", {}, ACTION_LABEL[a] ?? a) as HTMLButtonElement;
      b.addEventListener("click", () => void act(env, a, p, b, row, status, () => renderPeers(env, root, full)));
      acts.append(b);
    }
    row.append(acts);
    root.append(row);
    if (highlight === p.id) {
      row.scrollIntoView({ block: "center" });
      row.classList.add("pulse");
    }
  }
  const refresh = h("button", {}, "Refresh") as HTMLButtonElement;
  refresh.addEventListener("click", async () => {
    greyFor(refresh, 60_000);
    try {
      await rpc(env, "refresh");
      await renderPeers(env, root, full);
    } catch (e) {
      status.textContent = (e as Error).message;
    }
  });
  root.append(add(h("div", { class: "actions" }, refresh), !full && h("button", { onclick: () => env.openPage("#peers") }, "Open full view")), status);
}

async function act(env: UiEnv, a: string, p: PeerView, b: HTMLButtonElement, row: HTMLElement, status: HTMLElement, redraw: () => Promise<void>): Promise<void> {
  if (a === "remove") {
    const box = h(
      "div",
      { class: "confirm" },
      h("div", {}, T.removeConfirm(p.label)),
      h("button", {
        onclick: async () => {
          try {
            await rpc(env, "remove", { id: p.id });
          } catch (e) {
            status.textContent = (e as Error).message;
          }
          await redraw();
        },
      }, "Remove"),
      h("button", { onclick: () => box.remove() }, "Keep"),
    );
    row.append(box);
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
