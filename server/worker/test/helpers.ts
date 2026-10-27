// Test harness: env with generated vendor keys, peers, signed calls, vendor mock, log capture.
import { createExecutionContext, env as baseEnv, waitOnExecutionContext } from "cloudflare:test";
import { handle } from "../src/index";
import type { Env } from "../src/env";
import { b64urlEncode } from "../src/codec/b64url";
import { utf8 } from "../src/crypto/hash";
import { accountId, emailHash, peerId } from "../src/crypto/ids";
import { keyRef, makeTicket, type Purpose } from "../src/crypto/tokens";
import { signedBytes } from "../src/pipeline/signed";
import { deps } from "../src/push/deps";
import { TEST_SECRETS as S } from "./secrets";

export const captured: string[] = [];
export const forbidden = new Set<string>();
export function scrubViolations(lines: string[]): number {
  const all = lines.join("\n");
  let n = 0;
  for (const s of forbidden) if (s.length >= 8 && all.includes(s)) n++;
  return n;
}

export function secretString(s: string): string {
  forbidden.add(s);
  return s;
}

// ---------- key material ----------
function pem(der: ArrayBuffer, label: string): string {
  const b = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN ${label}-----\n${b.replace(/(.{64})/g, "$1\n")}\n-----END ${label}-----\n`;
}

export interface VendorKeys {
  fcmPem: string;
  fcmPublic: CryptoKey;
  apnsPem: string;
  apnsPublic: CryptoKey;
  applePem: string;
  applePublic: CryptoKey;
  vapidPem: string;
  vapidPublicRaw: string;
  vapidPublic: CryptoKey;
}

let keysP: Promise<VendorKeys> | null = null;
export function vendorKeys(): Promise<VendorKeys> {
  if (!keysP) {
    keysP = (async () => {
      const rsa = (await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign", "verify"],
      )) as CryptoKeyPair;
      const ec = async () => (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
      const apns = await ec();
      const apple = await ec();
      const vapid = await ec();
      return {
        fcmPem: pem((await crypto.subtle.exportKey("pkcs8", rsa.privateKey)) as ArrayBuffer, "PRIVATE KEY"),
        fcmPublic: rsa.publicKey,
        apnsPem: pem((await crypto.subtle.exportKey("pkcs8", apns.privateKey)) as ArrayBuffer, "PRIVATE KEY"),
        apnsPublic: apns.publicKey,
        applePem: pem((await crypto.subtle.exportKey("pkcs8", apple.privateKey)) as ArrayBuffer, "PRIVATE KEY"),
        applePublic: apple.publicKey,
        vapidPem: pem((await crypto.subtle.exportKey("pkcs8", vapid.privateKey)) as ArrayBuffer, "PRIVATE KEY"),
        vapidPublicRaw: b64urlEncode(new Uint8Array((await crypto.subtle.exportKey("raw", vapid.publicKey)) as ArrayBuffer)),
        vapidPublic: vapid.publicKey,
      };
    })();
  }
  return keysP;
}

export async function testEnv(over: Partial<Env> = {}): Promise<Env> {
  const k = await vendorKeys();
  for (const s of Object.values(S)) if (s.length >= 12) forbidden.add(s);
  return {
    ...(baseEnv as unknown as Env),
    GOOGLE_FCM_SA_PRIVATE_KEY: k.fcmPem,
    APPLE_APNS_KEY_P8: k.apnsPem,
    APPLE_SIGNIN_KEY_P8: k.applePem,
    WEBPUSH_VAPID_PRIVATE_KEY: k.vapidPem,
    WEBPUSH_VAPID_PUBLIC_KEY: k.vapidPublicRaw,
    ...over,
  };
}

// ---------- random values ----------
export function randBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

// A canonical b64url message of exactly len chars (len mod 4 != 1).
export function message(len = 512): string {
  const bytes = Math.floor((len * 3) / 4);
  const s = b64urlEncode(randBytes(bytes));
  if (s.length !== len) throw new Error("message length " + len);
  return secretString(s);
}

let ipCounter = 0;
export function freshIp(): string {
  ipCounter++;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

export function randomEmail(): string {
  return secretString(`u${b64urlEncode(randBytes(6)).replace(/[-_]/g, "x").toLowerCase()}@example.com`);
}

// ---------- peers ----------
export interface Peer {
  id: string;
  acct: string;
  email: string;
  sign: CryptoKeyPair;
  signPub: string;
  encPub: string;
  encPriv: CryptoKey;
  platform: string;
}

export async function keys(): Promise<{ sign: CryptoKeyPair; signPub: string; encPub: string; encPriv: CryptoKey; signRaw: Uint8Array; encRaw: Uint8Array }> {
  const sign = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const enc = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const signRaw = new Uint8Array((await crypto.subtle.exportKey("raw", sign.publicKey)) as ArrayBuffer);
  const encRaw = new Uint8Array((await crypto.subtle.exportKey("raw", enc.publicKey)) as ArrayBuffer);
  return { sign, signPub: b64urlEncode(signRaw), encPub: b64urlEncode(encRaw), encPriv: enc.privateKey, signRaw, encRaw };
}

export async function acctOf(email: string): Promise<string> {
  return accountId(S.PA_ID_SECRET, await emailHash(email));
}

export async function ticketFor(email: string, signPub: string, purpose: Purpose, lifeS = 120): Promise<string> {
  const { b64urlDecode } = await import("../src/codec/b64url");
  const t = await makeTicket(S.PA_TOKEN_SECRET, {
    a: await acctOf(email),
    k: await keyRef(b64urlDecode(signPub)!),
    p: purpose,
    x: Math.floor(Date.now() / 1000) + lifeS,
  });
  return secretString(t);
}

export function pushFor(platform: string, kind?: string): Record<string, unknown> {
  const p256 = (globalThis as { __p256?: string }).__p256!;
  const auth = b64urlEncode(randBytes(16));
  switch (kind ?? platform) {
    case "android":
    case "fcm":
      return { type: "fcm", token: secretString("fcmtok" + b64urlEncode(randBytes(24)).replace(/[-_]/g, "a")) };
    case "iphone":
    case "apns":
      return { type: "apns", token: secretString(Array.from(randBytes(32), (b) => b.toString(16).padStart(2, "0")).join("")) };
    case "apns-sandbox":
      return { type: "apns-sandbox", token: secretString(Array.from(randBytes(32), (b) => b.toString(16).padStart(2, "0")).join("")) };
    case "chrome":
      return { type: "webpush", endpoint: secretString("https://fcm.googleapis.com/fcm/send/" + b64urlEncode(randBytes(24))), p256dh: p256, auth };
    case "firefox":
      return { type: "webpush", endpoint: secretString("https://updates.push.services.mozilla.com/wpush/v2/" + b64urlEncode(randBytes(24))), p256dh: p256, auth };
    case "unifiedpush":
      return { type: "unifiedpush", endpoint: secretString("https://up.example.org/push/" + b64urlEncode(randBytes(24))), p256dh: p256, auth };
  }
  throw new Error("platform");
}

// A valid UA ECDH public key (shared by all web push fixtures).
export async function initP256(): Promise<void> {
  const k = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  (globalThis as { __p256?: string }).__p256 = b64urlEncode(new Uint8Array((await crypto.subtle.exportKey("raw", k.publicKey)) as ArrayBuffer));
}

// ---------- calls ----------
export interface CallOpts {
  peer?: Peer | null;
  sign?: CryptoKeyPair; // signer for POST /peers and DELETE /account
  time?: string | null;
  headers?: Record<string, string>;
  rawBody?: Uint8Array | string;
  env?: Env;
  ip?: string;
  noSig?: boolean;
}

export interface CallResult {
  res: Response;
  status: number;
  body: Record<string, unknown>;
}

export async function signReq(key: CryptoKey, method: string, path: string, time: string, body: Uint8Array): Promise<string> {
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, signedBytes(method, path, time, body));
  return b64urlEncode(new Uint8Array(sig));
}

export async function call(method: string, path: string, body?: unknown, o: CallOpts = {}): Promise<CallResult> {
  const env = o.env ?? (await testEnv());
  const bytes = o.rawBody !== undefined ? (typeof o.rawBody === "string" ? utf8(o.rawBody) : o.rawBody) : body === undefined ? new Uint8Array(0) : utf8(JSON.stringify(body));
  const headers: Record<string, string> = { "CF-Connecting-IP": o.ip ?? freshIp(), ...(o.headers ?? {}) };
  if (bytes.length) headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
  const time = o.time === undefined ? String(Date.now()) : o.time;
  const signer = o.sign ?? o.peer?.sign;
  if (o.peer) headers["PA-ID"] = o.peer.id;
  if (time !== null && (o.peer || o.sign)) headers["PA-Time"] = time;
  if (signer && time !== null && !o.noSig) headers["PA-Sig"] = await signReq(signer.privateKey, method, path, time, bytes);
  const req = new Request("https://api.pusharmor.com" + path, { method, headers, body: bytes.length ? bytes : undefined });
  const ctx = createExecutionContext();
  const res = await handle(req, env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }
  return { res, status: res.status, body: parsed };
}

export async function register(
  email: string,
  platform = "android",
  push: Record<string, unknown> | null | undefined = undefined,
  extra: Record<string, unknown> = {},
  envOver?: Env,
): Promise<{ peer: Peer; r: CallResult }> {
  const k = await keys();
  const p = push === undefined ? pushFor(platform) : push;
  const body = { ticket: await ticketFor(email, k.signPub, "register"), sign_pub: k.signPub, enc_pub: k.encPub, platform, push: p, ...extra };
  const r = await call("POST", "/v1/peers", body, { sign: k.sign, env: envOver });
  const acct = await acctOf(email);
  const id = await peerId(S.PA_ID_SECRET, acct, k.signRaw, k.encRaw);
  return { peer: { id, acct, email, sign: k.sign, signPub: k.signPub, encPub: k.encPub, encPriv: k.encPriv, platform }, r };
}

export async function newPeer(email: string, platform = "android", push?: Record<string, unknown> | null): Promise<Peer> {
  const { peer, r } = await register(email, platform, push);
  if (r.status !== 200) throw new Error("register failed " + r.status + " " + JSON.stringify(r.body));
  return peer;
}

// Two peers that approved each other (allow both ways), without relays mattering.
export async function setAllow(owner: Peer, ids: string[]): Promise<void> {
  const o: Record<string, number> = {};
  for (const id of ids) o[id] = 1;
  await baseEnv.DB.prepare("UPDATE peers SET allow = ?1 WHERE id = ?2").bind(JSON.stringify(o), owner.id).run();
}

export async function row(id: string): Promise<Record<string, unknown> | null> {
  return baseEnv.DB.prepare("SELECT * FROM peers WHERE id = ?1").bind(id).first();
}

// ---------- vendor mock ----------
export interface MockReq {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array;
  redirect?: string;
  hasSignal: boolean;
}

type Responder = (r: MockReq) => Response | Promise<Response>;
interface Script {
  match: (r: MockReq) => boolean;
  respond: Responder;
  times: number;
}

export const mock = {
  requests: [] as MockReq[],
  scripts: [] as Script[],
  clock: 0,
  sleeps: [] as number[],
};

export function onVendor(match: (r: MockReq) => boolean, respond: Responder, times = 1): void {
  mock.scripts.push({ match, respond, times });
}

export function vendorRequests(host?: string): MockReq[] {
  return mock.requests.filter((r) => !host || new URL(r.url).hostname === host);
}

function defaultResponse(r: MockReq): Response {
  const u = new URL(r.url);
  if (u.hostname === "oauth2.googleapis.com" && u.pathname === "/token") {
    return Response.json({ access_token: secretString("ya29.test-access-token"), expires_in: 3599 });
  }
  if (u.hostname === "fcm.googleapis.com" && u.pathname.startsWith("/v1/")) return Response.json({ name: "projects/test-project/messages/0:1" });
  if (u.hostname === "api.push.apple.com" || u.hostname === "api.sandbox.push.apple.com") return new Response(null, { status: 200 });
  if (u.hostname === "fcm.googleapis.com" || u.hostname === "updates.push.services.mozilla.com" || u.hostname === "up.example.org") {
    return new Response(null, { status: 201 });
  }
  if (u.hostname === "challenges.cloudflare.com") return Response.json({ success: true, hostname: "pusharmor.com", action: "email" });
  if (u.hostname.startsWith("email.")) return Response.json({ MessageId: "m-1" });
  if (u.hostname === "appleid.apple.com" && u.pathname === "/auth/revoke") return new Response(null, { status: 200 });
  return new Response("no mock", { status: 599 });
}

export function installVendorMock(): void {
  mock.requests = [];
  mock.scripts = [];
  mock.clock = 0;
  mock.sleeps = [];
  deps.now = () => Date.now() + mock.clock;
  deps.sleep = async (ms: number) => {
    mock.sleeps.push(ms);
    mock.clock += ms;
  };
  deps.fetch = async (url: string, init: RequestInit) => {
    const h: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (h[k] = v));
    let body: Uint8Array = new Uint8Array(0);
    if (typeof init.body === "string") body = utf8(init.body);
    else if (init.body instanceof Uint8Array) body = init.body;
    const r: MockReq = { url, method: init.method ?? "GET", headers: h, body, redirect: init.redirect as string, hasSignal: !!init.signal };
    mock.requests.push(r);
    const s = mock.scripts.find((x) => x.times > 0 && x.match(r));
    if (s) {
      s.times--;
      return s.respond(r);
    }
    return defaultResponse(r);
  };
}

export async function run<T>(f: () => Promise<T>): Promise<T> {
  return f();
}

export function decodeJwt(jwt: string): { header: Record<string, unknown>; claims: Record<string, unknown> } {
  const [h, c] = jwt.split(".");
  const dec = (s: string) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
  return { header: dec(h), claims: dec(c) };
}
