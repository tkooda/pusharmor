// Worker client (catalog General): PA-Sig signing, PA-Epoch-Ms offset,
// retries on 429 / 503 / network errors only, clock-skew rebuild.
import { utf8 } from "../crypto/bytes.ts";
import { paSig } from "../crypto/pasig.ts";

export const API_BASE = "https://api.pusharmor.com";
export const RETRY_DELAYS_MS = [500, 1500, 3000];
export const RETRY_BUDGET_MS = 8000;

export class ApiError extends Error {
  readonly status: number; // 0 = network error
  readonly error: string;
  readonly body: Record<string, unknown>;
  readonly retryAfter: number | null; // seconds
  constructor(status: number, error: string, body: Record<string, unknown>, retryAfter: number | null) {
    super(status + " " + error);
    this.status = status;
    this.error = error;
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

export interface Signer {
  id: string | null; // null: no PA-ID header (POST /peers, DELETE /account)
  key: CryptoKey;
}

export interface ApiDeps {
  fetch(input: string, init: RequestInit): Promise<Response>;
  now(): number;
  sleep(ms: number): Promise<void>;
  getOffset(): Promise<number>;
  setOffset(ms: number): Promise<void>;
}

export interface CallOpts {
  /** Signed call; omit for /auth/* calls. */
  signer?: Signer;
  /** Body builder; re-run after a 401 "clock skew" (new n, new encryption). */
  build?: () => Promise<unknown>;
  body?: unknown;
  /** No retries at all (used where the caller handles waits itself). */
  noRetry?: boolean;
}

export interface ApiReply {
  status: number;
  json: Record<string, unknown>;
}

function paTime(ms: number): string {
  return String(Math.round(ms));
}

export class Api {
  private readonly d: ApiDeps;
  /** Called on 401 "paused" for a signed call (the Worker paused this device). */
  onPaused: (() => Promise<void>) | null = null;
  constructor(d: ApiDeps) {
    this.d = d;
  }

  async call(method: string, path: string, opts: CallOpts = {}): Promise<ApiReply> {
    let skews = 0;
    for (;;) {
      const bodyObj = opts.build ? await opts.build() : opts.body;
      const bodyText = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
      try {
        return await this.withRetries(method, path, bodyText, opts);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401 && e.error === "clock skew" && opts.signer && skews === 0) {
          skews++;
          continue;
        }
        if (e instanceof ApiError && e.status === 401 && e.error === "clock skew") {
          throw new ApiError(401, "clock skew twice", e.body, null);
        }
        if (e instanceof ApiError && e.status === 401 && e.error === "paused" && opts.signer?.id != null) await this.onPaused?.();
        throw e;
      }
    }
  }

  private async withRetries(method: string, path: string, bodyText: string, opts: CallOpts): Promise<ApiReply> {
    const start = this.d.now();
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(method, path, bodyText, opts);
      } catch (e) {
        if (!(e instanceof ApiError) || opts.noRetry) throw e;
        const retryable = e.status === 0 || e.status === 429 || e.status === 503;
        if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw e;
        let wait = RETRY_DELAYS_MS[attempt]!;
        if (e.retryAfter !== null) wait = Math.max(wait, e.retryAfter * 1000);
        if (this.d.now() - start + wait > RETRY_BUDGET_MS) throw e;
        await this.d.sleep(wait);
      }
    }
  }

  private async once(method: string, path: string, bodyText: string, opts: CallOpts): Promise<ApiReply> {
    const fullPath = "/v1" + path;
    const headers: Record<string, string> = {};
    const bodyBytes = utf8(bodyText);
    if (bodyText !== "") headers["Content-Type"] = "application/json";
    if (opts.signer) {
      const t = paTime(this.d.now() + (await this.d.getOffset()));
      if (opts.signer.id !== null) headers["PA-ID"] = opts.signer.id;
      headers["PA-Time"] = t;
      headers["PA-Sig"] = await paSig(opts.signer.key, method, fullPath, t, bodyBytes);
    }
    let res: Response;
    try {
      const init: RequestInit = { method, headers, redirect: "manual", credentials: "omit", cache: "no-store" };
      if (bodyText !== "") init.body = bodyText;
      res = await this.d.fetch(API_BASE + fullPath, init);
    } catch {
      throw new ApiError(0, "network", {}, null);
    }
    const epoch = res.headers.get("PA-Epoch-Ms");
    if (epoch && /^[0-9]{1,16}$/.test(epoch)) await this.d.setOffset(Number(epoch) - this.d.now());
    let json: Record<string, unknown> = {};
    try {
      const t = await res.text();
      if (t) {
        const v = JSON.parse(t) as unknown;
        if (v && typeof v === "object" && !Array.isArray(v)) json = v as Record<string, unknown>;
      }
    } catch {
      json = {};
    }
    if (res.status >= 200 && res.status < 300) return { status: res.status, json };
    const err = typeof json.error === "string" ? json.error : "";
    let ra: number | null = null;
    const h = res.headers.get("Retry-After");
    if (h && /^[0-9]+$/.test(h)) ra = Number(h);
    else if (typeof json.retry_after === "number") ra = json.retry_after;
    throw new ApiError(res.status, err, json, ra);
  }
}

/** User-facing text for an API error (catalog Results and errors). */
export function errorText(e: unknown): string {
  if (!(e instanceof ApiError)) return "Something went wrong. Try again.";
  if (e.error === "clock skew twice") return "This device's clock is off by more than 5 minutes";
  if (e.status === 502) return "Could not send the email, try again";
  if (e.status === 400 && e.error === "bad email") return "Only email addresses with plain ASCII characters are supported.";
  if (e.status === 400 && e.error === "push endpoint not allowed") return "This browser's push service is not supported yet";
  if (e.status === 401 && e.error === "ticket expired") return "Sign-in expired, sign in again";
  if (e.status === 401 && e.error === "wrong code") return "That code did not work. Check the newest email from PushArmor and try again.";
  if (e.status === 401 && e.error === "code expired") return "This code has expired. Get a new code to continue.";
  if (e.status === 403 && e.error === "turnstile failed") return "The security check did not finish. Try it again.";
  if (e.status === 401 && e.error === "paused") return "Signed out. Sign in to resume";
  if (e.status === 429) return "Too many requests. Try again in " + (e.retryAfter ?? 60) + " s";
  if (e.status === 0) return "Offline. Try again.";
  return "Error: " + (e.error || String(e.status));
}
