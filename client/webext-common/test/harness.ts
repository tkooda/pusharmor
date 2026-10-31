// Test harness: in-memory platform, fake-indexeddb, and a mock Worker that
// implements the catalog endpoints the extension uses and relays pushes.
import { createHash, createHmac } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { Api } from "../src/api/client.ts";
import { b64urlDecode, b64urlEncode } from "../src/crypto/b64url.ts";
import { ascii, concat } from "../src/crypto/bytes.ts";
import { verify } from "../src/crypto/keys.ts";
import { type PushFields } from "../src/crypto/labels.ts";
import { reqSignedBytes } from "../src/crypto/pasig.ts";
import { Engine } from "../src/core/engine.ts";
import type { KV, MenuPeer, Platform } from "../src/platform.ts";
import { Db, openDb } from "../src/store/db.ts";

export class Clock {
  t = 1_761_300_000_000;
  now = () => this.t;
}

export class MemKV implements KV {
  data: Record<string, unknown> = {};
  async get(keys: string[] | null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this.data)) if (!keys || keys.includes(k)) out[k] = structuredClone(v);
    return out;
  }
  async set(items: Record<string, unknown>) {
    for (const [k, v] of Object.entries(items)) this.data[k] = structuredClone(v);
  }
  async remove(keys: string[]) {
    for (const k of keys) delete this.data[k];
  }
}

export class FakePlatform implements Platform {
  platformName: "chrome" | "firefox";
  appVersion = "0.0.19";
  isAndroid = false;
  notes = new Map<string, { title: string; body: string }>();
  noteLog: { id: string; body: string }[] = [];
  alarms = new Map<string, number>();
  opened: string[] = [];
  badge = "";
  menus: MenuPeer[] = [];
  storageLocal = new MemKV();
  storageSession = new MemKV();
  sub: PushFields | null = null;
  readonly worker: MockWorker;
  readonly clock: Clock;
  constructor(name: "chrome" | "firefox", worker: MockWorker, clock: Clock) {
    this.platformName = name;
    this.worker = worker;
    this.clock = clock;
  }
  async pushSubscribe(): Promise<PushFields> {
    this.sub = { type: "webpush", endpoint: "https://fcm.googleapis.com/fcm/send/" + Math.random().toString(36).slice(2), p256dh: "P", auth: "A" };
    return this.sub;
  }
  async pushCurrent() {
    return this.sub;
  }
  async pushUnsubscribe() {
    this.sub = null;
  }
  notify(id: string, title: string, body: string) {
    this.notes.set(id, { title, body });
    this.noteLog.push({ id, body });
  }
  clearNotification(id: string) {
    this.notes.delete(id);
  }
  async clearAllNotifications() {
    this.notes.clear();
  }
  async openTab(url: string) {
    this.opened.push(url);
    return 1;
  }
  closeTab() {}
  async authFlow() {
    return null;
  }
  async autoOpenTab(url: string) {
    this.opened.push(url);
    return true;
  }
  menusRebuild(peers: MenuPeer[]) {
    this.menus = peers;
  }
  setBadge(t: string) {
    this.badge = t;
  }
  alarmAt(name: string, when: number) {
    this.alarms.set(name, when);
  }
  clearAlarm(name: string) {
    this.alarms.delete(name);
  }
  fetch(input: string, init: RequestInit) {
    return this.worker.handle(input, init);
  }
  now() {
    return this.clock.t;
  }
}

interface WRow {
  id: string;
  sign_pub: Uint8Array;
  enc_pub: Uint8Array;
  platform: string;
  created: number;
  logged_out: boolean;
  listening?: boolean;
  allow: Set<string>;
  deny: Set<string>;
  name: Record<string, string>;
  pending: Record<string, string>;
  push: boolean;
}

export interface Injected {
  match: RegExp;
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  times: number;
}

export const ACCOUNT = new Uint8Array(9).fill(0x42);
const ID_SECRET = new Uint8Array(32).fill(9);

function sha(...p: Uint8Array[]) {
  return new Uint8Array(createHash("sha256").update(concat(...p)).digest());
}

export class MockWorker {
  rows = new Map<string, WRow>();
  queue: { to: string; m: string }[] = [];
  calls: { method: string; path: string; body: unknown; client: string | null }[] = [];
  inject: Injected[] = [];
  skewMs = 0;
  readonly clock: Clock;
  constructor(clock: Clock) {
    this.clock = clock;
  }

  peerId(sp: Uint8Array, ep: Uint8Array): string {
    const kh = sha(ascii("PA-ID1\n"), sp, ep).subarray(0, 12);
    const mac = new Uint8Array(createHmac("sha256", ID_SECRET).update(concat(ACCOUNT, kh)).digest()).subarray(0, 9);
    return b64urlEncode(concat(ACCOUNT, kh, mac));
  }

  /** Remove queued pushes for a recipient and return them. */
  take(to: string): string[] {
    const out = this.queue.filter((q) => q.to === to).map((q) => q.m);
    this.queue = this.queue.filter((q) => q.to !== to);
    return out;
  }

  private reply(status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "PA-Epoch": String(Math.floor((this.clock.t + this.skewMs) / 1000)), ...extra },
    });
  }

  private relay(from: WRow, to: string, m: string): string {
    const r = this.rows.get(to);
    if (!r) return "unknown";
    if (r.deny.has(from.id)) return "denied";
    if (!r.allow.has(from.id)) return "unapproved";
    if (r.logged_out) return "logged out";
    if (!r.push) return "gone";
    this.queue.push({ to, m });
    return "sent";
  }

  async handle(url: string, init: RequestInit): Promise<Response> {
    const u = new URL(url);
    const path = u.pathname;
    const method = init.method ?? "GET";
    const text = typeof init.body === "string" ? init.body : "";
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    this.calls.push({ method, path, body, client: new Headers(init.headers).get("PA-Client") });
    for (const inj of this.inject) {
      if (inj.times > 0 && inj.match.test(method + " " + path)) {
        inj.times--;
        return this.reply(inj.status, inj.body, inj.headers);
      }
    }
    const h = new Headers(init.headers);
    const t = h.get("PA-Time");
    const sig = h.get("PA-Sig");
    const pid = h.get("PA-ID");
    const wnow = this.clock.t + this.skewMs;
    if (path === "/v1/peers" && method === "POST") {
      const sp = b64urlDecode(body.sign_pub as string);
      const ep = b64urlDecode(body.enc_pub as string);
      if (!t || !sig || !(await verify(sp, b64urlDecode(sig), reqSignedBytes(method, path, t, ascii(text))))) return this.reply(401, { error: "invalid client signature" });
      if (Math.abs(Number(t) - wnow) > 300_000) return this.reply(401, { error: "clock skew" });
      const id = this.peerId(sp, ep);
      if (!this.rows.has(id)) {
        this.rows.set(id, { id, sign_pub: sp, enc_pub: ep, platform: body.platform as string, created: Math.floor(this.clock.t / 1000), logged_out: false, allow: new Set(), deny: new Set(), name: {}, pending: {}, push: false });
      }
      return this.reply(200, { ...this.listFor(id), id });
    }
    if (path === "/v1/account" && method === "DELETE") {
      for (const [, r] of this.rows) for (const [to, m] of Object.entries((body.m as Record<string, string>) ?? {})) this.relay(r, to, m);
      this.rows.clear();
      return this.reply(200, { r: {}, deleted: 1 });
    }
    const me = pid ? this.rows.get(pid) : undefined;
    if (!me) return this.reply(401, { error: "unknown peer" });
    if (!t || !sig || !(await verify(me.sign_pub, b64urlDecode(sig), reqSignedBytes(method, path, t, ascii(text))))) return this.reply(401, { error: "invalid client signature" });
    if (Math.abs(Number(t) - wnow) > 300_000) return this.reply(401, { error: "clock skew" });
    const withdraw = /^\/v1\/deny\//.test(path) && body.withdraw === 1;
    const login = path === "/v1/peers/" + me.id + "/login";
    if (me.logged_out && !withdraw && !login && !(method === "DELETE" && path === "/v1/peers/" + me.id)) return this.reply(401, { error: "logged out" });
    let mm: RegExpExecArray | null;
    if (path === "/v1/peers" && method === "GET") return this.reply(200, this.listFor(me.id));
    if ((mm = /^\/v1\/peers\/([^/]+)$/.exec(path)) && method === "PATCH") {
      if ("push" in body) me.push = body.push !== null;
      if (body.name) {
        for (const [k, v] of Object.entries(body.name as Record<string, string>)) if (me.allow.has(k)) me.name[k] = v;
        const missing = [...me.allow].filter((a) => !(a in ((body.m as object) ?? {})));
        if (missing.length) return this.reply(400, { error: "messages missing", ids: missing });
        const r: Record<string, string> = {};
        for (const [to, m] of Object.entries(body.m as Record<string, string>)) r[to] = this.relay(me, to, m);
        return this.reply(200, { r });
      }
      return this.reply(200, {});
    }
    if ((mm = /^\/v1\/peers\/([^/]+)\/(logout|login)$/.exec(path)) && method === "POST") {
      const m = (body.m as Record<string, string>) ?? {};
      const missing = [...me.allow].filter((a) => !(a in m));
      if (missing.length) return this.reply(400, { error: "messages missing", ids: missing });
      me.logged_out = mm[2] === "logout";
      const r: Record<string, string> = {};
      for (const [to, msg] of Object.entries(m)) r[to] = this.relay(me, to, msg);
      return this.reply(200, { r });
    }
    if ((mm = /^\/v1\/peers\/([^/]+)$/.exec(path)) && method === "DELETE") {
      const r: Record<string, string> = {};
      for (const [to, msg] of Object.entries((body.m as Record<string, string>) ?? {})) r[to] = this.relay(me, to, msg);
      this.rows.delete(mm[1]!);
      for (const row of this.rows.values()) {
        row.allow.delete(mm[1]!);
        row.deny.delete(mm[1]!);
        delete row.name[mm[1]!];
        delete row.pending[mm[1]!];
      }
      return this.reply(200, { r });
    }
    if ((mm = /^\/v1\/pair\/([^/]+)$/.exec(path))) {
      const x = this.rows.get(mm[1]!);
      if ((body.c as string).length !== 366) return this.reply(400, { error: "bad request" });
      if (!x) return this.reply(200, { r: "unknown" });
      if (x.deny.has(me.id)) return this.reply(200, { r: "denied" });
      if (x.logged_out) return this.reply(200, { r: "logged out" });
      this.queue.push({ to: x.id, m: body.c as string });
      return this.reply(200, { r: "sent" });
    }
    if ((mm = /^\/v1\/approve\/([^/]+)$/.exec(path))) {
      const x = this.rows.get(mm[1]!);
      if (!x) return this.reply(200, { r: "unknown" });
      if (x.deny.has(me.id)) return this.reply(200, { r: "denied" });
      me.allow.add(x.id);
      me.deny.delete(x.id);
      me.name[x.id] = body.name as string;
      me.pending[x.id] = body.c as string;
      if (x.allow.has(me.id)) {
        this.queue.push({ to: x.id, m: body.c as string });
        const out: Record<string, unknown> = { r: "sent" };
        if (x.pending[me.id]) out.c = x.pending[me.id];
        return this.reply(200, out);
      }
      return this.reply(200, { r: "stored" });
    }
    if ((mm = /^\/v1\/deny\/([^/]+)$/.exec(path))) {
      const xid = mm[1]!;
      me.allow.delete(xid);
      delete me.name[xid];
      delete me.pending[xid];
      if (withdraw) return this.reply(200, { r: "unapproved" });
      me.deny.add(xid);
      const x = this.rows.get(xid);
      if (!x) return this.reply(200, { r: "unknown" });
      if (!x.allow.has(me.id)) return this.reply(200, { r: "unapproved" });
      this.queue.push({ to: xid, m: body.c as string });
      return this.reply(200, { r: "sent" });
    }
    if (path === "/v1/send") {
      const r: Record<string, string> = {};
      for (const [to, m] of Object.entries(body.m as Record<string, string>)) r[to] = this.relay(me, to, m);
      return this.reply(200, { r });
    }
    return this.reply(404, { error: "not found" });
  }

  listFor(me: string) {
    const meRow = this.rows.get(me)!;
    return {
      my_push_sha256: null,
      my_allow: [...meRow.allow],
      peers: [...this.rows.values()].map((r) => ({
        id: r.id,
        sign_pub: b64urlEncode(r.sign_pub),
        enc_pub: b64urlEncode(r.enc_pub),
        platform: r.platform,
        created: r.created,
        logged_out: r.logged_out,
        ...(r.platform === "cli" ? { listening: r.listening !== false } : {}),
        approves: r.allow.size,
        approved_by: [...this.rows.values()].filter((o) => o.allow.has(r.id)).length,
        approves_me: r.allow.has(me),
        denies_me: r.deny.has(me),
        reachable: r.push,
        name_for_me: r.name[me] ?? null,
      })),
    };
  }
}

export interface Device {
  e: Engine;
  p: FakePlatform;
  db: Db;
  factory: IDBFactory;
  id: string;
}

export async function makeEngine(p: FakePlatform, factory: IDBFactory, clock: Clock): Promise<{ e: Engine; db: Db }> {
  const db = new Db(await openDb(factory));
  let offset = 0;
  const api = new Api({
    client: p.platformName + "/" + p.appVersion,
    fetch: (i, init) => p.fetch(i, init),
    now: clock.now,
    sleep: async (ms) => {
      clock.t += ms;
    },
    getOffset: async () => offset,
    setOffset: async (o) => {
      offset = o;
    },
  });
  const e = new Engine({ platform: p, db, api, vapidPub: new Uint8Array(65) });
  return { e, db };
}

/** A registered device on the mock Worker. */
export async function device(worker: MockWorker, clock: Clock, name: "chrome" | "firefox" = "chrome"): Promise<Device> {
  const p = new FakePlatform(name, worker, clock);
  const factory = new IDBFactory();
  const { e, db } = await makeEngine(p, factory, clock);
  const r = await e.register("T", "a@b.com");
  if (r) throw new Error("peer limit");
  const self = (await e.self())!;
  return { e, p, db, factory, id: self.id };
}

/** Simulates a service worker restart: same storage, new engine instance. */
export async function restart(d: Device, clock: Clock): Promise<Device> {
  d.db.db.close();
  const { e, db } = await makeEngine(d.p, d.factory, clock);
  return { ...d, e, db };
}

/** Deliver every queued push for a device. */
export async function deliver(worker: MockWorker, d: Device): Promise<number> {
  const ms = worker.take(d.id);
  for (const m of ms) await d.e.receive(m, "push");
  return ms.length;
}

/** Refresh both devices' peer lists. */
export async function refresh(...ds: Device[]) {
  for (const d of ds) await d.e.fetchPeersNow();
}

/** Full pairing of a (N) and b (X), both approve; returns the shared fingerprint. */
export async function pairAndApprove(w: MockWorker, a: Device, b: Device): Promise<string> {
  await refresh(a, b);
  await a.e.pairStart(b.id);
  await deliver(w, b); // commit -> automatic reply
  await deliver(w, a); // reply -> pin, open
  await deliver(w, b); // open -> pin, fingerprint
  const fa = (await a.e.pairRowView(b.id))!.fingerprint!;
  await a.e.approve(b.id);
  await b.e.approve(a.id);
  await deliver(w, a);
  return fa;
}
