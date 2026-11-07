// Release build of the site: copies site/public to OUT, fills the build ids from
// release/public.json into OUT, then rewrites the SRI and CSP hashes in OUT.
// Released versions (nothing is committed for a release): the newest tags
// android/vX.Y.Z, cli/vX.Y.Z and firefox/vX.Y.Z of the GitHub repo (git ls-remote)
// fill /download, /fdroid/android.txt (versionName, versionCode) and
// /fx/beta/updates.json. From each GitHub release: the APK SHA-256 values (hashes
// file of android/vX.Y.Z), the SHA-256 of pusharmor.py (cli/vX.Y.Z) and the Beta
// update manifest (firefox/vX.Y.Z, checked to name the same XPI), so a deploy
// before those releases are published fails. --versions android=X.Y.Z,cli=X.Y.Z,firefox=X.Y.Z
// replaces the tag lookup, --release-dir DIR reads local copies of those release
// files, and a CI dummy build takes 0.0.0 and zeros. The tracked site/public keeps
// its placeholders. "wrangler deploy" runs it as the
// build command from wrangler.jsonc and serves OUT (see site/README.md).
//   node site/tools/build.mjs [--out OUT] [--public FILE] [--versions LIST] [--release-dir DIR]
// OUT defaults to site/dist (gitignored) and is replaced. Fails when a value is missing, empty, malformed
// or a PLACEHOLDER (or a CI dummy without PA_CI_DUMMY=1), or a placeholder is left.
// A CI dummy skips the format checks.
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_PATH, loadPublic, publicProblems } from "../../release/public.mjs";
import { betaXpiUrl, buildNumber, parseTag, parseVersion } from "../../release/tag.mjs";
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
const REPO_URL = "https://github.com/tkooda/pusharmor";
const ciDummy = process.env.PA_CI_DUMMY === "1";
const versions = {};
if (arg("--versions")) {
  for (const kv of arg("--versions").split(",")) versions[kv.split("=")[0]] = kv.split("=")[1];
} else if (ciDummy) {
  for (const p of ["android", "cli", "firefox"]) versions[p] = "0.0.0";
} else {
  let refs;
  try { refs = execFileSync("git", ["ls-remote", "--tags", "--refs", REPO_URL + ".git"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { fail(["git ls-remote " + REPO_URL + ": " + String(e.stderr || e.message).trim()]); }
  for (const l of refs.split("\n")) {
    const t = parseTag((l.split("\t")[1] || "").replace(/^refs\/tags\//, ""));
    if (t && (!versions[t.platform] || buildNumber(t.version) > buildNumber(versions[t.platform]))) versions[t.platform] = t.version;
  }
}
const noVersion = ["android", "cli", "firefox"].filter((p) => !parseVersion(versions[p] || ""));
if (noVersion.length) fail(noVersion.map((p) => "no " + p + "/vX.Y.Z version"));
console.log("site build: android " + versions.android + ", cli " + versions.cli + ", firefox " + versions.firefox);
// A file of the GitHub release <platform>/vX.Y.Z; null in a CI dummy build without --release-dir.
async function releaseFile(platform, name) {
  if (arg("--release-dir")) {
    const p = join(arg("--release-dir"), name);
    try { return readFileSync(p, "utf8"); } catch (e) { fail([p + ": " + e.message]); }
  }
  if (ciDummy) return null;
  const tag = platform + "/v" + versions[platform];
  const url = REPO_URL + "/releases/download/" + tag + "/" + name;
  let r;
  try { r = await fetch(url); } catch (e) { fail([url + ": " + e.message]); }
  if (!r.ok) fail([url + ": HTTP " + r.status + " (deploy after the release " + tag + " is published)"]);
  return r.text();
}
const apkVersion = versions.android;
fill("download.html", "ANDROID_VERSION_PLACEHOLDER", apkVersion);
fill("fdroid/android.txt", "ANDROID_VERSION_CODE_PLACEHOLDER", String(buildNumber(apkVersion)));
fill("fdroid/android.txt", "ANDROID_VERSION_PLACEHOLDER", apkVersion);
const apkHashes = (await releaseFile("android", "pusharmor-" + apkVersion + ".hashes.txt"))
  ?? ["foss", "play"].map((k) => "0".repeat(64) + "  pusharmor-" + apkVersion + "-" + k + ".apk").join("\n");
for (const k of ["foss", "play"]) {
  const name = "pusharmor-" + apkVersion + "-" + k + ".apk";
  const h = apkHashes.split("\n").map((l) => l.trim().split(/\s+/)).find((x) => x[1] === name)?.[0];
  if (!/^[0-9a-f]{64}$/.test(h || "")) fail(["APK hashes file: no SHA-256 line for " + name]);
  fill("download.html", "APK_" + k.toUpperCase() + "_SHA256_PLACEHOLDER", h);
}
fill("download.html", "CLI_VERSION_PLACEHOLDER", versions.cli);
const cliSha = (await releaseFile("cli", "pusharmor.py.sha256")) ?? "0".repeat(64) + "  pusharmor.py";
const cliHash = cliSha.split("\n").map((l) => l.trim().split(/\s+/)).find((x) => x[1] === "pusharmor.py")?.[0];
if (!/^[0-9a-f]{64}$/.test(cliHash || "")) fail(["pusharmor.py.sha256: no SHA-256 line for pusharmor.py"]);
fill("download.html", "CLI_SHA256_PLACEHOLDER", cliHash);
fill("fx/beta/updates.json", "FIREFOX_VERSION_PLACEHOLDER", versions.firefox);
const beta = Object.values(JSON.parse(readFileSync(join(dir, "fx", "beta", "updates.json"), "utf8")).addons)[0].updates[0];
if (beta.update_link !== betaXpiUrl(versions.firefox)) fail(["fx/beta/updates.json: update_link " + beta.update_link + ", want " + betaXpiUrl(versions.firefox)]);
const betaName = "pusharmor-firefox-beta-" + versions.firefox + "-updates.json";
const released = await releaseFile("firefox", betaName);
if (released !== null) {
  let link;
  try { link = Object.values(JSON.parse(released).addons)[0].updates[0].update_link; } catch (e) { fail([betaName + ": " + e.message]); }
  if (link !== beta.update_link) fail([betaName + ": update_link " + link + ", want " + beta.update_link]);
}
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
