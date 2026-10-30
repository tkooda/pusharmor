// IndexedDB "pusharmor" (component-webext section 4.2). Migrations are
// additive and forward-only; a rollback build keeps the current version.
import { b64urlEncode } from "../crypto/b64url.ts";
import type { ReplayState } from "../model/replay.ts";

export const DB_NAME = "pusharmor";
export const DB_VERSION = 1;
export const STORES = ["keys", "meta", "peers", "replay", "history"] as const;
export type StoreName = (typeof STORES)[number];

export interface SelfKeys {
  sign: CryptoKeyPair;
  enc: CryptoKeyPair;
  sign_pub: Uint8Array;
  enc_pub: Uint8Array;
  id: string;
}

export interface WpKeys {
  ecdh: CryptoKeyPair;
  p256dh: Uint8Array;
  auth: Uint8Array;
}

export type Ruling = "approved" | "denied" | "none";
export type Platform4 = "android" | "ios" | "chrome" | "firefox";

export interface PeerRow {
  id: string;
  sign_pub: Uint8Array;
  enc_pub: Uint8Array;
  platform: Platform4;
  created: number;
  ruling: Ruling;
  approves_me: boolean; // verified approve, or a GET /peers fetched after the verify
  denies_me: boolean;
  reachable: boolean;
  name: string | null;
  name_n: number;
  last_n: number; // send counter to this peer
  pairing_id: Uint8Array | null;
  hidden: boolean;
  removed: boolean;
  missing: boolean;
  paused: boolean;
  pause_n: number; // n of the last applied pause / unpause
  pinned: boolean; // true only when a pairing pinned the keys
  approve_verified: boolean; // the peer's approve verified on this device
  get_after_verify: boolean; // a GET /peers was fetched after the verify
  pending_approve_n: number; // verified approve kept while unruled (0 = none)
}

export interface HistoryRow {
  id?: number;
  dir: "in" | "out";
  peer: string | null;
  peer_name?: string | null; // last known name, kept for "(removed)"
  type: "url" | "text" | "tel" | "event";
  event?: "denied" | "paused" | "resumed" | "unreadable" | "invalid";
  content: string;
  n: number | null;
  pairing_id: string | null;
  received: number;
  read: boolean;
  results?: Record<string, string>;
  count?: number; // merged consecutive events
  targets?: string[];
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error ?? new Error("aborted"));
  });
}

export function openDb(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = factory.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = (ev) => {
      const db = r.result;
      // version 1
      if (ev.oldVersion < 1) {
        db.createObjectStore("keys");
        db.createObjectStore("meta");
        db.createObjectStore("peers", { keyPath: "id" });
        db.createObjectStore("replay");
        const h = db.createObjectStore("history", { keyPath: "id", autoIncrement: true });
        h.createIndex("received", "received");
        h.createIndex("msg", ["peer", "pairing_id", "n"]);
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export class Db {
  readonly db: IDBDatabase;
  constructor(db: IDBDatabase) {
    this.db = db;
  }

  async get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    const tx = this.db.transaction(store, "readonly");
    return (await req(tx.objectStore(store).get(key))) as T | undefined;
  }

  async put(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
    const tx = this.db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    await txDone(tx);
  }

  async del(store: StoreName, key: IDBValidKey): Promise<void> {
    const tx = this.db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    await txDone(tx);
  }

  async all<T>(store: StoreName): Promise<T[]> {
    const tx = this.db.transaction(store, "readonly");
    return (await req(tx.objectStore(store).getAll())) as T[];
  }

  async clear(stores: StoreName[]): Promise<void> {
    const tx = this.db.transaction(stores, "readwrite");
    for (const s of stores) tx.objectStore(s).clear();
    await txDone(tx);
  }

  /**
   * One readwrite transaction over the given stores. fn must only issue
   * requests synchronously or chained on request callbacks (no awaits on
   * foreign promises), so the transaction stays active.
   */
  async tx<T>(stores: StoreName[], fn: (t: IDBTransaction) => Promise<T>): Promise<T> {
    const tx = this.db.transaction(stores, "readwrite");
    const done = txDone(tx);
    let out: T;
    try {
      out = await fn(tx);
    } catch (e) {
      try {
        tx.abort();
      } catch {
        // already finished
      }
      await done.catch(() => undefined);
      throw e;
    }
    await done;
    return out;
  }

  // ---- meta ----
  async meta<T>(key: string): Promise<T | undefined> {
    return this.get<T>("meta", key);
  }
  async setMeta(key: string, value: unknown): Promise<void> {
    return this.put("meta", value, key);
  }

  // ---- keys ----
  async self(): Promise<SelfKeys | undefined> {
    return this.get<SelfKeys>("keys", "self");
  }

  // ---- peers ----
  async peer(id: string): Promise<PeerRow | undefined> {
    return this.get<PeerRow>("peers", id);
  }
  async peers(): Promise<PeerRow[]> {
    return this.all<PeerRow>("peers");
  }
  async putPeer(p: PeerRow): Promise<void> {
    return this.put("peers", p);
  }

  /**
   * Read-modify-write of one peer row in ONE readwrite transaction, so a
   * concurrent reserveN or update is never lost. fn gets the current row
   * (undefined if none) and returns the new row, or null to write nothing.
   * fn must be synchronous. Returns the row written, or null.
   */
  async updatePeer(id: string, fn: (cur: PeerRow | undefined) => PeerRow | null): Promise<PeerRow | null> {
    return this.tx(["peers"], (tx) =>
      new Promise<PeerRow | null>((res, rej) => {
        const s = tx.objectStore("peers");
        const g = s.get(id);
        g.onsuccess = () => {
          let row: PeerRow | null;
          try {
            row = fn(g.result as PeerRow | undefined);
          } catch (e) {
            return rej(e);
          }
          if (row) s.put(row);
          res(row);
        };
        g.onerror = () => rej(g.error);
      }),
    );
  }

  /** Counter rule: reserve n = last_n + 1 in one readwrite transaction, committed before use. */
  async reserveN(id: string): Promise<number> {
    return this.tx(["peers"], (tx) =>
      new Promise<number>((res, rej) => {
        const s = tx.objectStore("peers");
        const g = s.get(id);
        g.onsuccess = () => {
          const p = g.result as PeerRow | undefined;
          if (!p) return rej(new Error("no peer"));
          p.last_n += 1;
          s.put(p);
          res(p.last_n);
        };
        g.onerror = () => rej(g.error);
      }),
    );
  }

  /** Pin: ONE transaction over peers + replay (keys, pairing id, last_n = 0, fresh replay row). */
  async pin(id: string, signPub: Uint8Array, encPub: Uint8Array, pairingId: Uint8Array, base: PeerRow): Promise<boolean> {
    return this.tx(["peers", "replay"], (tx) =>
      new Promise<boolean>((res, rej) => {
        const ps = tx.objectStore("peers");
        const g = ps.get(id);
        g.onsuccess = () => {
          const cur = (g.result as PeerRow | undefined) ?? base;
          if (cur.pinned && cur.pairing_id && eq(cur.pairing_id, pairingId)) return res(false);
          const row: PeerRow = {
            ...cur,
            sign_pub: signPub,
            enc_pub: encPub,
            pairing_id: pairingId,
            last_n: 0,
            pinned: true,
            approve_verified: false,
            get_after_verify: false,
            approves_me: false,
            pending_approve_n: 0,
            pause_n: 0,
          };
          ps.put(row);
          const rs: ReplayState = { pairing_id: pairingId, h: 0, bitmap: new Uint8Array(13) };
          tx.objectStore("replay").put(rs, id);
          res(true);
        };
        g.onerror = () => rej(g.error);
      }),
    );
  }

  /** Drop the pin, pairing id, counter and replay window of one peer (Cancel pairing, timeout). */
  async unpin(id: string): Promise<void> {
    await this.tx(["peers", "replay"], (tx) =>
      new Promise<void>((res, rej) => {
        const ps = tx.objectStore("peers");
        const g = ps.get(id);
        g.onsuccess = () => {
          const p = g.result as PeerRow | undefined;
          if (p) {
            ps.put({
              ...p,
              pinned: false,
              pairing_id: null,
              last_n: 0,
              ruling: "none",
              approves_me: false,
              approve_verified: false,
              get_after_verify: false,
              pending_approve_n: 0,
              name: null,
              name_n: 0,
            } satisfies PeerRow);
          }
          tx.objectStore("replay").delete(id);
          res();
        };
        g.onerror = () => rej(g.error);
      }),
    );
  }

  /**
   * Replay check and record in ONE transaction with the History row
   * (catalog Replay window). Returns "accept" (state recorded, row added),
   * "dup" (seen n with a History row for (sender, pairing id, n); that row's
   * id returned), "seen" (seen n, no row) or "old" (n <= h - 100), or
   * "nostate" when no replay row exists or its pairing id differs.
   * peerFn, when given, is applied to the sender's peer row in the same
   * transaction on "accept" (as updatePeer), so a crash cannot keep the
   * replay record and lose that change (I301).
   */
  async acceptN(
    sender: string,
    pairingIdB64: string,
    n: number,
    row: HistoryRow | null,
    check: (s: ReplayState) => "accept" | "seen" | "old",
    record: (s: ReplayState) => ReplayState,
    doRecord = true,
    peerFn?: (cur: PeerRow | undefined) => PeerRow | null,
  ): Promise<{ verdict: "accept" | "dup" | "seen" | "old" | "nostate"; rowId?: number; peer?: PeerRow | null }> {
    return this.tx(peerFn ? ["replay", "history", "peers"] : ["replay", "history"], (tx) =>
      new Promise((res, rej) => {
        const rs = tx.objectStore("replay");
        const g = rs.get(sender);
        g.onerror = () => rej(g.error);
        g.onsuccess = () => {
          const st = g.result as ReplayState | undefined;
          if (!st || b64urlEncode(st.pairing_id) !== pairingIdB64) return res({ verdict: "nostate" });
          const v = check(st);
          if (v === "accept") {
            if (!doRecord) return res({ verdict: "accept" });
            rs.put(record(st), sender);
            const done = (rowId?: number) => {
              if (!peerFn) return res({ verdict: "accept", rowId });
              const ps = tx.objectStore("peers");
              const pg = ps.get(sender);
              pg.onerror = () => rej(pg.error);
              pg.onsuccess = () => {
                let p: PeerRow | null;
                try {
                  p = peerFn(pg.result as PeerRow | undefined);
                } catch (e) {
                  return rej(e);
                }
                if (p) ps.put(p);
                res({ verdict: "accept", rowId, peer: p });
              };
            };
            if (row) {
              const a = tx.objectStore("history").add(row);
              a.onsuccess = () => done(a.result as number);
              a.onerror = () => rej(a.error);
            } else done();
            return;
          }
          if (v === "old") return res({ verdict: "old" });
          const q = tx.objectStore("history").index("msg").getKey([sender, pairingIdB64, n]);
          q.onerror = () => rej(q.error);
          q.onsuccess = () => {
            if (q.result !== undefined) res({ verdict: "dup", rowId: q.result as number });
            else res({ verdict: "seen" });
          };
        };
      }),
    );
  }

  async historyRowFor(peer: string, pairingIdB64: string, n: number): Promise<number | undefined> {
    const tx = this.db.transaction("history", "readonly");
    return (await req(tx.objectStore("history").index("msg").getKey([peer, pairingIdB64, n]))) as number | undefined;
  }

  async replay(id: string): Promise<ReplayState | undefined> {
    return this.get<ReplayState>("replay", id);
  }

  // ---- history ----
  async addHistory(row: HistoryRow): Promise<number> {
    const tx = this.db.transaction("history", "readwrite");
    const k = (await req(tx.objectStore("history").add(row))) as number;
    await txDone(tx);
    return k;
  }

  async history(): Promise<HistoryRow[]> {
    const rows = await this.all<HistoryRow>("history");
    return rows.sort((a, b) => b.received - a.received || (b.id ?? 0) - (a.id ?? 0));
  }

  async purgeHistory(before: number): Promise<void> {
    const tx = this.db.transaction("history", "readwrite");
    const idx = tx.objectStore("history").index("received");
    const r = idx.openCursor(IDBKeyRange.upperBound(before, true));
    r.onsuccess = () => {
      const c = r.result;
      if (c) {
        c.delete();
        c.continue();
      }
    };
    await txDone(tx);
  }
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function newPeerRow(id: string, signPub: Uint8Array, encPub: Uint8Array, platform: Platform4, created: number): PeerRow {
  return {
    id,
    sign_pub: signPub,
    enc_pub: encPub,
    platform,
    created,
    ruling: "none",
    approves_me: false,
    denies_me: false,
    reachable: false,
    name: null,
    name_n: 0,
    last_n: 0,
    pairing_id: null,
    hidden: false,
    removed: false,
    missing: false,
    paused: false,
    pause_n: 0,
    pinned: false,
    approve_verified: false,
    get_after_verify: false,
    pending_approve_n: 0,
  };
}
