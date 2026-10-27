// Strict canonical b64url (RFC 4648 URL alphabet, no padding). Rejects "=", any char
// outside A-Z a-z 0-9 - _, length mod 4 = 1 and nonzero spare bits.
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHA.length; i++) LOOKUP[ALPHA.charCodeAt(i)] = i;

export function b64urlEncode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHA[(n >> 18) & 63] + ALPHA[(n >> 12) & 63] + ALPHA[(n >> 6) & 63] + ALPHA[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += ALPHA[(n >> 18) & 63] + ALPHA[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += ALPHA[(n >> 18) & 63] + ALPHA[(n >> 12) & 63] + ALPHA[(n >> 6) & 63];
  }
  return out;
}

// Returns null for any non-canonical input.
export function b64urlDecode(s: string): Uint8Array | null {
  const len = s.length;
  if (len % 4 === 1) return null;
  const vals = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? LOOKUP[c] : -1;
    if (v < 0) return null;
    vals[i] = v;
  }
  const full = Math.floor(len / 4);
  const rem = len % 4;
  const out = new Uint8Array(full * 3 + (rem === 0 ? 0 : rem - 1));
  let o = 0;
  let i = 0;
  for (; i < full * 4; i += 4) {
    const n = (vals[i] << 18) | (vals[i + 1] << 12) | (vals[i + 2] << 6) | vals[i + 3];
    out[o++] = (n >> 16) & 255;
    out[o++] = (n >> 8) & 255;
    out[o++] = n & 255;
  }
  if (rem === 2) {
    if (vals[i + 1] & 15) return null;
    out[o++] = (vals[i] << 2) | (vals[i + 1] >> 4);
  } else if (rem === 3) {
    if (vals[i + 2] & 3) return null;
    const n = (vals[i] << 10) | (vals[i + 1] << 4) | (vals[i + 2] >> 2);
    out[o++] = (n >> 8) & 255;
    out[o++] = n & 255;
  }
  return out;
}

// True if s is canonical b64url of exactly nbytes bytes.
export function isB64urlBytes(s: unknown, nbytes: number): s is string {
  return typeof s === "string" && s.length === Math.ceil((nbytes * 4) / 3) && b64urlDecode(s) !== null;
}

export function isB64url(s: unknown): s is string {
  return typeof s === "string" && b64urlDecode(s) !== null;
}
