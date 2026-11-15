// Add-on catch of the site SW forward (section 5.3): webRequest on
// https://pusharmor.com/fx/fwd, blocking, requestBody.
import { historyAt } from "../../../webext-common/src/core/actions.ts";
import type { WebRequestDetails } from "../../../webext-common/src/shim-types.ts";
import type { HistoryRow } from "../../../webext-common/src/store/db.ts";

export const FWD_MAX = 3800;

/** A site message to relay: a string no longer than the forward cap. */
export const fwdAllowed = (m: unknown): m is string => typeof m === "string" && m.length <= FWD_MAX;

/** The site SW forwards a changed push subscription as "sub:" + JSON; undefined for any other body. */
export function readSub(m: string): unknown {
  if (!m.startsWith("sub:")) return undefined;
  try {
    return JSON.parse(m.slice(4)) as unknown;
  } catch {
    return null;
  }
}

/**
 * Returns the forwarded M when the request is the site SW fetch (tabId -1,
 * type xmlhttprequest, origin under https://pusharmor.com/fx/ required), or
 * null to let the page see the normal 404. tooLarge: cancel without delivery.
 */
export function readForward(d: WebRequestDetails): { m: string | null; cancel: boolean } {
  if (d.tabId !== -1 || d.type !== "xmlhttprequest" || d.method !== "POST") return { m: null, cancel: false };
  if (d.originUrl === undefined || !d.originUrl.startsWith("https://pusharmor.com/fx/")) return { m: null, cancel: false };
  const parts = d.requestBody?.raw ?? [];
  let total = 0;
  for (const p of parts) total += p.bytes ? p.bytes.byteLength : 0;
  if (total > FWD_MAX) return { m: null, cancel: true };
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    if (!p.bytes) continue;
    out.set(new Uint8Array(p.bytes), o);
    o += p.bytes.byteLength;
  }
  let m = "";
  for (const b of out) m += String.fromCharCode(b);
  return { m, cancel: true };
}

/**
 * webRequest listener result. A delivery that fails lets the request reach the
 * network (404): the site SW then keeps its notification for a click to retry.
 */
export async function onForward(d: WebRequestDetails, deliver: (m: string) => Promise<void>): Promise<{ cancel?: boolean }> {
  const r = readForward(d);
  if (r.m !== null) {
    try {
      await deliver(r.m);
    } catch {
      return {};
    }
  }
  return r.cancel ? { cancel: true } : {};
}

/** What /fx/open turns into once its waiting messages are passed on: the full view on History at the newest received message (rows newest first). */
export const fxShowView = (rows: HistoryRow[]): string => historyAt(rows.find((r) => r.dir === "in" && r.type !== "event")?.id);

/**
 * The site SW keeps each message it forwards in its queue (newest 150, up to 14 days)
 * and /fx/open passes every queued one on again. The add-on keeps a SHA-256 of each
 * message it has handled for as long, so /fx/open gets an ack for a known one
 * without a second receive, and the page deletes that queue entry.
 */
export const SEEN_MAX = 150;
export const SEEN_AGE_MS = 14 * 24 * 3600 * 1000;
export type Seen = { h: string; t: number }[];

async function fwdKey(m: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(m)));
  let s = "";
  for (const b of d) s += b.toString(16).padStart(2, "0");
  return s;
}

/** The handled-message record; calls run one at a time. */
export function fwdSeen(load: () => Promise<Seen | undefined>, save: (s: Seen) => Promise<void>, now: () => number) {
  let chain: Promise<unknown> = Promise.resolve();
  const run = <T>(f: () => Promise<T>): Promise<T> => {
    const p = chain.then(f);
    chain = p.catch(() => undefined);
    return p;
  };
  const fresh = async () => ((await load()) ?? []).filter((e) => now() - e.t <= SEEN_AGE_MS);
  return {
    has: (m: string) =>
      run(async () => {
        const h = await fwdKey(m);
        return (await fresh()).some((e) => e.h === h);
      }),
    add: (m: string) =>
      run(async () => {
        const h = await fwdKey(m);
        const s = (await fresh()).filter((e) => e.h !== h);
        s.push({ h, t: now() });
        await save(s.slice(-SEEN_MAX));
      }),
  };
}

/** /fx/open "fx-msg": a message handled before is acked at once; any other is received, then recorded, then acked. */
export async function bridgeMsg(m: string, seen: ReturnType<typeof fwdSeen>, receive: (m: string) => Promise<void>): Promise<{ ok: boolean }> {
  if (await seen.has(m)) return { ok: true };
  await receive(m);
  await seen.add(m);
  return { ok: true };
}
