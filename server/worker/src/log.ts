// One structured log line per request, built only from allow-listed fields. Never log
// emails, email_hash, IPs, tokens, tickets, codes, push tokens, endpoint paths, keys,
// messages, name entries, signatures, secrets, raw queries or bodies.
export interface RecipientLog {
  id: string;
  class: string;
  bytes: number;
  result: string;
  vendor?: string;
  retry: boolean;
}

// PA_LOG_SAMPLE as a rate; anything but a number in 0..1 logs every line.
export function sampleRate(v: string | undefined): number {
  if (v === undefined || !/^[0-9.]+$/.test(v)) return 1;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 1;
}

export class Log {
  route = "";
  status = 0;
  error?: string;
  colo?: string;
  account?: string;
  peer?: string;
  body_bytes?: number;
  recipients: RecipientLog[] = [];
  rl?: string;
  rl_error: string[] = [];
  gone_write?: "failed";
  endpoint_reject?: { host?: string; prefix_len?: number; reason?: string };
  exception?: string;
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

  line(): string {
    const o: Record<string, unknown> = {
      ts: new Date(this.t0).toISOString(),
      route: this.route,
      status: this.status,
      ms: Date.now() - this.t0,
    };
    if (this.error) o.error = this.error;
    if (this.colo) o.colo = this.colo;
    if (this.account) o.account = this.account;
    if (this.peer) o.peer = this.peer;
    if (this.body_bytes !== undefined) o.body_bytes = this.body_bytes;
    if (this.recipients.length) o.recipients = this.recipients;
    if (this.rl) o.rl = this.rl;
    if (this.rl_error.length) o["rl-error"] = this.rl_error;
    if (this.gone_write) o.gone_write = this.gone_write;
    if (this.endpoint_reject) o.endpoint_reject = this.endpoint_reject;
    if (this.exception) o.exception = this.exception;
    for (const [k, v] of Object.entries(this.extra)) o[k] = v;
    return JSON.stringify(o);
  }

  // A line worth keeping whatever the sample rate: server errors, client errors other than
  // 429, rate-limit binding errors, failed write-backs, endpoint rejects, and any recipient
  // that was not delivered on the first attempt.
  notable(): boolean {
    if (this.exception || this.rl_error.length || this.gone_write || this.endpoint_reject) return true;
    if (this.status >= 400 && this.status !== 429) return true;
    return this.recipients.some((r) => r.result !== "sent" || r.retry);
  }

  // Workers Logs bills every line, so plain successes and 429s are sampled at `rate` (0..1).
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
