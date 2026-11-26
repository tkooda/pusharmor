// Chrome offscreen document (reason BLOBS): runs every file transfer and decrypt
// for the service worker, which writes the History rows. Requests come by runtime
// message with target "offscreen"; download progress goes back as fileProgress.
// While a job runs, a beat every 20 s keeps the service worker running for the reply.
// It also keeps the blob URLs of saved files (the popup's download link uses them),
// so a popup that closes during the Save-as dialog does not end the download.
// With no job and no save for IDLE_MS it closes itself; the service worker also
// closes it on its next start when it reports idle. An offscreen document has only
// the runtime messaging APIs, so the client name comes in each job message.
import { type FileWorker, type JobReq, octetUrl, openWorker } from "../../webext-common/src/core/fileworker.ts";
import { browser } from "./shim.ts";

/** No job for this long: the document closes. */
const IDLE_MS = 60_000;
/** A save's blob URL is kept this long (no downloads permission: Chrome does not say when a download ends). */
const SAVE_KEEP_MS = 30 * 60_000;

const saves = new Map<string, number>(); // blob URL -> made at
let active = 0;
let lastUse = Date.now();

let worker: (() => Promise<FileWorker>) | null = null;
const makeWorker = (client: string) =>
  openWorker(
    client,
    (id, have, total) => void browser.runtime.sendMessage({ op: "fileProgress", id, have, total }).catch(() => undefined),
    async (blob) => {
      const url = octetUrl(blob);
      saves.set(url, Date.now());
      return { url };
    },
  );
let w: FileWorker | null = null;

function idle(): boolean {
  const t = Date.now();
  for (const [url, at] of saves) {
    if (t - at < SAVE_KEEP_MS) continue;
    URL.revokeObjectURL(url);
    saves.delete(url);
  }
  return active === 0 && !saves.size && !(w?.busy() ?? false) && t - lastUse >= IDLE_MS;
}

browser.runtime.onMessage.addListener((msg, _sender, respond) => {
  const m = msg as { target?: unknown; req?: JobReq | { op: "idle" }; client?: string } | null;
  if (m?.target !== "offscreen" || !m.req) return false;
  if (m.req.op === "idle") {
    respond({ idle: idle() });
    return false;
  }
  const req = m.req;
  active++;
  lastUse = Date.now();
  worker ??= makeWorker(m.client ?? "chrome");
  void worker()
    .then((x) => ((w = x), x.run(req)))
    .then(respond, () => respond(null))
    .finally(() => {
      active--;
      lastUse = Date.now();
    });
  return true;
});

setInterval(() => {
  if (active || w?.busy()) void browser.runtime.sendMessage({ op: "fileBeat" }).catch(() => undefined);
  else if (idle()) window.close();
}, 20_000);
