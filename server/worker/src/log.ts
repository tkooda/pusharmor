// One structured log line per request, built only from allow-listed fields. Never log
// emails, email_hash, IPs, tokens, tickets, codes, push tokens, endpoint paths, keys,
// messages, name entries, signatures, secrets, raw queries or bodies. The one exception:
// client IP prefixes (IPv4 /24, IPv6 /48) in the "suppressed" summary line.
export interface RecipientLog {
  id: string;
  class: string;
  bytes: number;
  result: string;
  vendor?: string;
  vendor_status?: string; // FCM error.status, e.g. "PERMISSION_DENIED"
  vendor_msg?: string; // vendor error message, cleaned of URLs and token-like strings
  retry: boolean;
}

// PA_LOG_SAMPLE as a rate; anything but a number in 0..1 logs every line.
export function sampleRate(v: string | undefined): number {
  if (v === undefined || !/^[0-9.]+$/.test(v)) return 1;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 1;
}

// LOG_LEVEL (dashboard variable): error = faults only (alerts, 5xx, exceptions); warn = also other
// notable lines and 401/403/429 refusals; info (default, and any unknown value) = warn plus
// PA_LOG_SAMPLE sampling of the rest; debug = every line, unsampled.
export type Level = "error" | "warn" | "info" | "debug";
export function logLevel(v: string | undefined): Level {
  return v === "error" || v === "warn" || v === "debug" ? v : "info";
}

// Refusals (401/403/429) are always logged, at most REFUSAL_MAX per fixed window of REFUSAL_WINDOW_MS
// per isolate. A window starts at the first refusal after the previous window ended. Past the
// limit a refusal is only counted; the next log call after the window ends first emits one
// "suppressed" summary line. IPs are kept only as prefixes (IPv4 /24, IPv6 /48).
const REFUSAL_MAX = 10;
const REFUSAL_WINDOW_MS = 60_000;
interface Window { start: number; n: number; supp: number; status: Record<string, number>; route: Record<string, number>; ip: Record<string, number>; account: Record<string, number> }
let win: Window | undefined;
let now = (): number => Date.now();
export const testing = {
  setClock(f: () => number): void { now = f; },
  reset(): void { win = undefined; now = () => Date.now(); },
};

const bump = (m: Record<string, number>, k: string): void => { m[k] = (m[k] ?? 0) + 1; };
const top3 = (m: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 3));

export function ipPrefix(ip: string): string | undefined {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (!/^[0-9a-fA-F:]+$/.test(ip) || !ip.includes(":")) return undefined;
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const g = ip.includes("::") ? [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  if (g.length !== 8) return undefined;
  const p = g.slice(0, 3).map((x) => parseInt(x || "0", 16).toString(16));
  return `${p[0]}:${p[1]}:${p[2]}::/48`;
}

// Relay-side fault kinds for the "alert" field. Never set for client errors (4xx) or
// device-side push failures.
export type Alert = "cron" | "mail" | "db" | "push-auth" | "ratelimit";

export class Log {
  route = "";
  status = 0;
  error?: string;
  colo?: string;
  client?: string;
  account?: string;
  ip_prefix?: string; // never printed by line(); only counted in the suppressed summary
  peer?: string;
  body_bytes?: number;
  recipients: RecipientLog[] = [];
  rl?: string;
  rl_error: string[] = [];
  gone_write?: "failed";
  endpoint_reject?: { host?: string; prefix_len?: number; reason?: string };
  exception?: string;
  pushAuth = false; // a push hit a relay-side fault (results.ts Outcome.relay, or a token mint failure)
  extra: Record<string, string | number> = {};
  private readonly t0 = Date.now();

  setIp(ip: string | null): void {
    this.ip_prefix = ip ? ipPrefix(ip) : undefined;
  }

  // Exceptions: class name and stack frames only, never the message text.
  setException(e: unknown): void {
    if (e instanceof Error) {
      const frames = (e.stack ?? "").split("\n").filter((l) => l.trimStart().startsWith("at ")).slice(0, 8).map((l) => l.trim());
      this.exception = [e.name, ...frames].join(" | ");
    } else {
      this.exception = typeof e;
    }
  }

  // One kind per line, in this priority order: cron (a scheduled job failed), mail (SES did not
  // send a login code: 502 "email send failed"), db (D1 error, uncaught exception, any 5xx, or a
  // failed write-back), push-auth (a vendor refused our credentials or a token mint failed),
  // ratelimit (a rate-limit binding threw).
  alert(): Alert | undefined {
    if (this.route.startsWith("cron")) return this.exception || this.error ? "cron" : undefined;
    if (this.error === "email send failed") return "mail";
    if (this.exception || this.status >= 500 || this.gone_write) return "db";
    if (this.pushAuth) return "push-auth";
    if (this.rl_error.length) return "ratelimit";
    return undefined;
  }

  line(): string {
    const o: Record<string, unknown> = {
      ts: new Date(this.t0).toISOString(),
      route: this.route,
      status: this.status,
      ms: Date.now() - this.t0,
    };
    if (this.error) o.error = this.error;
    if (this.colo) o.colo = this.colo;
    if (this.client) o.client = this.client;
    if (this.account) o.account = this.account;
    if (this.peer) o.peer = this.peer;
    if (this.body_bytes !== undefined) o.body_bytes = this.body_bytes;
    if (this.recipients.length) o.recipients = this.recipients;
    if (this.rl) o.rl = this.rl;
    if (this.rl_error.length) o["rl-error"] = this.rl_error;
    if (this.gone_write) o.gone_write = this.gone_write;
    if (this.endpoint_reject) o.endpoint_reject = this.endpoint_reject;
    if (this.exception) o.exception = this.exception;
    const alert = this.alert();
    if (alert) o.alert = alert;
    for (const [k, v] of Object.entries(this.extra)) o[k] = v;
    return JSON.stringify(o);
  }

  // A line worth keeping whatever the sample rate: any alert, server errors, rate-limit binding
  // errors, failed write-backs, endpoint rejects, and any recipient that was not delivered on the
  // first attempt. Client errors (4xx) are sampled, so a flood of refused requests is not
  // logged line by line.
  notable(): boolean {
    if (this.alert()) return true;
    if (this.exception || this.rl_error.length || this.gone_write || this.endpoint_reject) return true;
    if (this.status >= 500) return true;
    return this.recipients.some((r) => r.result !== "sent" || r.retry);
  }

  // A relay fault: an alert, an uncaught exception, or any 5xx.
  private fault(): boolean {
    return !!(this.alert() || this.exception || this.status >= 500);
  }

  // Workers Logs bills every line, so plain successes and other 4xx are sampled at `rate` (0..1).
  // A sampled line carries "sample": 1/rate, to scale counts back up.
  emit(rate = 1, level: Level = "info"): void {
    flushSuppressed();
    if (level === "debug") return void console.log(this.line());
    if (level === "error") return this.fault() ? void console.log(this.line()) : undefined;
    if (this.notable()) return void console.log(this.line());
    if ([401, 403, 429].includes(this.status)) return this.refusal();
    if (level === "warn" || rate <= 0 || (rate < 1 && Math.random() >= rate)) return;
    if (rate < 1) this.extra.sample = Math.round(1 / rate);
    console.log(this.line());
  }

  private refusal(): void {
    const t = now();
    win ??= { start: t, n: 0, supp: 0, status: {}, route: {}, ip: {}, account: {} };
    if (win.n++ < REFUSAL_MAX) return void console.log(this.line());
    win.supp++;
    bump(win.status, String(this.status));
    bump(win.route, this.route);
    if (this.ip_prefix) bump(win.ip, this.ip_prefix);
    if (this.account) bump(win.account, this.account);
  }
}

// On the first log call after a window ends: emit one summary line if anything was suppressed.
function flushSuppressed(): void {
  if (!win || now() < win.start + REFUSAL_WINDOW_MS) return;
  const w = win;
  win = undefined;
  if (!w.supp) return;
  const o: Record<string, unknown> = {
    ts: new Date(now()).toISOString(),
    route: "suppressed",
    suppressed: w.supp,
    window_start: new Date(w.start).toISOString(),
    window_end: new Date(w.start + REFUSAL_WINDOW_MS).toISOString(),
    by_status: w.status,
    by_route: w.route,
    ip_prefixes: top3(w.ip),
  };
  if (Object.keys(w.account).length) o.accounts = top3(w.account);
  console.log(JSON.stringify(o));
}
