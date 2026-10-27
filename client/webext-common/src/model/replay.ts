// Replay window (catalog Replay window): highest accepted n (h) and a
// 100-bit bitmap; bit k (0..99) marks n = h - k. Bit k is stored in byte
// k >> 3 at bit position k & 7 (LSB first).

export const WINDOW = 100;
export const BITMAP_BYTES = 13;

export interface ReplayState {
  pairing_id: Uint8Array;
  h: number;
  bitmap: Uint8Array;
}

export type ReplayVerdict = "accept" | "seen" | "old";

export function freshReplay(pairingId: Uint8Array): ReplayState {
  return { pairing_id: pairingId, h: 0, bitmap: new Uint8Array(BITMAP_BYTES) };
}

function getBit(b: Uint8Array, k: number): boolean {
  return ((b[k >> 3]! >> (k & 7)) & 1) === 1;
}

/** Accept iff n > h - 100 and the bit for n is not set. */
export function replayCheck(s: ReplayState, n: number): ReplayVerdict {
  if (n <= s.h - WINDOW) return "old";
  if (n > s.h) return "accept";
  return getBit(s.bitmap, s.h - n) ? "seen" : "accept";
}

/** Returns the new state after accepting n (caller ran replayCheck first). */
export function replayRecord(s: ReplayState, n: number): ReplayState {
  const out = new Uint8Array(BITMAP_BYTES);
  let h = s.h;
  if (n > h) {
    const d = n - h;
    if (d < WINDOW) {
      for (let k = 0; k + d < WINDOW; k++) {
        if (getBit(s.bitmap, k)) out[(k + d) >> 3]! |= 1 << ((k + d) & 7);
      }
    }
    h = n;
    out[0]! |= 1;
  } else {
    out.set(s.bitmap);
    const k = h - n;
    out[k >> 3]! |= 1 << (k & 7);
  }
  return { pairing_id: s.pairing_id, h, bitmap: out };
}

export type ReplayOutcome = "accept" | "invalid" | "noop" | "represent";

const CONTROL = new Set(["approve", "rename", "remove", "delete", "pause", "unpause", "deny"]);

/**
 * Outcome for a parsed message (catalog Replay window): n <= h - 100 ->
 * invalid; a seen n of a control type -> noop; a seen n of url/text/tel with
 * a History row for (sender, pairing id, n) -> represent; else invalid.
 */
export function replayClassify(s: ReplayState, n: number, type: string, historyRow: boolean): ReplayOutcome {
  const v = replayCheck(s, n);
  if (v === "accept") return "accept";
  if (v === "old") return "invalid";
  if (CONTROL.has(type)) return "noop";
  return historyRow ? "represent" : "invalid";
}

/** The n values whose bit is set, high to low. */
export function replaySeen(s: ReplayState): number[] {
  const out: number[] = [];
  for (let k = 0; k < WINDOW; k++) if (getBit(s.bitmap, k) && s.h - k >= 1) out.push(s.h - k);
  return out;
}

export function replayFromSeen(pairingId: Uint8Array, h: number, seen: number[]): ReplayState {
  const bitmap = new Uint8Array(BITMAP_BYTES);
  for (const n of seen) {
    const k = h - n;
    if (k >= 0 && k < WINDOW) bitmap[k >> 3]! |= 1 << (k & 7);
  }
  return { pairing_id: pairingId, h, bitmap };
}
