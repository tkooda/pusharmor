// Byte helpers.

export const te = new TextEncoder();
const tdFatal = new TextDecoder("utf-8", { fatal: true });

export function utf8(s: string): Uint8Array {
  return te.encode(s);
}

/** ASCII-only string to bytes; throws on any char above 0x7f. */
export function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0x7f) throw new Error("non-ASCII");
    out[i] = c;
  }
  return out;
}

export function utf8Decode(b: Uint8Array): string {
  return tdFatal.decode(b);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

/** Unsigned lexicographic compare: <0 if a < b, 0 if equal, >0 if a > b. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

export function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function unhex(s: string): Uint8Array {
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) throw new Error("bad hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

/** Copy into a fresh ArrayBuffer-backed array (WebCrypto BufferSource typing). */
export function buf(b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(b.length);
  out.set(b);
  return out;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}
