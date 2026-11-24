// IndexedDB "pusharmor-files": file bytes, apart from the main database so that
// its version never changes for files. "chunks": a download in progress, as
// Blob pieces in order, kept across restarts for a Range resume. "picked": a file
// the user picked to send, handed by record key to the page that uploads it.
// "plain": a decrypted file, by the same key as its chunks.

const NAME = "pusharmor-files";

interface Chunk {
  file: string;
  i: number;
  blob: Blob;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export function done(tx: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = (ev) => rej((ev.target as IDBRequest | null)?.error ?? tx.error); // a failed request: tx.error is still null here
    tx.onabort = () => rej(tx.error ?? new Error("aborted"));
  });
}

export class FileStore {
  private readonly db: IDBDatabase;
  private readonly range: typeof IDBKeyRange;
  private constructor(db: IDBDatabase, range: typeof IDBKeyRange) {
    this.db = db;
    this.range = range;
  }

  static open(factory: IDBFactory = indexedDB, range: typeof IDBKeyRange = IDBKeyRange): Promise<FileStore> {
    return new Promise((res, rej) => {
      const r = factory.open(NAME, 2);
      r.onupgradeneeded = () => {
        const have = r.result.objectStoreNames;
        if (!have.contains("chunks")) r.result.createObjectStore("chunks", { keyPath: ["file", "i"] });
        if (!have.contains("picked")) r.result.createObjectStore("picked");
        if (!have.contains("plain")) r.result.createObjectStore("plain");
      };
      r.onsuccess = () => res(new FileStore(r.result, range));
      r.onerror = () => rej(r.error);
    });
  }

  private chunks(file: string): IDBKeyRange {
    return this.range.bound([file, 0], [file, Number.MAX_SAFE_INTEGER]);
  }

  private async all(file: string): Promise<Chunk[]> {
    return (await req(this.db.transaction("chunks").objectStore("chunks").getAll(this.chunks(file)))) as Chunk[];
  }

  /** Adds a piece after the stored ones. A full disk rejects with a QuotaExceededError. */
  async append(file: string, blob: Blob): Promise<void> {
    const tx = this.db.transaction("chunks", "readwrite");
    const os = tx.objectStore("chunks");
    const c = await req(os.openCursor(this.chunks(file), "prev"));
    os.put({ file, i: c ? (c.value as Chunk).i + 1 : 0, blob });
    await done(tx);
  }

  /** Bytes stored for file. */
  async size(file: string): Promise<number> {
    return (await this.all(file)).reduce((s, c) => s + c.blob.size, 0);
  }

  /** The stored pieces as one Blob. */
  async blob(file: string): Promise<Blob> {
    return new Blob((await this.all(file)).map((c) => c.blob));
  }

  async clear(file: string): Promise<void> {
    const tx = this.db.transaction("chunks", "readwrite");
    tx.objectStore("chunks").delete(this.chunks(file));
    await done(tx);
  }

  /** Stores a picked file. -> its record key. */
  async putPicked(blob: Blob): Promise<string> {
    const key = crypto.randomUUID();
    const tx = this.db.transaction("picked", "readwrite");
    tx.objectStore("picked").put(blob, key);
    await done(tx);
    return key;
  }

  async picked(key: string): Promise<Blob | null> {
    return ((await req(this.db.transaction("picked").objectStore("picked").get(key))) as Blob | undefined) ?? null;
  }

  async deletePicked(key: string): Promise<void> {
    const tx = this.db.transaction("picked", "readwrite");
    tx.objectStore("picked").delete(key);
    await done(tx);
  }

  /** Stores the decrypted file of key. A full disk rejects with a QuotaExceededError. */
  async putPlain(key: string, blob: Blob): Promise<void> {
    const tx = this.db.transaction("plain", "readwrite");
    tx.objectStore("plain").put(blob, key);
    await done(tx);
  }

  async plain(key: string): Promise<Blob | null> {
    return ((await req(this.db.transaction("plain").objectStore("plain").get(key))) as Blob | undefined) ?? null;
  }

  /** Bytes of each decrypted file, by key. */
  async plainSizes(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const os = this.db.transaction("plain").objectStore("plain");
    const [keys, vals] = await Promise.all([req(os.getAllKeys()), req(os.getAll())]);
    keys.forEach((k, i) => out.set(String(k), (vals[i] as Blob).size));
    return out;
  }

  /** Keys with stored chunks or a decrypted file. */
  async keys(): Promise<Set<string>> {
    const tx = this.db.transaction(["chunks", "plain"]);
    const [c, p] = await Promise.all([req(tx.objectStore("chunks").getAllKeys()), req(tx.objectStore("plain").getAllKeys())]);
    return new Set([...c.map((k) => String((k as unknown[])[0])), ...p.map(String)]);
  }

  /** Every byte of key: chunks and the decrypted file. */
  async remove(key: string): Promise<void> {
    const tx = this.db.transaction(["chunks", "plain"], "readwrite");
    tx.objectStore("chunks").delete(this.chunks(key));
    tx.objectStore("plain").delete(key);
    await done(tx);
  }

  /** Logout and device removal: every stored file byte goes. */
  async clearAll(): Promise<void> {
    const tx = this.db.transaction(["chunks", "picked", "plain"], "readwrite");
    tx.objectStore("chunks").clear();
    tx.objectStore("picked").clear();
    tx.objectStore("plain").clear();
    await done(tx);
  }

  close(): void {
    this.db.close();
  }
}

/** Bytes this extension may still store, from navigator.storage.estimate(); null when unknown. */
export async function freeBytes(): Promise<number | null> {
  try {
    const e = await navigator.storage.estimate();
    return typeof e.quota === "number" && typeof e.usage === "number" ? Math.max(0, e.quota - e.usage) : null;
  } catch {
    return null;
  }
}
