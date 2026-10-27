// Email normalization: trim ASCII whitespace, then ASCII-only lowercase (A-Z -> a-z).
// Any char outside ASCII -> 400 "bad email". Relay addresses are accepted.
import { ApiError } from "../errors";

export function normalizeEmail(input: unknown): string {
  if (typeof input !== "string") throw new ApiError(400, "bad request");
  const s = input.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) throw new ApiError(400, "bad email");
  const out = s.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
  const at = out.indexOf("@");
  if (out.length > 254 || at < 1 || at !== out.lastIndexOf("@") || at === out.length - 1 || /[\x00-\x20\x7f]/.test(out)) {
    throw new ApiError(400, "bad request");
  }
  return out;
}
