// Stateless Worker tokens: b64url(body JSON) "." b64url(HMAC-SHA256(PA_TOKEN_SECRET, label || body part)).
// The MAC is checked over the string as received, before JSON.parse.
import { b64urlDecode, b64urlEncode } from "../codec/b64url";
import { concat, ctEqual, hmac, sha256, utf8 } from "./hash";

export const LABEL_REQUEST_TOKEN = "PA-RT1\n";
export const LABEL_TICKET = "PA-TK1\n";
export const LABEL_STATE = "PA-ST1\n";
const LABEL_SEAL = "PA-SEAL1\n";
const LABEL_PKCE = "PA-PKCE1\n";

export const PURPOSES = ["register", "login", "delete-account"] as const;
export type Purpose = (typeof PURPOSES)[number];
export const TICKET_LIFE_S = 120;
export const TICKET_LIFE_PEER_LIMIT_S = 600;
// A ticket renewed at the peer limit never lives past this many seconds from the first ticket.
export const TICKET_RENEW_MAX_S = 1800;
export const REQUEST_TOKEN_LIFE_S = 900;
export const STATE_LIFE_S = 600;

export async function makeToken(secret: string, label: string, body: object): Promise<string> {
  const part = b64urlEncode(utf8(JSON.stringify(body)));
  const mac = await hmac(secret, utf8(label + part));
  return part + "." + b64urlEncode(mac);
}

// Returns the parsed body object, or null when the form or MAC is wrong.
export async function openToken(secret: string, label: string, token: unknown): Promise<Record<string, unknown> | null> {
  if (typeof token !== "string" || token.length > 4096) return null;
  const dot = token.indexOf(".");
  if (dot < 1 || dot !== token.lastIndexOf(".")) return null;
  const part = token.slice(0, dot);
  const mac = b64urlDecode(token.slice(dot + 1));
  const bodyBytes = b64urlDecode(part);
  if (!mac || mac.length !== 32 || !bodyBytes) return null;
  if (!ctEqual(mac, await hmac(secret, utf8(label + part)))) return null;
  try {
    const v = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bodyBytes));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// k = b64url(sha256(sign_pub raw bytes)), 43 chars.
export async function keyRef(signPubRaw: Uint8Array): Promise<string> {
  return b64urlEncode(await sha256(signPubRaw));
}

export interface Ticket {
  a: string; // account id
  k: string;
  p: Purpose;
  x: number; // expiry, unix s
  i?: number; // first ticket's issue time, unix s (set on peer-limit renewal)
  s?: string; // sealed Apple refresh token (delete-account only)
}

export async function makeTicket(secret: string, t: Ticket): Promise<string> {
  return makeToken(secret, LABEL_TICKET, t);
}

// PKCE verifier derived from the state nonce n (43 chars).
export async function pkceVerifier(secret: string, n: string): Promise<string> {
  return b64urlEncode(await hmac(secret, utf8(LABEL_PKCE + n)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64urlEncode(await sha256(utf8(verifier)));
}

// OAuth nonce = b64url(sha256("PA-NONCE1\n" + purpose + "\n" + k)).
export async function oauthNonce(purpose: string, k: string): Promise<string> {
  return b64urlEncode(await sha256(utf8("PA-NONCE1\n" + purpose + "\n" + k)));
}

async function sealKey(secret: string): Promise<CryptoKey> {
  const raw = await hmac(secret, utf8(LABEL_SEAL));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// AES-256-GCM under a key derived from PA_TOKEN_SECRET; output b64url(iv 12 || ct+tag).
export async function seal(secret: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealKey(secret), utf8(plaintext)));
  return b64urlEncode(concat(iv, ct));
}

export async function unseal(secret: string, sealed: string): Promise<string | null> {
  const raw = b64urlDecode(sealed);
  if (!raw || raw.length < 12 + 16) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, await sealKey(secret), raw.slice(12));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}
