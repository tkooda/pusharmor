// Toolbar popup: Send, History, Peers, Settings (component-webext section 7).
import type { PeerView, StateView } from "../core/rpc.ts";
import type { SendResult } from "../core/engine.ts";
import { T } from "../core/texts.ts";
import { rememberedSelection } from "../model/sendsel.ts";
import type { Restore } from "../model/signin.ts";
import type { HistoryRow } from "../store/db.ts";
import { type UiEnv, add, clear, group, h, midEllipsis, peerStatus, platformLabel, rpc, sh, shortTime, statusLine } from "./dom.ts";
import { applyFilter, historyChips } from "./historyfilter.ts";
import { icon, type IconName, messagesArt, platformIcon } from "./icons.ts";
import { renderPeers } from "./peersview.ts";

const CAP = 2048;
type Tab = "send" | "history" | "peers" | "settings";

/** Wordmark "PushArmor" plus the Beta badge in the Beta build. */
export function wordmark(env: UiEnv, size: number): HTMLElement {
  const wm = h("span", { class: "wm", style: "font-size:" + size + "px" }, h("span", { class: "p" }, "Push"), h("span", { class: "a" }, "Armor"));
  return add(h("span", { class: "brand" }, wm), env.beta && h("span", { class: "beta" }, "Beta"));
}

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
    const going = (await rpc<Restore | null>(env, "signinProgress").catch(() => null))?.step === "code";
    const head = going ? "Check your email for your code" : st.reg === "paused" ? T.signedOut : st.banner ?? "Sign in to use PushArmor";
    add(
      root,
      h(
        "div",
        { class: "signin" },
        h("img", { src: "icons/icon-128.png", width: "64", height: "64", alt: "", class: "big-tile" }),
        wordmark(env, 24),
        h("div", { class: "banner" }, head),
        h("p", { class: "slogan" }, "Send the page you are on to your other devices in one click."),
        h("button", {
          class: "primary big",
          onclick: async () => {
            await env.openPage("#login");
            window.close();
          },
        }, going ? "Continue signing in" : "Sign in"),
        h("div", { class: "opens" }, icon("open", 16), "Opens in a new tab"),
        h("p", { class: "e2e" }, icon("lock", 20), h("span", {}, "All of your data is always end-to-end encrypted, and can never be read by the server or anyone else.")),
        st.platform === "firefox" && st.receiveNote ? h("div", { class: "dim" }, st.receiveNote) : null,
      ),
    );
    return;
  }
  const body = h("div", { class: "body" });
  const tabs = h("div", { class: "tabs", role: "tablist" });
  const show = (t: Tab, prefill?: string) => {
    for (const b of Array.from(tabs.children)) {
      const on = (b as HTMLElement).dataset.tab === t;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
    }
    clear(body);
    if (t === "send") void sendView(env, body, st, prefill);
    if (t === "history") void historyView(env, body, (text) => show("send", text));
    if (t === "peers") void renderPeers(env, body, false);
    if (t === "settings") void settingsView(env, body, st);
  };
  for (const [t, label] of [["send", "Send"], ["history", "History"], ["peers", "Devices"], ["settings", "Settings"]] as [Tab, string][]) {
    const b = h("button", { role: "tab", onclick: () => show(t) }, label);
    b.dataset.tab = t;
    tabs.append(b);
  }
  const top = h("div", { class: "top" }, h("div", { class: "head" }, h("img", { src: "icons/icon-32.png", width: "24", height: "24", alt: "" }), wordmark(env, 16)), tabs);
  root.append(top, body);
  show("send");
}

const TYPE_ICON: Record<string, IconName> = { url: "link", tel: "call", text: "notes" };

export async function sendView(env: UiEnv, root: HTMLElement, st: StateView, prefill?: string, offerCut = false): Promise<void> {
  const field = h("textarea", { rows: "3", "aria-label": "Text to send" }) as HTMLTextAreaElement;
  field.value = prefill ?? (await env.activeUrl().catch(() => ""));
  const badge = h("span", { class: "badge" });
  const counter = h("span", { class: "counter" });
  const asText = h("input", { type: "checkbox", role: "switch" }) as HTMLInputElement;
  const sendLabel = h("span", { class: "lbl" }, "Send");
  const sendBtn = h("button", { class: "primary big" }, icon("send", 18), sendLabel) as HTMLButtonElement;
  const result = h("div", { class: "result" });
  const targets = group();
  const data = await rpc<{ peers: PeerView[] }>(env, "peers");
  const sendable = data.peers.filter((p) => p.sendable);
  const checks: { id: string; box: HTMLInputElement }[] = [];
  const remembered = rememberedSelection(await rpc<string[]>(env, "sendSel").catch(() => []), sendable.map((p) => p.id));
  const save = () => void rpc(env, "sendSelSet", { ids: checks.filter((c) => c.box.checked).map((c) => c.id) }).catch(() => undefined);
  let allBox: HTMLInputElement | null = null;
  const target = (glyph: Node, name: string, sub: (Node | string)[], box: HTMLInputElement, dim = false) =>
    h("label", { class: "prow target" + (dim ? " off" : "") }, h("div", { class: "av" }, glyph), h("div", { class: "txt" }, h("div", { class: "t1 name" }, name), ...sub.map((s) => h("div", { class: "t2" }, s))), box);
  const sub = (p: PeerView): (Node | string)[] => {
    const s = peerStatus(p);
    return [platformLabel(p.platform), ...(s && s.kind === "off" ? [statusLine(s.kind, s.word)] : [])];
  };
  const count = () => checks.filter((c) => c.box.checked).length;
  const relabel = () => {
    const n = count();
    sendLabel.textContent = n > 0 ? "Send to " + n + (n === 1 ? " device" : " devices") : "Send";
  };
  if (st.settings.showAll) {
    allBox = h("input", { type: "checkbox", checked: remembered === null || remembered.length === sendable.length }) as HTMLInputElement;
    allBox.addEventListener("change", () => {
      for (const c of checks) c.box.checked = allBox!.checked;
      relabel();
      save();
    });
    targets.append(target(icon("devices", 18), "All", [], allBox));
  }
  // "All" sends to every sendable peer, so its rows show ticked; unticking one row leaves "All".
  for (const p of sendable) {
    const box = h("input", { type: "checkbox", checked: remembered ? remembered.includes(p.id) : allBox !== null }) as HTMLInputElement;
    box.addEventListener("change", () => {
      if (allBox) allBox.checked = checks.every((c) => c.box.checked);
      relabel();
      save();
    });
    checks.push({ id: p.id, box });
    targets.append(target(platformIcon(p.platform), p.label, sub(p), box, p.greyed !== null));
  }
  for (const p of data.peers.filter((x) => !x.sendable && x.greyed && !x.hidden)) {
    const s = peerStatus(p);
    const box = h("input", { type: "checkbox", disabled: true, "aria-hidden": "true", tabindex: "-1" }) as HTMLInputElement;
    const row = target(platformIcon(p.platform), p.label, [platformLabel(p.platform), s ? statusLine(s.kind, s.word) : p.greyed ?? ""], box, true);
    row.classList.add("greyed");
    row.addEventListener("click", () => void rpc(env, "greyedTap"));
    targets.append(row);
  }
  const update = async () => {
    const d = await rpc<{ type: string; bytes: number }>(env, "detect", { text: field.value });
    const type = asText.checked ? "text" : d.type;
    clear(badge).append(icon(TYPE_ICON[type] ?? "notes", 14), T.typeBadge(type));
    counter.textContent = d.bytes > CAP ? T.tooLong(d.bytes) : T.counter(d.bytes);
    counter.classList.toggle("red", d.bytes >= CAP * 0.9);
    sendBtn.disabled = d.bytes > CAP || d.bytes === 0;
  };
  field.addEventListener("input", () => void update());
  asText.addEventListener("change", () => void update());
  sendBtn.addEventListener("click", async () => {
    sendBtn.disabled = true;
    const to = allBox?.checked ? "all" : checks.filter((c) => c.box.checked).map((c) => c.id);
    try {
      const r = await rpc<SendResult>(env, "send", { text: field.value, asText: asText.checked, targets: to });
      clear(result).append(h("div", {}, T.sentToNofM(r.sent, r.total)), ...r.failures.map((f) => h("div", { class: "dim" }, f.text)));
      if (r.error) result.append(h("div", { class: "err" }, r.error));
    } catch (e) {
      result.textContent = (e as Error).message;
    }
    sendBtn.disabled = false;
  });
  root.append(field, h("div", { class: "meta" }, badge, counter));
  if (offerCut) {
    root.append(
      h("div", { class: "cut" }, h("button", {
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
      }, "Send the first 2048 bytes")),
    );
  }
  root.append(group(h("label", { class: "srow" }, h("span", {}, "Send as text"), asText)), sh("Send to"), targets, h("div", { class: "foot send-foot" }, result, sendBtn));
  relabel();
  await update();
}

export async function historyView(env: UiEnv, root: HTMLElement, resend: (text: string) => void, focus?: string): Promise<void> {
  await rpc(env, "historyOpened");
  const rows = await rpc<(HistoryRow & { sender: string })[]>(env, "history");
  let key = "all";
  if (!rows.length) {
    root.append(
      h(
        "div",
        { class: "empty" },
        messagesArt(),
        h("div", { class: "e-title" }, "No messages yet"),
        h("p", {}, "Everything you send or receive shows up here."),
      ),
    );
    return;
  }
  const chipsBox = h("div", { class: "chips" });
  const list = group();
  list.classList.add("hist-list");
  const draw = () => {
    const f = applyFilter(rows, key);
    key = f.key;
    clear(chipsBox);
    for (const c of historyChips(rows)) {
      const on = c.key === key;
      chipsBox.append(h("button", { class: "chip" + (on ? " on" : ""), "aria-pressed": String(on), onclick: () => { key = c.key; draw(); } }, ...(on ? [icon("check", 14)] : []), c.label));
    }
    clear(list);
    const now = Date.now();
    for (const r of f.rows) list.append(historyRow(env, r, resend, now));
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

function historyRow(env: UiEnv, r: HistoryRow & { sender: string }, resend: (text: string) => void, now: number): HTMLElement {
  const full = new Date(r.received).toLocaleString();
  const time = h("span", { class: "time", title: full }, shortTime(r.received, now));
  const row = h("div", { class: "hrow", id: "h-" + r.id });
  if (r.type === "event") {
    // Events: a bare glyph, no tile; the sender stays visible when the text lacks it.
    const named = r.event === "denied" || r.event === "paused" || r.event === "resumed";
    const col = h("div", { class: "txt" }, h("div", { class: "hmeta" }, h("span", { class: "who" }, named ? eventText(r) : r.sender), time));
    if (!named) col.append(h("div", { class: "content ev" }, eventText(r)));
    row.classList.add("event");
    row.append(h("div", { class: "av bare" }, icon(r.event === "paused" ? "pause" : "info", 18)), col);
    return row;
  }
  const sent = r.results ? Object.values(r.results).filter((v) => v === "sent").length : (r.targets?.length ?? 0);
  const whoText = r.dir === "out" ? T.sentToNofM(sent, r.targets?.length ?? 0) : r.sender;
  // A real button when it opens the peer, so Tab focuses it and Enter/Space activate it.
  const who = r.dir === "in" && r.peer ? h("button", { class: "who peerlink", type: "button" }, whoText) : h("span", { class: "who" }, whoText);
  if (r.dir === "in" && r.peer) who.addEventListener("click", () => env.openPage("#peers=" + r.peer));
  const col = h("div", { class: "txt" }, h("div", { class: "hmeta" }, who, time));
  const one = r.type === "url" || r.type === "tel";
  const content = h("div", { class: "content " + (one ? "one" : "clamp"), tabindex: "0" });
  if (r.type === "url") midEllipsis(content, r.content);
  else content.textContent = r.content;
  const dot = !r.read ? h("span", { class: "dot", title: "unread" }) : null;
  if (dot) row.classList.add("unread");
  const select = () => {
    for (const o of Array.from(row.parentElement?.querySelectorAll(".hrow.sel") ?? [])) if (o !== row) o.classList.remove("sel");
    row.classList.add("sel");
  };
  content.addEventListener("click", () => {
    void rpc(env, "historyRead", { id: r.id });
    row.querySelector(".dot")?.remove();
    row.classList.remove("unread");
    select();
  });
  row.addEventListener("click", select);
  const acts = h("div", { class: "actions acts" });
  if (r.type === "url") acts.append(h("button", { class: "ac", onclick: () => env.openUrl(r.content) }, icon("open", 15), "Open"));
  acts.append(
    h("button", { class: "ac", onclick: () => void env.copy(r.content) }, icon("copy", 15), "Copy"),
    h("button", { class: "ac", onclick: () => resend(r.content) }, icon("send", 15), "Send to..."),
  );
  col.append(content);
  if (r.dir === "out" && r.results) {
    const fails = Object.values(r.results).filter((v) => v !== "sent").length;
    if (fails) col.append(h("div", { class: "dim" }, fails + " not delivered"));
  }
  col.append(acts);
  row.append(h("div", { class: "av" }, icon(r.dir === "in" ? "received" : "sent", 18)), col);
  if (dot) row.append(dot);
  return row;
}

async function settingsView(env: UiEnv, root: HTMLElement, st: StateView): Promise<void> {
  const s = st.settings;
  const showAll = h("input", { type: "checkbox", role: "switch", checked: s.showAll }) as HTMLInputElement;
  const autoOpen = h("input", { type: "checkbox", role: "switch", checked: s.autoOpen }) as HTMLInputElement;
  const days = h("select", { "aria-label": "History auto-delete" }) as HTMLSelectElement;
  for (const d of [1, 7, 30, 90, 365]) days.append(h("option", { value: String(d), selected: d === s.historyDays }, d + (d === 1 ? " day" : " days")));
  const save = () => void rpc(env, "settings", { showAll: showAll.checked, autoOpen: autoOpen.checked, historyDays: Number(days.value) });
  showAll.addEventListener("change", save);
  autoOpen.addEventListener("change", save);
  days.addEventListener("change", save);
  const status = h("div", { class: "status" });
  const confirmDel = h("div", { class: "confirm-inline" });
  const ff = st.platform === "firefox";
  const acct = add(
    h("div", { class: "txt" }),
    st.email ? h("div", { class: "t1" }, T.signedInAs(st.email)) : null,
    ff && st.receiveMode ? h("div", { class: "t2" }, "Receive mode: " + st.receiveMode) : null,
    ff && st.receiveNote ? h("div", { class: "t2" }, st.receiveNote) : null,
  );
  add(
    root,
    sh("Sending"),
    group(
      h("label", { class: "srow" }, h("span", {}, 'Show "All" option'), showAll),
      h("label", { class: "srow" }, h("span", {}, "Open links automatically"), autoOpen),
    ),
    sh("History"),
    group(
      h("div", { class: "srow" }, h("span", {}, "History auto-delete"), days),
      h(
        "div",
        { class: "srow" },
        h("button", {
          class: "quiet errtext",
          onclick: () => {
            clear(confirmDel).append(
              h("span", {}, "Delete all history? "),
              h("button", { class: "danger", onclick: async () => { await rpc(env, "historyDeleteAll"); clear(confirmDel); status.textContent = "History deleted"; } }, "Delete"),
            );
          },
        }, "Delete all history"),
        confirmDel,
      ),
    ),
    acct.childNodes.length ? sh("Account") : null,
    acct.childNodes.length ? group(h("div", { class: "srow acct" }, acct)) : null,
    h(
      "div",
      { class: "btns" },
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
    ),
    status,
  );
}
