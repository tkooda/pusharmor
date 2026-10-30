// Add-on catch of the site SW forward (section 5.3): webRequest on
// https://pusharmor.com/fx/fwd, blocking, requestBody.
import type { WebRequestDetails } from "../../../webext-common/src/shim-types.ts";

export const FWD_MAX = 3800;

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
