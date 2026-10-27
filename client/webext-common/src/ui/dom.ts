// Tiny DOM helpers for the vanilla TypeScript UI (no framework).
import type { Reply, Req } from "../core/rpc.ts";

export type Call = (req: Req) => Promise<Reply>;

export interface UiEnv {
  call: Call;
  /** URL of the active tab (activeTab), or "" */
  activeUrl(): Promise<string>;
  /** Opens page.html with the given hash in a full tab. */
  openPage(hash: string): void;
  openUrl(url: string): void;
  copy(text: string): Promise<void>;
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

export async function rpc<T>(env: UiEnv, op: string, args?: Record<string, unknown>): Promise<T> {
  const r = await env.call(args ? { op, args } : { op });
  if (!r || !r.ok) throw new Error(r?.error ?? "No reply");
  return r.data as T;
}

/** Greys a button for ms with a countdown in its label (Refresh, Send again: 60 s). */
export function greyFor(btn: HTMLButtonElement, ms: number): void {
  const label = btn.textContent ?? "";
  const until = Date.now() + ms;
  btn.disabled = true;
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) {
      btn.disabled = false;
      btn.textContent = label;
      return;
    }
    btn.textContent = label + " (" + left + " s)";
    setTimeout(tick, 1000);
  };
  tick();
}

export function add(el: HTMLElement, ...kids: (Node | string | null | undefined | false)[]): HTMLElement {
  for (const k of kids) if (k !== null && k !== undefined && k !== false) el.append(k);
  return el;
}
