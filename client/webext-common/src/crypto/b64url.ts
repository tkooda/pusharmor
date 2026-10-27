// Strict, canonical base64url (RFC 4648 URL alphabet, no padding).
// Decoder rejects "=", any char outside A-Z a-z 0-9 - _, length mod 4 = 1
// and nonzero spare bits.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

export class B64Error extends Error {}

export function b64urlEncode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALPHABET[(v >> 18) & 63]! + ALPHABET[(v >> 12) & 63]! + ALPHABET[(v >> 6) & 63]! + ALPHABET[v & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const v = bytes[i]! << 16;
    out += ALPHABET[(v >> 18) & 63]! + ALPHABET[(v >> 12) & 63]!;
  } else if (rest === 2) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += ALPHABET[(v >> 18) & 63]! + ALPHABET[(v >> 12) & 63]! + ALPHABET[(v >> 6) & 63]!;
  }
  return out;
}

export function b64urlDecode(s: string): Uint8Array {
  const len = s.length;
  if (len % 4 === 1) throw new B64Error("bad length");
  const vals = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? LOOKUP[c]! : -1;
    if (v < 0) throw new B64Error("bad char");
    vals[i] = v;
  }
  const full = Math.floor(len / 4);
  const rest = len % 4;
  const out = new Uint8Array(full * 3 + (rest === 0 ? 0 : rest - 1));
  let o = 0;
  let i = 0;
  for (let q = 0; q < full; q++, i += 4) {
    const v = (vals[i]! << 18) | (vals[i + 1]! << 12) | (vals[i + 2]! << 6) | vals[i + 3]!;
    out[o++] = (v >> 16) & 255;
    out[o++] = (v >> 8) & 255;
    out[o++] = v & 255;
  }
  if (rest === 2) {
    if ((vals[i + 1]! & 15) !== 0) throw new B64Error("spare bits");
    out[o++] = ((vals[i]! << 2) | (vals[i + 1]! >> 4)) & 255;
  } else if (rest === 3) {
    if ((vals[i + 2]! & 3) !== 0) throw new B64Error("spare bits");
    const v = (vals[i]! << 12) | (vals[i + 1]! << 6) | vals[i + 2]!;
    out[o++] = (v >> 10) & 255;
    out[o++] = (v >> 2) & 255;
  }
  return out;
}

/** Decode, returning null instead of throwing. */
export function b64urlTryDecode(s: string): Uint8Array | null {
  try {
    return b64urlDecode(s);
  } catch {
    return null;
  }
}
