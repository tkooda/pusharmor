// Pairing (catalog r10: General/Pairing fingerprint, Pairing, Pairing flow).
import { b64d, b64e, b64ok, cat, sha256 } from './bytes.mjs';
import { idMatches } from './ids.mjs';
import { openWire, sealWire } from './hpke.mjs';
import { isValidPub } from './p256.mjs';

export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const commitHash = (signPubN, encPubN, rN) => sha256('PA-SAS1C\n', signPubN, encPubN, rN);

export const fingerprintHash = (sN, eN, sX, eX, rN, rX) => sha256('PA-SAS1\n', sN, eN, sX, eX, rN, rX);

// First 20 bits, MSB first, in 5-bit groups -> 4 Crockford chars.
export function crockford20(hash) {
  const v = (hash[0] << 12) | (hash[1] << 4) | (hash[2] >> 4);
  let out = '';
  for (let i = 3; i >= 0; i--) out += CROCKFORD[(v >> (i * 5)) & 31];
  return out;
}

export const pairingId = (rN, rX) => sha256('PA-PAIRID1\n', rN, rX).subarray(0, 8);

// pk over the raw 30-byte ids, N id first.
export const pairKey = (nId, xId) => b64e(sha256('PA-PAIRKEY1\n', nId, xId).subarray(0, 16));

export const KIND = { commit: 1, reply: 2, open: 3 };
const KIND_NAME = { 1: 'commit', 2: 'reply', 3: 'open' };
export const PAIR_PLAINTEXT_LEN = 193;
export const PAIR_WIRE_LEN = 366;

export function pairPlaintext(kind, fromId, body) {
  if (body.length !== 162) throw new Error('pair: body must be 162 bytes');
  return cat([KIND[kind]], fromId, body);
}

export const commitBody = (cN) => cat(cN, Buffer.alloc(130));
export const keysBody = (signPub, encPub, r) => cat(signPub, encPub, r);

export function sealPair(kind, fromId, body, recipientIdB64, recipientEncPub, ikmE) {
  const pt = pairPlaintext(kind, fromId, body);
  const s = sealWire(recipientEncPub, Buffer.from('PA-PAIR1'), Buffer.from(recipientIdB64), pt, ikmE);
  return { plaintext: pt, ...s, message: b64e(s.wire) };
}

// Receive a pair message. Returns { ok, kind, fromId, cN | signPub, encPub, r }.
// ok false = drop (Notice rule, outcome "unreadable").
export function openPair(message, ownIdB64, ownEncPriv, ownAccount) {
  if (message.length !== PAIR_WIRE_LEN || !b64ok(message)) return { ok: false, why: 'size or encoding' };
  let pt;
  try {
    pt = openWire(ownEncPriv, Buffer.from('PA-PAIR1'), Buffer.from(ownIdB64), b64d(message));
  } catch {
    return { ok: false, why: 'hpke' };
  }
  if (pt.length !== PAIR_PLAINTEXT_LEN) return { ok: false, why: 'plaintext size' };
  const kind = KIND_NAME[pt[0]];
  if (!kind) return { ok: false, why: 'kind' };
  const fromId = pt.subarray(1, 31);
  const body = pt.subarray(31);
  if (!idMatches(fromId, ownAccount)) return { ok: false, why: 'account prefix' };
  if (kind === 'commit') return { ok: true, kind, fromId, cN: body.subarray(0, 32) };
  const signPub = body.subarray(0, 65);
  const encPub = body.subarray(65, 130);
  const r = body.subarray(130, 162);
  if (!isValidPub(signPub) || !isValidPub(encPub) || signPub.equals(encPub)) return { ok: false, why: 'keys' };
  if (!idMatches(fromId, ownAccount, signPub, encPub)) return { ok: false, why: 'keyhash' };
  return { ok: true, kind, fromId, signPub, encPub, r };
}

// X on open: the open keys and r_N must hash to the stored c_N, else abort.
export const openMatchesCommit = (open, storedCN) => commitHash(open.signPub, open.encPub, open.r).equals(storedCN);

// ---------------------------------------------------------------------------
// pair_decide: X's PURE decision for a commit push (Pairing flow step 3,
// rules a-e; first matching rule wins).
//
// input:
//   own_id, from_id    40-char b64url ids
//   commit_c_N         b64url c_N carried by the commit
//   entry              null, or the open pairing entry for from_id:
//                        { role: "N" | "X",
//                          state: N: "committed" | "shown";
//                                 X: "replied" | "prompted" | "shown",
//                          c_N (X role), reply_authorized (X role) }
//   pinned, approved   this device pinned / approved from_id
//   approve_verified   from_id's approve verified on this device
//   approves_me        approves_me of from_id in the last GET /peers
//   get_after_verify   that GET was fetched after from_id's approve verified
//   listed             "yes" | "after_fetch" | "no" (in the last GET /peers;
//                      after one fetch; still absent)
//   open_entries       open pairing entries on this device (both roles)
//   cap                unix seconds of counted automatic replies
//   now                unix seconds
// output: { action, notice, entry, cap_counted }
// ---------------------------------------------------------------------------
export const CAP_WINDOW_S = 86400;
export const CAP_MAX = 10;
export const MAX_OPEN_ENTRIES = 9;

const out = (action, notice, entry, capCounted = false) => ({ action, notice, entry, cap_counted: capCounted });

export function halfState(i) {
  if (!i.pinned) return false;
  if (i.entry) return true;
  return i.approve_verified && i.get_after_verify && i.approves_me === false;
}

export function pairDecide(i) {
  const e = i.entry;
  // a. duplicate on an open X-role entry
  if (e && e.role === 'X' && e.c_N === i.commit_c_N) {
    if (e.state === 'shown') return out('notice', 'represent', 'unchanged');
    if (e.reply_authorized) return out('reply', 'represent', 'unchanged');
    return out('notice', 'represent', 'unchanged');
  }
  // b. different c_N on an open X-role entry, before Approve
  if (e && e.role === 'X' && !i.approved) return out('abort', 'could_not_read', 'aborted');
  // c. own N-role entry
  if (e && e.role === 'N') {
    if (e.state === 'committed') {
      if (compareRaw(i.own_id, i.from_id) < 0) return out('drop', 'crossing', 'unchanged');
      return out('reply', 'commit', 'n_wiped_x_replied');
    }
    if (i.approved && !i.approve_verified) return out('drop', 'half_state', 'unchanged');
    return out('drop', 'could_not_read', 'unchanged');
  }
  // d. pinned or approved id
  if (i.pinned || i.approved) {
    return out('drop', halfState(i) ? 'half_state' : 'could_not_read', 'unchanged');
  }
  // e. new entry
  if (i.listed === 'no') return out('drop', 'could_not_read', 'none');
  if (i.open_entries >= MAX_OPEN_ENTRIES) return out('drop', 'could_not_read', 'none');
  const inWindow = i.cap.filter((t) => i.now - t < CAP_WINDOW_S).length;
  if (inWindow >= CAP_MAX) return out('prompt', 'commit', 'created_prompted');
  return out('reply', 'commit', 'created_replied', true);
}

function compareRaw(a, b) {
  return Buffer.compare(b64d(a), b64d(b));
}

// Timeout of a pairing row (Pairing flow step 8). input:
//   approve_verified  the other side's approve verified (entry already ended)
//   approved          this device approved ("Waiting for $X" when not verified)
//   resend            result of the re-send of POST /v1/approve/$X:
//                     null (not run yet) | "offline" | "logged out" | "429" |
//                     "5xx" | "200_c_verified" | "200_other"
// output: "keep_pin" | "drop_pin" | "resend" | "keep_waiting" | "complete"
export function pairTimeout(i) {
  if (i.approve_verified) return 'keep_pin';
  if (!i.approved) return 'drop_pin';
  if (i.resend === null) return 'resend';
  if (i.resend === '200_c_verified') return 'complete';
  if (i.resend === '200_other') return 'drop_pin';
  return 'keep_waiting';
}

// N-side hint line on a row in state committed (Pairing flow step 8).
// input: { approves_me, committed_s } -> "still_holds" | "no_reply_yet" | null
export function pairHint(i) {
  if (i.approves_me === true) return 'still_holds';
  if (i.committed_s >= 3 * 86400) return 'no_reply_yet';
  return null;
}
