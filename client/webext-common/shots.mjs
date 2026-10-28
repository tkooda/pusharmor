// Store screenshots of the Chrome popup (workflow screenshots.yml):
//   node build.mjs --dev --shots && node shots.mjs <out-dir> [chrome binary]
// Serves chrome/dist/unpacked on a local port and loads shots.html#<tab> in headless
// Chrome at 1280x800 (branded Chrome 137+ ignores --load-extension, so the page runs as a
// plain web page; the popup gets canned replies and makes no Worker call).
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";

const SHOTS = [
  ["01-send", "send"],
  ["02-peers-fingerprint", "peers"],
  ["03-history-received-link", "history"],
];
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };

const out = process.argv[2];
const chrome = process.argv[3] ?? process.env.CHROME ?? "google-chrome";
if (!out) {
  console.error("usage: node shots.mjs <out-dir> [chrome binary]");
  process.exit(2);
}
const root = resolve(new URL("../chrome/dist/unpacked", import.meta.url).pathname);
if (!existsSync(join(root, "shots.html"))) {
  console.error("no shots.html in " + root + ": run node build.mjs --dev --shots first");
  process.exit(1);
}
mkdirSync(out, { recursive: true });

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  const file = resolve(join(root, path));
  if (!file.startsWith(root + "/") || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const port = server.address().port;

const run = promisify(execFile);
let failed = false;
for (const [name, tab] of SHOTS) {
  const profile = mkdtempSync(join(tmpdir(), "pa-shots-"));
  const png = resolve(out, name + ".png");
  try {
    await run(chrome, [
      "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1280,800",
      "--virtual-time-budget=3000", "--no-first-run", "--no-default-browser-check", "--disable-gpu",
      "--user-data-dir=" + profile, "--screenshot=" + png, `http://127.0.0.1:${port}/shots.html#${tab}`,
    ], { timeout: 60_000 });
    console.log("wrote", png);
  } catch (e) {
    console.error(name + ": " + e.message);
    failed = true;
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}
server.close();
process.exit(failed ? 1 : 0);
