// Runtime messages {op, args} from the UI pages to the background engine
// (component-webext section 3: UI pages never touch keys or counters).
import { formatCountdown, PAIRING_TIMEOUT_MS } from "../model/countdown.ts";
import { SEND_SEL_KEY } from "../model/sendsel.ts";
import { detectType } from "../model/detect.ts";
import { utf8Len } from "../model/padding.ts";
import type { HistoryRow, PeerRow } from "../store/db.ts";
import { type Engine, type Settings, UserError } from "./engine.ts";
import { Login, type Purpose } from "./login.ts";
import { PAIR_MSG_PREFIX, allEntries } from "./state.ts";
import { T, peerLabel } from "./texts.ts";
import { errorText } from "../api/client.ts";

export interface Req {
  op: string;
  args?: Record<string, unknown>;
}

export interface Reply {
  ok: boolean;
  data?: unknown;
  error?: string;
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
  sendable: boolean;
  /** the peer approves this device (peer status line) */
  approvesMe: boolean;
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
}

function created(p: PeerRow): string {
  const d = new Date(p.created * 1000);
  return (p.platform === "cli" ? "Command line" : p.platform.charAt(0).toUpperCase() + p.platform.slice(1)) + ", added " + d.toISOString().slice(0, 10);
}

export class Rpc {
  readonly e: Engine;
  readonly login: Login;
  constructor(e: Engine) {
    this.e = e;
    this.login = new Login(e);
  }

  async handle(req: Req, senderTabId?: number): Promise<Reply> {
    try {
      return { ok: true, data: await this.dispatch(req, senderTabId) };
    } catch (err) {
      if (err instanceof UserError) return { ok: false, error: err.message };
      return { ok: false, error: errorText(err) };
    }
  }

  private async dispatch(req: Req, tab?: number): Promise<unknown> {
    const a = req.args ?? {};
    const s = (k: string) => String(a[k] ?? "");
    const e = this.e;
    switch (req.op) {
      case "state":
        return this.state();
      case "popupOpen":
        await e.onPopupOpen();
        return this.state();
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
      case "historyDeleteAll":
        await e.db.clear(["history"]);
        await e.updateBadge();
        return null;
      case "sendSel":
        return ((await e.p.storageLocal.get([SEND_SEL_KEY]))[SEND_SEL_KEY] as string[] | undefined) ?? [];
      case "sendSelSet":
        await e.p.storageLocal.set({ [SEND_SEL_KEY]: Array.isArray(a.ids) ? (a.ids as unknown[]).map(String) : [] });
        return null;
      case "detect":
        return { type: detectType(s("text")), bytes: utf8Len(s("text")) };
      case "send":
        return e.send(s("text"), a.asText === true, Array.isArray(a.targets) ? (a.targets as string[]) : "all");
      case "pair":
        return e.pairStart(s("id"));
      case "sendAgain":
        return e.pairSendAgain(s("id"));
      case "reply":
        return e.pairReplyTap(s("id"));
      case "approve":
        return e.approve(s("id"));
      case "deny":
        return e.deny(s("id"));
      case "cancel":
        return e.cancelPairing(s("id"));
      case "pairAgain":
        return e.pairAgain(s("id"));
      case "remove":
        return e.remove(s("id"));
      case "localDelete":
        return e.localDelete(s("id"));
      case "hide":
        return e.setHidden(s("id"), a.hidden === true);
      case "rename":
        return e.rename(s("name"));
      case "refresh": {
        await e.fetchPeersNow();
        await e.pushReconcile(true).catch(() => undefined);
        await e.timeoutCheck();
        return this.peers();
      }
      case "greyedTap":
        return e.fetchTrigger();
      case "settings":
        return e.setSettings(a as Partial<Settings>);
      case "signout":
        await this.login.clearProgress();
        return e.logout();
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
        throw new UserError("Unknown request");
    }
  }

  async state(): Promise<StateView> {
    const e = this.e;
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
      setupNeeded:
        e.p.platformName === "firefox" &&
        (e.p.isAndroid || ((await e.db.meta<string>("receive_mode")) ?? "direct") !== "direct") &&
        !(await e.db.meta("fallback_push")),
    };
  }

  async peers(): Promise<{ self: { id: string; name: string } | null; peers: PeerView[] }> {
    const e = this.e;
    const self = await e.self();
    const entries = await allEntries(e.p.storageLocal);
    const local = await e.p.storageLocal.get(null);
    const out: PeerView[] = [];
    const t = e.p.now();
    for (const p of await e.db.peers()) {
      if (p.removed || p.id === self?.id) continue;
      const label = p.name ?? created(p);
      const nm = peerLabel(p.name);
      const v: PeerView = { id: p.id, label, platform: p.platform, lines: [], actions: [], countdown: null, fingerprint: null, pk: null, greyed: null, hidden: p.hidden, sendable: false, approvesMe: p.approves_me };
      const pv = entries.has(p.id) ? await e.pairRowView(p.id) : null;
      if (pv) {
        v.lines = pv.lines;
        v.actions = pv.actions;
        v.countdown = pv.countdown;
        v.fingerprint = pv.fingerprint;
        const ent = entries.get(p.id)!;
        v.pk = ent.pk;
        if (ent.last_send && t - ent.last_send < 60_000) v.actions = v.actions.filter((x) => x !== "send_again");
      } else if (p.missing) {
        v.greyed = "(missing)";
        v.actions = ["localDelete"];
      } else if (!p.pinned) {
        v.actions = ["pair", "deny"];
        const msg = local[PAIR_MSG_PREFIX + p.id];
        if (typeof msg === "string") v.lines.push(msg);
        if (p.ruling === "denied") v.lines.push("Denied");
      } else if (p.denies_me) {
        v.greyed = T.declinedBy(nm);
        v.actions = ["cancel"];
      } else if (p.approve_verified && p.get_after_verify && !p.approves_me) {
        v.greyed = T.notPairedOn(nm);
        v.actions = ["pair_again", "cancel"];
      } else if (p.ruling === "approved" && p.approves_me) {
        v.sendable = !p.logged_out && !p.hidden && p.listening !== false;
        if (p.logged_out) v.greyed = "logged out";
        else if (p.listening === false) v.greyed = "send only";
        else if (!p.reachable) v.greyed = "unreachable";
      }
      v.actions.push("remove", p.hidden ? "unhide" : "hide");
      out.push(v);
    }
    return { self: self ? { id: self.id, name: await e.myName() } : null, peers: out };
  }

  async history(): Promise<(HistoryRow & { sender: string })[]> {
    const e = this.e;
    const peers = new Map((await e.db.peers()).map((p) => [p.id, p]));
    return (await e.db.history()).map((r) => {
      const p = r.peer ? peers.get(r.peer) : undefined;
      let sender: string = T.unknownSender;
      if (r.peer) {
        const nm = p?.name ?? r.peer_name ?? null;
        sender = (nm ?? T.aPeer) + (!p || p.removed ? " (removed)" : "");
      } else if (r.dir === "out" && r.targets?.length === 1) {
        // A message to one device: History names it (Sent to "Laptop").
        sender = peers.get(r.targets[0]!)?.name ?? T.aPeer;
      }
      return { ...r, sender };
    });
  }
}

export function countdownFor(started: number, now: number): string {
  return formatCountdown(started + PAIRING_TIMEOUT_MS - now);
}
