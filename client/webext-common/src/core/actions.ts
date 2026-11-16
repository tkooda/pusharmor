// Shell-independent handlers for notification clicks and the page menu
// (component-webext sections 5 and 8).
import { detectType } from "../model/detect.ts";
import { SEND_CAP, utf8Len } from "../model/padding.ts";
import type { HistoryRow } from "../store/db.ts";
import type { Engine, SendResult } from "./engine.ts";
import { allEntries } from "./state.ts";
import { R, actionLine } from "./texts.ts";

type ClickTarget = { url: string } | { page: string } | null;

/** The page.html hash for the full view on History, scrolled to that message when an id is given. */
export const historyAt = (id?: number): string => "#history" + (id === undefined ? "" : "=" + id);

/**
 * Notification id -> what a click opens: "h:" row -> url opens the tab,
 * text/tel and event rows open the full view on History at that row; "a:" approve and
 * "d:" device status (logged in, logged out, rejected) -> Peers;
 * "p:" pairing -> Peers (row highlighted); "peerchg" -> Peers; "drop" and
 * anything else only dismiss.
 */
export async function clickTarget(e: Engine, id: string): Promise<ClickTarget> {
  if (id.startsWith("h:")) {
    const row = await e.db.get<HistoryRow>("history", Number(id.slice(2)));
    if (!row) return null;
    if (row.type !== "event") await e.db.put("history", { ...row, read: true });
    await e.updateBadge();
    if (row.type === "url") return { url: row.content };
    return { page: historyAt(row.id) };
  }
  if (id.startsWith("a:") || id.startsWith("d:")) return { page: "#peers=" + id.slice(2) };
  if (id.startsWith("p:")) {
    const pk = id.slice(2);
    for (const [peer, ent] of await allEntries(e.p.storageLocal)) if (ent.pk === pk) return { page: "#peers=" + peer };
    return { page: "#peers" };
  }
  if (id === "peerchg") return { page: "#peers" };
  return null;
}

export const MENU_URL = "pa-url";
export const MENU_PAGE = "pa-page";
export const MENU_SEL = "pa-sel";
/** The one item while logged out: opens the toolbar popup (the log in screen). */
export const MENU_LOGIN = "pa-login";
/** The one item while logged in with no paired device: opens Devices. */
export const MENU_PAIR = "pa-pair";
/** The context menu: the send items, or the one log in or pair item. */
export type MenuMode = "send" | "login" | "pair";
/** The one item each for "login" and "pair": [id, title, page.html hash when the popup cannot open]. */
export const MENU_SINGLE: Record<Exclude<MenuMode, "send">, readonly [string, string, string]> = {
  login: [MENU_LOGIN, "Log in to PushArmor...", ""],
  pair: [MENU_PAIR, "Pair a new device...", "#peers"],
};

/** Context menu parents: [id, title, context]. */
export const MENU_PARENTS: readonly (readonly [string, string, string])[] = [
  [MENU_URL, "PushArmor URL to", "link"],
  [MENU_PAGE, "PushArmor URL to", "page"],
  [MENU_SEL, "PushArmor selection to", "selection"],
];

export function selectionTitle(text: string): string {
  const t = detectType(text);
  return t === "url" ? "PushArmor URL to" : t === "tel" ? "PushArmor phone to" : "PushArmor text to";
}

interface MenuSendResult {
  badge: string | null;
  notice: string | null;
  overCap: string | null; // text to open in the send window
  result: SendResult | null; // the send, for a toolbar popup that started it late
}

/** A click on a child item: send the link, page URL or selection. */
export async function menuSend(e: Engine, text: string, child: string, fromSelection: boolean): Promise<MenuSendResult> {
  if (utf8Len(text) > SEND_CAP) {
    // no silent cut: the send window offers the first 2000 bytes (text only)
    return { badge: null, notice: null, overCap: text, result: null };
  }
  const targets = child === "all" ? "all" : [child];
  const r = await e.send(text, "auto", targets);
  void fromSelection;
  const total = targets === "all" ? r.total : 1;
  const badge = r.sent + "/" + total;
  const notice = r.sent < total ? (r.error || r.failures.map((f) => f.text).join("\n") || actionLine("send") + "\n" + R.someNotSent) : null;
  return { badge, notice, overCap: null, result: r };
}
