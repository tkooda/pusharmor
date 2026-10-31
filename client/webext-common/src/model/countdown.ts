// Pairing countdown: "X days" at 24 h or more left, "X hours" under 24 h,
// "X minutes" under 60 min (catalog Pairing flow step 8).

export const PAIRING_TIMEOUT_DAYS = 30;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function unit(v: number, one: string, many: string): string {
  return v + " " + (v === 1 ? one : many);
}

export function formatCountdown(msLeft: number): string {
  if (msLeft >= DAY) return unit(Math.floor(msLeft / DAY), "day", "days");
  if (msLeft >= HOUR) return unit(Math.floor(msLeft / HOUR), "hour", "hours");
  return unit(Math.max(0, Math.floor(msLeft / 60000)), "minute", "minutes");
}
