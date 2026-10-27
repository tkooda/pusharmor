// Release build of the site: fills the build ids from release/local.json into
// the assets directory in place, then rewrites the SRI and CSP hashes.
// Workers Builds runs it before "npx wrangler deploy" (see site/README.md).
//   node site/tools/build.mjs [--dir DIR] [--local FILE]
// DIR defaults to site/public. Fails when release/local.json is missing, a
// value is empty, malformed or a PLACEHOLDER, or a placeholder is left.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_PATH, loadLocal, localProblems } from "../../release/local.mjs";
import { computeHashUpdates, placeholderFiles } from "./site-lib.mjs";

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const dir = arg("--dir") || join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const localPath = arg("--local") || LOCAL_PATH;

function fail(lines) {
  console.error("site build failed:");
  for (const l of lines) console.error("  - " + l);
  process.exit(1);
}

const local = loadLocal(localPath);
const bad = localProblems(local, ["turnstile_sitekey", "vapid_public_key", "chrome_extension_id", "release_cert_sha256"], localPath);
if (!bad.length) {
  if (!/^[a-p]{32}$/.test(local.chrome_extension_id)) bad.push("release/local.json: chrome_extension_id is not 32 letters a-p");
  for (const f of [].concat(local.release_cert_sha256)) {
    if (!/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(String(f).toUpperCase())) bad.push("release/local.json: release_cert_sha256 " + JSON.stringify(f) + " is not a SHA-256 fingerprint");
  }
}
if (bad.length) fail(bad);

function fill(rel, from, to) {
  const p = join(dir, rel);
  const s = readFileSync(p, "utf8");
  if (!s.includes(from)) fail([rel + ": " + from + " not found"]);
  writeFileSync(p, s.split(from).join(to));
}
fill("turnstile.html", 'data-sitekey="TURNSTILE_SITEKEY_PLACEHOLDER"', 'data-sitekey="' + local.turnstile_sitekey + '"');
fill("js/fx-setup.js", '"VAPID_PUBLIC_KEY_PLACEHOLDER"', JSON.stringify(local.vapid_public_key));
fill("_headers", "chrome-extension://CHROME_EXTENSION_ID", "chrome-extension://" + local.chrome_extension_id);
const alp = join(dir, ".well-known", "assetlinks.json");
const al = JSON.parse(readFileSync(alp, "utf8"));
al[0].target.sha256_cert_fingerprints = [].concat(local.release_cert_sha256).map((f) => String(f).toUpperCase());
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
