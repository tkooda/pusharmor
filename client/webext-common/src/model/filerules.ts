// File transfer rules: the auto-download decision, the upload and download
// status table, and the free-storage check. Pure functions only.
import { MAX_FILE } from "../crypto/filecrypt.ts";
import { cutFileName } from "./filename.ts";

/** Auto-download picker limits in bytes: Off, Up to 10 MB, 25 MB, 50 MB, 100 MB. */
export const PICKER_SIZES: readonly number[] = [0, 10_000_000, 25_000_000, 50_000_000, 100_000_000];
export const DEFAULT_PICKER = 50_000_000;

/** true when the picker (bytes, 0 = Off) lets a file of this size download by itself. */
export function autoDownload(picker: number, size: number): boolean {
  return picker > 0 && size <= picker && size <= MAX_FILE;
}

/** Catch-up (app open, open from a notification, network change): a pending file starts by itself only before it expires by the local clock. */
export function catchUpDue(f: { size: number; expires: number }, picker: number, localNowSec: number): boolean {
  return localNowSec < f.expires && autoDownload(picker, f.size);
}

/** Bytes kept free beyond 2 x the file size. */
export const FREE_MARGIN = 10_000_000;

/** free: bytes the browser still allows this extension to store; null = unknown (no check). */
export function enoughStorage(free: number | null, size: number): boolean {
  return free === null || free >= 2 * size + FREE_MARGIN;
}

export function storageFullText(op: "upload" | "download", name: string): string {
  return "Not enough storage to " + (op === "upload" ? "send" : "download") + ' "' + cutFileName(name) + '"';
}

export type FinalCode =
  | "quota" // 429 file quota
  | "paused" // 503 files paused
  | "expired"
  | "deleted"
  | "update" // 404 update required, or 426
  | "too_large" // 413
  | "storage" // not enough storage on this device
  | "damaged" // sha256, size, or tag failed twice, or a bad file URL
  | "failed"; // any other refusal, or the automatic tries are used up

export type FileOutcome = { kind: "retry"; wait: number | null } | { kind: "final"; code: FinalCode; text: string | null };

export const FILE_PAUSED = "File sending is paused. Try again later";
export const FILE_DAMAGED = "Unable to open this file. It is not valid or was damaged.";

/** Seconds, rounded up -> "N minutes" under 1 hour, "N hours" under 2 days, else "N days" (3599 s -> "1 hour"). */
export function fileWait(s: number): string {
  const plural = (n: number, unit: string) => n + " " + unit + (n === 1 ? "" : "s");
  const m = Math.max(1, Math.ceil(s / 60));
  if (m < 60) return plural(m, "minute");
  const h = Math.ceil(s / 3600);
  return h < 48 ? plural(h, "hour") : plural(Math.ceil(s / 86400), "day");
}

/** retry_after in seconds from the JSON reply, else null. */
export function retryAfter(json: Record<string, unknown>): number | null {
  const ra = json.retry_after;
  return typeof ra === "number" && Number.isInteger(ra) && ra > 0 ? ra : null;
}

/**
 * The status table for POST /v1/file and the file GET. status 0 = no reply.
 * Download only: nowSec is the corrected clock (local + PA-Epoch offset) and expires the file's expires,
 * so a 404 reads "Deleted" before expires and "Expired" at or after it.
 */
export function fileStatus(op: "upload" | "download", status: number, json: Record<string, unknown>, nowSec = 0, expires = 0): FileOutcome {
  const ra = retryAfter(json);
  const final = (code: FinalCode, text: string | null = null): FileOutcome => ({ kind: "final", code, text });
  if (status === 429 && json.error === "file quota") return final("quota", "You reached your file limit. Try again " + (ra ? "in " + fileWait(ra) : "later"));
  if (status === 503 && json.error === "files paused") return final("paused", ra ? "File sending is over quota and paused for " + fileWait(ra) : FILE_PAUSED);
  if (status === 0 || status === 429 || (status >= 500 && status <= 599)) return { kind: "retry", wait: ra };
  if (status === 426) return final("update");
  if (op === "upload") return status === 413 ? final("too_large") : final("failed");
  if (status === 410) return final("expired", "Expired");
  if (status === 404 && json.error === "update required") return final("update", "Update the app");
  if (status === 404) return nowSec < expires ? final("deleted", "Deleted") : final("expired", "Expired");
  return final("failed", "Download failed");
}
