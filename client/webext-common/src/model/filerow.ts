// What a file row and the file settings show and decide: pure functions only, so
// the tables are unit tested. The words match the Android app.
import { BLOB_OVERHEAD, MAX_FILE } from "../crypto/filecrypt.ts";
import type { FinalCode } from "./filerules.ts";
import { PICKER_SIZES, DEFAULT_PICKER } from "./filerules.ts";
import { sanitizeName, splitExt } from "./filename.ts";

export const HELPER = "Larger files expire sooner, between 1 and 24 hours after they are sent";
export const AUTO_TITLE = "Download automatically";
export const STORAGE_TITLE = "Storage for received files";
export const STORAGE_HELPER = "When full, the oldest files are removed from this device";
export const REMOVED = "Removed from this device";
export const NO_MEMORY = "Not enough memory to decrypt";
export const PREVIEW_NA = "Preview not available";
export const CHOOSE_FILE = "Choose file...";
export const PAGE_URL = "Page URL";
export const REMOVE_FILE = "Remove file";
export const WILL_SEND_FILE = "Will be sent as file";
export const EXPIRED = "Expired";
export const DOWNLOAD_FAILED = "Download failed";
export const PLACEHOLDER = "Type or paste a URL or text, or drop a file here";
/** A pasted, dropped, or chosen file while the message box holds text: one type per message. */
export const PASTE_IMAGE_CLEAR = "Clear the message to add a file";

export const noMemoryToast = (name: string): string => 'Not enough memory to decrypt "' + name + '"';
export const tooLarge = (name: string): string => '"' + name + '" is too large to send';
export const unreadable = (name: string): string => 'Unable to read "' + name + '"';
export const saved = (name: string): string => 'Saved "' + name + '"';

// ---- auto-download picker ----

export function pickerLabel(bytes: number): string {
  return bytes <= 0 ? "Off" : "Up to " + bytes / 1_000_000 + " MB";
}

/** A saved picker value that is not one of the choices reads as the default. */
export function pickerValue(saved: unknown): number {
  return typeof saved === "number" && PICKER_SIZES.includes(saved) ? saved : DEFAULT_PICKER;
}

// ---- storage limit ----

export const STORAGE_SIZES: readonly number[] = [100_000_000, 500_000_000, 1_000_000_000, 5_000_000_000];
export const DEFAULT_STORAGE = 500_000_000;

export function storageLabel(bytes: number): string {
  return bytes >= 1_000_000_000 ? bytes / 1_000_000_000 + " GB" : bytes / 1_000_000 + " MB";
}

/** Choices that fit the browser's storage quota (null = unknown: all); the smallest always shows. */
export function storageOptions(quota: number | null): number[] {
  const o = STORAGE_SIZES.filter((s) => quota === null || s <= quota);
  return o.length ? o : [STORAGE_SIZES[0]!];
}

/** The limit in force: the saved choice (default 500 MB), else the largest choice that fits. */
export function storageLimit(saved: unknown, quota: number | null): number {
  const o = storageOptions(quota);
  const s = typeof saved === "number" ? saved : DEFAULT_STORAGE;
  if (o.includes(s)) return s;
  return [...o].reverse().find((x) => x <= s) ?? o[0]!;
}

/** One stored file: its key, its row time, and the bytes it holds here. */
export interface Stored {
  key: string;
  at: number;
  bytes: number;
}

/** Keys to remove, oldest first, until the rest fit limit; the newest file always stays. */
export function toRemove(files: Stored[], limit: number): string[] {
  const byAge = files.filter((f) => f.bytes > 0).sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  let total = byAge.reduce((s, f) => s + f.bytes, 0);
  const out: string[] = [];
  for (const f of byAge.slice(0, -1)) {
    if (total <= limit) break;
    out.push(f.key);
    total -= f.bytes;
  }
  return out;
}

// ---- row text ----

/** "512 bytes", "840 KB", "2.1 MB" (decimal units). */
export function sizeText(bytes: number): string {
  if (bytes < 1000) return bytes + " bytes";
  if (bytes < 1_000_000) {
    const k = Math.floor((bytes + 500) / 1000);
    return k === 1000 ? "1.0 MB" : k + " KB";
  }
  const t = Math.floor((bytes + 50_000) / 100_000);
  return Math.floor(t / 10) + "." + (t % 10) + " MB";
}

/** "expires in 23 h", "expires in 40 min"; "Expired" at or after expires (local clock). */
export function expiresText(expires: number, nowSec: number): string {
  const left = expires - nowSec;
  if (left <= 0) return EXPIRED;
  return left < 3600 ? "expires in " + Math.floor((left + 59) / 60) + " min" : "expires in " + Math.floor((left + 1799) / 3600) + " h";
}

export type Kind = "image" | "pdf" | "text" | "code" | "audio" | "video" | "archive" | "other";

const KINDS: [Kind, string[]][] = [
  ["image", ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "avif", "bmp"]],
  ["pdf", ["pdf"]],
  ["text", ["txt", "md", "csv", "log"]],
  ["code", ["html", "htm", "json", "js", "xml", "css", "svg"]],
  ["audio", ["mp3", "m4a", "wav", "ogg", "opus", "flac", "aac"]],
  ["video", ["mp4", "mov", "webm", "mkv", "3gp", "m4v"]],
  ["archive", ["zip", "7z", "tar", "gz", "tgz", "rar", "bz2", "xz"]],
];

/** Lowercase extension without the dot, or "". */
export function ext(name: string): string {
  return splitExt(name)[1].slice(1).toLowerCase();
}

/** The icon kind, from the extension only (never trusted for View). */
export function kind(name: string): Kind {
  const e = ext(name);
  return KINDS.find(([, l]) => l.includes(e))?.[0] ?? "other";
}

/** "JPEG image", "PDF", "Text", "M4A audio", "MP4 video", "ZIP archive", "DWG file", "File". */
export function typeLabel(name: string): string {
  const e = ext(name);
  if (!e) return "File";
  const up = e === "jpg" ? "JPEG" : e.toUpperCase();
  switch (kind(name)) {
    case "image":
      return up + " image";
    case "pdf":
      return "PDF";
    case "text":
      return "Text";
    case "audio":
      return up + " audio";
    case "video":
      return up + " video";
    case "archive":
      return up + " archive";
    default:
      return up + " file";
  }
}

/** The second line of a file row: "2.1 MB - PDF". */
export function detail(name: string, size: number): string {
  return sizeText(size) + " - " + typeLabel(name);
}

/** The name a receiver shows and saves under: the file name rule, with its receive time for a fallback name. */
export function receivedName(sent: string, atMs: number): string {
  return sanitizeName(sent, Math.floor(atMs / 1000), kind(sent) === "image");
}

// ---- images ----

/** The raster image type of the first bytes, or null. Only these show in View (an <img> from a blob). */
export function sniffImage(b: Uint8Array): "png" | "jpg" | "gif" | "webp" | "avif" | "bmp" | null {
  const at = (i: number, s: string) => [...s].every((c, j) => b[i + j] === c.charCodeAt(0));
  if (b.length >= 8 && b[0] === 0x89 && at(1, "PNG\r\n\x1a\n")) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (at(0, "GIF87a") || at(0, "GIF89a")) return "gif";
  if (b.length >= 12 && at(0, "RIFF") && at(8, "WEBP")) return "webp";
  if (b.length >= 12 && at(4, "ftyp") && (at(8, "avif") || at(8, "avis"))) return "avif";
  if (b.length >= 2 && at(0, "BM")) return "bmp";
  return null;
}

/** heic and heif are named from their bytes but never shown. */
function sniffHeic(b: Uint8Array): boolean {
  const s = String.fromCharCode(...b.subarray(4, 12));
  return /^ftyp(heic|heix|hevc|mif1|msf1)/.test(s);
}

const MIME_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/heic": "heic", "image/heif": "heif", "image/bmp": "bmp" };

/**
 * The name of an image taken from a web page: the last URL path segment (decoded, no query), cleaned by
 * the name rule; the extension from the bytes, else the Content-Type (or data: MIME), replacing one that
 * disagrees. nowSec: the send time, for a fallback name.
 */
export function webImageName(url: string, head: Uint8Array, contentType: string, nowSec: number): string {
  let seg = "";
  try {
    const u = new URL(url);
    if (u.protocol === "data:") contentType = contentType || u.pathname.split(/[;,]/)[0]!;
    else seg = decodeURIComponent(u.pathname.split("/").pop() ?? "");
  } catch {
    seg = "";
  }
  const sniffed = sniffImage(head) ?? (sniffHeic(head) ? "heic" : null);
  const e = sniffed ?? MIME_EXT[contentType.split(";")[0]!.trim().toLowerCase()] ?? "";
  if (!e) return sanitizeName(seg, nowSec, true);
  const [base, old] = splitExt(seg);
  const same = old.slice(1).toLowerCase() === e || (e === "jpg" && old.toLowerCase() === ".jpeg");
  // no name left (a data: URL): "_" makes the name rule give the fallback name
  return sanitizeName(same ? seg : (base || "_") + "." + e, nowSec, true);
}

// ---- row state ----

/** The download and decrypt state of a received file, kept on its History row. */
export interface FileState {
  /** A final error of the last download: its code and the row text. */
  code?: FinalCode;
  text?: string | null;
  /** Automatic download attempts used. */
  tries?: number;
  /** The blob is stored and its size and sha256 match. */
  got?: boolean;
  /** The decrypted file was stored (it may have been removed for space since). */
  plain?: boolean;
  /** A decrypt started and did not end yet: found later, the decrypt closed the browser's process. */
  mark?: boolean;
  /** Not enough memory to decrypt: never tried again by itself. */
  mem?: boolean;
  /** The decrypted file is a raster image (sniffed). */
  image?: boolean;
}

export type FileStatus =
  | { k: "pending"; expires: string }
  | { k: "downloading"; pct: number }
  | { k: "decrypting" }
  | { k: "failed"; text: string; download: boolean; expires: string | null; grey?: true }
  | { k: "memory" }
  /** Downloaded, but the decrypt failed (not enough storage, or it could not run): the text and a Decrypt button. */
  | { k: "undecrypted"; text: string }
  | { k: "expired" }
  | { k: "ready" };

/**
 * What a received file row shows. running: a download of it runs now (pct done); plainThere: the
 * decrypted file is on this device. A tap on Download is offered while no final error says otherwise.
 */
export function fileRowStatus(s: FileState, running: boolean, pct: number, plainThere: boolean, expires: number, nowSec: number): FileStatus {
  const exp = expiresText(expires, nowSec);
  const gone = nowSec >= expires;
  if (s.plain && plainThere) return { k: "ready" };
  if (running) return { k: "downloading", pct: Math.max(0, Math.min(99, Math.floor(pct))) };
  if (s.plain) return { k: "failed", text: REMOVED, download: !gone, expires: gone ? null : exp, grey: true };
  if (s.mem) return { k: "memory" };
  // the blob is here: past expires too, the next step is Decrypt, never Download
  if (s.got) return s.code ? { k: "undecrypted", text: s.text || DOWNLOAD_FAILED } : { k: "decrypting" };
  switch (s.code) {
    case undefined:
      break;
    case "expired":
      return { k: "expired" };
    case "deleted":
    case "update":
    case "damaged":
      return { k: "failed", text: s.text || DOWNLOAD_FAILED, download: false, expires: null };
    default:
      return gone ? { k: "failed", text: s.text || DOWNLOAD_FAILED, download: false, expires: null } : { k: "failed", text: s.text || DOWNLOAD_FAILED, download: true, expires: exp };
  }
  if (gone) return { k: "expired" };
  return { k: "pending", expires: exp };
}

/** The buttons of a decrypted file: an image has View, Copy (where the clipboard takes images), and Save; any other file Save. */
export function fileActions(s: FileState, canCopyImage: boolean): ("view" | "copy" | "save")[] {
  if (!s.image) return ["save"];
  return canCopyImage ? ["view", "copy", "save"] : ["view", "save"];
}

/** "Preview not available": the name says image but the bytes are not one this browser shows. */
export function previewMissing(name: string, s: FileState): boolean {
  return !!s.plain && !s.image && kind(name) === "image";
}

/**
 * The decrypt step while History shows. inFlight: rows whose decrypt runs now. A marked row not in
 * flight closed the process: it gets the memory error and is never tried by itself again.
 * force: the Decrypt button of that row (skips the memory error, still marks).
 */
export function decryptPlan(rows: { id: number; fs: FileState }[], inFlight: Set<number>, force: number | null = null): { decrypt: number[]; memory: number[] } {
  const decrypt: number[] = [];
  const memory: number[] = [];
  for (const r of rows) {
    if (inFlight.has(r.id) || !r.fs.got || r.fs.plain) continue;
    if (r.id === force) decrypt.push(r.id);
    else if (r.fs.mark) memory.push(r.id);
    else if (!r.fs.mem && !r.fs.code) decrypt.push(r.id); // a final error waits for the Decrypt button
  }
  return { decrypt, memory };
}

/** A picked file the Send view can take: null when it fits, else the toast. */
export function pickCheck(name: string, size: number): string | null {
  return size > MAX_FILE ? tooLarge(name) : null;
}

/** Blob bytes of a file of plaintext size. */
export const blobSize = (size: number): number => size + BLOB_OVERHEAD;
