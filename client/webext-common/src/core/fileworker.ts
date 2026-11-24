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

/** The requests a host (offscreen document or background page) runs. */
export type JobReq =
  | { op: "upload"; picked: string }
  | { op: "download"; key: string; ref: FileRef; tries: number; id: number }
  | { op: "decrypt"; key: string; fileKey: string }
  | { op: "forget"; picked: string };

export interface WorkerDeps {
  store: FileStore;
  self(): Promise<SelfKeys | null>;
  file: Omit<FileDeps, "fetch">;
  fetch(input: string, init: RequestInit): Promise<Response>;
  /** Download progress of row id: bytes of the blob stored so far, of total. */
  progress(id: number, have: number, total: number): void;
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

  run(req: JobReq): Promise<UploadOut | DownloadOut | DecryptOut | null> {
    switch (req.op) {
      case "upload":
        return this.upload(req.picked);
      case "download":
        return this.download(req.key, req.ref, req.tries, req.id);
      case "decrypt":
        return this.decrypt(req.key, req.fileKey);
      case "forget":
        this.prior.delete(req.picked);
        return Promise.resolve(null);
    }
  }

  async upload(picked: string): Promise<UploadOut> {
    try {
      const self = await this.d.self();
      if (!self) throw new FileError("failed", null, 401, "logged out");
      const signer = { id: self.id, key: self.sign.privateKey };
      const deps: FileDeps = { ...this.d.file, fetch: (i, init) => this.d.fetch(i, init) };
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
      const deps = {
        ...this.d.file,
        freeBytes,
        fetch: async (i: string, init: RequestInit) => {
          const range = (init.headers as Record<string, string> | undefined)?.Range;
          start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
          return counted(await this.d.fetch(i, init), (n) => this.d.progress(id, start + n, total));
        },
      };
      this.d.progress(id, have, total);
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
export function openWorker(client: string, progress: WorkerDeps["progress"]): () => Promise<FileWorker> {
  let p: Promise<FileWorker> | null = null;
  return () => {
    if (!p) {
      p = (async () => {
        const db = new Db(await openDb());
        const store = await FileStore.open();
        return new FileWorker({
          store,
          self: async () => (await db.self()) ?? null,
          fetch: (i, init) => fetch(i, init),
          progress,
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
