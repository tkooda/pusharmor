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

export class Log {
  route = "";
  status = 0;
  error?: string;
  colo?: string;
  account?: string;
  peer?: string;
  body_bytes?: number;
  recipients: RecipientLog[] = [];
  rows_read = 0;
  rows_written = 0;
  rl?: string;
  rl_error: string[] = [];
  gone_write?: "failed";
  endpoint_reject?: { host?: string; prefix_len?: number; reason?: string };
  exception?: string;
  extra: Record<string, string | number> = {};
  private readonly t0 = Date.now();

  addMeta(meta: { rows_read?: number; rows_written?: number } | undefined): void {
    if (!meta) return;
    this.rows_read += meta.rows_read ?? 0;
    this.rows_written += meta.rows_written ?? 0;
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
    if (this.rows_read || this.rows_written) {
      o.rows_read = this.rows_read;
      o.rows_written = this.rows_written;
    }
    if (this.rl) o.rl = this.rl;
    if (this.rl_error.length) o["rl-error"] = this.rl_error;
    if (this.gone_write) o.gone_write = this.gone_write;
    if (this.endpoint_reject) o.endpoint_reject = this.endpoint_reject;
    if (this.exception) o.exception = this.exception;
    for (const [k, v] of Object.entries(this.extra)) o[k] = v;
    return JSON.stringify(o);
  }

  emit(): void {
    console.log(this.line());
  }
}
