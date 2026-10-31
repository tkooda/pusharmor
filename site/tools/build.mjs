// Release build of the site: copies site/public to OUT, fills the build ids from
// release/public.json into OUT, then rewrites the SRI and CSP hashes in OUT.
// The tracked site/public keeps its placeholders. "wrangler deploy" runs it as the
// build command from wrangler.jsonc and serves OUT (see site/README.md).
//   node site/tools/build.mjs [--out OUT] [--public FILE]
// OUT defaults to site/dist (gitignored) and is replaced. Fails when a value is missing, empty, malformed
// or a PLACEHOLDER (or a CI dummy without PA_CI_DUMMY=1), or a placeholder is left.
// A CI dummy skips the format checks.
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_PATH, loadPublic, publicProblems } from "../../release/public.mjs";
import { computeHashUpdates, placeholderFiles } from "./site-lib.mjs";

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(site, "public");
const dir = resolve(arg("--out") || join(site, "dist"));
const publicPath = arg("--public") || PUBLIC_PATH;
const outside = (a, b) => relative(a, b).startsWith("..");
if (!outside(src, dir) || !outside(dir, src)) { console.error("site build failed:\n  - --out must not hold or be inside site/public"); process.exit(1); }
rmSync(dir, { recursive: true, force: true });
cpSync(src, dir, { recursive: true });

// wrangler.jsonc runs this script as its build command, also for "wrangler dev"
// (WRANGLER_COMMAND=dev). A dev run serves the copy with the placeholders kept.
if (process.env.WRANGLER_COMMAND === "dev") { console.log("site build: ids not filled for wrangler dev, copied to " + dir); process.exit(0); }

function fail(lines) {
  console.error("site build failed:");
  for (const l of lines) console.error("  - " + l);
  process.exit(1);
}

let pub;
try { pub = loadPublic(publicPath); } catch (e) { fail([publicPath + ": " + e.message]); }
const bad = publicProblems(["cloudflare_turnstile_sitekey", "webpush_vapid_public_key", "google_chrome_extension_id", "google_chrome_beta_extension_id", "android_release_cert_sha256"], pub);
const dummy = (v) => /ci-fork-dummy/i.test(v);
if (!bad.length) {
  for (const k of ["google_chrome_extension_id", "google_chrome_beta_extension_id"]) {
    if (!dummy(pub[k]) && !/^[a-p]{32}$/.test(pub[k])) bad.push("release/public.json: " + k + " is not 32 letters a-p");
  }
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
fill("_headers", "chrome-extension://CHROME_BETA_EXTENSION_ID", "chrome-extension://" + pub.google_chrome_beta_extension_id);
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
