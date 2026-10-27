// Wire size buckets (catalog Inner message, Size cap).

export const BUCKETS = [512, 1024, 2048, 3800] as const;
export const WIRE_CAP = 3800;
export const CONTENT_CAP = 2048;
export const INFLATE_CAP = 16384;
export const PAIR_WIRE_LEN = 366;

/** b64url chars for n bytes. */
export function wireChars(bytes: number): number {
  return Math.ceil((bytes * 4) / 3);
}

/**
 * Total HPKE wire bytes (enc + ct + tag) to pad to, given the unpadded total.
 * Rounds the wire length up to the next bucket; approve never below 1024.
 * Returns null when the message cannot fit under 3800 chars.
 */
export function paddedWireBytes(unpaddedBytes: number, approve: boolean): number | null {
  const chars = wireChars(unpaddedBytes);
  for (const b of BUCKETS) {
    if (approve && b < 1024) continue;
    if (chars <= b) return Math.floor((b * 3) / 4);
  }
  return null;
}

/** UTF-8 byte length (size cap counter). */
export function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** The first maxBytes UTF-8 bytes of s, cut on a code point boundary. */
export function truncateUtf8(s: string, maxBytes: number = CONTENT_CAP): string {
  let bytes = 0;
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const len = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + len > maxBytes) break;
    bytes += len;
    out += ch;
  }
  return out;
}
