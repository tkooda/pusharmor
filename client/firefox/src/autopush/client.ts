// Mozilla autopush WebSocket client for the Firefox desktop add-on
// (component-webext section 5.2): hello / register / notification / ack,
// RFC 8291 decrypt, dedupe on version, reconnect with backoff, keepalive,
// and the switch to the site-SW fallback.
import { b64urlEncode, b64urlTryDecode } from "../../../webext-common/src/crypto/b64url.ts";
import { generateWebPushKeys, rfc8291Decrypt, type WebPushKeys } from "../../../webext-common/src/crypto/rfc8291.ts";
import type { PushFields } from "../../../webext-common/src/crypto/labels.ts";

export const AUTOPUSH_URL = "wss://push.services.mozilla.com/";
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_CAP_MS = 30 * 60_000;
export const IDLE_PING_MS = 10 * 60_000;
export const PING_DEAD_MS = 10_000;
export const FALLBACK_AFTER_MS = 30 * 60_000;
export const PROBE_EVERY_MS = 60 * 60_000;
export const DRIFT_MS = 60_000;
export const CLOSE_NO_RECONNECT = 4774;

export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: (() => void) | null;
}

export interface ApState {
  uaid: string | null;
  channelID: string | null;
  endpoint: string | null;
}

export interface AutopushDeps {
  socket(url: string): SocketLike;
  vapidPub: Uint8Array;
  loadState(): Promise<ApState>;
  saveState(s: ApState): Promise<void>;
  loadKeys(): Promise<WebPushKeys | null>;
  saveKeys(k: WebPushKeys): Promise<void>;
  /** engine.receive(M) for a decrypted push. */
  deliver(m: string): Promise<void>;
  /** The endpoint changed (new registration): PATCH push. */
  onEndpoint(p: PushFields): Promise<void>;
  /** Switch: "fallback" after 30 min of failed connects while the Worker is reachable, or close 4774; "direct" after a good probe. */
  onMode(mode: "direct" | "fallback"): Promise<void>;
  workerReachable(): Promise<boolean>;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  uuid(): string;
}

type Frame = Record<string, unknown>;

export class Autopush {
  private readonly d: AutopushDeps;
  private ws: SocketLike | null = null;
  private attempt = 0;
  private firstFail: number | null = null;
  private pingTimer: unknown = null;
  private deadTimer: unknown = null;
  private retryTimer: unknown = null;
  private versions: string[] = [];
  private state: ApState = { uaid: null, channelID: null, endpoint: null };
  mode: "direct" | "fallback" = "direct";
  private stopped = false;
  private probing = false;

  constructor(d: AutopushDeps) {
    this.d = d;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.state = await this.d.loadState();
    if (!(await this.d.loadKeys())) await this.d.saveKeys(await generateWebPushKeys());
    this.connect(false);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
  }

  /** Unregister the channel and close (wipe routine). */
  async unregister(): Promise<void> {
    if (this.ws && this.state.channelID) this.send({ messageType: "unregister", channelID: this.state.channelID });
    this.stop();
    this.state = { uaid: this.state.uaid, channelID: null, endpoint: null };
    await this.d.saveState(this.state);
  }

  async fields(): Promise<PushFields | null> {
    const k = await this.d.loadKeys();
    if (!k || !this.state.endpoint) return null;
    return { type: "webpush", endpoint: this.state.endpoint, p256dh: b64urlEncode(k.p256dh), auth: b64urlEncode(k.auth) };
  }

  /** "online" event or a timer drift: reconnect at once. */
  reconnectNow(): void {
    if (this.stopped || this.mode === "fallback") return;
    this.attempt = 0;
    this.ws?.close();
    this.connect(false);
  }

  private clearTimers(): void {
    for (const t of [this.pingTimer, this.deadTimer, this.retryTimer]) if (t !== null) this.d.clearTimer(t);
    this.pingTimer = this.deadTimer = this.retryTimer = null;
  }

  private send(f: Frame): void {
    this.ws?.send(JSON.stringify(f));
  }

  private connect(probe: boolean): void {
    this.clearTimers();
    this.probing = probe;
    let ws: SocketLike;
    try {
      ws = this.d.socket(AUTOPUSH_URL);
    } catch {
      void this.failed();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.send({
        messageType: "hello",
        uaid: this.state.uaid ?? "",
        channelIDs: this.state.channelID ? [this.state.channelID] : [],
        use_webpush: true,
        broadcasts: {},
      });
    };
    ws.onmessage = (ev) => void this.onFrame(ev.data);
    ws.onerror = () => undefined;
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      if (ev.code === CLOSE_NO_RECONNECT) {
        void this.toFallback();
        return;
      }
      if (this.probing) this.retryTimer = this.d.setTimer(() => this.connect(true), PROBE_EVERY_MS);
      else void this.failed();
    };
  }

  private async failed(): Promise<void> {
    if (this.stopped) return;
    const t = this.d.now();
    if (this.firstFail === null) this.firstFail = t;
    if (this.mode === "direct" && t - this.firstFail >= FALLBACK_AFTER_MS && (await this.d.workerReachable())) {
      await this.toFallback();
      return;
    }
    const wait = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
    this.attempt++;
    this.retryTimer = this.d.setTimer(() => this.connect(false), wait);
  }

  private async toFallback(): Promise<void> {
    this.mode = "fallback";
    await this.d.onMode("fallback");
    this.retryTimer = this.d.setTimer(() => this.connect(true), PROBE_EVERY_MS);
  }

  private armKeepalive(): void {
    if (this.pingTimer !== null) this.d.clearTimer(this.pingTimer);
    this.pingTimer = this.d.setTimer(() => {
      this.send({});
      this.deadTimer = this.d.setTimer(() => {
        this.ws?.close();
      }, PING_DEAD_MS);
    }, IDLE_PING_MS);
  }

  private async onFrame(data: unknown): Promise<void> {
    if (this.deadTimer !== null) {
      this.d.clearTimer(this.deadTimer);
      this.deadTimer = null;
    }
    this.armKeepalive();
    let f: Frame;
    try {
      f = JSON.parse(String(data)) as Frame;
    } catch {
      return;
    }
    switch (f.messageType) {
      case "hello":
        return this.onHello(f);
      case "register":
        return this.onRegister(f);
      case "notification":
        return this.onNotification(f);
      default:
        return;
    }
  }

  private async onHello(f: Frame): Promise<void> {
    if (f.status !== 200 || typeof f.uaid !== "string") {
      this.ws?.close();
      return;
    }
    this.attempt = 0;
    this.firstFail = null;
    if (this.probing) {
      // probe = hello + ack any notification frames + close; success switches back
      this.mode = "direct";
      this.probing = false;
      await this.d.onMode("direct");
    }
    if (f.uaid !== this.state.uaid) {
      // UAID reset: register again and PATCH the new endpoint
      this.state = { uaid: f.uaid, channelID: null, endpoint: null };
      await this.d.saveState(this.state);
    }
    if (!this.state.channelID || !this.state.endpoint) this.register();
  }

  private register(): void {
    const channelID = this.d.uuid();
    this.state = { ...this.state, channelID, endpoint: null };
    this.send({ messageType: "register", channelID, key: b64urlEncode(this.d.vapidPub) });
  }

  private async onRegister(f: Frame): Promise<void> {
    if (f.status === 409) return this.register();
    if (f.status !== 200 || typeof f.pushEndpoint !== "string") {
      this.ws?.close();
      return;
    }
    let ok = false;
    try {
      ok = new URL(f.pushEndpoint).pathname.startsWith("/wpush/v2/");
    } catch {
      ok = false;
    }
    if (!ok) return this.register();
    this.state = { ...this.state, channelID: String(f.channelID ?? this.state.channelID), endpoint: f.pushEndpoint };
    await this.d.saveState(this.state);
    const p = await this.fields();
    if (p && this.mode === "direct") await this.d.onEndpoint(p);
  }

  private async onNotification(f: Frame): Promise<void> {
    const channelID = String(f.channelID ?? "");
    const version = String(f.version ?? "");
    if (channelID !== this.state.channelID) {
      this.send({ messageType: "ack", updates: [{ channelID, version, code: 100 }] });
      this.send({ messageType: "unregister", channelID });
      return;
    }
    if (this.versions.includes(version)) {
      this.send({ messageType: "ack", updates: [{ channelID, version, code: 100 }] });
      return;
    }
    this.versions.push(version);
    if (this.versions.length > 100) this.versions.shift();
    let code = 100;
    let m: string | null = null;
    try {
      const k = await this.d.loadKeys();
      const body = typeof f.data === "string" ? b64urlTryDecode(f.data.replace(/=+$/, "")) : null;
      if (!k || !body) throw new Error("no data");
      const pt = await rfc8291Decrypt(k.ecdh.privateKey, k.p256dh, k.auth, body);
      m = String.fromCharCode(...pt);
    } catch {
      code = 101;
    }
    this.send({ messageType: "ack", updates: [{ channelID, version, code }] });
    if (m !== null) await this.d.deliver(m).catch(() => undefined);
    if (this.mode === "fallback") this.ws?.close();
  }
}

