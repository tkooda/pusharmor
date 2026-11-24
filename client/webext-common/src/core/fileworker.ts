// File transfers and decrypts, run outside the popup: in the Chrome offscreen
// document and in the Firefox background page. Upload: the picked file is read,
// sealed, and uploaded. Download: the blob goes into the file store (Range
// resume). Decrypt: the stored blob is opened and the plaintext stored.
import { type FileDeps, FileError, type FileRef, type UploadReply, downloadFile, newSendId, uploadFile } from "../api/file.ts";
import { b64urlDecode, b64urlEncode } from "../crypto/b64url.ts";
import { newFileKey, openFile, sealFile } from "../crypto/filecrypt.ts";
import { sha256Blob } from "../crypto/sha256.ts";
import type { FinalCode } from "../model/filerules.ts";
import { sniffImage } from "../model/filerow.ts";
import { Db, type SelfKeys, openDb } from "../store/db.ts";
import { FileStore, freeBytes } from "../store/files.ts";

/** What a file job tells its caller. */
export type JobError = { code: FinalCode; text: string | null; status: number; error: string };
export type UploadOut = { ok: true; url: string; expires: number; key: string; sha256: string } | { ok: false; err: JobError };
export type DownloadOut = { ok: true; tries: number } | { ok: false; tries: number; err: JobError };
export type DecryptOut = { result: "ok"; image: boolean } | { result: "damaged" | "memory" | "missing" | "storage" };
/** A save: Chrome gets a blob URL that this page keeps (the popup's download link uses it); Firefox gets the saved path (null: cancelled). */
export type SaveOut = { url: string } | { path: string | null } | { missing: true };

/** The requests a host (offscreen document or background page) runs. */
export type JobReq =
  | { op: "upload"; picked: string }
  | { op: "download"; key: string; ref: FileRef; tries: number; id: number }
  | { op: "decrypt"; key: string; fileKey: string }
  | { op: "forget"; picked: string }
  | { op: "save"; key: string; name: string };

export interface WorkerDeps {
  store: FileStore;
  self(): Promise<SelfKeys | null>;
  file: Omit<FileDeps, "fetch">;
  /** sent: an upload, told the bytes of the body sent so far. */
  fetch(input: string, init: RequestInit, sent?: (n: number) => void): Promise<Response>;
  /** Download progress of row id (a number), or upload progress of a picked key (a string): bytes so far, of total. */
  progress(id: number | string, have: number, total: number): void;
  /** Saves the bytes as application/octet-stream under name (see SaveOut); the blob URL lives in this page, not in the popup. */
  save(blob: Blob, name: string): Promise<SaveOut>;
}

function jobError(e: unknown): JobError {
  if (e instanceof FileError) return { code: e.code, text: e.text, status: e.status, error: e.error };
  if (e instanceof DOMException && e.name === "QuotaExceededError") return { code: "storage", text: null, status: 0, error: "" };
  return { code: "failed", text: null, status: 0, error: "" };
}

/** A body that reports each piece read. */
function counted(res: Response, on: (n: number) => void): Response {
  if (!res.body) return res;
  let n = 0;
  const t = new TransformStream<Uint8Array, Uint8Array>({
    transform(c, ctl) {
      n += c.length;
      on(n);
      ctl.enqueue(c);
    },
  });
  const out = new Response(res.body.pipeThrough(t), { status: res.status, statusText: res.statusText, headers: res.headers });
  Object.defineProperty(out, "url", { value: res.url });
  return out;
}

export class FileWorker {
  private readonly d: WorkerDeps;
  /** The 201 of an upload whose file message was not sent yet, by picked key: a new try uses it again while it has not expired. */
  private readonly prior = new Map<string, { reply: UploadReply; key: string; sha256: string }>();
  constructor(d: WorkerDeps) {
    this.d = d;
  }

  /** Downloads and decrypts running now, by store key: a second request for a key (a restarted service worker) joins the first. */
  private readonly running = new Map<string, Promise<DownloadOut | DecryptOut>>();

  run(req: JobReq): Promise<UploadOut | DownloadOut | DecryptOut | SaveOut | { ok: true }> {
    switch (req.op) {
      case "upload":
        return this.upload(req.picked);
      case "download":
        return this.once(req.key, () => this.download(req.key, req.ref, req.tries, req.id));
      case "decrypt":
        return this.once(req.key, () => this.decrypt(req.key, req.fileKey));
      case "forget":
        this.prior.delete(req.picked);
        return Promise.resolve({ ok: true });
      case "save":
        return this.saveFile(req.key, req.name);
    }
  }

  /** true while a download or decrypt of a key runs here. */
  busy(): boolean {
    return this.running.size > 0;
  }

  private once<T extends DownloadOut | DecryptOut>(key: string, job: () => Promise<T>): Promise<T> {
    const cur = this.running.get(key);
    if (cur) return cur as Promise<T>;
    const p = job().finally(() => this.running.delete(key));
    this.running.set(key, p);
    return p;
  }

  async saveFile(key: string, name: string): Promise<SaveOut> {
    const blob = await this.d.store.plain(key);
    return blob ? this.d.save(blob, name) : { missing: true };
  }

  async upload(picked: string): Promise<UploadOut> {
    try {
      const self = await this.d.self();
      if (!self) throw new FileError("failed", null, 401, "logged out");
      const signer = { id: self.id, key: self.sign.privateKey };
      let sent: ((n: number) => void) | undefined;
      const deps: FileDeps = { ...this.d.file, fetch: (i, init) => this.d.fetch(i, init, sent) };
      const p = this.prior.get(picked);
      if (p && Math.floor(deps.now() / 1000) + (await deps.getOffset()) < p.reply.expires) return { ok: true, url: p.reply.url, expires: p.reply.expires, key: p.key, sha256: p.sha256 };
      const file = await this.d.store.picked(picked);
      if (!file) throw new FileError("failed", null, 0, "unreadable");
      let bytes: ArrayBuffer;
      try {
        bytes = await file.arrayBuffer();
      } catch {
        throw new FileError("failed", null, 0, "unreadable"); // the file changed or went since it was picked
      }
      const key = newFileKey();
      const blob = await sealFile(key, new Uint8Array(bytes));
      const sha256 = await sha256Blob(blob);
      let shown = -1;
      // progress goes out at each whole percent, not at each piece sent
      sent = (n) => {
        const pct = Math.floor((n * 100) / blob.size);
        if (pct === shown) return;
        shown = pct;
        this.d.progress(picked, n, blob.size);
      };
      sent(0); // the upload starts: the Send bar shows at once
      const reply = await uploadFile(deps, signer, blob, sha256, newSendId());
      const k = b64urlEncode(key);
      this.prior.set(picked, { reply, key: k, sha256 });
      return { ok: true, url: reply.url, expires: reply.expires, key: k, sha256 };
    } catch (e) {
      return { ok: false, err: jobError(e) };
    }
  }

  async download(key: string, ref: FileRef, tries: number, id: number): Promise<DownloadOut> {
    const t = { n: tries };
    const total = ref.size + 28;
    try {
      const have = await this.d.store.size(key);
      let start = have;
      let shown = -1;
      // progress goes out at each whole percent, not at each piece read
      const tell = (n: number) => {
        const pct = Math.floor((n * 100) / total);
        if (pct === shown) return;
        shown = pct;
        this.d.progress(id, n, total);
      };
      const deps = {
        ...this.d.file,
        freeBytes,
        fetch: async (i: string, init: RequestInit) => {
          const range = (init.headers as Record<string, string> | undefined)?.Range;
          start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
          return counted(await this.d.fetch(i, init), (n) => tell(start + n));
        },
      };
      tell(have);
      await downloadFile(deps, this.d.store, key, ref, t);
      return { ok: true, tries: t.n };
    } catch (e) {
      return { ok: false, tries: t.n, err: jobError(e) };
    }
  }

  /** Opens the stored blob; out of memory (RangeError, or any other Web Crypto rejection) is "memory". */
  async decrypt(key: string, fileKey: string): Promise<DecryptOut> {
    let plain: Uint8Array | null;
    try {
      const blob = await this.d.store.blob(key);
      if (!blob.size) return { result: "missing" };
      plain = await openFile(b64urlDecode(fileKey), new Uint8Array(await blob.arrayBuffer()));
    } catch {
      return { result: "memory" };
    }
    if (!plain) {
      await this.d.store.clear(key);
      return { result: "damaged" };
    }
    const image = sniffImage(plain.subarray(0, 32)) !== null;
    try {
      await this.d.store.putPlain(key, new Blob([plain as Uint8Array<ArrayBuffer>]));
    } catch (e) {
      return { result: e instanceof DOMException && e.name === "QuotaExceededError" ? "storage" : "memory" };
    }
    await this.d.store.clear(key);
    return { result: "ok", image };
  }
}

/**
 * The worker of a host page: its own connections to the database (keys, clock offset) and the file store.
 * client: the PA-Client value. A failed open is tried again by the next call.
 */
export function openWorker(client: string, progress: WorkerDeps["progress"], save: WorkerDeps["save"]): () => Promise<FileWorker> {
  let p: Promise<FileWorker> | null = null;
  return () => {
    if (!p) {
      p = (async () => {
        const db = new Db(await openDb());
        const store = await FileStore.open();
        return new FileWorker({
          store,
          self: async () => (await db.self()) ?? null,
          fetch: (i, init, sent) => (sent ? sendCounted(i, init, sent) : fetch(i, init)),
          progress,
          save,
          file: {
            client,
            now: () => Date.now(),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            getOffset: async () => (await db.meta<number>("offset_s")) ?? 0,
            setOffset: (o) => db.setMeta("offset_s", o),
          },
        });
      })();
      p.catch(() => (p = null));
    }
    return p;
  };
}

/** fetch for an upload that tells the bytes sent so far (fetch cannot): XMLHttpRequest upload progress. */
function sendCounted(url: string, init: RequestInit, sent: (n: number) => void): Promise<Response> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(init.method ?? "GET", url);
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) x.setRequestHeader(k, v);
    x.responseType = "arraybuffer";
    x.upload.onprogress = (ev) => sent(ev.loaded);
    x.onload = () => {
      try {
        // a redirect fails, as fetch with redirect "manual" does
        if (x.responseURL !== new URL(url).href) throw new TypeError("redirected");
        const headers = new Headers();
        for (const line of x.getAllResponseHeaders().split("\r\n")) {
          const i = line.indexOf(":");
          if (i > 0) headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
        }
        const empty = [101, 204, 205, 304].includes(x.status);
        resolve(new Response(empty ? null : (x.response as ArrayBuffer), { status: x.status, statusText: x.statusText, headers }));
      } catch (e) {
        reject(e);
      }
    };
    x.onerror = x.ontimeout = () => reject(new TypeError("network error"));
    x.onabort = () => reject(new DOMException("aborted", "AbortError"));
    init.signal?.addEventListener("abort", () => x.abort());
    x.send(init.body as XMLHttpRequestBodyInit);
  });
}

/** The octet-stream copy of a file for a download link (never shown or run, only saved). */
export function octetUrl(blob: Blob): string {
  return URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" }));
}
