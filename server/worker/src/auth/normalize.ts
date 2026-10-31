// Email normalization: trim ASCII whitespace, then ASCII-only lowercase (A-Z -> a-z).
// Any char outside ASCII -> 400 "bad email"; controls, space and <>"(),;:\ -> 400.
// Relay addresses are accepted. The account identity is mailboxKey() of the result (Q334);
// login codes still go to the normalized address as typed.
import { ApiError } from "../errors";

export function normalizeEmail(input: unknown): string {
  if (typeof input !== "string") throw new ApiError(400, "bad request");
  const s = input.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) throw new ApiError(400, "bad email");
  const out = s.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
  const at = out.indexOf("@");
  if (out.length > 254 || at < 1 || at !== out.lastIndexOf("@") || at === out.length - 1 || /[\x00-\x20\x7f<>"(),;:\\]/.test(out)) {
    throw new ApiError(400, "bad request");
  }
  return out;
}

// Providers that deliver "local+tag" to "local"; Gmail also ignores dots in the local part.
const PLUS_TAG = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "fastmail.com", "proton.me", "protonmail.com", "protonmail.ch", "pm.me"]);
const GMAIL = new Set(["gmail.com", "googlemail.com"]);

// Account identity and abuse limiter key: one mailbox for a normalized address.
export function mailboxKey(normalized: string): string {
  const at = normalized.lastIndexOf("@");
  let local = normalized.slice(0, at);
  let domain = normalized.slice(at + 1);
  if (!PLUS_TAG.has(domain)) return normalized;
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (GMAIL.has(domain)) {
    domain = "gmail.com";
    local = local.replace(/\./g, "") || local;
  }
  return local + "@" + domain;
}
