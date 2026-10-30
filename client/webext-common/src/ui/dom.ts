// Tiny DOM helpers for the vanilla TypeScript UI (no framework).
import type { PeerView, Reply, Req } from "../core/rpc.ts";
import { T } from "../core/texts.ts";
import type { ThemeStore } from "./theme.ts";

export type Call = (req: Req) => Promise<Reply>;

export interface UiEnv {
  call: Call;
  /** URL of the active tab (activeTab), or "" */
  activeUrl(): Promise<string>;
  /** Opens page.html with the given hash in a full tab (or shows the tab already open on it). */
  openPage(hash: string): void | Promise<void>;
  openUrl(url: string): void;
  copy(text: string): Promise<void>;
  /** true in the Beta build (manifest name "PushArmor Beta") */
  beta: boolean;
  /** Theme choice (storage.local, written by the UI directly) */
  theme: ThemeStore;
}

type Attrs = Record<string, string | boolean | ((ev: Event) => void)>;

export function h(tag: string, attrs: Attrs = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false) el.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null && k !== undefined && k !== false) el.append(typeof k === "string" ? document.createTextNode(k) : k);
  return el;
}

export function clear(el: HTMLElement): HTMLElement {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** An error message with a Retry button in place of the view (the background could not start). */
export function failView(root: HTMLElement, message: string, retry: () => void): void {
  const btn = h("button", { class: "primary", onclick: retry }, "Retry");
  clear(root).append(h("div", { class: "fail", role: "alert" }, h("p", {}, message), btn));
  btn.focus();
}

export async function rpc<T>(env: UiEnv, op: string, args?: Record<string, unknown>): Promise<T> {
  const r = await env.call(args ? { op, args } : { op });
  if (!r || !r.ok) throw new Error(r?.error ?? "No reply");
  return r.data as T;
}

/** Greys a button for ms with a countdown in its label (Refresh, Send again: 60 s). */
export function greyFor(btn: HTMLButtonElement, ms: number): void {
  const el = (btn.querySelector(".lbl") as HTMLElement | null) ?? btn; // keeps a leading icon
  const label = el.textContent ?? "";
  const until = Date.now() + ms;
  btn.disabled = true;
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) {
      btn.disabled = false;
      el.textContent = label;
      return;
    }
    el.textContent = label + " (" + left + " s)";
    setTimeout(tick, 1000);
  };
  tick();
}

export function add(el: HTMLElement, ...kids: (Node | string | null | undefined | false)[]): HTMLElement {
  for (const k of kids) if (k !== null && k !== undefined && k !== false) el.append(k);
  return el;
}

/** A section header (caps by CSS; the DOM text stays sentence case). A heading, and focusable by script. */
export function sh(text: string): HTMLElement {
  return h("h2", { class: "sh", tabindex: "-1" }, text);
}

/** The tab an arrow, Home or End key moves to, or null for any other key (tab widget pattern). */
export function nextTabIndex(key: string, i: number, n: number): number | null {
  if (key === "ArrowRight") return (i + 1) % n;
  if (key === "ArrowLeft") return (i - 1 + n) % n;
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return null;
}

/** A bordered group card holding rows. */
export function group(...rows: (Node | null | undefined | false)[]): HTMLElement {
  return h("div", { class: "grp" }, ...rows);
}

export type StatusKind = "ok" | "wait" | "off";

/** Status mark (filled dot, ring, ring with a bar) plus its word. */
export function statusLine(kind: StatusKind, word: string): HTMLElement {
  const ns = "http://www.w3.org/2000/svg";
  const mark = document.createElementNS(ns, "svg");
  mark.setAttribute("viewBox", "0 0 10 10");
  mark.setAttribute("aria-hidden", "true");
  const c = document.createElementNS(ns, "circle");
  for (const [k, v] of Object.entries({ cx: "5", cy: "5", r: kind === "ok" ? "4.5" : "3.9" })) c.setAttribute(k, v);
  if (kind === "ok") c.setAttribute("fill", "currentColor");
  else for (const [k, v] of Object.entries({ fill: "none", stroke: "currentColor", "stroke-width": "1.6" })) c.setAttribute(k, v);
  mark.append(c);
  if (kind === "off") {
    const bar = document.createElementNS(ns, "path");
    for (const [k, v] of Object.entries({ d: "M2.4 5h5.2", stroke: "currentColor", "stroke-width": "1.6" })) bar.setAttribute(k, v);
    mark.append(bar);
  }
  const el = h("span", { class: "st " + kind });
  el.append(mark, word);
  return el;
}

const OFF_WORDS: Record<string, string> = { "(missing)": "(missing)", "logged out": "Logged out", "send only": T.sendOnly, unreachable: "Unreachable" };

/**
 * The peer status line by priority (missing, logged out, send only, unreachable, approves,
 * has not approved), or null when pairing or note lines take its place.
 */
export function peerStatus(p: PeerView): { kind: StatusKind; word: string } | null {
  if (p.fingerprint || p.lines.length) return null;
  if (p.greyed) return OFF_WORDS[p.greyed] ? { kind: "off", word: OFF_WORDS[p.greyed]! } : null;
  return p.approvesMe ? { kind: "ok", word: "Paired" } : { kind: "wait", word: "Has not approved this device" };
}

const PLATFORM_LABEL: Record<string, string> = { android: "Android", ios: "iPhone", chrome: "Chrome", firefox: "Firefox", cli: "Command line" };
export function platformLabel(platform: string): string {
  return PLATFORM_LABEL[platform] ?? platform;
}

/** Short History time: clock time today, "Yesterday", else month and day. */
export function shortTime(ts: number, now: number): string {
  const d = new Date(ts);
  const day = (x: Date) => x.getFullYear() * 10000 + x.getMonth() * 100 + x.getDate();
  const today = new Date(now);
  if (day(d) === day(today)) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (day(d) === day(y)) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * The longest head + "..." + tail of text that fits (tail a third of the kept
 * characters), or text itself when it fits. Exactly one "..." is ever added.
 */
export function fitMiddle(text: string, fits: (s: string) => boolean): string {
  if (fits(text)) return text;
  let lo = 1;
  let hi = text.length - 1;
  let best = "...";
  while (lo <= hi) {
    const k = (lo + hi) >> 1;
    const tail = Math.floor(k / 3);
    const s = text.slice(0, k - tail) + "..." + text.slice(text.length - tail);
    if (fits(s)) {
      best = s;
      lo = k + 1;
    } else hi = k - 1;
  }
  return best;
}

let refitInstalled = false;

/** Middle ellipsis on one line; the full text stays in title and aria-label. */
export function midEllipsis(el: HTMLElement, text: string): void {
  el.title = text;
  el.setAttribute("aria-label", text);
  el.dataset.full = text;
  el.classList.add("mid");
  const fit = () => {
    if (!el.isConnected) return;
    el.textContent = fitMiddle(text, (s) => {
      el.textContent = s;
      return el.scrollWidth <= el.clientWidth;
    });
  };
  el.textContent = text;
  requestAnimationFrame(fit);
  if (!refitInstalled) {
    refitInstalled = true;
    addEventListener("resize", () => {
      for (const m of Array.from(document.querySelectorAll<HTMLElement>(".mid"))) midEllipsis(m, m.dataset.full ?? "");
    });
  }
}

/** A more_vert button that opens a small menu (Escape and outside click close it). */
export function overflowMenu(label: string, items: { label: string; run: (b: HTMLButtonElement) => void }[], moreIcon: Node): HTMLElement {
  const wrap = h("span", { class: "more" });
  const btn = h("button", { class: "quiet ib", "aria-label": "More options for " + label, "aria-haspopup": "menu", "aria-expanded": "false" }, moreIcon) as HTMLButtonElement;
  let menu: HTMLElement | null = null;
  const close = (refocus: boolean) => {
    if (!menu) return;
    menu.remove();
    menu = null;
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    if (refocus) btn.focus();
  };
  const outside = (ev: Event) => {
    if (!wrap.contains(ev.target as Node)) close(false);
  };
  btn.addEventListener("click", () => {
    if (menu) return close(true);
    menu = h("div", { role: "menu", class: "menu", "aria-label": label });
    for (const it of items) {
      const mi = h("button", { role: "menuitem", tabindex: "-1" }, it.label) as HTMLButtonElement;
      mi.addEventListener("click", () => {
        close(true);
        it.run(btn);
      });
      menu.append(mi);
    }
    menu.addEventListener("keydown", (ev: KeyboardEvent) => {
      const all = Array.from(menu?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []);
      const i = all.indexOf(document.activeElement as HTMLButtonElement);
      if (ev.key === "Tab") return close(false);
      if (ev.key === "Escape") close(true);
      else if (ev.key === "ArrowDown") all[(i + 1) % all.length]?.focus();
      else if (ev.key === "ArrowUp") all[(i - 1 + all.length) % all.length]?.focus();
      else return;
      ev.preventDefault();
    });
    wrap.append(menu);
    btn.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", outside, true);
    (menu.firstElementChild as HTMLElement | null)?.focus();
  });
  wrap.append(btn);
  return wrap;
}

/** Settings account line: only while logged in (a logged-out profile keeps its email). */
export function accountLine(st: { email: string | null; reg: string | null }): string | null {
  return st.email && st.reg !== "logged_out" ? T.signedInAs(st.email) : null;
}
