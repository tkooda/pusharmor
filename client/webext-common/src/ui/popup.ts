// Toolbar popup: Send, History, Peers, Settings (component-webext section 7).
import type { PeerView, StateView } from "../core/rpc.ts";
import type { SendResult } from "../core/engine.ts";
import { T } from "../core/texts.ts";
import type { HistoryRow } from "../store/db.ts";
import { type UiEnv, add, clear, h, rpc } from "./dom.ts";
import { applyFilter, historyChips } from "./historyfilter.ts";
import { renderPeers } from "./peersview.ts";

const CAP = 2048;
type Tab = "send" | "history" | "peers" | "settings";

export async function mountPopup(env: UiEnv, root: HTMLElement): Promise<void> {
  let st: StateView;
  try {
    st = await rpc<StateView>(env, "popupOpen");
  } catch (e) {
    root.textContent = (e as Error).message;
    return;
  }
  clear(root);
  if (st.reg !== "registered") {
    const head = st.reg === "paused" ? T.signedOut : st.banner ?? "Sign in to use PushArmor";
    add(
      root,
      h("div", { class: "banner" }, head),
      h("button", { onclick: () => env.openPage("#login") }, "Sign in"),
      st.platform === "firefox" && st.receiveNote ? h("div", { class: "dim" }, st.receiveNote) : null,
    );
    return;
  }
  const body = h("div", { class: "body" });
  const tabs = h("div", { class: "tabs", role: "tablist" });
  const show = (t: Tab, prefill?: string) => {
    for (const b of Array.from(tabs.children)) b.classList.toggle("on", (b as HTMLElement).dataset.tab === t);
    clear(body);
    if (t === "send") void sendView(env, body, st, prefill);
    if (t === "history") void historyView(env, body, (text) => show("send", text));
    if (t === "peers") void renderPeers(env, body, false);
    if (t === "settings") void settingsView(env, body, st);
  };
  for (const [t, label] of [["send", "Send"], ["history", "History"], ["peers", "Peers"], ["settings", "Settings"]] as [Tab, string][]) {
    const b = h("button", { role: "tab", onclick: () => show(t) }, label);
    b.dataset.tab = t;
    tabs.append(b);
  }
  root.append(tabs, body);
  show("send");
}

export async function sendView(env: UiEnv, root: HTMLElement, st: StateView, prefill?: string, offerCut = false): Promise<void> {
  const field = h("textarea", { rows: "3", "aria-label": "Text to send" }) as HTMLTextAreaElement;
  field.value = prefill ?? (await env.activeUrl().catch(() => ""));
  const badge = h("span", { class: "badge" });
  const counter = h("span", { class: "counter" });
  const asText = h("input", { type: "checkbox" }) as HTMLInputElement;
  const sendBtn = h("button", { class: "primary" }, "Send") as HTMLButtonElement;
  const result = h("div", { class: "result" });
  const targetsBox = h("div", { class: "targets" });
  const data = await rpc<{ peers: PeerView[] }>(env, "peers");
  const sendable = data.peers.filter((p) => p.sendable);
  const checks: { id: string; box: HTMLInputElement }[] = [];
  let allBox: HTMLInputElement | null = null;
  if (st.settings.showAll) {
    allBox = h("input", { type: "checkbox", checked: true }) as HTMLInputElement;
    targetsBox.append(h("label", { class: "target" }, allBox, " All"));
  }
  for (const p of sendable) {
    const box = h("input", { type: "checkbox" }) as HTMLInputElement;
    checks.push({ id: p.id, box });
    targetsBox.append(h("label", { class: "target" }, box, " " + p.label));
  }
  for (const p of data.peers.filter((x) => !x.sendable && x.greyed && !x.hidden)) {
    targetsBox.append(h("div", { class: "target greyed", onclick: () => void rpc(env, "greyedTap") }, p.label + " " + p.greyed));
  }
  const update = async () => {
    const d = await rpc<{ type: string; bytes: number }>(env, "detect", { text: field.value });
    badge.textContent = T.typeBadge(asText.checked ? "text" : d.type);
    counter.textContent = d.bytes > CAP ? T.tooLong(d.bytes) : T.counter(d.bytes);
    counter.classList.toggle("red", d.bytes >= CAP * 0.9);
    sendBtn.disabled = d.bytes > CAP || d.bytes === 0;
  };
  field.addEventListener("input", () => void update());
  asText.addEventListener("change", () => void update());
  sendBtn.addEventListener("click", async () => {
    sendBtn.disabled = true;
    const targets = allBox?.checked ? "all" : checks.filter((c) => c.box.checked).map((c) => c.id);
    try {
      const r = await rpc<SendResult>(env, "send", { text: field.value, asText: asText.checked, targets });
      clear(result).append(h("div", {}, T.sentToNofM(r.sent, r.total)), ...r.failures.map((f) => h("div", { class: "dim" }, f.text)));
      if (r.error) result.append(h("div", { class: "err" }, r.error));
    } catch (e) {
      result.textContent = (e as Error).message;
    }
    sendBtn.disabled = false;
  });
  root.append(field, h("div", { class: "meta" }, badge, " ", counter, h("label", {}, asText, " Send as text")));
  if (offerCut) {
    root.append(
      h("button", {
        onclick: async () => {
          const enc = new TextEncoder();
          let out = "";
          for (const ch of field.value) {
            if (enc.encode(out + ch).length > CAP) break;
            out += ch;
          }
          field.value = out;
          asText.checked = true;
          await update();
        },
      }, "Send the first 2048 bytes"),
    );
  }
  root.append(targetsBox, sendBtn, result);
  await update();
}

export async function historyView(env: UiEnv, root: HTMLElement, resend: (text: string) => void, focus?: string): Promise<void> {
  await rpc(env, "historyOpened");
  const rows = await rpc<(HistoryRow & { sender: string })[]>(env, "history");
  let key = "all";
  const chipsBox = h("div", { class: "chips" });
  const list = h("div", { class: "list" });
  const draw = () => {
    const f = applyFilter(rows, key);
    key = f.key;
    clear(chipsBox);
    for (const c of historyChips(rows)) {
      chipsBox.append(h("button", { class: "chip" + (c.key === key ? " on" : ""), onclick: () => { key = c.key; draw(); } }, c.label));
    }
    clear(list);
    for (const r of f.rows) list.append(historyRow(env, r, resend));
  };
  draw();
  root.append(chipsBox, list);
  if (focus) document.getElementById("h-" + focus)?.scrollIntoView({ block: "center" });
}

function eventText(r: HistoryRow & { sender: string }): string {
  const nm = r.sender;
  const count = r.count && r.count > 1 ? " (" + r.count + ")" : "";
  switch (r.event) {
    case "denied":
      return T.denied(nm);
    case "paused":
      return T.pausedRecv(nm);
    case "resumed":
      return T.resumedRecv(nm);
    case "invalid":
      return T.invalid + count;
    default:
      return T.couldNotRead + count;
  }
}

function historyRow(env: UiEnv, r: HistoryRow & { sender: string }, resend: (text: string) => void): HTMLElement {
  const time = new Date(r.received).toLocaleString();
  const who = r.dir === "out" ? "To " + (r.targets?.length ?? 0) + " peer(s)" : r.sender;
  const row = h("div", { class: "row hist", id: "h-" + r.id });
  const name = h("div", { class: "sender dim" }, who + "  " + time);
  if (r.dir === "in" && r.peer) name.addEventListener("click", () => env.openPage("#peers=" + r.peer));
  row.append(h("span", { class: "icon" }, r.dir === "in" ? "<" : ">"), name);
  if (r.type === "event") {
    row.append(h("div", { class: "content" }, eventText(r)));
    return row;
  }
  if (!r.read) row.append(h("span", { class: "dot", title: "unread" }));
  const content = h("div", { class: "content", tabindex: "0" }, r.content);
  content.addEventListener("click", () => {
    void rpc(env, "historyRead", { id: r.id });
    row.querySelector(".dot")?.remove();
  });
  const acts = h("div", { class: "actions" });
  if (r.type === "url") acts.append(h("button", { onclick: () => env.openUrl(r.content) }, "Open"));
  acts.append(
    h("button", { onclick: () => void env.copy(r.content) }, "Copy"),
    h("button", { onclick: () => resend(r.content) }, "Send to..."),
  );
  if (r.dir === "out" && r.results) {
    const fails = Object.values(r.results).filter((v) => v !== "sent").length;
    if (fails) row.append(h("div", { class: "dim" }, fails + " not delivered"));
  }
  row.append(content, acts);
  return row;
}

async function settingsView(env: UiEnv, root: HTMLElement, st: StateView): Promise<void> {
  const s = st.settings;
  const showAll = h("input", { type: "checkbox", checked: s.showAll }) as HTMLInputElement;
  const autoOpen = h("input", { type: "checkbox", checked: s.autoOpen }) as HTMLInputElement;
  const days = h("select", {}) as HTMLSelectElement;
  for (const d of [1, 7, 30, 90, 365]) days.append(h("option", { value: String(d), selected: d === s.historyDays }, d + (d === 1 ? " day" : " days")));
  const save = () => void rpc(env, "settings", { showAll: showAll.checked, autoOpen: autoOpen.checked, historyDays: Number(days.value) });
  showAll.addEventListener("change", save);
  autoOpen.addEventListener("change", save);
  days.addEventListener("change", save);
  const status = h("div", { class: "status" });
  const confirmDel = h("div", {});
  add(
    root,
    h("label", { class: "row" }, showAll, ' Show "All" option'),
    h("label", { class: "row" }, autoOpen, " Open links automatically"),
    h("label", { class: "row" }, "History auto-delete ", days),
    h("button", {
      onclick: () => {
        clear(confirmDel).append(
          h("span", {}, "Delete all history? "),
          h("button", { onclick: async () => { await rpc(env, "historyDeleteAll"); clear(confirmDel); status.textContent = "History deleted"; } }, "Delete"),
        );
      },
    }, "Delete all history"),
    confirmDel,
    st.email ? h("div", { class: "row" }, T.signedInAs(st.email)) : null,
    st.platform === "firefox" && st.receiveMode ? h("div", { class: "row dim" }, "Receive mode: " + st.receiveMode) : null,
    st.platform === "firefox" && st.receiveNote ? h("div", { class: "row dim" }, st.receiveNote) : null,
    h("button", {
      onclick: async () => {
        try {
          await rpc(env, "signout");
          status.textContent = T.signedOut;
        } catch (e) {
          status.textContent = (e as Error).message;
        }
      },
    }, "Sign out"),
    h("button", { class: "danger", onclick: () => env.openPage("#login=delete-account") }, "Delete account"),
    status,
  );
}
