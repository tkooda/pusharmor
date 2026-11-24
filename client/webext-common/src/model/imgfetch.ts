// "PushArmor image to": the bytes of a page image. pageImageFetch runs in the page
// (activeTab, injected on the menu click) and sends the bytes over a port in
// base64 pieces of at most 8 MB; the background joins them, up to MAX_FILE.
// Anything else (no bytes, refused by the page's server, over the cap) sends the
// image URL instead.
import { MAX_FILE } from "../crypto/filecrypt.ts";

/** Raw bytes per piece: 6,000,000 bytes are 8,000,000 base64 characters. */
export const PIECE_RAW = 6_000_000;
export const PIECE_B64 = 8_000_000;

export type ImgMsg = { b64: string } | { done: true; type: string } | { over: true } | { failed: true };

/**
 * Injected into the page: no reference to anything outside this function. Connects a port named
 * portName and sends the bytes of src, then { done, type }; { over } past cap bytes; { failed } on any error.
 */
export function pageImageFetch(src: string, portName: string, cap: number, piece: number): void {
  const g = globalThis as unknown as { browser?: { runtime: unknown }; chrome?: { runtime: unknown } };
  const rt = (g.browser ?? g.chrome)!.runtime as { connect(o: { name: string }): { postMessage(m: unknown): void } };
  const port = rt.connect({ name: portName });
  const b64 = (parts: Uint8Array[], n: number): string => {
    const all = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
      all.set(p, o);
      o += p.length;
    }
    let s = "";
    for (let i = 0; i < n; i += 0x8000) s += String.fromCharCode(...all.subarray(i, i + 0x8000));
    return btoa(s);
  };
  void (async () => {
    try {
      const res = await fetch(src);
      if (!res.ok || !res.body) throw new Error("no image");
      if (Number(res.headers.get("content-length") ?? 0) > cap) return port.postMessage({ over: true });
      const reader = res.body.getReader();
      let parts: Uint8Array[] = [];
      let held = 0;
      let total = 0;
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        let v = r.value;
        total += v.length;
        if (total > cap) {
          void reader.cancel();
          return port.postMessage({ over: true });
        }
        while (held + v.length >= piece) {
          const take = piece - held;
          parts.push(v.subarray(0, take));
          port.postMessage({ b64: b64(parts, piece) });
          parts = [];
          held = 0;
          v = v.subarray(take);
        }
        if (v.length) {
          parts.push(v);
          held += v.length;
        }
      }
      if (held) port.postMessage({ b64: b64(parts, held) });
      port.postMessage({ done: true, type: res.headers.get("content-type") ?? "" });
    } catch {
      port.postMessage({ failed: true });
    }
  })();
}

/** Joins the pieces; refuses a piece over PIECE_B64 characters and a total over MAX_FILE. */
export class ImageCollector {
  private parts: Uint8Array<ArrayBuffer>[] = [];
  size = 0;
  /** -> "more", or the end: "done" (blob() has the bytes), "over", or "failed". */
  add(m: unknown): "more" | "done" | "over" | "failed" {
    const x = (m ?? {}) as Record<string, unknown>;
    if (typeof x.b64 === "string") {
      if (x.b64.length > PIECE_B64) return "failed";
      let bin: string;
      try {
        bin = atob(x.b64);
      } catch {
        return "failed";
      }
      this.size += bin.length;
      if (this.size > MAX_FILE) return "over";
      const b = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
      this.parts.push(b);
      return "more";
    }
    if (x.done === true) return this.size > 0 ? "done" : "failed";
    if (x.over === true) return "over";
    return "failed";
  }

  blob(): Blob {
    return new Blob(this.parts);
  }

  head(): Uint8Array {
    return this.parts[0]?.subarray(0, 32) ?? new Uint8Array(0);
  }
}

export interface PortLike {
  name: string;
  onMessage: { addListener(f: (m: unknown) => void): void };
  onDisconnect: { addListener(f: () => void): void };
  disconnect(): void;
}

/** Waiting ports by name: the background's runtime.onConnect hands each "pa-img:" port to its waiter. */
const waiting = new Map<string, (p: PortLike) => void>();

export function onImagePort(p: PortLike): void {
  const w = waiting.get(p.name);
  if (!w) return;
  waiting.delete(p.name);
  w(p);
}

/** How long a page may take to send the image. */
export const IMAGE_WAIT_MS = 120_000;

/**
 * Runs inject (which injects pageImageFetch with the port name) and collects the image.
 * -> the bytes and the Content-Type, or null (send the image URL).
 */
export async function collectImage(inject: (portName: string) => Promise<void>, waitMs = IMAGE_WAIT_MS): Promise<{ blob: Blob; head: Uint8Array; type: string } | null> {
  const name = "pa-img:" + crypto.randomUUID();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const got = new Promise<{ blob: Blob; head: Uint8Array; type: string } | null>((resolve) => {
    timer = setTimeout(() => {
      waiting.delete(name);
      resolve(null);
    }, waitMs);
    waiting.set(name, (p) => {
      const c = new ImageCollector();
      let ended = false;
      const end = (v: { blob: Blob; head: Uint8Array; type: string } | null) => {
        if (ended) return;
        ended = true;
        try {
          p.disconnect();
        } catch {
          // already closed
        }
        resolve(v);
      };
      p.onMessage.addListener((m) => {
        const r = c.add(m);
        if (r === "done") end({ blob: c.blob(), head: c.head(), type: String((m as { type?: unknown }).type ?? "") });
        else if (r !== "more") end(null);
      });
      p.onDisconnect.addListener(() => end(null));
    });
  });
  try {
    await inject(name);
  } catch {
    waiting.delete(name);
    clearTimeout(timer);
    return null;
  }
  const r = await got;
  clearTimeout(timer);
  return r;
}
