// One structured log line per request, built only from allow-listed fields. Never log
// emails, email_hash, IPs, tokens, tickets, codes, push tokens, endpoint paths, keys,
// messages, name entries, signatures, secrets, raw queries or bodies.
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

  // Workers Logs bills every line, so plain successes and 4xx are sampled at `rate` (0..1).
  // A sampled line carries "sample": 1/rate, to scale counts back up.
  emit(rate = 1): void {
    if (rate >= 1 || this.notable()) {
      console.log(this.line());
      return;
    }
    if (rate <= 0 || Math.random() >= rate) return;
    this.extra.sample = Math.round(1 / rate);
    console.log(this.line());
  }
}
