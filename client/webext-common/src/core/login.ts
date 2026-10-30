// Sign-in flows (catalog Auth; component-webext section 7 Login): email code,
// Google and Apple. The ticket then registers, logs in or deletes.
import { API_BASE, ApiError } from "../api/client.ts";
import { b64urlEncode } from "../crypto/b64url.ts";
import { normalizeEmail, oauthK } from "../crypto/labels.ts";
import { type Restore, SIGNIN_PROGRESS, restoreStep } from "../model/signin.ts";
import type { Engine } from "./engine.ts";
import { UserError } from "./engine.ts";
import { T } from "./texts.ts";

export type Purpose = "register" | "login" | "delete-account";
export const AUTH_PENDING = "auth_pending";
export const REQUEST_TOKEN = "request_token";
const AUTH_PENDING_MS = 10 * 60_000;
const TICKET_RE = /^[A-Za-z0-9_.-]{16,4096}$/;

export interface LoginResult {
  done: boolean;
  limit?: Record<string, unknown>; // 409 "peer limit" body for the picker
  ticket?: string;
}

/** Paste rule (Q54 A, I029): a standalone 6-char token, inner dashes or spaces allowed. */
export function cleanCode(input: string): string | null {
  const m = /(?:^|[^0-9A-Za-z])([0-9A-Za-z](?:[ -]?[0-9A-Za-z]){5})(?![0-9A-Za-z])/.exec(input.trim());
  if (!m) return null;
  return m[1]!.replace(/[ -]/g, "").toUpperCase();
}

export class Login {
  readonly e: Engine;
  constructor(e: Engine) {
    this.e = e;
  }

  async purpose(): Promise<Purpose> {
    return (await this.e.regState()) === "logged_out" ? "login" : "register";
  }

  async emailStart(email: string, turnstile: string, purpose: Purpose): Promise<void> {
    const n = normalizeEmail(email);
    if (n === null) throw new UserError(T.badEmail);
    const keys = await this.e.signInKeys();
    const r = await this.e.api.call("POST", "/auth/email", {
      body: { email: n, sign_pub: b64urlEncode(keys.sign_pub), purpose, turnstile },
    });
    if (typeof r.json.request_token !== "string") throw new UserError("Bad reply from the server");
    await this.e.p.storageSession.set({
      [REQUEST_TOKEN]: { token: r.json.request_token, purpose },
      [SIGNIN_PROGRESS]: { v: 1, step: "code", email: email.trim(), purpose, sentAt: this.e.p.now() },
    });
  }

  /** Saved sign-in progress for this purpose (storage.session; see model/signin.ts). */
  async progress(purpose: Purpose): Promise<Restore | null> {
    const got = await this.e.p.storageSession.get([SIGNIN_PROGRESS, REQUEST_TOKEN]);
    const rt = got[REQUEST_TOKEN] as { purpose?: string } | undefined;
    return restoreStep(got[SIGNIN_PROGRESS], this.e.p.now(), purpose, !!rt && rt.purpose === purpose);
  }

  /** Step 1: keep the typed email so a reopened tab can fill it in. */
  async draft(email: string, purpose: Purpose): Promise<void> {
    await this.e.p.storageSession.set({ [SIGNIN_PROGRESS]: { v: 1, step: "email", email: email.slice(0, 320), purpose, sentAt: 0 } });
  }

  async clearProgress(): Promise<void> {
    await this.e.p.storageSession.remove([SIGNIN_PROGRESS]);
  }

  async emailVerify(code: string, evict?: string[]): Promise<LoginResult> {
    const c = cleanCode(code);
    if (!c) throw new UserError("Enter the 6-character code");
    const st = (await this.e.p.storageSession.get([REQUEST_TOKEN]))[REQUEST_TOKEN] as { token: string; purpose: Purpose } | undefined;
    if (!st) throw new UserError("Login expired, log in again");
    const r = await this.e.api.call("POST", "/auth/email/verify", { body: { request_token: st.token, code: c } });
    const ticket = typeof r.json.ticket === "string" ? r.json.ticket : "";
    const email = typeof r.json.email === "string" ? r.json.email : null;
    return this.complete(st.purpose, ticket, email, evict);
  }

  async oauthUrl(provider: "google" | "apple", purpose: Purpose): Promise<string> {
    const keys = await this.e.signInKeys();
    const k = await oauthK(keys.sign_pub);
    const r = this.e.p.platformName;
    return API_BASE + "/v1/auth/" + provider + "?k=" + encodeURIComponent(k) + "&r=" + r + "&p=" + purpose;
  }

  /** Starts Google or Apple sign-in. Chrome finishes here; Firefox finishes in authDone. */
  async oauthStart(provider: "google" | "apple", purpose: Purpose): Promise<LoginResult> {
    const url = await this.oauthUrl(provider, purpose);
    const redirect = await this.e.p.authFlow(url);
    if (redirect !== null) {
      const f = parseFragment(redirect);
      return this.complete(purpose, f.ticket ?? "", f.email ?? null);
    }
    const tabId = await this.e.p.openTab(url, true);
    await this.e.p.storageSession.set({ [AUTH_PENDING]: { tabId, purpose, until: this.e.p.now() + AUTH_PENDING_MS } });
    return { done: false };
  }

  /** Firefox: the /auth/done content script relayed the fragment from tab tabId. */
  async authDone(tabId: number | undefined, hash: string): Promise<LoginResult> {
    const pend = (await this.e.p.storageSession.get([AUTH_PENDING]))[AUTH_PENDING] as { tabId: number | null; purpose: Purpose; until: number } | undefined;
    if (!pend || tabId === undefined || pend.tabId !== tabId || this.e.p.now() > pend.until) return { done: false };
    await this.e.p.storageSession.remove([AUTH_PENDING]); // consumed once
    this.e.p.closeTab(tabId);
    const f = parseFragment("#" + hash.replace(/^#/, ""));
    return this.complete(pend.purpose, f.ticket ?? "", f.email ?? null);
  }

  async complete(purpose: Purpose, ticket: string, email: string | null, evict?: string[]): Promise<LoginResult> {
    if (!TICKET_RE.test(ticket)) throw new UserError("Login failed, try again");
    if (email !== null) await this.e.db.setMeta("email", email);
    try {
      if (purpose === "register") {
        const limit = await this.e.register(ticket, email, evict);
        if (limit) return { done: false, limit, ticket: typeof limit.ticket === "string" ? limit.ticket : ticket };
      } else if (purpose === "login") await this.e.login(ticket);
      else await this.e.deleteAccount(ticket);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && err.error === "ticket expired") throw new UserError("Login expired, log in again");
      throw err;
    }
    await this.clearProgress();
    return { done: true };
  }
}

export function parseFragment(url: string): Record<string, string> {
  const i = url.indexOf("#");
  const out: Record<string, string> = {};
  if (i < 0) return out;
  for (const part of url.slice(i + 1).split("&")) {
    const [k, v] = part.split("=");
    if (k && v !== undefined) {
      try {
        out[decodeURIComponent(k)] = decodeURIComponent(v);
      } catch {
        // ignore a malformed pair
      }
    }
  }
  return out;
}
