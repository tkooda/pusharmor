// The service worker's file host: the offscreen document, created on demand. It
// closes itself when idle; a service worker that starts also closes one that says
// it is idle (the worker sleeps after 30 s, so it keeps no timer for this), but
// never while a job of this worker is queued or running. A job whose document
// closed under it (an idle close racing the job) opens a new one and runs once more,
// except a decrypt, which is never re-run by itself.
import { type FileHost, HostFailed, HostGone } from "../../webext-common/src/core/files.ts";
import type { Browser } from "../../webext-common/src/shim-types.ts";

export function offscreenHost(b: Browser): FileHost {
  let creating: Promise<void> | null = null;
  let jobs = 0;
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
  // the start check: the close waits for its answer and runs only while no job is queued here
  let closing: Promise<void> | null = (async () => {
    if (!(await exists().catch(() => false))) return;
    const r = (await b.runtime.sendMessage({ target: "offscreen", req: { op: "idle" } }).catch(() => null)) as { idle?: boolean } | null;
    if (r?.idle && jobs === 0 && !creating) await b.offscreen?.closeDocument().catch(() => undefined);
  })().finally(() => (closing = null));
  return {
    async run(req) {
      jobs++;
      try {
        if (closing) await closing;
        for (let attempt = 0; ; attempt++) {
          try {
            await ensure();
          } catch {
            throw new HostFailed();
          }
          let r: unknown;
          try {
            r = await b.runtime.sendMessage({ target: "offscreen", req, client: "chrome/" + b.runtime.getManifest().version });
          } catch {
            if (attempt === 0 && req.op !== "decrypt") continue; // closed under the job: a new document, once
            throw new HostGone();
          }
          if (r === null || r === undefined) throw new HostFailed();
          return r;
        }
      } finally {
        jobs--;
      }
    },
  };
}
