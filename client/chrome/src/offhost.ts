// The service worker's file host: the offscreen document, created on demand. It
// closes itself when idle; a service worker that starts also closes one that says
// it is idle (the worker sleeps after 30 s, so it keeps no timer for this).
import { type FileHost, HostFailed, HostGone } from "../../webext-common/src/core/files.ts";
import type { Browser } from "../../webext-common/src/shim-types.ts";

export function offscreenHost(b: Browser): FileHost {
  let creating: Promise<void> | null = null;
  const exists = async () => !!(await b.runtime.getContexts?.({ contextTypes: ["OFFSCREEN_DOCUMENT"] }))?.length;
  const ensure = async () => {
    if (await exists()) return;
    creating ??= b.offscreen!
      .createDocument({ url: "offscreen.html", reasons: ["BLOBS"], justification: "Encrypts, uploads, downloads, decrypts, and saves files sent between your devices" })
      .catch((e: unknown) => {
        if (!/single offscreen/i.test(String((e as Error)?.message))) throw e; // one already exists
      })
      .finally(() => (creating = null));
    await creating;
  };
  void (async () => {
    if (!(await exists().catch(() => false))) return;
    const r = (await b.runtime.sendMessage({ target: "offscreen", req: { op: "idle" } }).catch(() => null)) as { idle?: boolean } | null;
    if (r?.idle && !creating) await b.offscreen?.closeDocument().catch(() => undefined);
  })();
  return {
    async run(req) {
      try {
        await ensure();
      } catch {
        throw new HostFailed();
      }
      let r: unknown;
      try {
        r = await b.runtime.sendMessage({ target: "offscreen", req });
      } catch {
        throw new HostGone(); // the document closed while the job ran (its process ended)
      }
      if (r === null || r === undefined) throw new HostFailed();
      return r;
    },
  };
}
