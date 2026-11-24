// Files on the background side (Chrome service worker, Firefox background page):
// the file send, auto-download and catch-up, the decrypt while History shows,
// the storage limit, and the local bytes. Transfers and decrypts run in the host
// (core/fileworker.ts); this side keeps the History rows.
import { DOWNLOAD_TRIES } from "../api/file.ts";
import { MAX_FILE } from "../crypto/filecrypt.ts";
import { BUSY, STEP } from "../model/busy.ts";
import { FILE_DAMAGED, catchUpDue, storageFullText } from "../model/filerules.ts";
import { DOWNLOAD_FAILED, type FileState, decryptPlan, kind, storageLimit, storageOptions, toRemove, tooLarge, unreadable } from "../model/filerow.ts";
import { sanitizeName } from "../model/filename.ts";
import type { FileValue } from "../model/message.ts";
import type { HistoryRow } from "../store/db.ts";
import type { FileStore } from "../store/files.ts";
import type { Engine, FilesHook, SendResult } from "./engine.ts";
import type { DecryptOut, DownloadOut, JobError, JobReq, UploadOut } from "./fileworker.ts";
import { ReasonError } from "./failtext.ts";
import { R, actionLine } from "./texts.ts";

/** Runs a job where transfers run; rejects when that place went away (its process closed). */
export interface FileHost {
  run(req: JobReq): Promise<unknown>;
}

/** Told to open views: a file row changed (pct: download progress). */
export interface FileEvent {
  op: "fileEvent";
  id: number;
  pct?: number;
}

/** The store key of a row's bytes. */
export const fileKey = (id: number): string => "f" + id;

/** The error text of a failed upload. */
export function sendFileError(err: JobError, name: string): string {
  if (err.code === "storage") return storageFullText("upload", name);
  if (err.code === "too_large") return tooLarge(name);
  if (err.error === "unreadable") return unreadable(name);
  const why =
    err.text ??
    (err.code === "update"
      ? R.tooOld
      : err.status === 401 && err.error === "logged out"
        ? R.loggedOut
        : err.status === 0
          ? R.unreachable
          : err.status >= 500
            ? R.serverDown
            : R.refused);
  return actionLine("send") + "\n" + why;
}

export class Files implements FilesHook {
  private readonly e: Engine;
  private readonly host: FileHost;
  private readonly store: () => Promise<FileStore>;
  private readonly tell: (m: FileEvent) => void;
  /** Downloads running now: row id -> percent. */
  readonly running = new Map<number, number>();
  private readonly decrypting = new Set<number>();
  /** Free-storage quota of this browser, for the storage choices; null = unknown. */
  quota: () => Promise<number | null> = async () => {
    try {
      const q = (await navigator.storage.estimate()).quota;
      return typeof q === "number" ? q : null;
    } catch {
      return null;
    }
  };

  constructor(e: Engine, host: FileHost, store: () => Promise<FileStore>, tell: (m: FileEvent) => void) {
    this.e = e;
    this.host = host;
    this.store = store;
    this.tell = tell;
  }

  private nowSec(): number {
    return Math.floor(this.e.p.now() / 1000);
  }

  private async fileRows(): Promise<(HistoryRow & { id: number; file: FileValue })[]> {
    return (await this.e.db.history()).filter((r): r is HistoryRow & { id: number; file: FileValue } => r.type === "file" && r.dir === "in" && !!r.file && r.id !== undefined);
  }

  /** Changes the file state of a row (read, change, write); null when the row is gone. */
  private async setFs(id: number, f: (s: FileState) => FileState): Promise<HistoryRow | null> {
    const r = await this.e.db.get<HistoryRow>("history", id);
    if (!r || r.type !== "file") return null;
    const next = { ...r, fs: f({ ...(r.fs ?? {}) }) };
    await this.e.db.put("history", next);
    return next;
  }

  // ---- send ----

  /**
   * Sends the picked file (stored under picked by the Send view): sealed and uploaded where transfers
   * run, then the file message goes to each device as a message does. The picked file is dropped once
   * a device got it.
   */
  async send(picked: string, name: string, size: number, targets: string[] | "all", shown?: string[]): Promise<SendResult> {
    const self = await this.e.self();
    if (!self) throw new ReasonError(R.loggedOut);
    const clean = sanitizeName(name, this.nowSec(), kind(name) === "image");
    if (size > MAX_FILE) return { sent: 0, total: 0, failures: [], error: tooLarge(clean) };
    const to = await this.e.sendTargets(targets, shown);
    if (to.ids.length === 0) return to.none;
    const names = await Promise.all(to.ids.map((id) => this.e.peerName(id)));
    await this.e.p.storageSession.set({ [BUSY]: { cap: STEP.encryptingFor(names), done: 1, total: 4 } });
    let out: UploadOut;
    try {
      out = (await this.host.run({ op: "upload", picked })) as UploadOut;
    } catch {
      out = { ok: false, err: { code: "failed", text: null, status: 0, error: "" } };
    }
    if (!out.ok) {
      await this.e.step(null);
      return { sent: 0, total: to.ids.length + to.skipped.length, all: to.all.length, failures: [], error: sendFileError(out.err, clean) };
    }
    const value: FileValue = { url: out.url, expires: out.expires, key: out.key, name: clean, size, sha256: out.sha256 };
    const r = await this.e.deliver(self, to, { type: "file", value }, { type: "file", content: clean, file: value });
    if (r.sent > 0) {
      await (await this.store()).deletePicked(picked).catch(() => undefined);
      await this.host.run({ op: "forget", picked }).catch(() => undefined);
    }
    return r;
  }

  // ---- download ----

  async received(rowId: number): Promise<void> {
    const r = await this.e.db.get<HistoryRow>("history", rowId);
    if (!r?.file) return;
    if (catchUpDue(r.file, (await this.e.settings()).fileAuto, this.nowSec())) void this.download(rowId, true);
  }

  /** Catch-up (popup open, open from a notification, back online): every waiting file the picker allows. */
  async catchUp(): Promise<void> {
    const picker = (await this.e.settings()).fileAuto;
    for (const r of await this.fileRows()) {
      const s = r.fs ?? {};
      if (s.got || s.plain || s.code || s.mem || (s.tries ?? 0) >= DOWNLOAD_TRIES || this.running.has(r.id)) continue;
      if (catchUpDue(r.file, picker, this.nowSec())) void this.download(r.id, true);
    }
  }

  /** Downloads a row's blob. auto: started by itself (counts toward the automatic tries); else the Download button. */
  async download(id: number, auto: boolean): Promise<void> {
    if (this.running.has(id)) return;
    const r = await this.e.db.get<HistoryRow>("history", id);
    if (!r?.file || r.dir !== "in") return;
    const s = r.fs ?? {};
    if (auto && (s.tries ?? 0) >= DOWNLOAD_TRIES) return;
    this.running.set(id, 0);
    this.tell({ op: "fileEvent", id, pct: 0 });
    if (!auto) await this.setFs(id, ({ code: _c, text: _t, plain: _p, ...rest }) => rest);
    const f = r.file;
    let out: DownloadOut;
    try {
      out = (await this.host.run({ op: "download", key: fileKey(id), ref: { url: f.url, expires: f.expires, name: f.name, size: f.size, sha256: f.sha256 }, tries: auto ? s.tries ?? 0 : 0, id })) as DownloadOut;
    } catch {
      out = { ok: false, tries: (s.tries ?? 0) + 1, err: { code: "failed", text: DOWNLOAD_FAILED, status: 0, error: "" } };
    }
    this.running.delete(id);
    await this.setFs(id, (x) => {
      const n: FileState = { ...x, tries: auto ? out.tries : x.tries ?? 0 };
      if (out.ok) return { ...n, got: true };
      const text = out.err.text ?? (out.err.code === "storage" ? storageFullText("download", f.name) : DOWNLOAD_FAILED);
      return { ...n, got: false, code: out.err.code, text };
    });
    this.tell({ op: "fileEvent", id });
  }

  /** Download progress from the host; open views are told at each whole percent. */
  progress(id: number, have: number, total: number): void {
    if (!this.running.has(id)) return;
    const pct = total > 0 ? Math.floor((have * 100) / total) : 0;
    if (pct === this.running.get(id)) return;
    this.running.set(id, pct);
    this.tell({ op: "fileEvent", id, pct });
  }

  // ---- decrypt (only while History shows) ----

  /**
   * Decrypts every downloaded file, one at a time; force: the Decrypt button of that row.
   * -> the names of the files that ran short of memory (the popup shows a toast for each).
   */
  async decryptShown(force: number | null = null): Promise<string[]> {
    const rows = await this.fileRows();
    const plan = decryptPlan(rows.map((r) => ({ id: r.id, fs: r.fs ?? {} })), this.decrypting, force);
    const short: string[] = [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of plan.memory) {
      await this.setFs(id, (x) => ({ ...x, mark: false, mem: true }));
      short.push(byId.get(id)!.file.name);
    }
    for (const id of plan.decrypt) {
      const r = byId.get(id)!;
      // the mark is written first: a decrypt that closes the process leaves it for the next look
      await this.setFs(id, (x) => ({ ...x, mark: true, mem: false }));
      this.decrypting.add(id);
      this.tell({ op: "fileEvent", id });
      let out: DecryptOut;
      try {
        out = (await this.host.run({ op: "decrypt", key: fileKey(id), fileKey: r.file.key })) as DecryptOut;
      } catch {
        out = { result: "memory" };
      }
      this.decrypting.delete(id);
      await this.setFs(id, (x) => {
        const n: FileState = { ...x, mark: false };
        switch (out.result) {
          case "ok":
            return { ...n, got: false, plain: true, image: out.image };
          case "damaged":
            return { ...n, got: false, code: "damaged", text: FILE_DAMAGED };
          case "missing":
            return { ...n, got: false };
          case "storage":
            return { ...n, code: "storage", text: storageFullText("download", r.file.name) };
          default:
            return { ...n, mem: true };
        }
      });
      if (out.result === "memory") short.push(r.file.name);
      if (out.result === "ok") await this.evict().catch(() => undefined);
      this.tell({ op: "fileEvent", id });
    }
    return short;
  }

  // ---- local bytes ----

  async storageInfo(): Promise<{ options: number[]; limit: number }> {
    const q = await this.quota();
    return { options: storageOptions(q), limit: storageLimit((await this.e.settings()).fileStorage, q) };
  }

  /** Removes the oldest decrypted files until the rest fit the storage limit; their rows say "Removed from this device". */
  async evict(): Promise<void> {
    const store = await this.store();
    const sizes = await store.plainSizes();
    const at = new Map((await this.fileRows()).map((r) => [fileKey(r.id), r.received]));
    const files = [...sizes].map(([key, bytes]) => ({ key, at: at.get(key) ?? 0, bytes }));
    const limit = (await this.storageInfo()).limit;
    for (const k of toRemove(files, limit)) await store.remove(k);
  }

  /** Keys whose decrypted file is on this device. */
  async here(): Promise<Set<string>> {
    return new Set((await (await this.store()).plainSizes()).keys());
  }

  /** Drops the bytes of rows that are gone (deleted, purged, or trimmed). */
  async gc(): Promise<void> {
    const store = await this.store();
    const rows = new Set((await this.e.db.history()).filter((r) => r.type === "file" && r.id !== undefined).map((r) => fileKey(r.id!)));
    for (const k of await store.keys()) {
      const id = Number(k.slice(1));
      if (!rows.has(k) && !this.running.has(id) && !this.decrypting.has(id)) await store.remove(k);
    }
  }

  async clearAll(): Promise<void> {
    await (await this.store()).clearAll();
  }
}
