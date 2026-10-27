// Sender gate for runtime messages on Firefox. A content script on the site
// may only use the three site ops, each from its own page; every other op
// needs an extension page sender.
import type { MessageSender } from "../../webext-common/src/shim-types.ts";

const SITE_PAGE: Record<string, string> = { "fx-sub": "/fx/setup", "fx-msg": "/fx/open", authDone: "/auth/done" };

export function fromSite(sender: MessageSender, path: string, runtimeId: string): boolean {
  return typeof sender.url === "string" && sender.url.startsWith("https://pusharmor.com" + path) && sender.id === runtimeId;
}

/** True if op from sender may proceed (extBase is runtime.getURL("")). */
export function senderAllowed(op: string, sender: MessageSender, runtimeId: string, extBase: string): boolean {
  const page = SITE_PAGE[op];
  if (page !== undefined) return fromSite(sender, page, runtimeId);
  return sender.id === runtimeId && typeof sender.url === "string" && extBase !== "" && sender.url.startsWith(extBase);
}
