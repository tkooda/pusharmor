// Confirm dialog (native modal <dialog>) and the one bottom message (toast) for the popup and the full tab.
import { h } from "./dom.ts";
import { icon } from "./icons.ts";

let dialogs = 0;

/**
 * Asks before a destructive action: Cancel on the left, the action on the right.
 * Resolves true for the action; Cancel and Esc resolve false. Focus starts on Cancel
 * (the safe choice) and goes back to the element that had it.
 */
export function confirmDialog(title: string, message: string, ok: string): Promise<boolean> {
  const opener = document.activeElement as HTMLElement | null;
  const n = ++dialogs;
  const dlg = h("dialog", { class: "dlg", "aria-labelledby": "dlg-t" + n, "aria-describedby": "dlg-m" + n }) as HTMLDialogElement;
  const cancel = h("button", { type: "button", onclick: () => dlg.close("") }, "Cancel") as HTMLButtonElement;
  const yes = h("button", { type: "button", class: "danger", onclick: () => dlg.close("ok") }, ok);
  dlg.append(h("h2", { id: "dlg-t" + n }, title), h("p", { id: "dlg-m" + n }, message), h("div", { class: "dlg-acts" }, cancel, yes));
  return new Promise((done) => {
    // Esc closes the dialog without a return value (cancel)
    dlg.addEventListener("close", () => {
      dlg.remove();
      opener?.focus();
      done(dlg.returnValue === "ok");
    });
    document.body.append(dlg);
    dlg.showModal();
    cancel.focus();
  });
}

export type ToastKind = "ok" | "info" | "err";

let current: { el: HTMLElement; stop: () => void } | null = null;

/** Removes the message shown at the bottom, if any. */
export function dismissToast(): void {
  current?.stop();
  current = null;
}

/**
 * Shows msg at the bottom, above a view's footer. ok and info go after about 2 s; an
 * error stays until its Close button, the next click, or the next message.
 */
export function toast(msg: string, kind: ToastKind = "info"): void {
  dismissToast();
  const text = h("span", { class: "toast-msg" });
  const el = h("div", { class: "toast " + kind, role: kind === "err" ? "alert" : "status" }, text);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onClick = (ev: Event) => {
    if (!el.contains(ev.target as Node)) dismissToast();
  };
  const stop = () => {
    clearTimeout(timer);
    document.removeEventListener("click", onClick, true);
    el.remove();
  };
  if (kind === "err") el.append(h("button", { type: "button", class: "quiet ib", "aria-label": "Close", title: "Close", onclick: dismissToast }, icon("close", 18)));
  // popup: keep clear of the footer pinned to its bottom (the Send button, the Devices tools)
  const foot = document.body.classList.contains("page") ? null : document.querySelector<HTMLElement>(".foot");
  if (foot?.offsetHeight) el.style.bottom = foot.offsetHeight + 8 + "px";
  document.body.append(el);
  current = { el, stop };
  // text put in a live region after it is in the page is announced; text present at insert is not
  timer = setTimeout(() => {
    text.textContent = msg;
    el.classList.add("on");
    if (kind === "err") document.addEventListener("click", onClick, true);
    else timer = setTimeout(() => current?.el === el && dismissToast(), 2000);
  }, 50);
}
