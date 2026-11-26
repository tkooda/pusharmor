// Runtime messages {op, args} from the UI pages to the background engine
// (component-webext section 3: UI pages never touch keys or counters).
import { SEND_SEL_KEY } from "../model/sendsel.ts";
import { detectType } from "../model/detect.ts";
import { utf8Len } from "../model/padding.ts";
import type { HistoryRow } from "../store/db.ts";
import { type Engine, type Settings, UserError } from "./engine.ts";
import { ActionError, RestartError, reasonOf, failText } from "./failtext.ts";
import { Login, type Purpose } from "./login.ts";
import { type Files, fileKey } from "./files.ts";
import { PAIR_AGAIN_PREFIX, PAIR_MSG_PREFIX, allEntries } from "./state.ts";
import { type ActionId, T, peerLabel, pushVendor, rowLabel } from "./texts.ts";

export interface Req {
  op: string;
  args?: Record<string, unknown>;
}

export interface Reply {
  ok: boolean;
  data?: unknown;
  error?: string;
  restart?: boolean; // the login page starts again at its first step
}

export interface PeerView {
  id: string;
  label: string;
  platform: string;
  lines: string[];
  actions: string[];
  countdown: string | null;
  fingerprint: string | null;
  pk: string | null;
  greyed: string | null;
  hidden: boolean;
  /** content may show in notifications from this device */
  allowContent?: boolean;
  sendable: boolean;
  /** the peer approves this device (peer status line) */
  approvesMe: boolean;
  /** paired both ways and no pairing in progress (none paired shows the first-device screen) */
  paired: boolean;
  /** rejected on this device: listed only under Rejected devices until it sends a new pairing request or gets Pair */
  rejected?: boolean;
  /** server added time, seconds (0 = unknown) */
  created?: number;
  /** Devices section: Waiting to pair, Pairing, or Paired devices (rejected rows go under Rejected devices) */
  section?: "waiting" | "pairing" | "paired";
  /** Codes match done here: waiting for the other device's response */
  awaiting?: boolean;
}

export interface StateView {
  reg: "registered" | "logged_out" | null;
  banner: string | null;
  email: string | null;
  name: string;
  settings: Settings;
  platform: "chrome" | "firefox";
  isAndroid: boolean;
  receiveMode: string | null;
  receiveNote: string | null;
  /** Firefox without direct push: the setup tab has not delivered a push subscription yet. */
  setupNeeded: boolean;
  /** The relay server refused this version (HTTP 426): every view shows the update screen. */
  updateRequired: boolean;
  /** "Check again" on the update screen was used less than an hour ago. */
  recheckLocked: boolean;
  /**
   * This browser cannot receive: its push service refused, it has no push service (noservice),
   * the relay server does not take its push service (unsupported), the relay server refused the push, or (fault) the relay server cannot reach the push service.
   */
  pushIssue: "refused" | "noservice" | "unsupported" | "relay" | "nostart" | "noreach" | "fault" | null;
  /** Whose push service this browser uses (Google, Mozilla, ...), for the fault message. */
  pushVendor?: string;
  /** popupOpen only: a message of a newer format version arrived and the toast was not shown yet (newerShown clears it). */
  newerSeen?: boolean;
  /** The saved keys failed the local check: every view shows the keys screen. */
  keysBroken: boolean;
  /** This build's version (manifest version), shown at the bottom of Settings. */
  version: string;
}

/** The action line of each request that can fail where the user clicked. */
const ACTION: Record<string, ActionId> = {
  send: "send",
  sendFile: "send",
  refresh: "refresh",
  rename: "rename",
  pair: "pair",
  sendAgain: "pair",
  tryAgain: "pair",
  reply: "pair",
  approve: "confirm",
  deny: "reject",
  cancel: "cancel",
  remove: "remove",
  localDelete: "remove",
  hide: "changeSetting",
  allowContent: "changeSetting",
  settings: "changeSetting",
  signout: "logout",
  historyDelete: "deleteHistory",
  keysDelete: "deleteKeys",
  emailStart: "sendCode",
  emailVerify: "checkCode",
  evict: "evict",
  authDone: "login",
};

/** A logged in, logged out, or rejected row: History lists messages, not device status. */
export const isStatusRow = (r: HistoryRow): boolean => r.type === "event" && (r.event === "logged_in" || r.event === "logged_out" || r.event === "denied");

export class Rpc {
  readonly e: Engine;
  readonly login: Login;
  /** The network work of the last popup open (popupSettled waits for it). */
  private opening: Promise<void> = Promise.resolve();
  /** The last History delete, with its relay server file deletes. */
  private fileDeletes: Promise<string | null> = Promise.resolve(null);
  constructor(e: Engine) {
    this.e = e;
    this.login = new Login(e);
  }

  private files(): Files {
    if (!this.e.files) throw new Error("files unavailable");
    return this.e.files as Files;
  }

  async handle(req: Req, senderTabId?: number): Promise<Reply> {
    try {
      return { ok: true, data: await this.dispatch(req, senderTabId) };
    } catch (err) {
      const error = await this.failure(req, err);
      return (err instanceof ActionError ? err.err : err) instanceof RestartError ? { ok: false, error, restart: true } : { ok: false, error };
    }
  }

  /** The error text for a failed request: its own action line (with the device name), then why. */
  private async failure(req: Req, err: unknown): Promise<string> {
    if (err instanceof UserError) return err.message;
    const a = req.args ?? {};
    const action =
      req.op === "oauth" ? (a.purpose === "delete-account" ? "deleteAccount" : a.provider === "apple" ? "loginApple" : "loginGoogle") : ACTION[req.op];
    if (!action) return reasonOf(err); // no action line for a view that only reads
    const selfKept = !!(await this.e.self().catch(() => null));
    let name: string | undefined;
    if (typeof a.id === "string") {
      const p = await this.e.db.peer(a.id).catch(() => undefined);
      name = peerLabel(p);
    }
    return failText(action, err, { name, selfKept });
  }

  private async dispatch(req: Req, tab?: number): Promise<unknown> {
    const a = req.args ?? {};
    const s = (k: string) => String(a[k] ?? "");
    const e = this.e;
    switch (req.op) {
      case "state":
        void e.retryPendingLogout().catch(() => undefined); // full tab open
        return this.state();
      case "recheck":
        return e.recheckUpdate();
      case "popupOpen":
        await e.probeKeys().catch(() => undefined); // local only
        // draw from the local state at once; the network work runs behind it
        this.opening = e.onPopupOpen().catch(() => undefined);
        void this.e.files?.catchUp().catch(() => undefined); // waiting files the picker allows
        void this.e.files?.gc().catch(() => undefined);
        return (await e.newerSeen()) ? { ...(await this.state()), newerSeen: true } : this.state();
      case "pushCheck": {
        const result = await e.checkPush();
        return { result, state: await this.state() };
      }
      case "newerShown":
        await e.newerShown();
        return null;
      case "popupSettled":
        // the state after that work, so the popup can update what it drew from the local state
        await this.opening;
        return this.state();
      case "keysRetry":
        await e.probeKeys();
        return null;
      case "keysDelete":
        return e.deleteBrokenKeys();
      case "peers":
        return this.peers();
      case "history":
        return this.history();
      case "historyRead": {
        const row = await e.db.get<HistoryRow>("history", Number(a.id));
        if (row) await e.db.put("history", { ...row, read: true });
        await e.updateBadge();
        return null;
      }
      case "historyOpened":
        for (const r of await e.db.history()) if (!r.read) await e.db.put("history", { ...r, read: true });
        await e.updateBadge();
        return null;
      case "historyDelete": {
        // answers once the rows are gone here; the relay server file deletes go on (historyDeleteFiles waits for them)
        let local!: (n: string | null) => void;
        const first = new Promise<string | null>((r) => (local = r));
        const all = e.deleteHistory((a.ids as number[]).map(Number), local);
        this.fileDeletes = all.catch(() => null);
        return Promise.race([first, all]);
      }
      case "historyDeleteFiles": {
        // the whole delete's notice: the device notice when there was one, else the relay server file notice
        const r = await this.fileDeletes;
        this.fileDeletes = Promise.resolve(null);
        return r;
      }
      case "sendSel":
        return ((await e.p.storageLocal.get([SEND_SEL_KEY]))[SEND_SEL_KEY] as string[] | undefined) ?? [];
      case "sendSelSet":
        await e.p.storageLocal.set({ [SEND_SEL_KEY]: Array.isArray(a.ids) ? (a.ids as unknown[]).map(String) : [] });
        return null;
      case "detect":
        return { type: detectType(s("text")), bytes: utf8Len(s("text")) };
      case "send":
        return e.send(s("text"), a.auto === true ? "auto" : a.asUrl === true ? "url" : a.asText === true ? "text" : "telOrText", Array.isArray(a.targets) ? (a.targets as string[]) : "all", Array.isArray(a.shown) ? (a.shown as string[]) : undefined);
      case "sendFile":
        return this.files().send(s("picked"), s("name"), Number(a.size), Array.isArray(a.targets) ? (a.targets as string[]) : "all", Array.isArray(a.shown) ? (a.shown as string[]) : undefined);
      case "fileDownload":
        void this.files().download(Number(a.id), false);
        return null;
      case "filesDecrypt":
        return this.files().decryptShown(typeof a.id === "number" ? a.id : null);
      case "fileStorage":
        return this.files().storageInfo();
      case "fileSave":
        return this.files().save(Number(a.id));
      case "fileSendShown":
        this.files().shown(s("picked"));
        return null;
      case "pair":
        return e.pair(s("id"));
      case "sendAgain":
        return e.pairSendAgain(s("id"));
      case "tryAgain":
        return e.pairTryAgain(s("id"));
      case "reply":
        return e.pairReplyTap(s("id"));
      case "approve":
        return e.approve(s("id"));
      case "deny":
        return e.deny(s("id"));
      case "cancel":
        return e.cancelPairing(s("id"));
      case "remove":
        return e.remove(s("id"));
      case "localDelete":
        return e.localDelete(s("id"));
      case "hide":
        return e.setHidden(s("id"), a.hidden === true);
      case "allowContent":
        return e.setAllowContent(s("id"), a.allow === true);
      case "rename":
        return e.rename(s("name"));
      case "refresh": {
        await e.fetchPeersNow();
        // PATCH only a changed push; a push the relay server lost comes back as push_missing
        await e.pushReconcile().catch(() => undefined);
        await e.timeoutCheck();
        return this.peers();
      }
      case "greyedTap":
        return e.fetchTrigger();
      case "getSettings":
        return e.settings();
      case "settings":
        return e.setSettings(a as Partial<Settings>);
      case "signout":
        await this.login.clearProgress();
        // logged out here at once; the relay server call runs after and is retried
        await e.logoutLocal();
        void e.retryPendingLogout().catch(() => undefined);
        return null;
      case "loginPurpose":
        return this.login.purpose();
      case "signinProgress":
        return this.login.progress(a.purpose ? (s("purpose") as Purpose) : await this.login.purpose());
      case "signinDraft":
        return this.login.draft(s("email"), s("purpose") as Purpose);
      case "signinClear":
        return this.login.clearProgress();
      case "emailStart":
        return this.login.emailStart(s("email"), s("turnstile"), s("purpose") as Purpose);
      case "emailVerify":
        return this.login.emailVerify(s("code"), Array.isArray(a.evict) ? (a.evict as string[]) : undefined);
      case "oauth":
        return this.login.oauthStart(s("provider") as "google" | "apple", s("purpose") as Purpose, tab);
      case "evict":
        return this.login.complete("register", s("ticket"), null, Array.isArray(a.evict) ? (a.evict as string[]) : []);
      case "authDone":
        return this.login.authDone(tab, s("hash"));
      case "fingerprintShown":
        e.p.clearNotification("p:" + s("pk"));
        return null;
      default:
        throw new UserError(T.requestFailed);
    }
  }

  async state(): Promise<StateView> {
    const e = this.e;
    const setupNeeded =
      e.p.platformName === "firefox" &&
      (e.p.isAndroid || ((await e.db.meta<string>("receive_mode")) ?? "direct") !== "direct") &&
      !(await e.db.meta("fallback_push"));
    // the Firefox setup note covers a missing push; local causes come before a relay-side fault
    const pushIssue = setupNeeded ? null : ((await e.db.meta<"refused" | "noservice" | "unsupported" | "relay" | "nostart" | "noreach">("push_issue")) ?? ((await e.db.meta<boolean>("my_relay_fault")) ? "fault" : null));
    return {
      reg: await e.regState(),
      banner: (await e.db.meta<string | null>("banner")) ?? null,
      email: (await e.db.meta<string>("email")) ?? null,
      name: await e.myName(),
      settings: await e.settings(),
      platform: e.p.platformName,
      isAndroid: e.p.isAndroid,
      receiveMode: (await e.db.meta<string>("receive_mode")) ?? null,
      receiveNote: (await e.db.meta<string>("receive_note")) ?? null,
      updateRequired: await e.updateRequired(),
      recheckLocked: await e.recheckLocked(),
      keysBroken: await e.keysBroken(),
      setupNeeded,
      pushIssue,
      version: e.p.appVersion,
      ...(pushIssue === "fault" ? { pushVendor: pushVendor((await e.currentPush().catch(() => null))?.endpoint ?? null, e.p.platformName) } : {}),
    };
  }

  async peers(): Promise<{ self: { id: string; name: string } | null; peers: PeerView[]; allowContent: boolean }> {
    const e = this.e;
    const self = await e.self();
    const entries = await allEntries(e.p.storageLocal);
    const local = await e.p.storageLocal.get(null);
    const out: PeerView[] = [];
    const t = e.p.now();
    for (const p of await e.db.peers()) {
      if (p.removed || p.id === self?.id) continue;
      const label = rowLabel(p);
      const v: PeerView = { id: p.id, label, platform: p.platform, lines: [], actions: [], countdown: null, fingerprint: null, pk: null, greyed: null, hidden: p.hidden, allowContent: p.allow_content !== false, sendable: false, approvesMe: p.approves_me, paired: false, created: p.created };
      const pv = entries.has(p.id) ? await e.pairRowView(p.id) : null;
      // no pairing started here, or the other device wants to pair again: Waiting to pair
      v.section = "waiting";
      if (pv) {
        if (entries.get(p.id)!.half && p.pinned) v.greyed = T.wantsPairAgain;
        else v.section = "pairing";
        v.lines = pv.lines;
        v.actions = pv.actions;
        v.countdown = pv.countdown;
        v.fingerprint = pv.fingerprint;
        v.awaiting = pv.awaiting;
        const ent = entries.get(p.id)!;
        v.pk = ent.pk;
        if (ent.last_send && t - ent.last_send < 60_000) v.actions = v.actions.filter((x) => x !== "send_again");
      } else if (p.missing) {
        v.section = "paired";
        v.greyed = "(missing)";
        v.actions = ["localDelete"];
      } else if (!p.pinned && p.ruling === "denied") {
        // rejected: listed under Rejected devices; a new pairing request from it or Pair here shows it again
        v.rejected = true;
        v.actions = ["pair"];
      } else if (!p.pinned) {
        v.actions = ["pair", "deny"];
        const msg = local[PAIR_MSG_PREFIX + p.id];
        if (typeof msg === "string") v.lines.push(...msg.split("\n"));
      } else if (p.denies_me) {
        // it rejected this device: Reject moves it to Rejected devices, Pair asks again
        v.greyed = T.rejectedThis;
        v.actions = ["deny", "pair"];
      } else if (p.approve_verified && p.get_after_verify && !p.approves_me) {
        // it no longer pairs with this device: Cancel pairing request until it asks to pair again
        const again = local[PAIR_AGAIN_PREFIX + p.id] === true;
        v.greyed = again ? T.wantsPairAgain : T.notPairedOn(label);
        v.actions = again ? ["deny", "pair"] : ["cancel"];
      } else if (p.ruling === "approved" && p.approves_me) {
        v.section = "paired";
        v.paired = true;
        v.sendable = !p.logged_out && !p.hidden && p.listening !== false;
        if (p.logged_out) v.greyed = "logged out";
        else if (p.listening === false) v.greyed = "send only";
        else if (!p.reachable) v.greyed = "unreachable";
      } else v.section = "pairing"; // approved here, waiting for the other device
      v.actions.push("remove");
      out.push(v);
    }
    return { self: self ? { id: self.id, name: await e.myName() } : null, peers: out, allowContent: (await e.settings()).allowContent };
  }

  async history(): Promise<(HistoryRow & { sender: string; notDeleted?: string[] })[]> {
    const e = this.e;
    const waiting = await e.settleDeletes();
    const peers = new Map((await e.db.peers()).map((p) => [p.id, p]));
    const f = e.files as Files | null;
    const here = f ? await f.here().catch(() => new Set<string>()) : new Set<string>();
    // no device status rows: those an older version stored stay in the database, unlisted
    return (await e.db.history()).filter((r) => !isStatusRow(r)).map((r) => {
      const p = r.peer ? peers.get(r.peer) : undefined;
      let sender: string = T.unknownSender;
      if (r.peer) {
        const nm = p?.name ?? r.peer_name ?? null;
        sender = (nm ?? peerLabel(p)) + (!p || p.removed ? " (removed)" : "");
      } else if (r.dir === "out" && r.targets?.length === 1) {
        // A message to one device: History names it (Sent to "Laptop").
        sender = peerLabel(peers.get(r.targets[0]!));
      }
      // a delete not done yet: the names of the devices it waits on
      const left = waiting.get(r.id!);
      // a file: its download percent while one runs, and whether its decrypted file is here
      const fx = r.type === "file" ? { pct: f?.running.get(r.id!), here: here.has(fileKey(r.id!)) } : {};
      return left ? { ...r, ...fx, sender, notDeleted: left.map((id) => peerLabel(peers.get(id))) } : { ...r, ...fx, sender };
    });
  }
}
