// The service worker's file host: the offscreen document, created on demand and
// closed when no job ran for a minute.
import type { FileHost } from "../../webext-common/src/core/files.ts";
import type { Browser } from "../../webext-common/src/shim-types.ts";

const IDLE_MS = 60_000;

export function offscreenHost(b: Browser): FileHost {
  let creating: Promise<void> | null = null;
  let jobs = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const ensure = async () => {
    const open = await b.runtime.getContexts?.({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (open?.length) return;
    creating ??= b.offscreen!
      .createDocument({ url: "offscreen.html", reasons: ["BLOBS"], justification: "Encrypts, uploads, downloads, and decrypts files sent between your devices" })
      .catch((e: unknown) => {
        if (!/single offscreen/i.test(String((e as Error)?.message))) throw e; // one already exists
      })
      .finally(() => (creating = null));
    await creating;
  };
  return {
    async run(req) {
      clearTimeout(idle);
      jobs++;
      try {
        await ensure();
        const r = await b.runtime.sendMessage({ target: "offscreen", req });
        if (r === null || r === undefined) throw new Error("file job failed");
        return r;
      } finally {
        if (--jobs === 0) idle = setTimeout(() => void (jobs === 0 && b.offscreen?.closeDocument().catch(() => undefined)), IDLE_MS);
      }
    },
  };
}
