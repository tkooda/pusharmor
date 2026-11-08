// Worker client (catalog General): PA-Sig signing, PA-Epoch offset (seconds),
// retries on 429 (server wait) and on 5xx / network errors (3 tries, 1 s then 3 s), clock-skew rebuild.
import { utf8 } from "../crypto/bytes.ts";
import { paSig } from "../crypto/pasig.ts";

export const API_BASE = "https://api.pusharmor.com";
const RETRY_DELAYS_MS = [500, 1500, 3000];
const RETRY_BUDGET_MS = 8000;
/** HTTP 5xx and network errors: 3 tries in all, with these waits between them. */
export const SERVER_RETRY_DELAYS_MS = [1000, 3000];
/** One request (headers and body) may take this long before it is aborted. */
export const FETCH_TIMEOUT_MS = 15000;

export class ApiError extends Error {
  readonly status: number; // 0 = network error
  readonly error: string;
  readonly body: Record<string, unknown>;
  readonly retryAfter: number | null; // seconds
  /** No reply (status 0): aborted after the timeout, the browser is offline, or any other network error. */
  readonly kind: "timeout" | "offline" | "network";
  constructor(status: number, error: string, body: Record<string, unknown>, retryAfter: number | null, kind: "timeout" | "offline" | "network" = "network") {
    super(status + " " + error);
    this.status = status;
    this.error = error;
    this.body = body;
    this.retryAfter = retryAfter;
    this.kind = kind;
  }
}

export interface Signer {
  id: string | null; // null: no PA-ID header (POST /peers, DELETE /account)
  key: CryptoKey;
}

interface ApiDeps {
  /** PA-Client header value, e.g. "chrome/0.0.19". */
  client: string;
  fetch(input: string, init: RequestInit): Promise<Response>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Server clock minus local clock, in whole seconds. */
  getOffset(): Promise<number>;
  setOffset(s: number): Promise<void>;
}

export interface CallOpts {
  /** Signed call; omit for /auth/* calls. */
  signer?: Signer;
  /** Body builder; re-run after a 401 "clock skew" (new n, new encryption). */
  build?: () => Promise<unknown>;
  body?: unknown;
  /** No retries at all (used where the caller handles waits itself, or the server may apply a repeat twice). */
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
  /** Called on 401 "logged out" for a signed call (the Worker logged this device out). */
  onLoggedOut: (() => Promise<void>) | null = null;
  /** Called on HTTP 426 (this version is too old for the relay server). */
  onUpdateRequired: (() => Promise<void>) | null = null;
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
        if (e instanceof ApiError && e.status === 426) await this.onUpdateRequired?.().catch(() => undefined);
        if (e instanceof ApiError && e.status === 401 && e.error === "clock skew" && opts.signer && skews === 0) {
          skews++;
          continue;
        }
        if (e instanceof ApiError && e.status === 401 && e.error === "clock skew") {
          throw new ApiError(401, "clock skew twice", e.body, null);
        }
        if (e instanceof ApiError && e.status === 401 && e.error === "logged out" && opts.signer?.id != null) await this.onLoggedOut?.();
        throw e;
      }
    }
  }

  private async withRetries(method: string, path: string, bodyText: string, opts: CallOpts): Promise<ApiReply> {
    const start = this.d.now();
    let busy = 0;
    let down = 0;
    for (;;) {
      try {
        return await this.once(method, path, bodyText, opts);
      } catch (e) {
        if (!(e instanceof ApiError) || opts.noRetry) throw e;
        if (e.status === 429) {
          if (busy >= RETRY_DELAYS_MS.length) throw e;
          let wait = RETRY_DELAYS_MS[busy]!;
          if (e.retryAfter !== null) wait = Math.max(wait, e.retryAfter * 1000);
          if (this.d.now() - start + wait > RETRY_BUDGET_MS) throw e;
          busy++;
          await this.d.sleep(wait);
        } else if (e.status === 0 || (e.status >= 500 && e.status <= 599)) {
          if (down >= SERVER_RETRY_DELAYS_MS.length) throw e;
          await this.d.sleep(SERVER_RETRY_DELAYS_MS[down++]!);
        } else throw e;
      }
    }
  }

  private async once(method: string, path: string, bodyText: string, opts: CallOpts): Promise<ApiReply> {
    const fullPath = "/v1" + path;
    const headers: Record<string, string> = { "PA-Client": this.d.client };
    const bodyBytes = utf8(bodyText);
    if (bodyText !== "") headers["Content-Type"] = "application/json";
    if (opts.signer) {
      const t = paTime(this.d.now() + (await this.d.getOffset()) * 1000);
      if (opts.signer.id !== null) headers["PA-ID"] = opts.signer.id;
      headers["PA-Time"] = t;
      headers["PA-Sig"] = await paSig(opts.signer.key, method, fullPath, t, bodyBytes);
    }
    let res: Response;
    let t = "";
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
    try {
      try {
        const init: RequestInit = { method, headers, redirect: "manual", credentials: "omit", cache: "no-store", signal: abort.signal };
        if (bodyText !== "") init.body = bodyText;
        res = await this.d.fetch(API_BASE + fullPath, init);
      } catch {
        throw noReply(abort.signal.aborted);
      }
      try {
        t = await res.text();
      } catch {
        if (abort.signal.aborted) throw noReply(true);
      }
    } finally {
      clearTimeout(timer);
    }
    const epoch = res.headers.get("PA-Epoch");
    if (epoch && /^[0-9]{1,13}$/.test(epoch)) await this.d.setOffset(Number(epoch) - Math.floor(this.d.now() / 1000));
    let json: Record<string, unknown> = {};
    try {
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
    throw new ApiError(res.status, err, json, ra === null ? null : clampRetry(ra));
  }
}

/** A request with no reply: timed out, offline (navigator.onLine false), or another network error. */
function noReply(aborted: boolean): ApiError {
  const offline = (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine === false;
  return new ApiError(0, "network", {}, null, aborted ? "timeout" : offline ? "offline" : "network");
}

/** Retry-After seconds clamped to 0..1 hour, so a bad value cannot hold calls back for ever. */
function clampRetry(s: number): number {
  return Math.min(Math.max(s, 0), 3600);
}

/** HTTP 426: the relay server no longer accepts this version. */
export const UPDATE_REQUIRED = "Update PushArmor to continue.";
