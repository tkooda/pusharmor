// Release build of the site: fills the build ids from release/public.json into
// the assets directory in place, then rewrites the SRI and CSP hashes.
// "wrangler deploy" runs it as the build command from wrangler.jsonc (see site/README.md).
//   node site/tools/build.mjs [--dir DIR] [--public FILE]
// DIR defaults to site/public. Fails when a value is missing, empty, malformed
// or a PLACEHOLDER (or a CI dummy without PA_CI_DUMMY=1), or a placeholder is left.
// A CI dummy skips the format checks.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_PATH, loadPublic, publicProblems } from "../../release/public.mjs";
import { computeHashUpdates, placeholderFiles } from "./site-lib.mjs";

// wrangler.jsonc runs this script as its build command, also for "wrangler dev"
// (WRANGLER_COMMAND=dev). A dev run keeps the placeholders and must not rewrite the tree.
if (process.env.WRANGLER_COMMAND === "dev") { console.log("site build: skipped for wrangler dev"); process.exit(0); }

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const dir = arg("--dir") || join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const publicPath = arg("--public") || PUBLIC_PATH;

function fail(lines) {
  console.error("site build failed:");
  for (const l of lines) console.error("  - " + l);
  process.exit(1);
}

let pub;
try { pub = loadPublic(publicPath); } catch (e) { fail([publicPath + ": " + e.message]); }
const bad = publicProblems(["cloudflare_turnstile_sitekey", "webpush_vapid_public_key", "google_chrome_extension_id", "android_release_cert_sha256"], pub);
const dummy = (v) => /ci-fork-dummy/i.test(v);
if (!bad.length) {
  const id = pub.google_chrome_extension_id;
  if (!dummy(id) && !/^[a-p]{32}$/.test(id)) bad.push("release/public.json: google_chrome_extension_id is not 32 letters a-p");
  for (const f of [].concat(pub.android_release_cert_sha256)) {
    if (!dummy(f) && !/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(String(f).toUpperCase())) bad.push("release/public.json: android_release_cert_sha256 " + JSON.stringify(f) + " is not a SHA-256 fingerprint");
  }
}
if (bad.length) fail(bad);

function fill(rel, from, to) {
  const p = join(dir, rel);
  const s = readFileSync(p, "utf8");
  if (!s.includes(from)) fail([rel + ": " + from + " not found"]);
  writeFileSync(p, s.split(from).join(to));
}
fill("turnstile.html", 'data-sitekey="TURNSTILE_SITEKEY_PLACEHOLDER"', 'data-sitekey="' + pub.cloudflare_turnstile_sitekey + '"');
fill("js/fx-setup.js", '"VAPID_PUBLIC_KEY_PLACEHOLDER"', JSON.stringify(pub.webpush_vapid_public_key));
fill("_headers", "chrome-extension://CHROME_EXTENSION_ID", "chrome-extension://" + pub.google_chrome_extension_id);
const alp = join(dir, ".well-known", "assetlinks.json");
const al = JSON.parse(readFileSync(alp, "utf8"));
al[0].target.sha256_cert_fingerprints = [].concat(pub.android_release_cert_sha256).map((f) => String(f).toUpperCase());
writeFileSync(alp, JSON.stringify(al, null, 2) + "\n");

for (let i = 0; i < 3; i++) {
  const updates = computeHashUpdates(dir);
  if (!Object.keys(updates).length) break;
  for (const [rel, content] of Object.entries(updates)) writeFileSync(join(dir, rel), content);
}
if (Object.keys(computeHashUpdates(dir)).length) fail(["hashes did not settle"]);
const left = placeholderFiles(dir);
if (left.length) fail(left);
console.log("site build: ids filled and hashes rewritten in " + dir);
