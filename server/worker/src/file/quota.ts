// Per-account file upload quota: one Durable Object per account (named by the account id), one
// storage-backed row. A missing row reads as all zeros. Count limits only; a charge is never
// refunded (not on abort, storage failure, or hash mismatch), except for an upload that ends
// after its own expiry (its object is deleted and the upload is refused).
import { DurableObject } from "cloudflare:workers";

// day and month are the UTC start (unix s) of the period the counts belong to. sends holds, per
// device id, the last charged upload of that device: a POST from that device with the same
// PA-Send-ID and attempts < 3 (the first try plus 2 automatic retries) is not charged again. No
// timer. At most MAX_SLOTS devices are kept; the least recently charged slot is dropped first.
export interface SendSlot {
  send_id: string;
  attempts: number;
}

export interface QuotaRow {
  day: number;
  day_count: number;
  month: number;
  month_count: number;
  sends: Record<string, SendSlot>;
}

export const FREE_ATTEMPTS = 3;
export const MAX_SLOTS = 16;
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
export function chargeRow(old: QuotaRow | undefined, device: string, sendId: string, dayLimit: number, monthLimit: number, now: number): { row: QuotaRow | null; result: ChargeResult } {
  const r: QuotaRow = old ? { ...old, sends: { ...old.sends } } : { day: 0, day_count: 0, month: 0, month_count: 0, sends: {} };
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
  const slot = Object.hasOwn(r.sends, device) ? r.sends[device] : undefined;
  if (slot && slot.send_id === sendId && slot.attempts < FREE_ATTEMPTS) {
    r.sends[device] = { send_id: sendId, attempts: slot.attempts + 1 };
    return { row: r, result: { ok: true, charged: false, quota: quota() } };
  }
  if (r.day_count >= dayLimit || r.month_count >= monthLimit) return { row: null, result: { ok: false, charged: false, quota: quota() } };
  r.day_count++;
  r.month_count++;
  // Re-insert so key order is charge order; drop the oldest slots past MAX_SLOTS.
  delete r.sends[device];
  r.sends[device] = { send_id: sendId, attempts: 1 };
  const ids = Object.keys(r.sends);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_SLOTS))) delete r.sends[id];
  return { row: r, result: { ok: true, charged: true, quota: quota() } };
}

// Pure refund step: takes back one charge made at chargedAt, in the periods that are still
// current. The device slot is kept. Returns the new row, or null when unchanged.
export function refundRow(old: QuotaRow | undefined, chargedAt: number): QuotaRow | null {
  if (!old) return null;
  const r: QuotaRow = { ...old };
  let changed = false;
  if (r.day === dayOf(chargedAt) && r.day_count > 0) {
    r.day_count--;
    changed = true;
  }
  if (r.month === monthOf(chargedAt) && r.month_count > 0) {
    r.month_count--;
    changed = true;
  }
  return changed ? r : null;
}

export class FileQuota extends DurableObject {
  // Storage calls hold the object's input gate, so no other call runs between this get and put:
  // the read-modify-write is atomic.
  async charge(device: string, sendId: string, dayLimit: number, monthLimit: number, now: number): Promise<ChargeResult> {
    const { row, result } = chargeRow(await this.ctx.storage.get<QuotaRow>(ROW), device, sendId, dayLimit, monthLimit, now);
    if (row) await this.ctx.storage.put(ROW, row);
    return result;
  }

  async refund(chargedAt: number): Promise<void> {
    const row = refundRow(await this.ctx.storage.get<QuotaRow>(ROW), chargedAt);
    if (row) await this.ctx.storage.put(ROW, row);
  }
}
