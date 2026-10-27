// The receive pipeline for inner messages as one pure decision (component
// webext section 5 steps 1-5; catalog Inner message, Replay window, Receiver
// acceptance). The engine supplies the pinned peer, the replay state and the
// History lookup, then commits an "accept" atomically.
import { b64urlEncode, b64urlTryDecode } from "../crypto/b64url.ts";
import { equal } from "../crypto/bytes.ts";
import { accountOf, hasAccount, idMatchesKeys } from "../crypto/labels.ts";
import { type Content, inflateInner, openInner, parseInnerJson, parseInnerPlain, verifyInner, verifyNameEntry } from "./message.ts";
import { type ReplayOutcome, type ReplayState, replayClassify } from "./replay.ts";

export interface Pin {
  id: string;
  sign_pub: Uint8Array;
  enc_pub: Uint8Array;
  pairing_id: Uint8Array;
  ruling: "approved" | "unruled" | "denied";
  removed?: boolean;
}

export interface ReceiveInput {
  enc: CryptoKeyPair; // receiver ECDH key pair
  id: string; // receiver id (40 chars)
  m: string;
  pin(from: string): Promise<Pin | null>;
  window(from: string): Promise<ReplayState | null>;
  hasHistory(from: string, pairingIdB64: string, n: number): Promise<boolean>;
}

export type ReceiveResult =
  | { outcome: "unreadable"; from: string | null; unknownSender?: boolean }
  | { outcome: Exclude<ReplayOutcome, "accept">; from: string; n: number; content: Content }
  | { outcome: "accept"; from: string; n: number; content: Content; name: string | null; pin: Pin };

/** Acceptance table (catalog Receiver acceptance) for a verified, pinned sender. */
export function acceptable(type: Content["type"], ruling: Pin["ruling"]): boolean {
  switch (type) {
    case "approve":
      return ruling !== "denied";
    case "deny":
      return true;
    default:
      return ruling === "approved";
  }
}

export async function receiveDecide(i: ReceiveInput): Promise<ReceiveResult> {
  const pt = await openInner(i.enc, i.id, i.m);
  if (!pt) return { outcome: "unreadable", from: null };
  const p = parseInnerPlain(pt);
  if (!p) return { outcome: "unreadable", from: null };
  const myId = b64urlTryDecode(i.id);
  if (!myId) return { outcome: "unreadable", from: null };
  const acct = accountOf(myId);
  if (!hasAccount(p.fromId, acct)) return { outcome: "unreadable", from: null };
  const from = b64urlEncode(p.fromId);
  const pin = await i.pin(from);
  if (!pin || pin.removed) return { outcome: "unreadable", from: null, unknownSender: !pin };
  if (p.keys) {
    if (!(await idMatchesKeys(p.fromId, p.keys.sign_pub, p.keys.enc_pub, acct))) return { outcome: "unreadable", from: null };
    // "keys changed, not trusted" is a plain drop
    if (!equal(p.keys.sign_pub, pin.sign_pub) || !equal(p.keys.enc_pub, pin.enc_pub)) return { outcome: "unreadable", from: null };
  }
  if (!(await verifyInner(pin.sign_pub, i.id, p))) return { outcome: "unreadable", from: null };
  if (!equal(p.pairingId, pin.pairing_id)) return { outcome: "unreadable", from };
  const inflated = await inflateInner(p);
  const j = inflated ? parseInnerJson(inflated) : null;
  if (!j) return { outcome: "unreadable", from };
  const c = j.content;
  if ((c.type === "approve") !== (p.keys !== null)) return { outcome: "unreadable", from };
  const win = await i.window(from);
  if (!win || !equal(win.pairing_id, pin.pairing_id)) return { outcome: "unreadable", from };
  const pidB64 = b64urlEncode(pin.pairing_id);
  const r = replayClassify(win, j.n, c.type, await i.hasHistory(from, pidB64, j.n));
  if (r !== "accept") return { outcome: r, from, n: j.n, content: c };
  if (!acceptable(c.type, pin.ruling)) return { outcome: "unreadable", from };
  let name: string | null = null;
  if (c.type === "approve" || c.type === "rename") {
    name = await verifyNameEntry(pin.sign_pub, from, i.id, pin.pairing_id, c.entry);
    if (name === null) return { outcome: "unreadable", from };
  }
  return { outcome: "accept", from, n: j.n, content: c, name, pin };
}
