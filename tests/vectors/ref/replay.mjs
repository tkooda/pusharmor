// Replay window (catalog r10, Replay window): per sender, highest accepted n
// (h) and a 100-bit bitmap; bit k marks n = h - k as seen. Here the bitmap
// is carried as the list of seen n values (h - k for every set bit k).
export const WINDOW = 100;
export const CONTROL_TYPES = ['approve', 'rename', 'remove', 'delete', 'logout', 'login', 'deny'];

// -> "fresh" | "seen" | "old"
export function windowCheck(state, n) {
  if (n <= state.h - WINDOW) return 'old';
  if (n <= state.h && state.seen.includes(n)) return 'seen';
  return 'fresh';
}

// Accept n (caller has checked "fresh"); returns the new state.
export function windowAccept(state, n) {
  if (n > state.h) {
    const seen = [n, ...state.seen.filter((m) => m > n - WINDOW)];
    return { h: n, seen: seen.sort((a, b) => b - a) };
  }
  return { h: state.h, seen: [...state.seen, n].sort((a, b) => b - a) };
}

// Outcome for a message with a valid signature and pairing id.
// -> "accept" | "invalid" | "represent" | "noop"
export function replayOutcome(state, n, type, historyRow) {
  const c = windowCheck(state, n);
  if (c === 'fresh') return 'accept';
  if (c === 'old') return 'invalid';
  if (CONTROL_TYPES.includes(type)) return 'noop';
  return historyRow ? 'represent' : 'invalid';
}
