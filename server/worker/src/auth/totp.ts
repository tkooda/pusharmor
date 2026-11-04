// Store review and release-gate logins: two fixed addresses log in with a TOTP code
// (RFC 6238: HMAC-SHA1, 6 digits, 30 s step, one step either side) instead of a mailed code.
// The addresses are held only as SHA-256 hex of the normalized address. Each has its own
// base32 key in a Worker secret; while that secret is unset, the address mails a code as usual.
import { ctEqualStr, utf8 } from "../crypto/hash";

type TotpSecret = "PA_TOTP_KEY_REVIEWER" | "PA_TOTP_KEY_RELEASE_TEST";

// SHA-256 hex of the normalized address -> the secret that holds its key. Exported for tests.
export const TOTP_LOGINS = new Map<string, TotpSecret>([
  ["0cb0ee6c640e13641d605d3fd417c1e412e707676424a34a92bef701c855c7c4", "PA_TOTP_KEY_REVIEWER"],
  ["34a7fa4e54529533ee628eb78cee8b7322eda149625c442bf1b33f13e55f3120", "PA_TOTP_KEY_RELEASE_TEST"],
]);

export const TOTP_STEP_S = 30;

// RFC 4648 base32 (upper or lower case, optional "=" padding); null on any other char.
export function base32Decode(s: string): Uint8Array | null {
  const t = s.replace(/=+$/, "").toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of t) {
    const v = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 255);
    }
  }
  return out.length ? new Uint8Array(out) : null;
}

// The key for a normalized address, or null (not a TOTP address, or its secret is unset or bad).
export async function totpKeyFor(env: Partial<Record<TotpSecret, string>>, normalized: string): Promise<Uint8Array | null> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(normalized)));
  let h = "";
  for (const x of d) h += x.toString(16).padStart(2, "0");
  const name = TOTP_LOGINS.get(h);
  const v = name ? env[name] : undefined;
  return v ? base32Decode(v) : null;
}

// HOTP (RFC 4226) over the 8-byte big-endian counter.
export async function totp(key: Uint8Array, counter: number, digits = 6): Promise<string> {
  const msg = new Uint8Array(8);
  const view = new DataView(msg.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const m = new Uint8Array(await crypto.subtle.sign("HMAC", k, msg));
  const o = m[m.length - 1] & 15;
  const bin = ((m[o] & 127) << 24) | (m[o + 1] << 16) | (m[o + 2] << 8) | m[o + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

// True when input is the code of the current step or one step either side.
export async function checkTotp(key: Uint8Array, input: string, nowSeconds: number): Promise<boolean> {
  if (!/^[0-9]{6}$/.test(input)) return false;
  const c = Math.floor(nowSeconds / TOTP_STEP_S);
  let ok = false;
  for (const s of [c - 1, c, c + 1]) if (ctEqualStr(input, await totp(key, s))) ok = true;
  return ok;
}
