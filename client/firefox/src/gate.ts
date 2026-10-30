// Sender gate for runtime messages on Firefox. A content script on the site
// may only use the three site ops, each from its own page; every other op
// needs an extension page sender.
import type { MessageSender } from "../../webext-common/src/shim-types.ts";

const SITE_PAGE: Record<string, string> = { "fx-sub": "/fx/setup", "fx-msg": "/fx/open", authDone: "/auth/done" };

export function fromSite(sender: MessageSender, path: string, runtimeId: string): boolean {
  if (typeof sender.url !== "string" || sender.id !== runtimeId) return false;
  try {
    const u = new URL(sender.url);
    return u.origin === "https://pusharmor.com" && u.pathname === path;
  } catch {
    return false;
  }
}

/** The fx-sub fields when the value has the expected shape (bounded strings), else null. */
export function fxSubFields(d: unknown): { endpoint: string; p256dh: string; auth: string } | null {
  if (typeof d !== "object" || d === null) return null;
  const { endpoint, p256dh, auth } = d as Record<string, unknown>;
  const ok = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
  if (!ok(endpoint, 2048) || !ok(p256dh, 128) || !ok(auth, 64)) return null;
  return { endpoint, p256dh, auth };
}

/** True if op from sender may proceed (extBase is runtime.getURL("")). */
export function senderAllowed(op: string, sender: MessageSender, runtimeId: string, extBase: string): boolean {
  const page = SITE_PAGE[op];
  if (page !== undefined) return fromSite(sender, page, runtimeId);
  return sender.id === runtimeId && typeof sender.url === "string" && extBase !== "" && sender.url.startsWith(extBase);
}
