// Request validators: ids, keys, messages, name entries, "m" maps, push objects.
import { ApiError } from "../errors";
import { b64urlDecode, isB64url } from "./b64url";
import { checkUnifiedPushEndpoint, checkWebpushEndpoint, cliTopicOk, prefixes, type EndpointReject } from "../push/allowlist";
import { importEcdhPub, rawPoint } from "../crypto/ecdsa";
import { sha256, utf8 } from "../crypto/hash";
import { b64urlEncode } from "./b64url";

export const MAX_MESSAGE = 3800;
export const MAX_NAME_ENTRY = 1024;
export const MAX_MAP = 9;
export const PAIR_MESSAGE_LEN = 366;

export function bad(): ApiError {
  return new ApiError(400, "bad request");
}

export function isId(s: unknown): s is string {
  if (typeof s !== "string" || s.length !== 40) return false;
  const raw = b64urlDecode(s);
  return raw !== null && raw.length === 30;
}

// Exactly the allowed keys; every required key present.
export function keysExactly(o: Record<string, unknown>, required: string[], optional: string[] = []): void {
  for (const k of required) if (!(k in o)) throw bad();
  for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) throw bad();
}

// A relayed message: strict b64url, 1..3800 chars (over 3800 -> 413).
export function checkMessage(v: unknown): string {
  if (typeof v !== "string") throw bad();
  if (v.length > MAX_MESSAGE) throw new ApiError(413, "too large");
  if (v.length === 0 || !isB64url(v)) throw bad();
  return v;
}

export function checkNameEntry(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_NAME_ENTRY || !isB64url(v)) throw bad();
  return v;
}

// "m" map: object, at most 9 entries, keys are ids, values messages.
export function checkMessageMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad();
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length > MAX_MAP) throw bad();
  const out: Record<string, string> = {};
  for (const k of keys) {
    if (!isId(k)) throw bad();
    out[k] = checkMessage(o[k]);
  }
  return out;
}

export function checkNameMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad();
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length > MAX_MAP) throw bad();
  const out: Record<string, string> = {};
  for (const k of keys) {
    if (!isId(k)) throw bad();
    out[k] = checkNameEntry(o[k]);
  }
  return out;
}

// Account prefix check of ids (after the account is known).
export function requireAccount(ids: Iterable<string>, acct: string): void {
  for (const id of ids) if (id.slice(0, 12) !== acct) throw bad();
}

export const PLATFORMS = ["android", "ios", "chrome", "firefox", "cli"] as const;
export type Platform = (typeof PLATFORMS)[number];

export function checkPlatform(v: unknown): Platform {
  if (typeof v !== "string" || !(PLATFORMS as readonly string[]).includes(v)) throw bad();
  return v as Platform;
}

const PLATFORM_TYPES: Record<Platform, number[]> = { android: [1, 6], ios: [2, 5], chrome: [3], firefox: [4], cli: [6] };

export interface PushValue {
  pushType: number;
  stored: string; // re-serialized JSON, fixed key order
  fields: Record<string, string>; // type + pushed fields
}

const FCM_TOKEN = /^[A-Za-z0-9_:-]{1,4096}$/;
const APNS_TOKEN = /^[0-9a-fA-F]{32,512}$/;

function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== "string") throw bad();
  return v;
}

// Validates a push object (section 7.4) and returns its stored form and type.
export async function checkPush(v: unknown, allowedPrefixes: string, upHosts: string, onReject: (r: EndpointReject) => void): Promise<PushValue> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad();
  const o = v as Record<string, unknown>;
  const type = str(o, "type");
  if (type === "fcm" || type === "apns" || type === "apns-sandbox") {
    const token = str(o, "token");
    if (!(type === "fcm" ? FCM_TOKEN : APNS_TOKEN).test(token)) throw bad();
    const fields = { type, token };
    return { pushType: type === "fcm" ? 1 : type === "apns" ? 2 : 5, stored: JSON.stringify(fields), fields };
  }
  if (type !== "webpush" && type !== "unifiedpush") throw bad();
  const endpoint = str(o, "endpoint");
  const p256dh = str(o, "p256dh");
  const auth = str(o, "auth");
  const point = rawPoint(p256dh);
  if (!point || !(await importEcdhPub(point))) throw bad();
  const authRaw = b64urlDecode(auth);
  if (auth.length !== 22 || !authRaw || authRaw.length !== 16) throw bad();
  let pushType: number;
  if (type === "webpush") {
    const r = checkWebpushEndpoint(endpoint, prefixes(allowedPrefixes));
    if ("reject" in r) {
      onReject(r.reject);
      throw new ApiError(400, "push endpoint not allowed");
    }
    const host = new URL(endpoint).hostname;
    if (host === "fcm.googleapis.com") pushType = 3;
    else if (host === "updates.push.services.mozilla.com") pushType = 4;
    else {
      onReject({ host, prefix_len: r.prefix.length });
      throw new ApiError(400, "push endpoint not allowed");
    }
  } else {
    const reason = checkUnifiedPushEndpoint(endpoint, prefixes(upHosts));
    if (reason) {
      onReject({ reason });
      throw new ApiError(400, "push endpoint not allowed");
    }
    pushType = 6;
  }
  const fields = { type, endpoint, p256dh, auth };
  return { pushType, stored: JSON.stringify(fields), fields };
}

export function fitsPlatform(platform: Platform, pushType: number): boolean {
  return PLATFORM_TYPES[platform].includes(pushType);
}

// Platform rules for a push: type per platform (400), and the cli topic form.
export function checkPushPlatform(platform: Platform, push: PushValue): void {
  if (!fitsPlatform(platform, push.pushType)) throw bad();
  if (platform === "cli" && !cliTopicOk(push.fields.endpoint)) throw new ApiError(400, "push endpoint not allowed");
}

// my_push_sha256 = b64url(first 16 bytes of sha256(type "\n" token) or
// (type "\n" endpoint "\n" p256dh "\n" auth)).
export async function pushSha256(fields: Record<string, unknown>): Promise<string> {
  const t = fields.type;
  const s =
    t === "webpush" || t === "unifiedpush"
      ? `${t}\n${fields.endpoint}\n${fields.p256dh}\n${fields.auth}`
      : `${t}\n${fields.token}`;
  return b64urlEncode((await sha256(utf8(s))).slice(0, 16));
}

// Stored push JSON without verified_at, for the PATCH skip rule.
export function storedWithoutVerified(stored: string): { base: string; verified: boolean } {
  const o = JSON.parse(stored) as Record<string, unknown>;
  const verified = "verified_at" in o;
  delete o.verified_at;
  return { base: JSON.stringify(o), verified };
}
