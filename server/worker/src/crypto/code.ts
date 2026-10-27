// Email code: first 30 bits of HMAC-SHA256(CODE_SECRET, request_token string), MSB first,
// as 6 Crockford chars. Input is upper-cased and Crockford-mapped (O->0, I/L->1).
import { ctEqualStr, hmac, utf8 } from "./hash";

export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export async function deriveCode(codeSecret: string, requestToken: string): Promise<string> {
  const m = await hmac(codeSecret, utf8(requestToken));
  const bits = ((m[0] << 24) | (m[1] << 16) | (m[2] << 8) | m[3]) >>> 2; // top 30 bits
  let out = "";
  for (let i = 5; i >= 0; i--) out += CROCKFORD[(bits >>> (i * 5)) & 31];
  return out;
}

export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
}

export async function checkCode(codeSecret: string, requestToken: string, input: string): Promise<boolean> {
  return ctEqualStr(normalizeCode(input), await deriveCode(codeSecret, requestToken));
}
