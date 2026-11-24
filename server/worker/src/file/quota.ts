// Per-account file upload quota: one Durable Object per account (named by the account id), one
// storage-backed row. A missing row reads as all zeros. Count limits only; a charge is never
// refunded (not on abort, storage failure, or hash mismatch).
import { DurableObject } from "cloudflare:workers";

// day and month are the UTC start (unix s) of the period the counts belong to. send_id and
// attempts belong to the last charged upload: a POST with the same PA-Send-ID and attempts < 3
// (the first try plus 2 automatic retries) is not charged again. No timer.
export interface QuotaRow {
  day: number;
  day_count: number;
  month: number;
  month_count: number;
  send_id: string;
  attempts: number;
}

export const FREE_ATTEMPTS = 3;
const ROW = "q";

export interface Period {
  used: number;
  limit: number;
  resets_at: number;
}

export interface Quota {
  day: Period;
  month: Period;
}

export interface ChargeResult {
  ok: boolean; // false: over a limit, nothing charged
  charged: boolean; // false: a free retry of the last charged send
  quota: Quota;
}

export function dayOf(t: number): number {
  return t - (t % 86400);
}

export function nextDay(t: number): number {
  return dayOf(t) + 86400;
}

export function monthOf(t: number): number {
  const d = new Date(t * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
}

export function nextMonth(t: number): number {
  const d = new Date(t * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
}

// Pure charge step: returns the new row (null when unchanged) and the result.
export function chargeRow(old: QuotaRow | undefined, sendId: string, dayLimit: number, monthLimit: number, now: number): { row: QuotaRow | null; result: ChargeResult } {
  const r: QuotaRow = old ? { ...old } : { day: 0, day_count: 0, month: 0, month_count: 0, send_id: "", attempts: 0 };
  if (r.day !== dayOf(now)) {
    r.day = dayOf(now);
    r.day_count = 0;
  }
  if (r.month !== monthOf(now)) {
    r.month = monthOf(now);
    r.month_count = 0;
  }
  const quota = (): Quota => ({
    day: { used: r.day_count, limit: dayLimit, resets_at: nextDay(now) },
    month: { used: r.month_count, limit: monthLimit, resets_at: nextMonth(now) },
  });
  if (r.send_id === sendId && r.attempts < FREE_ATTEMPTS) {
    r.attempts++;
    return { row: r, result: { ok: true, charged: false, quota: quota() } };
  }
  if (r.day_count >= dayLimit || r.month_count >= monthLimit) return { row: null, result: { ok: false, charged: false, quota: quota() } };
  r.day_count++;
  r.month_count++;
  r.send_id = sendId;
  r.attempts = 1;
  return { row: r, result: { ok: true, charged: true, quota: quota() } };
}

export class FileQuota extends DurableObject {
  // One call at a time per object (no await between get and put), so the read-modify-write is atomic.
  async charge(sendId: string, dayLimit: number, monthLimit: number, now: number): Promise<ChargeResult> {
    const { row, result } = chargeRow(await this.ctx.storage.get<QuotaRow>(ROW), sendId, dayLimit, monthLimit, now);
    if (row) await this.ctx.storage.put(ROW, row);
    return result;
  }
}
