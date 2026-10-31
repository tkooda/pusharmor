// Store screenshots of the Chrome popup (workflow screenshots.yml):
//   node build.mjs --dev --shots && node shots.mjs <out-dir> [chrome binary]
//   node build.mjs --dev --shots && node shots.mjs <out-dir> --firefox [firefox binary]
// --firefox: headless Firefox, page loaded with ?platform=firefox (this device is Firefox).
// Serves chrome/dist/unpacked on a local port and loads shots.html#<tab> in headless
// Chrome at 1280x800 (branded Chrome 137+ ignores --load-extension, so the page runs as a
// plain web page; the popup gets canned replies and makes no Worker call).
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";

const SHOTS = [
  ["01-send", "send"],
  ["02-peers-fingerprint", "peers"],
  ["03-history-received-link", "history"],
];
// --popup=<dir>: the About-page popup shots (plus the send message and the Remove confirm) (400x560 popup alone, captured at 2x: 800x1120 files).
// --review=<dir>: also write review images (sign-in, Settings, Log out) there; not store shots.
const REVIEW = [
  ["90-signin", "signin.html#email"],
  ["91-settings", "shots.html#settings"],
  ["92-signout", "shots.html#signout"],
  ["93-signin-popup", "signin.html#popup"],
];
const POPUP = [
  ["04-first-pair-waiting", "shots.html?bare&n=0&wait#peers"],
  ["05-pairing-code", "shots.html?bare&only=new#peers"],
  ["06-settings", "shots.html?bare&top#settings"],
  ["07-devices", "shots.html?bare&n=9#peers"],
  ["08-send-error", "shots.html?bare&n=3&senderr#send"],
  ["09-history-open", "shots.html?bare&open#history"],
  ["10-send-done", "shots.html?bare&n=3&sendok#send"],
  ["11-remove-confirm", "shots.html?bare&n=3&confirm#peers"],
];
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };

const firefox = process.argv.includes("--firefox");
const reviewArg = process.argv.find((a) => a.startsWith("--review="));
const reviewOut = reviewArg?.slice("--review=".length);
const popupArg = process.argv.find((a) => a.startsWith("--popup="));
const popupOut = popupArg?.slice("--popup=".length);
const [out, bin0] = process.argv.slice(2).filter((a) => a !== "--firefox" && a !== reviewArg && a !== popupArg);
const chrome = bin0 ?? (firefox ? process.env.FIREFOX ?? "firefox" : process.env.CHROME ?? "google-chrome");
if (!out) {
  console.error("usage: node shots.mjs <out-dir> [--firefox] [browser binary]");
  process.exit(2);
}
const root = resolve(new URL("../chrome/dist/unpacked", import.meta.url).pathname);
if (!existsSync(join(root, "shots.html"))) {
  console.error("no shots.html in " + root + ": run node build.mjs --dev --shots first");
  process.exit(1);
}
mkdirSync(out, { recursive: true });
if (reviewOut) mkdirSync(reviewOut, { recursive: true });
if (popupOut) mkdirSync(popupOut, { recursive: true });

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  if (firefox && path === "/hold.png") {
    setTimeout(() => res.writeHead(200, { "content-type": "image/png" }).end(PIX), 3000);
    return;
  }
  const file = resolve(join(root, path));
  if (!file.startsWith(root + "/") || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  let body = readFileSync(file);
  // Firefox draws the tab switch after the screenshot is taken; a slow image holds the load event.
  if (firefox && (path === "/shots.html" || path === "/signin.html")) {
    body = body.toString().replace("</body>", '<img src="hold.png" alt="" style="position:absolute;width:1px;height:1px;opacity:0"><style>.frame,.frame *{scrollbar-width:none}</style></body>');
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const port = server.address().port;

const PIX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const run = promisify(execFile);
// ?platform=firefox (and ?ff for the sign-in page) before the #fragment
const ffPage = (page, popup) => {
  const [path, hash] = page.split("#");
  return `${path}${path.includes("?") ? "&" : "?"}platform=firefox&ff${popup ? "&zoom=2" : ""}#${hash}`;
};
let failed = false;
const jobs = SHOTS.map(([name, tab]) => [name, "shots.html#" + tab, out]);
if (reviewOut) jobs.push(...REVIEW.map(([name, page]) => [name, page, reviewOut]));
if (popupOut) jobs.push(...POPUP.map(([name, page]) => [name, page, popupOut, true]));
for (const [name, page, dir, popup] of jobs) {
  const size = popup && firefox ? "800,1120" : popup ? "400,560" : "1280,800";
  const scale = popup ? 2 : 1;
  const profile = mkdtempSync(join(tmpdir(), "pa-shots-"));
  const png = resolve(dir, name + ".png");
  try {
    if (firefox) {
      writeFileSync(join(profile, "user.js"), [
        ["font.name.sans-serif.x-western", "Noto Sans"], ["font.name.serif.x-western", "Noto Sans"],
        ["font.name.monospace.x-western", "DejaVu Sans Mono"], ["font.default.x-western", "sans-serif"],
      ].map(([k, v]) => `user_pref("${k}", "${v}");`).join("\n") + "\n");
      await run(chrome, ["--headless", "--no-remote", "--profile", profile, "--window-size=" + size,
        "--screenshot", png, `http://127.0.0.1:${port}/${ffPage(page, popup)}`], { timeout: 90_000 });
    } else await run(chrome, [
      "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=" + scale, "--window-size=" + size,
      "--virtual-time-budget=3000", "--no-first-run", "--no-default-browser-check", "--disable-gpu",
      "--user-data-dir=" + profile, "--screenshot=" + png, `http://127.0.0.1:${port}/${page}`,
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
