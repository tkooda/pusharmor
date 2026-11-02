// Error texts for failed calls and actions (the words are in texts.ts, same as Android
// and iOS): line 1 says what could not be done, line 2 says why and what to do next.
import { ApiError } from "../api/client.ts";
import { formatWait } from "../model/signin.ts";
import { UserError } from "./engine.ts";
import { type ActionId, R, actionLine } from "./texts.ts";

/** A failure whose reason line is known where it happens; the caller adds the action line. */
export class ReasonError extends Error {}

const KEY_ERRORS = new Set(["OperationError", "InvalidAccessError", "NotSupportedError"]);
const STORE_ERRORS = new Set(["UnknownError", "InvalidStateError", "TransactionInactiveError", "ReadOnlyError", "ConstraintError", "AbortError", "VersionError"]);

/** Why a call failed. `provider` names the sign-in service for a refused id token. */
export function reasonOf(err: unknown, provider?: string): string {
  if (err instanceof ReasonError) return err.message;
  if (err instanceof ApiError) {
    const s = err.status;
    const w = err.error;
    if (s === 0) return err.kind === "offline" ? R.offline : err.kind === "timeout" ? R.timeout : R.unreachable;
    if (s === 426) return R.tooOld;
    if (s === 429) return R.rateLimited(formatWait((err.retryAfter ?? 60) * 1000));
    if (s === 413) return R.tooLong;
    if (s === 401 && w.startsWith("clock skew")) return R.clockOff;
    if (s === 401 && w === "unknown peer") return R.removed;
    if (s === 401 && w === "logged out") return R.loggedOut;
    if (s === 401 && w === "invalid client signature") return R.refused;
    if (s === 401 && w === "ticket expired") return R.loginExpired;
    if (s === 401 && (w === "invalid ticket" || w === "bad ticket")) return R.badLink;
    if (s === 401 && w === "wrong code") return R.wrongCode;
    if (s === 401 && w === "code expired") return R.codeExpired;
    if (s === 401 && w === "email not verified") return R.emailNotVerified;
    if (s === 401 && w === "invalid id_token") return provider ? R.notConfirmed(provider) : R.tryAgain;
    if (s === 403 && w === "banned") return R.blocked;
    if (s === 403 && w === "turnstile failed") return R.securityCheck;
    if (s === 400 && w === "bad email") return R.badEmail;
    if (s === 400 && w === "push endpoint not allowed") return R.pushNotSupported;
    if ((s === 400 && w === "bad request") || s === 404 || s === 405) return R.refused;
    if (s === 502 && w === "email send failed") return R.emailSendFailed;
    if (s >= 500 && s <= 599) return R.serverDown;
    return R.tryAgain; // includes 401 "bad id", which is not a removal
  }
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "QuotaExceededError") return R.storageFull;
  if (typeof name === "string" && KEY_ERRORS.has(name)) return R.keysUnusable;
  if (typeof name === "string" && STORE_ERRORS.has(name)) return R.saveFailed;
  return R.tryAgain;
}

/**
 * The two-line text for a failed action. A local check that already says what to do
 * (UserError) keeps its own words. `selfKept`: a 401 "unknown peer" whose removal the
 * check did not confirm is not called a removal.
 */
export function failText(a: ActionId, err: unknown, ctx: { name?: string; selfKept?: boolean } = {}): string {
  if (err instanceof UserError) return err.message;
  const provider = a === "loginGoogle" ? "Google" : a === "loginApple" ? "Apple" : undefined;
  const unconfirmed = ctx.selfKept && err instanceof ApiError && err.status === 401 && err.error === "unknown peer";
  return actionLine(a, ctx.name) + "\n" + (unconfirmed ? R.tryAgain : reasonOf(err, provider));
}
