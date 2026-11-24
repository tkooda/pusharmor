// File transfers: POST /v1/file (PA-FILE1, one PA-Send-ID per send, at most 2
// automatic retries, each signed again) and the file GET (Range resume into the
// file store, sha256 of the blob checked right after the last byte).
import { b64urlEncode } from "../crypto/b64url.ts";
import { randomBytes } from "../crypto/bytes.ts";
import { BLOB_OVERHEAD, MAX_FILE } from "../crypto/filecrypt.ts";
import { fileSignedBytes } from "../crypto/pasig.ts";
import { sha256Blob } from "../crypto/sha256.ts";
import { sign } from "../crypto/keys.ts";
import { type FinalCode, FILE_DAMAGED, enoughStorage, fileStatus, storageFullText } from "../model/filerules.ts";
import type { FileStore } from "../store/files.ts";
import { API_BASE } from "./client.ts";

/** An upload and at most 2 automatic retries of the same send. */
export const UPLOAD_TRIES = 3;
/** Automatic download attempts per file. */
export const DOWNLOAD_TRIES = 5;
/** Waits between upload tries when the reply names none. */
const UPLOAD_WAITS_MS = [1000, 3000];
/** No wait between tries is longer than this. */
const MAX_WAIT_MS = 60_000;
/** One file request may take this long before it is aborted. */
export const FILE_TIMEOUT_MS = 30 * 60 * 1000;
/** Download bytes are stored in pieces of about this size. */
const PIECE = 4 * 1024 * 1024;

export class FileError extends Error {
  readonly code: FinalCode;
  /** The text for the row or toast; null where the caller words it. */
  readonly text: string | null;
  /** HTTP status (0 = no reply) and the reply's "error", for a refusal the caller handles (401 logged out, 403 unapproved). */
  readonly status: number;
  readonly error: string;
  constructor(code: FinalCode, text: string | null, status = 0, error = "") {
    super(code + (text ? ": " + text : ""));
    this.code = code;
    this.text = text;
    this.status = status;
    this.error = error;
  }
}

export interface FileDeps {
  /** PA-Client header value, e.g. "chrome/0.0.55". */
  client: string;
  fetch(input: string, init: RequestInit): Promise<Response>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Server clock minus local clock, in whole seconds. */
  getOffset(): Promise<number>;
  setOffset(s: number): Promise<void>;
}

/** A new PA-Send-ID: 22-char b64url of 16 random bytes, one per send, the same on each retry. */
export function newSendId(): string {
  return b64urlEncode(randomBytes(16));
}

/** A file URL: https on a pusharmor.com host, default port, no user name or password. */
export function fileUrlOk(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.endsWith(".pusharmor.com") && u.port === "" && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

/** Headers of a POST /v1/file. Content-Length is listed for the signature; the browser sets it from the body. */
export async function uploadHeaders(
  client: string,
  signer: { id: string; key: CryptoKey },
  paTime: string,
  length: number,
  sha256: string,
  sendId: string,
): Promise<Record<string, string>> {
  const sig = await sign(signer.key, fileSignedBytes("POST", "/v1/file", paTime, { length, sha256, sendId }));
  return {
    "PA-Client": client,
    "PA-ID": signer.id,
    "PA-Time": paTime,
    "Content-Length": String(length),
    "PA-File-SHA256": sha256,
    "PA-Send-ID": sendId,
    "PA-Sig": b64urlEncode(sig),
    "Content-Type": "application/octet-stream",
  };
}

export interface UploadReply {
  id: string;
  expires: number;
  url: string;
  sendId: string;
}

interface Reply {
  status: number;
  json: Record<string, unknown>;
  body: ReadableStream<Uint8Array> | null;
  headers: Headers | null;
  url: string; // after redirects; "" when unknown
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  try {
    const v = JSON.parse((await res.text()).slice(0, 4096)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function request(d: FileDeps, url: string, init: RequestInit, keepBody: boolean, signal: AbortSignal): Promise<Reply> {
  let res: Response;
  try {
    res = await d.fetch(url, { ...init, credentials: "omit", cache: "no-store", signal });
  } catch {
    return { status: 0, json: {}, body: null, headers: null, url: "" };
  }
  const epoch = res.headers.get("PA-Epoch");
  if (epoch && /^[0-9]{1,13}$/.test(epoch)) await d.setOffset(Number(epoch) - Math.floor(d.now() / 1000));
  if (keepBody && (res.status === 200 || res.status === 206)) return { status: res.status, json: {}, body: res.body, headers: res.headers, url: res.url };
  return { status: res.status, json: await jsonOf(res), body: null, headers: res.headers, url: res.url };
}

function waitMs(seconds: number | null, fallback: number): number {
  return Math.min(seconds !== null ? seconds * 1000 : fallback, MAX_WAIT_MS);
}

/**
 * Uploads one blob. prior: the 201 reply of an earlier try of the same send; it is used again (no new
 * upload) while it has not expired by the corrected clock. Throws FileError.
 */
export async function uploadFile(
  d: FileDeps,
  signer: { id: string; key: CryptoKey },
  blob: Blob,
  sha256: string,
  sendId: string,
  prior: UploadReply | null = null,
): Promise<UploadReply> {
  const nowSec = async () => Math.floor(d.now() / 1000) + (await d.getOffset());
  if (prior && prior.sendId === sendId && (await nowSec()) < prior.expires) return prior;
  if (blob.size > MAX_FILE + BLOB_OVERHEAD) throw new FileError("too_large", null, 413);
  let tries = 0;
  let skewed = false;
  for (;;) {
    const t = String(d.now() + (await d.getOffset()) * 1000);
    const headers = await uploadHeaders(d.client, signer, t, blob.size, sha256, sendId);
    delete headers["Content-Length"];
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), FILE_TIMEOUT_MS);
    let r: Reply;
    try {
      r = await request(d, API_BASE + "/v1/file", { method: "POST", headers, body: blob, redirect: "manual" }, false, abort.signal);
    } finally {
      clearTimeout(timer);
    }
    if (r.status === 401 && r.json.error === "clock skew" && !skewed) {
      skewed = true; // signed again with the new offset; not one of the tries
      continue;
    }
    if (r.status >= 200 && r.status < 300) {
      const { id, expires, url } = r.json;
      if (typeof id !== "string" || typeof url !== "string" || !fileUrlOk(url) || typeof expires !== "number" || !Number.isSafeInteger(expires) || expires < 0) {
        throw new FileError("failed", null, r.status);
      }
      return { id, expires, url, sendId };
    }
    const o = fileStatus("upload", r.status, r.json);
    const err = typeof r.json.error === "string" ? r.json.error : "";
    if (o.kind === "final") throw new FileError(o.code, o.text, r.status, err);
    if (++tries >= UPLOAD_TRIES) throw new FileError("failed", null, r.status, err);
    await d.sleep(waitMs(o.wait, UPLOAD_WAITS_MS[tries - 1]!));
  }
}

export interface DownloadDeps extends FileDeps {
  /** Bytes this extension may still store; null = unknown. */
  freeBytes(): Promise<number | null>;
}

/** The file fields a download needs. */
export interface FileRef {
  url: string;
  expires: number;
  name: string; // sanitized
  size: number;
  sha256: string;
}

/**
 * Downloads the blob of f into the store under key, resuming with Range from the bytes already stored.
 * tries: automatic attempts used for this file so far (kept by the caller across calls).
 * Returns the blob once its size and sha256 match; one re-download when they do not. Throws FileError.
 */
export async function downloadFile(d: DownloadDeps, store: FileStore, key: string, f: FileRef, tries: { n: number }): Promise<Blob> {
  try {
    return await download(d, store, key, f, tries);
  } catch (e) {
    if (e instanceof FileError) await store.clear(key); // a final error keeps no partial blob
    throw e;
  }
}

async function download(d: DownloadDeps, store: FileStore, key: string, f: FileRef, tries: { n: number }): Promise<Blob> {
  if (f.size > MAX_FILE) throw new FileError("too_large", null);
  if (!fileUrlOk(f.url)) throw new FileError("damaged", FILE_DAMAGED);
  const want = f.size + BLOB_OVERHEAD;
  if (!enoughStorage(await d.freeBytes(), f.size)) throw new FileError("storage", storageFullText("download", f.name));
  for (let checks = 0; ; checks++) {
    try {
      await fetchBlob(d, store, key, f, want, tries);
      const blob = await store.blob(key);
      if (blob.size === want && (await sha256Blob(blob)) === f.sha256) return blob;
    } catch (e) {
      if (e instanceof DOMException && e.name === "QuotaExceededError") throw new FileError("storage", storageFullText("download", f.name));
      if (!(e instanceof Damaged)) throw e;
    }
    await store.clear(key);
    if (checks >= 1) throw new FileError("damaged", FILE_DAMAGED);
  }
}

class Damaged extends Error {}

async function fetchBlob(d: DownloadDeps, store: FileStore, key: string, f: FileRef, want: number, tries: { n: number }): Promise<void> {
  let have = await store.size(key);
  if (have > want) {
    await store.clear(key);
    have = 0;
  }
  while (have < want) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), FILE_TIMEOUT_MS);
    let status: number;
    let json: Record<string, unknown> = {};
    try {
      const init: RequestInit = { method: "GET", redirect: "follow" };
      if (have) init.headers = { Range: "bytes=" + have + "-" };
      const r = await request(d, f.url, init, true, abort.signal);
      status = r.status;
      json = r.json;
      if (r.url && !fileUrlOk(r.url)) {
        await r.body?.cancel().catch(() => undefined);
        throw new FileError("damaged", FILE_DAMAGED, status); // redirected off the file hosts
      }
      if (status === 416) throw new Damaged(); // the stored part is longer than the object
      if (r.body && status === 206 && !(r.headers?.get("Content-Range") ?? "").startsWith("bytes " + have + "-")) {
        await r.body.cancel().catch(() => undefined);
        await store.clear(key); // not the asked range: start again
        have = 0;
        status = 0;
      } else if (r.body) {
        if (status === 200 && have) {
          await store.clear(key);
          have = 0;
        }
        const got = await readInto(store, key, r.body, have, want);
        have = got.have;
        if (have > want || (got.ended && have < want)) throw new Damaged(); // too long, or a whole reply that is too short
        if (have === want) return;
        status = 0; // cut off: resume
      }
    } finally {
      clearTimeout(timer);
    }
    const nowSec = Math.floor(d.now() / 1000) + (await d.getOffset());
    const o = fileStatus("download", status, json, nowSec, f.expires);
    if (o.kind === "final") throw new FileError(o.code, o.text, status, typeof json.error === "string" ? json.error : "");
    if (++tries.n >= DOWNLOAD_TRIES) throw new FileError("failed", "Download failed", status);
    await d.sleep(waitMs(o.wait, 1000 * 2 ** tries.n));
  }
}

/** Reads body into the store in pieces; a cut-off body keeps what arrived. -> bytes stored, and ended: the body ended normally. */
async function readInto(store: FileStore, key: string, body: ReadableStream<Uint8Array>, have: number, want: number): Promise<{ have: number; ended: boolean }> {
  const reader = body.getReader();
  let parts: Uint8Array[] = [];
  let held = 0;
  let ended = false;
  const flush = async () => {
    if (!held) return;
    const b = new Blob(parts as BlobPart[]);
    parts = [];
    have += held;
    held = 0;
    await store.append(key, b);
  };
  try {
    for (;;) {
      let r: ReadableStreamReadResult<Uint8Array>;
      try {
        r = await reader.read();
      } catch {
        break; // cut off
      }
      if (r.done) {
        ended = true;
        break;
      }
      parts.push(r.value);
      held += r.value.length;
      if (have + held > want) break;
      if (held >= PIECE) await flush();
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  await flush();
  return { have, ended };
}
