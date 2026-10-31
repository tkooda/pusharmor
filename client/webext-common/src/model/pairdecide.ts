// Pure decision for a received commit (catalog Pairing flow step 3, rules
// a to e; I229, I231, I232, I235, I264, I266, I272). No I/O.
import { compareBytes, equal } from "../crypto/bytes.ts";

export const AUTO_REPLY_CAP = 10;
export const AUTO_REPLY_WINDOW_MS = 24 * 3600 * 1000;
export const MAX_OPEN_ENTRIES = 9;

export type Role = "N" | "X";
export type PairState = "committed" | "prompted" | "replied" | "shown";

export interface DecideEntry {
  role: Role;
  state: PairState;
  c_N?: Uint8Array; // X role
  authorized?: boolean; // X role
}

export interface PairDecideInput {
  myId: Uint8Array;
  fromId: Uint8Array;
  c_N: Uint8Array;
  entry: DecideEntry | null;
  pinned: boolean;
  approved: boolean; // this device approved the sender (an approved id is also pinned)
  approveVerified: boolean; // the sender's approve verified on this device
  lastGetApprovesMe: boolean | null; // from a GET /peers fetched after the verify; null if none
  inLastList: boolean;
  fetched: boolean; // one GET /peers already ran for this commit
  openEntries: number;
  capTimestamps: number[];
  now: number;
}

export type PairNotice = "commit" | "current" | "half" | "crossing" | "unreadable";

export type PairDecision =
  | { action: "reply"; rule: "c" | "e"; counted: boolean; tapped: boolean }
  | { action: "resend"; rule: "a" }
  | { action: "prompt"; rule: "e" }
  | { action: "notice"; rule: "a" | "c" | "d"; notice: PairNotice }
  | { action: "abort"; rule: "b"; notice: "unreadable" }
  | { action: "fetch"; rule: "e" }
  | { action: "drop"; rule: "c" | "d" | "e"; notice: "unreadable" };

/** Unsigned lexicographic compare of raw ids (I232). True when a is the lower id. */
export function idLower(a: Uint8Array, b: Uint8Array): boolean {
  return compareBytes(a, b) < 0;
}

export function capCount(ts: number[], now: number): number {
  return ts.filter((t) => t <= now && now - t < AUTO_REPLY_WINDOW_MS).length;
}

/** Half state: a pinned row that offers Cancel pairing. */
export function isHalfState(i: Pick<PairDecideInput, "entry" | "pinned" | "approveVerified" | "lastGetApprovesMe">): boolean {
  if (!i.pinned) return false;
  if (i.entry) return true;
  return i.approveVerified && i.lastGetApprovesMe === false;
}

export function pairDecide(i: PairDecideInput): PairDecision {
  const e = i.entry;
  if (e && e.role === "X") {
    if (e.c_N && equal(e.c_N, i.c_N)) {
      // a. duplicate
      if (e.state === "shown") return { action: "notice", rule: "a", notice: "current" };
      if (e.authorized) return { action: "resend", rule: "a" };
      return { action: "notice", rule: "a", notice: "current" };
    }
    // b. different c_N before Approve
    if (!i.approved) return { action: "abort", rule: "b", notice: "unreadable" };
  }
  if (e && e.role === "N") {
    // c. crossing
    if (e.state === "committed") {
      if (idLower(i.myId, i.fromId)) return { action: "notice", rule: "c", notice: "crossing" };
      return { action: "reply", rule: "c", counted: false, tapped: true };
    }
    if (i.approved && !i.approveVerified) return { action: "notice", rule: "c", notice: "half" };
    return { action: "drop", rule: "c", notice: "unreadable" };
  }
  if (i.pinned || i.approved) {
    // d. pinned or approved
    if (isHalfState(i)) return { action: "notice", rule: "d", notice: "half" };
    return { action: "drop", rule: "d", notice: "unreadable" };
  }
  // e. new entry
  if (!i.inLastList) return i.fetched ? { action: "drop", rule: "e", notice: "unreadable" } : { action: "fetch", rule: "e" };
  if (i.openEntries >= MAX_OPEN_ENTRIES) return { action: "drop", rule: "e", notice: "unreadable" };
  if (capCount(i.capTimestamps, i.now) >= AUTO_REPLY_CAP) return { action: "prompt", rule: "e" };
  return { action: "reply", rule: "e", counted: true, tapped: false };
}

// ---- Pairing timeout and the N-side hint (Pairing flow step 8) ----

export type ResendResult = null | "offline" | "logged out" | "429" | "5xx" | "200_c_verified" | "200_other";
export type TimeoutAction = "keep_pin" | "drop_pin" | "resend" | "keep_waiting" | "complete";

/** Decision for a pairing row past 14 days. */
export function pairTimeout(approveVerified: boolean, approved: boolean, resend: ResendResult): TimeoutAction {
  if (approveVerified) return "keep_pin";
  if (!approved) return "drop_pin";
  if (resend === null) return "resend";
  if (resend === "200_c_verified") return "complete";
  if (resend === "200_other") return "drop_pin";
  return "keep_waiting";
}

export const NO_REPLY_MS = 3 * 24 * 3600 * 1000;

/** N-side hint on a row in state committed. */
export function pairHint(approvesMe: boolean | null, committedMs: number): "still_holds" | "no_reply_yet" | null {
  if (approvesMe === true) return "still_holds";
  if (committedMs >= NO_REPLY_MS) return "no_reply_yet";
  return null;
}
