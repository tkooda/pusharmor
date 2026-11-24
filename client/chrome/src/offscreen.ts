// Chrome offscreen document (reason BLOBS): runs every file transfer and decrypt
// for the service worker, which writes the History rows. Requests come by runtime
// message with target "offscreen"; download progress goes back as fileProgress.
// While a job runs, a beat every 20 s keeps the service worker running for the reply.
import { type JobReq, openWorker } from "../../webext-common/src/core/fileworker.ts";
import { browser } from "./shim.ts";

const worker = openWorker("chrome/" + browser.runtime.getManifest().version, (id, have, total) => {
  void browser.runtime.sendMessage({ op: "fileProgress", id, have, total }).catch(() => undefined);
});
let active = 0;

browser.runtime.onMessage.addListener((msg, _sender, respond) => {
  const m = msg as { target?: unknown; req?: JobReq } | null;
  if (m?.target !== "offscreen" || !m.req) return false;
  active++;
  void worker()
    .then((w) => w.run(m.req!))
    .then(respond, () => respond(null))
    .finally(() => active--);
  return true;
});

setInterval(() => {
  if (active) void browser.runtime.sendMessage({ op: "fileBeat" }).catch(() => undefined);
}, 20_000);
