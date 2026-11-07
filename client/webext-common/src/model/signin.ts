// Sign-in tab: saved progress (storage.session, key SIGNIN_PROGRESS) and the
// Turnstile frame height. Never holds the code or the Turnstile token.
import { R, T, actionLine } from "../core/texts.ts";
export const SIGNIN_PROGRESS = "signin_progress";
/** Restore step 2 only while the code still works: Worker REQUEST_TOKEN_LIFE_S 900 s less 60 s. */
export const RESTORE_MS = 14 * 60_000;
/** "Get a new code" waits this long after a send. */
export const RESEND_MS = 60_000;
const FRAME_MIN = 65;
const FRAME_MAX = 600;

interface Progress {
  v: 1;
  step: "email" | "code";
  email: string;
  purpose: string;
  /** ms, set when the code was sent (step "code") */
  sentAt: number;
}

export interface Restore {
  step: "email" | "code";
  email: string;
  /** "restored": step 2 picked up again; "expired": the last code no longer works */
  note: "restored" | "expired" | null;
  sentAt: number;
}

/** The saved record, or null when it is missing or malformed. */
export function readProgress(saved: unknown): Progress | null {
  const p = saved as Partial<Progress> | null | undefined;
  if (!p || typeof p !== "object" || p.v !== 1) return null;
  if (p.step !== "email" && p.step !== "code") return null;
  if (typeof p.email !== "string" || p.email.length > 320 || typeof p.purpose !== "string") return null;
  if (typeof p.sentAt !== "number" || !Number.isFinite(p.sentAt)) return null;
  return { v: 1, step: p.step, email: p.email, purpose: p.purpose, sentAt: p.sentAt };
}

/**
 * Which step to show when the sign-in tab opens. null: start fresh (no record,
 * bad record, or a record for another purpose).
 */
export function restoreStep(saved: unknown, now: number, purpose: string, hasRequestToken: boolean): Restore | null {
  const p = readProgress(saved);
  if (!p || p.purpose !== purpose) return null;
  if (p.step === "email") return { step: "email", email: p.email, note: null, sentAt: p.sentAt };
  const age = now - p.sentAt;
  const live = hasRequestToken && age >= 0 && age < RESTORE_MS;
  return { step: live ? "code" : "email", email: p.email, note: live ? "restored" : "expired", sentAt: p.sentAt };
}

/** ms until "Get a new code" is enabled again. */
export function resendLeftMs(sentAt: number, now: number): number {
  return Math.max(0, sentAt + RESEND_MS - now);
}

/** Human wait text: over 60 s whole minutes rounded up, else whole seconds rounded up. */
export function formatWait(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s > 60) {
    const m = Math.ceil(s / 60);
    return m + (m === 1 ? " minute" : " minutes");
  }
  return s + (s === 1 ? " second" : " seconds");
}

/** ms until "Email me a code" is enabled again: only the address that was just sent to waits. */
export function sendLeftMs(sentAt: number, sentTo: string, email: string, now: number): number {
  if (!sentTo || sentTo !== email.trim().toLowerCase()) return 0;
  return resendLeftMs(sentAt, now);
}

/** Height posted by the Turnstile page, clamped; null when it is not a number. */
export function clampFrameHeight(h: unknown): number | null {
  if (typeof h !== "number" || !Number.isFinite(h)) return null;
  return Math.min(FRAME_MAX, Math.max(FRAME_MIN, Math.ceil(h)));
}

/** storage.session key the background changes on every login state change; open views mount again. */
export const AUTH_CHANGED = "auth_changed";
/** Ends the AUTH_CHANGED value of an account switch: the view starts on its home page, not on the old account's tab or item. */
export const AUTH_SWITCHED = ":switched";

/** A Chrome extension id is known when it is one of the store ids the build put in (public, Beta). */
export function knownChromeId(id: string, known: readonly string[]): boolean {
  return known.includes(id);
}

/**
 * Chrome's login redirect has the form https://<32 letters a-p>.chromiumapp.org/. Some Chromium
 * builds rewrite that host (ungoogled-chromium: ch40m1umapp.qjz9zk), so the provider can never return.
 */
export function chromiumRedirectOk(url: string): boolean {
  return /^https:\/\/[a-p]{32}\.chromiumapp\.org\/$/.test(url);
}

/** Firefox Google or Apple login: the background writes the result here (storage.session) for the login tab. */
export const AUTH_RESULT = "auth_result";
/** A result older than this is from an earlier login and is ignored. */
export const AUTH_RESULT_MS = 10 * 60_000;

export interface AuthResult {
  done: boolean;
  limit?: Record<string, unknown>;
  ticket?: string;
  error?: string;
  /** ms, when the background wrote it */
  at: number;
}

/** The stored login result when it is well formed and recent, else null. */
export function readAuthResult(v: unknown, now: number): AuthResult | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.done !== "boolean" || typeof r.at !== "number" || r.at > now || now - r.at > AUTH_RESULT_MS) return null;
  const out: AuthResult = { done: r.done, at: r.at };
  if (r.limit && typeof r.limit === "object") out.limit = r.limit as Record<string, unknown>;
  if (typeof r.ticket === "string") out.ticket = r.ticket;
  if (typeof r.error === "string") out.error = r.error;
  return out;
}

/** The check before a code is sent: "" when the address is usable, else the two-line help text. */
export function emailProblem(raw: string): string {
  const v = raw.trim();
  const why = v === "" ? R.enterEmail : /[^\x00-\x7f]/.test(v) ? T.badEmail : !/^[^@\s]+@[^@\s]+$/.test(v) ? R.emailNotValid : "";
  return why && actionLine("sendCode") + "\n" + why;
}

/** The code to check on its own after an edit: six characters, and not the one that was just tried. */
export function autoVerifyCode(cleaned: string, lastTried: string): string | null {
  return cleaned.length === 6 && cleaned !== lastTried ? cleaned : null;
}
