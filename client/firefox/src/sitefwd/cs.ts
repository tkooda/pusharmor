// Content script on https://pusharmor.com/fx/setup, /fx/open and /auth/done
// (FIREFOX-MATCH-LIST). Runs at document_start.
import { fxSubFields } from "../gate.ts";
import { browser } from "../shim.ts";
import { fwdAllowed } from "./fwd.ts";
import { relayRetry } from "./relay.ts";

const SITE = "https://pusharmor.com";

function relay(op: string, args: Record<string, unknown>): Promise<unknown> {
  return browser.runtime.sendMessage({ op, args });
}

const relayWake = (op: string, args: Record<string, unknown>) =>
  relayRetry(() => relay(op, args), (ms) => new Promise((r) => setTimeout(r, ms)));

/** /fx/open: quiet time after the last waiting message before the tab turns into the add-on's History. */
const SHOW_AFTER_MS = 1000;

if (location.origin === SITE) {
  const path = location.pathname;
  if (path === "/auth/done") {
    const hash = location.hash;
    if (hash.length > 1) {
      history.replaceState(null, "", location.pathname + location.search);
      void relay("authDone", { hash: hash.slice(1) });
    }
  } else if (path === "/fx/setup") {
    // a private tab: the page asks for a normal tab and makes no push subscription (none would get pushes)
    const priv = browser.extension?.inIncognitoContext === true;
    if (priv) {
      const mark = () => document.documentElement.setAttribute("data-pa-private", "");
      if (document.documentElement) mark();
      else document.addEventListener("readystatechange", mark, { once: true });
    }
    window.addEventListener("message", (ev: MessageEvent) => {
      if (ev.source !== window || ev.origin !== SITE) return;
      const d = ev.data as { pa?: string } | null;
      if (d && d.pa === "fx-close") return void relay("fx-close", {});
      const f = d && d.pa === "fx-sub" && !priv ? fxSubFields(d) : null;
      if (f) void relayWake("fx-sub", f);
    });
  } else if (path === "/fx/open") {
    // once no waiting message has come for a moment, the add-on shows its tabs on History here
    let idle: ReturnType<typeof setTimeout> | undefined;
    const showSoon = () => {
      clearTimeout(idle);
      idle = setTimeout(() => void relayWake("fx-show", {}), SHOW_AFTER_MS);
    };
    window.addEventListener("message", (ev: MessageEvent) => {
      if (ev.source !== window || ev.origin !== SITE) return;
      const d = ev.data as { pa?: string; id?: unknown; M?: unknown };
      if (d && d.pa === "fx-msg" && fwdAllowed(d.M)) {
        clearTimeout(idle);
        void relayWake("fx-msg", { m: d.M })
          .then((r) => {
            if ((r as { ok?: boolean } | undefined)?.ok) window.postMessage({ pa: "fx-ack", id: d.id }, SITE);
          })
          .finally(showSoon);
      }
    });
    document.addEventListener("DOMContentLoaded", () => {
      window.postMessage({ pa: "fx-ready" }, SITE);
      showSoon();
    });
  }
}
