// Content script on https://pusharmor.com/fx/setup, /fx/open and /auth/done
// (FIREFOX-MATCH-LIST). Runs at document_start.
import { browser } from "../shim.ts";

const SITE = "https://pusharmor.com";

function relay(op: string, args: Record<string, unknown>): Promise<unknown> {
  return browser.runtime.sendMessage({ op, args });
}

if (location.origin === SITE) {
  const path = location.pathname;
  if (path === "/auth/done") {
    const hash = location.hash;
    if (hash.length > 1) {
      history.replaceState(null, "", location.pathname + location.search);
      void relay("authDone", { hash: hash.slice(1) });
    }
  } else if (path === "/fx/setup") {
    window.addEventListener("message", (ev: MessageEvent) => {
      if (ev.source !== window || ev.origin !== SITE) return;
      const d = ev.data as { pa?: string; endpoint?: unknown; p256dh?: unknown; auth?: unknown };
      if (d && d.pa === "fx-sub" && typeof d.endpoint === "string" && typeof d.p256dh === "string" && typeof d.auth === "string") {
        void relay("fx-sub", { endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth });
      }
    });
  } else if (path === "/fx/open") {
    window.addEventListener("message", (ev: MessageEvent) => {
      if (ev.source !== window || ev.origin !== SITE) return;
      const d = ev.data as { pa?: string; id?: unknown; M?: unknown };
      if (d && d.pa === "fx-msg" && typeof d.M === "string") {
        void relay("fx-msg", { m: d.M }).then((r) => {
          if ((r as { ok?: boolean } | undefined)?.ok) window.postMessage({ pa: "fx-ack", id: d.id }, SITE);
        });
      }
    });
    document.addEventListener("DOMContentLoaded", () => window.postMessage({ pa: "fx-ready" }, SITE));
  }
}
