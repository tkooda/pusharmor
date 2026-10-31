// The background engine (component-webext section 3): the one owner of keys,
// counters, replay state and Worker calls. Every operation reads state at
// start and commits before it returns, so a stopped service worker loses
// nothing.
import { type ApiReply, Api, ApiError, UPDATE_REQUIRED, errorText } from "../api/client.ts";
import { b64urlDecode, b64urlEncode, b64urlTryDecode } from "../crypto/b64url.ts";
import { equal, randomBytes } from "../crypto/bytes.ts";
import { generateKeySet, isValidPub } from "../crypto/keys.ts";
import {
  type PushFields,
  ACCOUNT_LEN,
  ID_LEN,
  KEYHASH_LEN,
  accountOf,
  commitHash,
  keyhash,
  validPeerEntry,
  pairingFingerprint,
  pairingId,
  pairingKey,
  pushHash,
} from "../crypto/labels.ts";
import { formatCountdown, PAIRING_TIMEOUT_MS } from "../model/countdown.ts";
import { autoOpenAllowed, detectType, isPhone, parseHttpUrl, type SendType } from "../model/detect.ts";
import {
  type Content,
  buildJson,
  encodeInner,
  encodePair,
  isPairWire,
  isPrintableName,
  makeNameEntry,
  openNameEntry,
  openPair,
  pairAcceptable,
  sealNameEntry,
  verifyNameEntry,
} from "../model/message.ts";
import { CONTENT_CAP, utf8Len } from "../model/padding.ts";
import { AUTO_REPLY_WINDOW_MS, pairDecide, type PairDecision, pairHint, pairTimeout, type ResendResult } from "../model/pairdecide.ts";
import { replayCheck, replayRecord } from "../model/replay.ts";
import { receiveDecide } from "../model/receive.ts";
import type { Platform } from "../platform.ts";
import { type HistoryRow, type PeerRow, type Platform4, type SelfKeys, Db, newPeerRow } from "../store/db.ts";
import {
  ALLOW_SET,
  Lock,
  NET_NOT_BEFORE,
  PAIR_AUTO,
  PAIR_MSG_PREFIX,
  PAIR_PREFIX,
  type PairEntry,
  REG_MARKER,
  UPDATE_NEEDED,
  allEntries,
  getAllowSet,
  getEntry,
  pairKeyOf,
} from "./state.ts";
import { T, peerLabel, sendResultText } from "./texts.ts";
import { AUTH_CHANGED } from "../model/signin.ts";

export type Src = "push" | "bridge" | "returned";
export const FETCH_WINDOW_MS = 60_000;
export const SEND_AGAIN_MS = 60_000;
export const AUTO_OPEN_MAX = 3;
export const AUTO_OPEN_WINDOW_MS = 60_000;

export interface Settings {
  showAll: boolean;
  autoOpen: boolean;
  historyDays: number;
}
export const DEFAULT_SETTINGS: Settings = { showAll: true, autoOpen: false, historyDays: 30 };

export interface EngineDeps {
  platform: Platform;
  db: Db;
  api: Api;
  vapidPub: Uint8Array;
}

export interface SendResult {
  sent: number;
  total: number;
  failures: { id: string; result: string; text: string }[];
  error?: string;
}

/** Thrown by an operation; the UI shows text. */
export class UserError extends Error {}

function now(p: Platform): number {
  return p.now();
}

/**
 * A received approve as a field-level update on the current peer row
 * (I286, I287): a concurrent approve() or reserveN is kept. A row
 * re-pinned since the decide (another pairing id) is left alone (I314).
 */
function approveRow(n: number, name: string | null, pairingId: Uint8Array): (cur: PeerRow | undefined) => PeerRow | null {
  return (cur) => {
    if (!cur || !cur.pairing_id || !equal(cur.pairing_id, pairingId)) return null;
    let r = cur;
    if (name !== null && n > r.name_n) r = { ...r, name, name_n: n };
    if (r.ruling === "approved") return { ...r, approves_me: true, approve_verified: true, get_after_verify: false, pending_approve_n: 0 };
    // pinned, unruled: keep it; mark "approves me" when I approve
    return { ...r, pending_approve_n: n };
  };
}

/** meta key: a Log out the relay server has not confirmed yet (Q368). */
const LOGOUT_PENDING = "logout_pending";

export class Engine {
  readonly p: Platform;
  readonly db: Db;
  readonly api: Api;
  readonly vapid: Uint8Array;
  readonly lock = new Lock();
  private readonly pairingAgain = new Set<string>();
  private fetching: Promise<void> | null = null;
  private loggingOut: Promise<void> | null = null;
  private authN = 0;

  constructor(d: EngineDeps) {
    this.p = d.platform;
    this.db = d.db;
    this.api = d.api;
    this.api.onLoggedOut = () => this.setReg("logged_out");
    this.api.onUpdateRequired = async () => {
      if (!(await this.updateRequired())) {
        await this.p.storageLocal.set({ [UPDATE_NEEDED]: this.p.appVersion });
        await this.authChanged(); // open views show the update screen
      }
    };
    this.vapid = d.vapidPub;
  }

  get penalized(): boolean {
    return this.p.platformName === "firefox";
  }

  // ------------------------------------------------------------------ basics

  async settings(): Promise<Settings> {
    return { ...DEFAULT_SETTINGS, ...((await this.db.meta<Settings>("settings")) ?? {}) };
  }

  async setSettings(s: Partial<Settings>): Promise<void> {
    await this.db.setMeta("settings", { ...(await this.settings()), ...s });
    await this.rebuildMenus();
  }

  async self(): Promise<SelfKeys | null> {
    const s = await this.db.self();
    return s && s.id ? s : null;
  }

  /** true once the relay server refused this version (HTTP 426); a newer version starts clean. */
  async updateRequired(): Promise<boolean> {
    return (await this.p.storageLocal.get([UPDATE_NEEDED]))[UPDATE_NEEDED] === this.p.appVersion;
  }

  /** Tells open popups and tabs that the login state changed: they mount again (I465). */
  async authChanged(): Promise<void> {
    await this.p.storageSession.set({ [AUTH_CHANGED]: this.p.now() + ":" + ++this.authN }).catch(() => undefined);
  }

  private async setReg(v: "registered" | "logged_out"): Promise<void> {
    await this.db.setMeta("reg", v);
    await this.authChanged();
  }

  async regState(): Promise<"registered" | "logged_out" | null> {
    return (await this.db.meta<"registered" | "logged_out">("reg")) ?? null;
  }

  private signerOf(s: SelfKeys) {
    return { id: s.id, key: s.sign.privateKey };
  }

  async myName(): Promise<string> {
    const n = await this.db.meta<string>("my_name");
    return n ?? (this.p.platformName === "chrome" ? "Chrome" : "Firefox");
  }

  private async peerName(id: string): Promise<string> {
    const p = await this.db.peer(id);
    return peerLabel(p?.name ?? null);
  }

  // ---------------------------------------------------------------- receive

  /** engine.receive(M): the common receive pipeline (section 5). */
  async receive(m: string, src: Src = "push"): Promise<void> {
    const self = await this.self();
    if (!self) return;
    if (isPairWire(m)) {
      await this.lock.run(() => this.receivePair(m, self, src));
      return;
    }
    await this.receiveInner(m, self, src);
  }

  private async dropEvent(kind: "unreadable" | "invalid", peer: string | null, src: Src): Promise<void> {
    if (src === "returned") return;
    await this.addEvent(kind, peer);
    if (this.penalized && src === "push") this.p.notify("drop", T.appName, kind === "invalid" ? T.invalid : T.couldNotRead);
  }

  private async addEvent(kind: NonNullable<HistoryRow["event"]>, peer: string | null): Promise<number> {
    const t = now(this.p);
    if (kind === "unreadable" || kind === "invalid") {
      const top = (await this.db.history())[0];
      if (top && top.type === "event" && top.event === kind && top.peer === peer && top.id !== undefined) {
        top.count = (top.count ?? 1) + 1;
        top.received = t;
        await this.db.put("history", top);
        return top.id;
      }
    }
    const name = peer ? ((await this.db.peer(peer))?.name ?? null) : null;
    return this.db.addHistory({
      dir: "in",
      peer,
      peer_name: name,
      type: "event",
      event: kind,
      content: "",
      n: null,
      pairing_id: null,
      received: t,
      read: true,
      count: 1,
    } as HistoryRow);
  }

  private async receiveInner(m: string, self: SelfKeys, src: Src): Promise<void> {
    const r = await receiveDecide({
      enc: self.enc,
      id: self.id,
      m,
      pin: async (from) => {
        const p = await this.db.peer(from);
        if (!p || !p.pinned || !p.pairing_id) return null;
        return {
          id: p.id,
          sign_pub: p.sign_pub,
          enc_pub: p.enc_pub,
          pairing_id: p.pairing_id,
          ruling: p.ruling === "none" ? "unruled" : p.ruling,
          removed: p.removed,
        };
      },
      window: async (from) => (await this.db.replay(from)) ?? null,
      hasHistory: async (from, pid, n) => (await this.db.historyRowFor(from, pid, n)) !== undefined,
    });
    if (r.outcome === "unreadable") {
      if (r.unknownSender && src !== "returned") await this.fetchTrigger();
      return this.dropEvent("unreadable", r.from, src);
    }
    if (src === "returned" && r.content.type !== "approve") return;
    if (r.outcome !== "accept") {
      if (r.outcome === "invalid") return this.dropEvent("invalid", r.from, src);
      if (r.outcome === "noop") {
        if (src === "push" && this.penalized) await this.representControl(r.content, r.from);
        return;
      }
      // represent: a seen n with a History row (bridge: silent no-op)
      const id = await this.db.historyRowFor(r.from, b64urlEncode((await this.db.peer(r.from))!.pairing_id!), r.n);
      if (src === "push" && id !== undefined) await this.represent(id);
      return;
    }
    const c = r.content;
    const peer = (await this.db.peer(r.from))!;
    const pidB64 = b64urlEncode(r.pin.pairing_id);
    const row = c.type === "url" || c.type === "text" || c.type === "tel" ? this.inboundRow(peer, c.type, c.value, r.n, pidB64) : null;
    // approve: the peer-row change commits with the replay record (I301)
    const peerFn = c.type === "approve" ? approveRow(r.n, r.name, r.pin.pairing_id) : undefined;
    const rec = await this.db.acceptN(r.from, pidB64, r.n, row, (s) => replayCheck(s, r.n), (s) => replayRecord(s, r.n), true, peerFn);
    if (rec.verdict !== "accept") return; // lost a race with a concurrent duplicate
    let cur = (await this.db.peer(r.from))!;
    if (cur.missing) {
      // a valid push from a peer marked missing clears the mark
      cur = (await this.db.updatePeer(r.from, (p) => (p ? { ...p, missing: false } : null))) ?? cur;
    }
    await this.act(c, r.n, cur, r.name, rec.rowId, src, self, rec.peer);
  }

  private inboundRow(peer: PeerRow, type: "url" | "text" | "tel", value: string, n: number, pidB64: string): HistoryRow {
    let t: HistoryRow["type"] = type;
    let content = value;
    if (type === "url") {
      const u = parseHttpUrl(value);
      if (u) content = u.href;
      else t = "text";
    } else if (type === "tel" && !isPhone(value)) t = "text";
    return {
      dir: "in",
      peer: peer.id,
      peer_name: peer.name,
      type: t,
      content,
      n,
      pairing_id: pidB64,
      received: now(this.p),
      read: false,
    } as HistoryRow;
  }

  private async act(
    c: Content,
    n: number,
    peer: PeerRow,
    name: string | null,
    rowId: number | undefined,
    src: Src,
    self: SelfKeys,
    applied?: PeerRow | null,
  ): Promise<void> {
    switch (c.type) {
      case "url":
      case "text":
      case "tel": {
        if (rowId === undefined) return;
        const row = (await this.db.get<HistoryRow>("history", rowId))!;
        if (row.type === "url" && (await this.tryAutoOpen(row))) return;
        this.notifyRow(row);
        await this.updateBadge();
        return;
      }
      case "approve": {
        // the peer row was updated with the replay record (approveRow)
        const row = applied ?? peer;
        if (row.ruling === "approved") {
          await this.p.storageLocal.remove([pairKeyOf(peer.id)]);
          if (src === "push") this.p.notify("a:" + peer.id, T.appName, T.approved(peerLabel(row.name)));
          await this.rebuildMenus();
        }
        return;
      }
      case "rename": {
        if (name !== null) await this.db.updatePeer(peer.id, (p) => (p && n > p.name_n ? { ...p, name, name_n: n } : null));
        if (src === "push") this.p.notify("peerchg", T.appName, T.peerChanged);
        await this.rebuildMenus();
        return;
      }
      case "remove": {
        if (c.id === self.id) {
          await this.selfRemoved(T.removed);
          return;
        }
        const target = await this.db.peer(c.id);
        if (target) await this.markRemoved(target);
        if (src === "push") this.p.notify("peerchg", T.appName, T.peerChanged);
        await this.rebuildMenus();
        return;
      }
      case "delete":
        await this.selfRemoved(T.accountDeleted);
        return;
      case "logout":
      case "login": {
        await this.db.updatePeer(peer.id, (p) => (p && n > p.logout_n ? { ...p, logged_out: c.type === "logout", logout_n: n } : null));
        const id = await this.addEvent(c.type === "logout" ? "logged_out" : "logged_in", peer.id);
        if (this.penalized && src === "push") {
          const nm = peerLabel(peer.name);
          this.p.notify("h:" + id, T.appName, c.type === "logout" ? T.loggedOutRecv(nm) : T.loggedInRecv(nm));
        }
        await this.rebuildMenus();
        return;
      }
      case "deny": {
        await this.db.updatePeer(peer.id, (p) => (p ? { ...p, denies_me: true, approves_me: false } : null));
        await this.p.storageLocal.remove([pairKeyOf(peer.id)]);
        const id = await this.addEvent("denied", peer.id);
        if (this.penalized && src === "push") this.p.notify("h:" + id, T.appName, T.denied(peerLabel(peer.name)));
        await this.rebuildMenus();
        return;
      }
    }
  }

  private async representControl(c: Content, from: string): Promise<void> {
    const nm = await this.peerName(from);
    if (c.type === "approve") this.p.notify("a:" + from, T.appName, T.approved(nm));
    else if (c.type === "rename" || c.type === "remove") this.p.notify("peerchg", T.appName, T.peerChanged);
    else if (c.type === "logout" || c.type === "login" || c.type === "deny") {
      const ev = c.type === "logout" ? "logged_out" : c.type === "login" ? "logged_in" : "denied";
      const top = (await this.db.history()).find((h) => h.type === "event" && h.event === ev && h.peer === from);
      const text = c.type === "logout" ? T.loggedOutRecv(nm) : c.type === "login" ? T.loggedInRecv(nm) : T.denied(nm);
      this.p.notify(top?.id !== undefined ? "h:" + top.id : "drop", T.appName, text);
    }
  }

  private async represent(rowId: number): Promise<void> {
    const row = await this.db.get<HistoryRow>("history", rowId);
    if (row) this.notifyRow(row);
  }

  private notifyRow(row: HistoryRow): void {
    const title = row.type === "url" ? T.titleUrl : row.type === "tel" ? T.titleTel : T.titleText;
    this.p.notify("h:" + row.id, title, row.content.slice(0, 120));
  }

  /** Auto-open rules (section 9). Returns true when the tab was opened. */
  private async tryAutoOpen(row: HistoryRow): Promise<boolean> {
    const s = await this.settings();
    if (!s.autoOpen) return false;
    const u = parseHttpUrl(row.content);
    if (!u || !autoOpenAllowed(u)) return false;
    const t = now(this.p);
    const recent = ((await this.db.meta<number[]>("auto_open")) ?? []).filter((x) => t - x < AUTO_OPEN_WINDOW_MS);
    if (recent.length >= AUTO_OPEN_MAX) return false;
    let opened = false;
    try {
      opened = await this.p.autoOpenTab(u.href);
    } catch {
      opened = false;
    }
    if (!opened) return false;
    recent.push(t);
    await this.db.setMeta("auto_open", recent);
    row.read = true;
    await this.db.put("history", row);
    return true;
  }

  async updateBadge(): Promise<void> {
    const n = (await this.db.history()).filter((h) => h.dir === "in" && h.type !== "event" && !h.read).length;
    this.p.setBadge(n > 0 ? String(n) : "");
  }

  // ---------------------------------------------------------- pair receive

  private async pairNotice(pk: string, text: string): Promise<void> {
    this.p.notify("p:" + pk, T.appName, text);
  }

  private async receivePair(m: string, self: SelfKeys, src: Src): Promise<void> {
    if (src === "returned") return;
    const msg = await openPair(self.enc, self.id, m);
    if (!msg) return this.dropEvent("unreadable", null, src);
    const from = b64urlEncode(msg.fromId);
    const acct = accountOf(b64urlDecode(self.id));
    const e = await getEntry(this.p.storageLocal, from);
    // the kind must fit the receiver state: reply on an N entry, open on an X entry, commit any
    const expected = msg.body.kind === "commit" ? "commit" : e?.role === "N" ? "reply" : e?.role === "X" ? "open" : null;
    // (the open's c_N check runs in onOpen, where a mismatch aborts the entry visibly)
    if (from === self.id || !expected || !(await pairAcceptable(msg, acct, expected))) return this.dropEvent("unreadable", null, src);
    const b = msg.body;
    if (b.kind === "commit") return this.onCommit(from, b.c_N, self, src, false);
    if (b.kind === "reply") return this.onReply(from, b.sign_pub, b.enc_pub, b.r, self, src);
    return this.onOpen(from, b.sign_pub, b.enc_pub, b.r, self, src);
  }

  private async decideInput(from: string, cN: Uint8Array, self: SelfKeys) {
    const entries = await allEntries(this.p.storageLocal);
    const e = entries.get(from) ?? null;
    const peer = await this.db.peer(from);
    const listed = (await this.db.meta<string[]>("listed")) ?? [];
    const auto = ((await this.p.storageLocal.get([PAIR_AUTO]))[PAIR_AUTO] as number[] | undefined) ?? [];
    return {
      entries,
      auto,
      input: {
        myId: b64urlDecode(self.id),
        fromId: b64urlDecode(from),
        c_N: cN,
        entry: e ? { role: e.role, state: e.state, c_N: b64urlDecode(e.c_N), authorized: !!e.authorized } : null,
        pinned: !!peer?.pinned,
        approved: peer?.ruling === "approved",
        approveVerified: !!peer?.approve_verified,
        lastGetApprovesMe: peer?.approve_verified && peer.get_after_verify ? peer.approves_me : null,
        inLastList: listed.includes(from) && !!peer && !peer.removed,
        fetched: false,
        openEntries: [...entries.values()].length,
        capTimestamps: auto,
        now: now(this.p),
      },
    };
  }

  private async onCommit(from: string, cN: Uint8Array, self: SelfKeys, src: Src, afterFetch: boolean): Promise<void> {
    const { input, auto } = await this.decideInput(from, cN, self);
    const d: PairDecision = pairDecide({ ...input, fetched: afterFetch });
    const pkX = await pairingKey(b64urlDecode(from), b64urlDecode(self.id)); // sender is N
    const name = await this.halfName(from);
    switch (d.action) {
      case "fetch":
        await this.fetchPeersNow().catch(() => undefined);
        return this.onCommit(from, cN, self, src, true);
      case "drop":
        return this.dropEvent("unreadable", null, src);
      case "abort":
        await this.endEntry(from, T.pairFailed, false);
        return this.dropEvent("unreadable", null, src);
      case "notice": {
        if (d.notice === "half") {
          const cur = await getEntry(this.p.storageLocal, from);
          if (cur && !cur.half) await this.p.storageLocal.set({ [pairKeyOf(from)]: { ...cur, half: true } satisfies PairEntry });
          return this.pairNotice(pkX, T.pairHalf(name));
        }
        if (d.notice === "crossing") {
          const pkN = await pairingKey(b64urlDecode(self.id), b64urlDecode(from));
          return this.pairNotice(pkN, T.pairCrossing(name));
        }
        const e = await getEntry(this.p.storageLocal, from);
        if (e && e.state === "shown" && e.fingerprint) return this.pairNotice(e.pk, T.pairOpen(e.fingerprint));
        return this.pairNotice(e?.pk ?? pkX, T.pairCommit);
      }
      case "resend": {
        await this.pairNotice(pkX, T.pairCommit);
        await this.sendReply(from);
        return;
      }
      case "prompt":
      case "reply": {
        const t = now(this.p);
        const entry: PairEntry = {
          role: "X",
          state: "prompted",
          pk: pkX,
          r: b64urlEncode(randomBytes(32)),
          c_N: b64urlEncode(cN),
          started: t,
          authorized: d.action === "reply",
          unsent: d.action === "reply",
        };
        // one storage.local.set with both keys (I235); the cap counts when the entry persists
        const items: Record<string, unknown> = { [pairKeyOf(from)]: entry };
        if (d.action === "reply" && d.counted) {
          items[PAIR_AUTO] = [...auto.filter((x) => t - x < AUTO_REPLY_WINDOW_MS), t];
        }
        await this.p.storageLocal.remove([PAIR_MSG_PREFIX + from]);
        await this.p.storageLocal.set(items);
        await this.pairNotice(pkX, T.pairCommit);
        if (d.action === "reply") await this.sendReply(from);
        return;
      }
    }
  }

  private async halfName(id: string): Promise<string> {
    const p = await this.db.peer(id);
    if (p?.name) return p.name;
    if (!p) return T.aPeer;
    const plat = p.platform.charAt(0).toUpperCase() + p.platform.slice(1);
    const d = new Date(p.created * 1000);
    const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
    return plat + " device added " + mon + " " + d.getUTCDate();
  }

  /** X: send (or re-send) the reply of an authorized entry, same r_X. */
  async sendReply(from: string): Promise<void> {
    const self = await this.self();
    const e = await getEntry(this.p.storageLocal, from);
    const peer = await this.db.peer(from);
    if (!self || !e || e.role !== "X" || !e.authorized || !peer) return;
    if (e.not_before && now(this.p) < e.not_before) {
      this.p.alarmAt("pair:" + from, Math.max(e.not_before, now(this.p) + 30_000));
      return;
    }
    let msg = e.msg;
    if (!msg) {
      msg = await encodePair(b64urlDecode(self.id), { kind: "reply", sign_pub: self.sign_pub, enc_pub: self.enc_pub, r: b64urlDecode(e.r) }, from, peer.enc_pub);
    }
    const res = await this.postPair(from, "reply", msg, self);
    const cur = await getEntry(this.p.storageLocal, from);
    if (!cur) return;
    const upd: PairEntry = { ...cur, msg, last_send: now(this.p), last_result: res.result };
    if (res.result === "sent") {
      upd.unsent = false;
      if (upd.state === "prompted") upd.state = "replied";
    } else if (res.notBefore) {
      upd.not_before = res.notBefore;
      this.p.alarmAt("pair:" + from, res.notBefore);
    }
    await this.p.storageLocal.set({ [pairKeyOf(from)]: upd });
  }

  private async postPair(x: string, kind: "commit" | "reply" | "open", c: string, self: SelfKeys): Promise<{ result: string; notBefore?: number }> {
    try {
      const r = await this.api.call("POST", "/pair/" + x, { signer: this.signerOf(self), body: { k: kind, c }, noRetry: true });
      await this.afterSignedReply(r);
      return { result: typeof r.json.r === "string" ? r.json.r : "failed" };
    } catch (e) {
      return this.callFailure(e);
    }
  }

  private async callFailure(e: unknown): Promise<{ result: string; notBefore?: number }> {
    if (e instanceof ApiError) {
      if (e.status === 426) return { result: UPDATE_REQUIRED };
      if (e.status === 401 && e.error === "unknown peer") await this.selfRemoved(T.removed);
      if ((e.status === 429 || e.status === 503) && e.retryAfter !== null) {
        return { result: String(e.status), notBefore: now(this.p) + Math.max(30, e.retryAfter) * 1000 };
      }
      return { result: e.status === 0 ? "network" : String(e.status) + (e.error ? " " + e.error : "") };
    }
    return { result: "error" };
  }

  private async onReply(from: string, sp: Uint8Array, ep: Uint8Array, rX: Uint8Array, self: SelfKeys, src: Src): Promise<void> {
    const e = await getEntry(this.p.storageLocal, from);
    const peer = await this.db.peer(from);
    if (!e || e.role !== "N" || !peer || !(await isValidPub(sp)) || !(await isValidPub(ep))) return this.dropEvent("unreadable", null, src);
    const rN = b64urlDecode(e.r);
    const pid = await pairingId(rN, rX);
    if (e.state !== "committed") {
      // idempotent: a redelivered reply after the pin and the state write
      if (e.state === "shown" && peer.pinned && peer.pairing_id && equal(peer.pairing_id, pid)) return;
      return this.dropEvent("unreadable", null, src);
    }
    await this.db.pin(from, sp, ep, pid, peer);
    const fp = await pairingFingerprint(self.sign_pub, self.enc_pub, sp, ep, rN, rX);
    const open = await encodePair(b64urlDecode(self.id), { kind: "open", sign_pub: self.sign_pub, enc_pub: self.enc_pub, r: rN }, from, ep);
    const shown: PairEntry = {
      ...e,
      state: "shown",
      fingerprint: fp,
      keys: { sign_pub: b64urlEncode(sp), enc_pub: b64urlEncode(ep) },
      msg: open,
    };
    await this.p.storageLocal.set({ [pairKeyOf(from)]: shown });
    // Chrome: no notice for a reply on N; Firefox shows one (same id p:pk)
    if (this.penalized && src === "push") await this.pairNotice(e.pk, T.pairReply);
    const res = await this.postPair(from, "open", open, self);
    const cur = await getEntry(this.p.storageLocal, from);
    if (cur) {
      const upd: PairEntry = { ...cur, last_send: now(this.p), last_result: res.result };
      if (res.notBefore) upd.not_before = res.notBefore;
      await this.p.storageLocal.set({ [pairKeyOf(from)]: upd });
    }
  }

  private async onOpen(from: string, sp: Uint8Array, ep: Uint8Array, rN: Uint8Array, self: SelfKeys, src: Src): Promise<void> {
    const e = await getEntry(this.p.storageLocal, from);
    const peer = await this.db.peer(from);
    if (!e || e.role !== "X" || !peer) return this.dropEvent("unreadable", null, src);
    if (e.state === "shown") {
      if (e.keys && e.keys.sign_pub === b64urlEncode(sp) && e.keys.enc_pub === b64urlEncode(ep) && e.fingerprint) {
        return this.pairNotice(e.pk, T.pairOpen(e.fingerprint));
      }
      return this.dropEvent("unreadable", null, src);
    }
    if (e.state !== "replied") return this.dropEvent("unreadable", null, src);
    const c = await commitHash(sp, ep, rN);
    if (!equal(c, b64urlDecode(e.c_N)) || !(await isValidPub(sp)) || !(await isValidPub(ep))) {
      await this.endEntry(from, T.pairFailed, false);
      return this.dropEvent("unreadable", null, src);
    }
    const rX = b64urlDecode(e.r);
    const pid = await pairingId(rN, rX);
    await this.db.pin(from, sp, ep, pid, peer);
    const fp = await pairingFingerprint(sp, ep, self.sign_pub, self.enc_pub, rN, rX);
    await this.p.storageLocal.set({
      [pairKeyOf(from)]: { ...e, state: "shown", fingerprint: fp, keys: { sign_pub: b64urlEncode(sp), enc_pub: b64urlEncode(ep) } } satisfies PairEntry,
    });
    await this.pairNotice(e.pk, T.pairOpen(fp));
  }

  /** Ends a pairing entry (r wiped). dropPin: also drop any pin made by this pairing. */
  private async endEntry(id: string, message: string | null, dropPin: boolean): Promise<void> {
    await this.p.storageLocal.remove([pairKeyOf(id)]);
    if (message) await this.p.storageLocal.set({ [PAIR_MSG_PREFIX + id]: message });
    if (dropPin) {
      const peer = await this.db.peer(id);
      if (peer && peer.pinned && !peer.approve_verified) await this.db.unpin(id);
    }
  }

  // ------------------------------------------------------- pairing actions

  /** [Pair] on an unpinned row (step 2). */
  async pairStart(x: string): Promise<void> {
    await this.lock.run(async () => {
      const self = await this.self();
      const peer = await this.db.peer(x);
      if (!self || !peer || peer.removed) throw new UserError("Unknown device");
      if (peer.pinned) throw new UserError("Already paired");
      if (await getEntry(this.p.storageLocal, x)) throw new UserError("A pairing with this device is already open");
      const rN = randomBytes(32);
      const cN = await commitHash(self.sign_pub, self.enc_pub, rN);
      const msg = await encodePair(b64urlDecode(self.id), { kind: "commit", c_N: cN }, x, peer.enc_pub);
      const e: PairEntry = {
        role: "N",
        state: "committed",
        pk: await pairingKey(b64urlDecode(self.id), b64urlDecode(x)),
        r: b64urlEncode(rN),
        c_N: b64urlEncode(cN),
        started: now(this.p),
        msg,
      };
      await this.p.storageLocal.remove([PAIR_MSG_PREFIX + x]);
      await this.p.storageLocal.set({ [pairKeyOf(x)]: e });
      await this.sendStored(x, "commit", self);
    });
  }

  private async sendStored(x: string, kind: "commit" | "open", self: SelfKeys): Promise<void> {
    const e = await getEntry(this.p.storageLocal, x);
    if (!e || !e.msg) return;
    const res = await this.postPair(x, kind, e.msg, self);
    const cur = await getEntry(this.p.storageLocal, x);
    if (!cur) return;
    const upd: PairEntry = { ...cur, last_send: now(this.p), last_result: res.result };
    if (res.notBefore) upd.not_before = res.notBefore;
    await this.p.storageLocal.set({ [pairKeyOf(x)]: upd });
  }

  /** [Send again] on N: same commit (committed) or same open (shown); 60 s after the last send. */
  async pairSendAgain(x: string): Promise<void> {
    const self = await this.self();
    const e = await getEntry(this.p.storageLocal, x);
    if (!self || !e || e.role !== "N") return;
    const t = now(this.p);
    if (e.last_send && t - e.last_send < SEND_AGAIN_MS) return;
    if (e.not_before && t < e.not_before) {
      this.p.alarmAt("pair:" + x, Math.max(e.not_before, t + 30_000));
      return;
    }
    if (e.state === "committed") await this.sendStored(x, "commit", self);
    else if (e.state === "shown" && !(await this.db.peer(x))?.approve_verified) await this.sendStored(x, "open", self);
  }

  /** [Reply] tap on a prompted X entry (not counted in the cap). */
  async pairReplyTap(x: string): Promise<void> {
    await this.lock.run(async () => {
      const e = await getEntry(this.p.storageLocal, x);
      if (!e || e.role !== "X" || e.state !== "prompted") return;
      await this.p.storageLocal.set({ [pairKeyOf(x)]: { ...e, authorized: true, unsent: true } satisfies PairEntry });
    });
    await this.sendReply(x);
  }

  /** Approve on a peer in state shown (step 7). */
  async approve(x: string): Promise<string> {
    const self = await this.self();
    const e = await getEntry(this.p.storageLocal, x);
    let peer = await this.db.peer(x);
    if (!self || !peer || !peer.pinned || !peer.pairing_id) throw new UserError("Pair first");
    if (e && e.state !== "shown") throw new UserError("Pair first");
    // field-level update on the current row (I286, I287): a concurrent pushed approve or reserveN is kept
    peer =
      (await this.db.updatePeer(x, (cur) => {
        if (!cur) return null;
        const r: PeerRow = { ...cur, ruling: "approved", denies_me: false };
        if (r.pending_approve_n > 0) return { ...r, approves_me: true, approve_verified: true, get_after_verify: false, pending_approve_n: 0 };
        return r;
      })) ?? peer;
    const name = await this.myName();
    const body = await this.buildApprove(x, self, name);
    if (e) await this.p.storageLocal.set({ [pairKeyOf(x)]: { ...e, approved: true, approve_body: body, approve_name: name } satisfies PairEntry });
    if (peer.approve_verified) await this.p.storageLocal.remove([pairKeyOf(x)]);
    const r = await this.postApprove(x, body, self);
    await this.rebuildMenus();
    return r;
  }

  private async buildApprove(x: string, self: SelfKeys, name: string): Promise<string> {
    const peer = (await this.db.peer(x))!;
    const n = await this.db.reserveN(x);
    const entry = await makeNameEntry(self.sign.privateKey, self.id, x, peer.pairing_id!, n, name);
    const c = await encodeInner({
      signKey: self.sign.privateKey,
      fromId: b64urlDecode(self.id),
      pairingId: peer.pairing_id!,
      keys: { sign_pub: self.sign_pub, enc_pub: self.enc_pub },
      json: buildJson(n, { type: "approve", entry }),
      recipientId: x,
      recipientEncPub: peer.enc_pub,
    });
    const nameCt = await sealNameEntry(entry, x, peer.enc_pub);
    return JSON.stringify({ c, name: nameCt });
  }

  /** POST /approve with stored bytes; the allow set gets x BEFORE the POST. */
  private async postApprove(x: string, body: string, self: SelfKeys, quiet = false): Promise<string> {
    const allow = await getAllowSet(this.p.storageLocal);
    if (!allow.includes(x)) await this.p.storageLocal.set({ [ALLOW_SET]: [...allow, x] });
    let result: string;
    let notBefore: number | undefined;
    let built = body;
    let calls = 0;
    try {
      const r = await this.api.call("POST", "/approve/" + x, {
        signer: this.signerOf(self),
        // first try: the stored bytes; after a 401 "clock skew": a new n, re-encrypted
        build: async () => {
          if (calls++ > 0) built = await this.buildApprove(x, self, await this.myName());
          return JSON.parse(built) as unknown;
        },
      });
      await this.afterSignedReply(r);
      result = typeof r.json.r === "string" ? r.json.r : "failed";
      if (typeof r.json.c === "string") await this.receive(r.json.c, "returned");
    } catch (err) {
      if (err instanceof ApiError && err.error === "clock skew twice") result = T.clockOff;
      else {
        const f = await this.callFailure(err);
        result = f.result;
        notBefore = f.notBefore;
      }
      if (quiet) return result;
    }
    const e = await getEntry(this.p.storageLocal, x);
    if (e) {
      const upd: PairEntry = { ...e, approve_result: result, approve_last: now(this.p), approve_body: built };
      if (notBefore) upd.not_before = notBefore;
      await this.p.storageLocal.set({ [pairKeyOf(x)]: upd });
    }
    if (result === "denied") {
      await this.db.updatePeer(x, (p) => (p ? { ...p, denies_me: true } : null));
      await this.p.storageLocal.remove([pairKeyOf(x)]);
    }
    return result;
  }

  /** Re-fetch while waiting (I265): same bytes, or a fresh approve after a rename (I280). */
  async refetchWaiting(): Promise<void> {
    for (const [x, e] of await allEntries(this.p.storageLocal)) {
      if (e.approved && e.approve_body) await this.refetchOne(x);
    }
  }

  /** One re-send of POST /approve/$X for a "Waiting for $X" row; maps the result for pairTimeout. */
  private async refetchOne(x: string): Promise<ResendResult> {
    const self = await this.self();
    const e = await getEntry(this.p.storageLocal, x);
    const peer = await this.db.peer(x);
    if (!self || !e || !e.approve_body || !peer) return null;
    if (peer.approve_verified) return "200_c_verified";
    if ((await this.regState()) !== "registered") return "logged out";
    let body = e.approve_body;
    const name = await this.myName();
    if (e.approve_name !== name) {
      body = await this.buildApprove(x, self, name);
      await this.p.storageLocal.set({ [pairKeyOf(x)]: { ...e, approve_body: body, approve_name: name } satisfies PairEntry });
    }
    const result = await this.postApprove(x, body, self, true);
    if ((await this.db.peer(x))?.approve_verified) return "200_c_verified";
    if (result === "network") return "offline";
    if (result.startsWith("401 logged out")) return "logged out";
    if (result.startsWith("429")) return "429";
    if (/^5[0-9][0-9]/.test(result)) return "5xx";
    if (/^[0-9]{3}/.test(result)) return "200_other";
    return "200_other";
  }

  /** Deny on an unpinned row or a pairing in state shown. */
  async deny(x: string): Promise<string> {
    const self = await this.self();
    const peer = await this.db.peer(x);
    if (!self || !peer) throw new UserError("Unknown device");
    const pid = peer.pairing_id ?? new Uint8Array(8);
    const n = await this.db.reserveN(x);
    const c = await encodeInner({
      signKey: self.sign.privateKey,
      fromId: b64urlDecode(self.id),
      pairingId: pid,
      json: buildJson(n, { type: "deny" }),
      recipientId: x,
      recipientEncPub: peer.enc_pub,
    });
    await this.p.storageLocal.remove([pairKeyOf(x)]);
    if (peer.pinned) await this.db.unpin(x);
    await this.db.updatePeer(x, (p) => (p ? { ...p, ruling: "denied" } : null));
    let result: string;
    try {
      const r = await this.api.call("POST", "/deny/" + x, { signer: this.signerOf(self), body: { c } });
      result = typeof r.json.r === "string" ? r.json.r : "failed";
    } catch (e) {
      result = (await this.callFailure(e)).result;
    }
    await this.rebuildMenus();
    return result;
  }

  /** Cancel pairing (I264, I279): local drop, then the allow reconcile. */
  async cancelPairing(x: string): Promise<void> {
    await this.lock.run(async () => {
      await this.p.storageLocal.remove([pairKeyOf(x), PAIR_MSG_PREFIX + x]);
      this.p.clearAlarm("pair:" + x);
      const peer = await this.db.peer(x);
      if (peer && peer.pinned) await this.db.unpin(x);
    });
    await this.rebuildMenus();
    await this.reconcileAllow();
  }

  /** [Pair again] on a half-state row: Cancel pairing (local drop + allow reconcile), then [Pair]. */
  async pairAgain(x: string): Promise<void> {
    if (this.pairingAgain.has(x)) return; // a second click while it runs
    this.pairingAgain.add(x);
    try {
      await this.cancelPairing(x);
      await this.pairStart(x);
    } finally {
      this.pairingAgain.delete(x);
    }
  }

  /** Allow reconcile (I277, I278): withdraw every id in the allow set with no pin. */
  async reconcileAllow(): Promise<void> {
    const self = await this.self();
    if (!self) return;
    const set = await getAllowSet(this.p.storageLocal);
    for (const id of set) {
      const peer = await this.db.peer(id);
      if (peer?.pinned) continue;
      let remove = false;
      try {
        await this.api.call("POST", "/deny/" + id, { signer: this.signerOf(self), body: { withdraw: 1 } });
        remove = true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 400) remove = true;
        else if (e instanceof ApiError && e.status === 401 && e.error === "unknown peer") {
          await this.selfRemoved(T.removed);
          return;
        }
      }
      if (remove) {
        const cur = await getAllowSet(this.p.storageLocal);
        await this.p.storageLocal.set({ [ALLOW_SET]: cur.filter((v) => v !== id) });
      }
    }
  }

  /** Sweep: expired entries (14 days), unsent replies. Runs at start and on the fetch alarm. */
  async sweep(): Promise<void> {
    const t = now(this.p);
    let dropped = false;
    for (const [x, e] of await allEntries(this.p.storageLocal)) {
      if (e.started + PAIRING_TIMEOUT_MS > t) {
        if (e.role === "X" && e.authorized && e.unsent) await this.sendReply(x);
        continue;
      }
      const peer = await this.db.peer(x);
      let resend: ResendResult = null;
      for (;;) {
        const act = pairTimeout(!!peer?.approve_verified, !!e.approved, resend);
        if (act === "resend") {
          resend = await this.refetchOne(x);
          continue;
        }
        if (act === "keep_pin" || act === "complete") await this.p.storageLocal.remove([pairKeyOf(x)]);
        else if (act === "drop_pin") {
          await this.endEntry(x, T.pairTimedOut, true);
          dropped = true;
        }
        break;
      }
    }
    if (dropped) await this.reconcileAllow();
  }

  /** Popup open, Refresh, login: the re-fetch of waiting rows, then the timeout sweep. */
  async timeoutCheck(): Promise<void> {
    await this.refetchWaiting();
    await this.sweep();
  }

  // ---------------------------------------------------------------- fetch

  /** Fetch trigger with 60 s coalescing (persisted alarm + pending flag). */
  async fetchTrigger(): Promise<void> {
    const t = now(this.p);
    const last = (await this.db.meta<number>("last_fetch")) ?? 0;
    if (t - last >= FETCH_WINDOW_MS && !this.fetching) {
      await this.fetchPeersNow().catch(() => undefined);
      return;
    }
    await this.db.setMeta("fetch_pending", true);
    this.p.alarmAt("fetch", Math.max(last + FETCH_WINDOW_MS, t + 1000));
  }

  async onFetchAlarm(): Promise<void> {
    if (await this.db.meta<boolean>("fetch_pending")) {
      await this.db.setMeta("fetch_pending", false);
      await this.fetchPeersNow().catch(() => undefined);
    }
    await this.sweep();
  }

  async fetchPeersNow(): Promise<void> {
    if (this.fetching) return this.fetching;
    this.fetching = this.doFetch().finally(() => {
      this.fetching = null;
    });
    return this.fetching;
  }

  private async doFetch(): Promise<void> {
    const self = await this.self();
    if (!self) return;
    const nb = ((await this.p.storageLocal.get([NET_NOT_BEFORE]))[NET_NOT_BEFORE] as number | undefined) ?? 0;
    if (now(this.p) < nb) {
      await this.db.setMeta("fetch_pending", true);
      this.p.alarmAt("fetch", Math.max(nb, now(this.p) + 30_000));
      return;
    }
    await this.db.setMeta("last_fetch", now(this.p));
    let r: ApiReply;
    try {
      r = await this.api.call("GET", "/peers", { signer: this.signerOf(self) });
    } catch (e) {
      const f = await this.callFailure(e);
      if (f.notBefore) await this.p.storageLocal.set({ [NET_NOT_BEFORE]: f.notBefore });
      throw e;
    }
    await this.mergePeers(r.json, self);
    await this.afterSignedReply(r);
    await this.reconcileAllow();
  }

  /** GET /peers merge (section 4.2, catalog Removal rules). */
  async mergePeers(json: Record<string, unknown>, self: SelfKeys): Promise<void> {
    const acct = accountOf(b64urlDecode(self.id));
    const list = Array.isArray(json.peers) ? (json.peers as Record<string, unknown>[]) : [];
    const myAllow = Array.isArray(json.my_allow) ? (json.my_allow as unknown[]).filter((v): v is string => typeof v === "string") : [];
    await this.p.storageLocal.set({ [ALLOW_SET]: myAllow });
    const seen = new Set<string>();
    for (const it of list) {
      if (typeof it.id !== "string" || it.id === self.id) continue;
      const id = b64urlTryDecode(it.id);
      const sp = typeof it.sign_pub === "string" ? b64urlTryDecode(it.sign_pub) : null;
      const ep = typeof it.enc_pub === "string" ? b64urlTryDecode(it.enc_pub) : null;
      if (!id || id.length !== ID_LEN || !sp || !ep) continue;
      if (!(await validPeerEntry(id, sp, ep, acct))) continue;
      const platform = (["android", "ios", "chrome", "firefox", "cli"] as const).includes(it.platform as Platform4) ? (it.platform as Platform4) : "android";
      const created = typeof it.created === "number" ? it.created : 0;
      const snap = await this.db.peer(it.id);
      if (snap?.removed) continue;
      seen.add(it.id);
      if (snap?.pinned && (!equal(snap.sign_pub, sp) || !equal(snap.enc_pub, ep))) {
        // keys changed, not trusted: plain drop of the list keys (a Worker list never pins)
        console.warn("peer keys changed in list; ignored", it.id);
      }
      // name entry checked against the snapshot; applied below only if the row still matches
      let nameCand: { name: string; n: number; pairing_id: Uint8Array; sign_pub: Uint8Array } | null = null;
      if (snap && snap.pinned && snap.ruling === "approved" && typeof it.name_for_me === "string" && snap.pairing_id) {
        const ent = await openNameEntry(self.enc, self.id, it.name_for_me);
        if (ent && ent.n > snap.name_n) {
          const nm = await verifyNameEntry(snap.sign_pub, snap.id, self.id, snap.pairing_id, ent);
          if (nm !== null) nameCand = { name: nm, n: ent.n, pairing_id: snap.pairing_id, sign_pub: snap.sign_pub };
        }
      }
      // field-level update on the current row in one transaction (I286): a concurrent reserveN is kept
      await this.db.updatePeer(it.id, (cur) => {
        let row = cur ?? newPeerRow(it.id as string, sp, ep, platform, created);
        if (row.removed) return null;
        if (!row.pinned) row = { ...row, sign_pub: sp, enc_pub: ep };
        row = {
          ...row,
          platform,
          created,
          logged_out: it.logged_out === true,
          listening: it.listening !== false,
          reachable: it.reachable === true,
          denies_me: it.denies_me === true,
          missing: false,
        };
        if (row.pinned && row.approve_verified) row = { ...row, approves_me: it.approves_me === true, get_after_verify: true };
        else if (!row.pinned) row = { ...row, approves_me: it.approves_me === true };
        if (
          nameCand &&
          row.pinned &&
          row.ruling === "approved" &&
          row.pairing_id &&
          equal(row.pairing_id, nameCand.pairing_id) &&
          equal(row.sign_pub, nameCand.sign_pub) &&
          nameCand.n > row.name_n
        )
          row = { ...row, name: nameCand.name, name_n: nameCand.n };
        return row;
      });
    }
    for (const row of await this.db.peers()) {
      if (seen.has(row.id) || row.removed) continue;
      if (row.ruling === "approved") {
        if (!row.missing) await this.db.updatePeer(row.id, (p) => (p ? { ...p, missing: true } : null));
      } else {
        if (await getEntry(this.p.storageLocal, row.id)) continue;
        await this.db.del("peers", row.id);
        await this.db.del("replay", row.id);
      }
    }
    await this.db.setMeta("listed", [...seen]);
    await this.db.setMeta("my_push_sha256", typeof json.my_push_sha256 === "string" ? json.my_push_sha256 : null);
    await this.rebuildMenus();
  }

  /** push_missing in any signed reply -> re-subscribe and PATCH. */
  private async afterSignedReply(r: ApiReply): Promise<void> {
    if (r.json.push_missing === true) await this.pushReconcile(true).catch(() => undefined);
  }

  // ------------------------------------------------------------------ push

  /** Gone recovery: compare the current subscription with the last PATCHed hash. */
  async pushReconcile(force = false, quiet = false): Promise<void> {
    const self = await this.self();
    if (!self || (await this.regState()) !== "registered") return;
    let cur = await this.currentPush();
    if (!cur || force) cur = await this.subscribePush(quiet);
    if (!cur) return;
    const h = await pushHash(cur);
    const last = await this.db.meta<string>("push_hash");
    if (!force && last === h) return;
    await this.api.call("PATCH", "/peers/" + self.id, { signer: this.signerOf(self), body: { push: cur } });
    await this.db.setMeta("push_hash", h);
  }

  /** The push PATCHed for this platform (Firefox: autopush or the site fallback). */
  async currentPush(): Promise<PushFields | null> {
    return this.p.pushCurrent();
  }

  async subscribePush(quiet = false): Promise<PushFields | null> {
    try {
      return await this.p.pushSubscribe(this.vapid, quiet);
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ send

  /** The All set (catalog): approved by me, approves me, not hidden, not logged out, listening, not missing. */
  async allSet(): Promise<PeerRow[]> {
    return (await this.db.peers()).filter(
      (p) => p.pinned && p.ruling === "approved" && p.approves_me && !p.hidden && !p.logged_out && p.listening !== false && !p.missing && !p.removed,
    );
  }

  /** engine.send (section 10). */
  async send(text: string, asText: boolean, targets: string[] | "all"): Promise<SendResult> {
    const self = await this.self();
    if (!self) throw new UserError(T.signedOut);
    const all = await this.allSet();
    const ids = targets === "all" ? all.map((p) => p.id) : targets.filter((t) => all.some((p) => p.id === t));
    const total = all.length;
    const len = utf8Len(text);
    if (len > CONTENT_CAP) throw new UserError(T.tooLong(len));
    let type: SendType = asText ? "text" : detectType(text);
    let value = text;
    if (type === "url") {
      const u = parseHttpUrl(text.replace(/^[\t\n\f\r \u00a0]+|[\t\n\f\r \u00a0]+$/g, ""));
      if (u) value = u.href;
      else type = "text";
    }
    const valueLen = utf8Len(value);
    if (valueLen > CONTENT_CAP) throw new UserError(T.tooLong(valueLen)); // href percent-encodes
    if (ids.length === 0) return { sent: 0, total, failures: [] };
    const build = async () => {
      const m: Record<string, string> = {};
      for (const id of ids) {
        const peer = (await this.db.peer(id))!;
        const n = await this.db.reserveN(id);
        m[id] = await encodeInner({
          signKey: self.sign.privateKey,
          fromId: b64urlDecode(self.id),
          pairingId: peer.pairing_id!,
          json: buildJson(n, { type, value } as Content),
          recipientId: id,
          recipientEncPub: peer.enc_pub,
        });
      }
      return { v: 1, m };
    };
    let results: Record<string, string> = {};
    let error: string | undefined;
    try {
      const r = await this.api.call("POST", "/send", { signer: this.signerOf(self), build });
      await this.afterSignedReply(r);
      if (r.json.r && typeof r.json.r === "object") results = r.json.r as Record<string, string>;
    } catch (e) {
      await this.callFailure(e);
      error = e instanceof ApiError && e.status === 401 && e.error === "unknown peer" ? T.removed : errorText(e);
      if (e instanceof ApiError && (e.status === 429 || e.status === 503) && e.retryAfter !== null) {
        await this.p.storageLocal.set({ [NET_NOT_BEFORE]: now(this.p) + e.retryAfter * 1000 });
      }
    }
    const failures: SendResult["failures"] = [];
    let sent = 0;
    let trigger = false;
    for (const id of ids) {
      const res = results[id] ?? (error ? "failed" : "failed");
      if (res === "sent") {
        sent++;
        continue;
      }
      const nm = await this.peerName(id);
      failures.push({ id, result: res, text: error ? nm + ": " + error : sendResultText(nm, res) });
      if (res === "unapproved" || res === "unknown" || res === "gone") trigger = true;
      if (res === "logged out") {
        await this.db.updatePeer(id, (p) => (p ? { ...p, logged_out: true } : null));
      }
      if (res === "not listening") {
        await this.db.updatePeer(id, (p) => (p ? { ...p, listening: false } : null));
      }
    }
    await this.db.addHistory({
      dir: "out",
      peer: null,
      type,
      content: value,
      n: null,
      pairing_id: null,
      received: now(this.p),
      read: true,
      results,
      targets: ids,
    });
    if (trigger) await this.fetchTrigger();
    const out: SendResult = { sent, total, failures };
    if (error) out.error = error;
    return out;
  }

  // -------------------------------------------- allow-list m (logout etc.)

  /** The caller's allow list: every id this device approved (pinned). */
  private async allowList(): Promise<PeerRow[]> {
    return (await this.db.peers()).filter((p) => p.pinned && p.ruling === "approved" && !p.removed);
  }

  /**
   * Builds m for every id in the allow list (plus named extra ids that hold a
   * pin). mk returns the message content for one peer and its reserved n.
   */
  private async buildM(self: SelfKeys, mk: (p: PeerRow, n: number) => Promise<Content>, extra: string[]): Promise<Record<string, string>> {
    const m: Record<string, string> = {};
    const peers = await this.allowList();
    for (const id of extra) {
      const p = await this.db.peer(id);
      if (p && p.pinned && p.pairing_id && !peers.some((q) => q.id === id)) peers.push(p);
    }
    for (const p of peers) {
      const n = await this.db.reserveN(p.id);
      m[p.id] = await encodeInner({
        signKey: self.sign.privateKey,
        fromId: b64urlDecode(self.id),
        pairingId: p.pairing_id!,
        json: buildJson(n, await mk(p, n)),
        recipientId: p.id,
        recipientEncPub: p.enc_pub,
      });
    }
    return m;
  }

  /** Signed call whose m covers the allow list; 400 "messages missing" -> reconcile + one retry. */
  private async allowListCall(
    method: string,
    path: string,
    self: SelfKeys,
    body: (m: Record<string, string>) => unknown,
    mk: (p: PeerRow, n: number) => Promise<Content>,
    withId = true,
  ): Promise<ApiReply> {
    let extra: string[] = [];
    const signer = { id: withId ? self.id : null, key: self.sign.privateKey };
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await this.api.call(method, path, { signer, build: async () => body(await this.buildM(self, mk, extra)) });
        await this.afterSignedReply(r);
        return r;
      } catch (e) {
        if (attempt === 0 && e instanceof ApiError && e.status === 400 && e.error === "messages missing") {
          const named = Array.isArray(e.body.ids) ? (e.body.ids as unknown[]).filter((v): v is string => typeof v === "string") : [];
          const set = await getAllowSet(this.p.storageLocal);
          await this.p.storageLocal.set({ [ALLOW_SET]: [...new Set([...set, ...named])] });
          await this.reconcileAllow();
          extra = named;
          continue;
        }
        if (e instanceof ApiError && e.status === 401 && e.error === "unknown peer") await this.selfRemoved(T.removed);
        throw e;
      }
    }
  }

  /** Log out (catalog Logout rules): logged out here at once, then the relay server call. */
  async logout(): Promise<void> {
    await this.logoutLocal();
    await this.retryPendingLogout();
  }

  /**
   * Log out click (Q368): logged out here at once, with the relay server call kept as
   * pending so it is sent now and again on later opens until it goes through.
   */
  async logoutLocal(): Promise<void> {
    // no keys on this device: nothing to log out on the relay server; drop what is left
    if (!(await this.self())) return this.wipe();
    await this.db.setMeta(LOGOUT_PENDING, true);
    await this.setReg("logged_out");
  }

  /** Sends a pending logout; one at a time. */
  retryPendingLogout(): Promise<void> {
    return (this.loggingOut ??= this.sendPendingLogout().finally(() => {
      this.loggingOut = null;
    }));
  }

  /**
   * It stays pending on no reply, 429, 5xx, or clock skew; it is dropped once the relay
   * server answered otherwise, or when this device was removed or logged in again.
   */
  private async sendPendingLogout(): Promise<void> {
    if (!(await this.db.meta(LOGOUT_PENDING))) return;
    const self = await this.self();
    if (self && (await this.regState()) === "logged_out") {
      try {
        await this.reconcileAllow();
        await this.allowListCall("POST", "/peers/" + self.id + "/logout", self, (m) => ({ m }), async () => ({ type: "logout" }));
      } catch (e) {
        if (!(e instanceof ApiError) || e.status === 0 || e.status === 429 || e.status >= 500 || e.error.startsWith("clock skew")) return;
      }
    }
    await this.db.del("meta", LOGOUT_PENDING);
  }

  async login(ticket: string): Promise<void> {
    const self = await this.self();
    if (!self) return;
    await this.reconcileAllow();
    await this.allowListCall("POST", "/peers/" + self.id + "/login", self, (m) => ({ ticket, m }), async () => ({ type: "login" }));
    await this.setReg("registered");
    await this.db.del("meta", LOGOUT_PENDING);
    await this.fetchPeersNow().catch(() => undefined);
    await this.pushReconcile().catch(() => undefined);
    await this.timeoutCheck();
  }

  /** Rename: one name entry and one rename message per allow-list peer, same n (I269, I280). */
  async rename(name: string): Promise<void> {
    const self = await this.self();
    if (!self) return;
    if (!isPrintableName(name)) throw new UserError("Use 1 to 32 plain ASCII characters, no double quote.");
    let names: Record<string, string> = {};
    await this.allowListCall(
      "PATCH",
      "/peers/" + self.id,
      self,
      (m) => {
        const body = { name: names, m };
        names = {};
        return body;
      },
      async (p, n) => {
        const entry = await makeNameEntry(self.sign.privateKey, self.id, p.id, p.pairing_id!, n, name);
        names[p.id] = await sealNameEntry(entry, p.id, p.enc_pub);
        return { type: "rename", entry };
      },
    );
    await this.db.setMeta("my_name", name);
  }

  async remove(x: string): Promise<void> {
    const self = await this.self();
    if (!self) return;
    await this.allowListCall("DELETE", "/peers/" + x, self, (m) => ({ m }), async () => ({ type: "remove", id: x }));
    if (x === self.id) {
      await this.selfRemoved(T.removed);
      return;
    }
    const p = await this.db.peer(x);
    if (p) await this.markRemoved(p);
    await this.rebuildMenus();
  }

  async deleteAccount(ticket: string): Promise<void> {
    const self = await this.self();
    if (!self) return;
    await this.allowListCall("DELETE", "/account", self, (m) => ({ ticket, sign_pub: b64urlEncode(self.sign_pub), m }), async () => ({ type: "delete" }), false);
    await this.wipe();
    await this.db.setMeta("banner", null);
  }

  private async markRemoved(p: PeerRow): Promise<void> {
    await this.p.storageLocal.remove([pairKeyOf(p.id)]);
    await this.db.unpin(p.id);
    await this.db.updatePeer(p.id, (cur) => (cur ? { ...cur, removed: true, ruling: "none", hidden: false, missing: false, name: p.name } : null));
  }

  /** Local Delete of a missing row: drop the pin and the shortcut, keep history, no Worker call. */
  async localDelete(x: string): Promise<void> {
    await this.p.storageLocal.remove([pairKeyOf(x)]);
    await this.db.del("peers", x);
    await this.db.del("replay", x);
    await this.rebuildMenus();
  }

  async setHidden(x: string, hidden: boolean): Promise<void> {
    await this.db.updatePeer(x, (p) => (p ? { ...p, hidden } : null));
    await this.rebuildMenus();
  }

  // ------------------------------------------------------- removal / wipe

  async selfRemoved(banner: string): Promise<void> {
    await this.wipe();
    await this.db.setMeta("banner", banner);
    await this.authChanged();
  }

  /** The one wipe routine (section 4.1). History is kept. */
  async wipe(): Promise<void> {
    await this.p.storageLocal.remove([REG_MARKER]);
    await this.db.clear(["keys", "peers", "replay"]);
    for (const k of ["reg", LOGOUT_PENDING, "push_hash", "listed", "my_push_sha256", "fetch_pending", "last_fetch"]) await this.db.del("meta", k);
    const all = await this.p.storageLocal.get(null);
    const drop = Object.keys(all).filter((k) => k.startsWith(PAIR_PREFIX) || k.startsWith(PAIR_MSG_PREFIX) || k === PAIR_AUTO || k === ALLOW_SET || k === NET_NOT_BEFORE);
    await this.p.storageLocal.remove(drop);
    await this.p.pushUnsubscribe().catch(() => undefined);
    await this.p.clearAllNotifications().catch(() => undefined);
    await this.rebuildMenus();
    await this.authChanged();
  }

  // ------------------------------------------------------------ menus

  async rebuildMenus(): Promise<void> {
    const s = await this.settings();
    const peers = (await this.allSet()).map((p) => ({ id: p.id, name: peerLabel(p.name) }));
    this.p.menusRebuild(peers, s.showAll);
  }

  // ------------------------------------------------------------- views

  /** Row text helpers for the Peers screen. */
  async pairRowView(x: string): Promise<{ lines: string[]; actions: string[]; countdown: string | null; fingerprint: string | null } | null> {
    const e = await getEntry(this.p.storageLocal, x);
    const peer = await this.db.peer(x);
    if (!e || !peer) return null;
    const nm = peerLabel(peer.name);
    const t = now(this.p);
    const lines: string[] = [];
    const actions: string[] = e.half && peer.pinned ? ["pair_again", "cancel"] : ["cancel"];
    const countdown = formatCountdown(e.started + PAIRING_TIMEOUT_MS - t);
    if (e.approved && !peer.approve_verified) {
      lines.push(T.waiting(nm));
      if (e.approve_result && e.approve_result !== "sent" && e.approve_result !== "stored" && e.approve_result !== "denied") actions.push("approve_again");
    } else if (e.state === "committed") {
      lines.push(T.pairingWith(nm), T.pairing);
      const hint = pairHint((await this.db.meta<string[]>("listed"))?.includes(x) ? peer.approves_me : null, t - e.started);
      if (hint === "still_holds") lines.push(T.stillHolds(nm));
      else if (hint === "no_reply_yet") lines.push(T.noReplyYet(nm));
      actions.push("send_again");
    } else if (e.state === "prompted") {
      lines.push(T.wantsToPair(nm), T.pairing);
      actions.push("reply");
    } else if (e.state === "replied") {
      lines.push(T.pairing);
    } else if (e.state === "shown") {
      lines.push(T.fingerprint(e.fingerprint ?? "????"));
      actions.push("approve", "deny");
      if (e.role === "N") actions.push("send_again");
    }
    return { lines, actions, countdown, fingerprint: e.fingerprint ?? null };
  }

  // -------------------------------------------------------- registration

  /** Keys for sign-in: existing keys (logout) or fresh ones (first sign-in, after a removal). */
  async signInKeys(): Promise<SelfKeys> {
    const cur = await this.db.self();
    if (cur) return cur;
    const k = await generateKeySet();
    const s: SelfKeys = { sign: k.sign, enc: k.enc, sign_pub: k.sign_pub, enc_pub: k.enc_pub, id: "" };
    await this.db.put("keys", s, "self");
    return s;
  }

  /** Key-loss check at start: marker present and the IDB keys store empty. */
  async keysLost(): Promise<boolean> {
    const m = (await this.p.storageLocal.get([REG_MARKER]))[REG_MARKER] as { id: string; registered: boolean } | undefined;
    if (!m || !m.registered) return false;
    return !(await this.db.self());
  }

  /** POST /peers with a "register" ticket. Returns the 409 "peer limit" body when the picker is needed. */
  async register(ticket: string, email: string | null, evict?: string[]): Promise<Record<string, unknown> | null> {
    const lost = (await this.p.storageLocal.get([REG_MARKER]))[REG_MARKER] as { id: string; registered: boolean } | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const keys = await this.signInKeys();
      const body: Record<string, unknown> = {
        ticket,
        sign_pub: b64urlEncode(keys.sign_pub),
        enc_pub: b64urlEncode(keys.enc_pub),
        platform: this.p.platformName,
        push: null,
      };
      if (evict && evict.length) body.evict = evict;
      let r: ApiReply;
      try {
        r = await this.api.call("POST", "/peers", { signer: { id: null, key: keys.sign.privateKey }, body });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.error === "peer limit") return e.body;
        if (e instanceof ApiError && e.status === 409 && e.error === "id collision") {
          await this.db.clear(["keys"]);
          continue;
        }
        throw e;
      }
      const id = typeof r.json.id === "string" ? r.json.id : "";
      const idb = b64urlTryDecode(id);
      // the id must carry our own keyhash, or peers drop every message from us
      if (!idb || idb.length !== ID_LEN || !equal(idb.subarray(ACCOUNT_LEN, ACCOUNT_LEN + KEYHASH_LEN), await keyhash(keys.sign_pub, keys.enc_pub)))
        throw new UserError(T.badReply);
      await this.db.put("keys", { ...keys, id }, "self");
      await this.p.storageLocal.set({ [REG_MARKER]: { id, registered: true } });
      await this.db.setMeta("reg", "registered");
      await this.db.setMeta("banner", null);
      if (email) await this.db.setMeta("email", email);
      await this.authChanged();
      const self = (await this.self())!;
      await this.mergePeers(r.json, self);
      if (lost && lost.id && lost.id !== id) {
        try {
          await this.api.call("DELETE", "/peers/" + lost.id, { signer: this.signerOf(self), body: { m: {} } });
        } catch {
          // 400 "bad request" counts as done; other errors: the peers mark it missing
        }
      }
      await this.pushReconcile().catch(() => undefined);
      return null;
    }
    throw new UserError("Could not register. Try again.");
  }

  async start(): Promise<void> {
    if (await this.keysLost()) {
      await this.db.setMeta("banner", T.keysLost);
      return;
    }
    if (!(await this.self())) return;
    await this.sweep();
    await this.pushReconcile().catch(() => undefined);
    await this.purgeHistory();
    await this.rebuildMenus();
  }

  async purgeHistory(): Promise<void> {
    const s = await this.settings();
    await this.db.purgeHistory(now(this.p) - s.historyDays * 86400_000);
  }

  /** Popup open: re-fetch waiting approves, timeouts, reconcile, gone recovery. */
  async onPopupOpen(): Promise<void> {
    void this.retryPendingLogout().catch(() => undefined);
    if ((await this.regState()) !== "registered") return;
    await this.timeoutCheck();
    await this.reconcileAllow();
    await this.pushReconcile(false, true).catch(() => undefined); // I555: no setup tab from the popup
  }
}
