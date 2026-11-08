// Promote (workflow promote.yml, then store.yml on each platform tag): sends the
// build of version X.Y.Z in its GitHub release to the public channel of one
// store. A tag uploads nothing to any store; the store job uploads the release
// file right before the review submission. Nothing is rebuilt: Play uploads the
// AAB of the release, App Store the IPA of the release (store.yml uploads it
// after appstore-upload), Chrome and Firefox the public zip of the release.
// Each file is checked against the release hashes file and the build
// attestation. Every command is safe to rerun: it skips a version that is
// already live or in review, and fails with the store and version when an
// earlier version is still in review there.
//   node release/promote.mjs check X.Y.Z      tags, releases, listings
//   node release/promote.mjs gate X.Y.Z       store.yml: tag ref, approved promote run
//   node release/promote.mjs play X.Y.Z       env TOKEN (androidpublisher), GH_TOKEN
//   node release/promote.mjs appstore-upload X.Y.Z  env as appstore, GH_TOKEN, IPA_DIR:
//                                             review check; output ipa (the verified
//                                             IPA in IPA_DIR) when the build is not on
//                                             App Store Connect yet, else empty
//   node release/promote.mjs appstore X.Y.Z   env ASC_API_KEY_P8, ASC_API_KEY_ID, ASC_API_ISSUER_ID
//   node release/promote.mjs chrome X.Y.Z     env TOKEN (chromewebstore)
//   node release/promote.mjs firefox X.Y.Z    env MOZILLA_AMO_JWT_ISSUER, MOZILLA_AMO_JWT_SECRET
// Each command writes short result lines to the job summary.
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomUUID, sign } from "node:crypto";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDir } from "./check-screenshots.mjs";
import { loadPublic } from "./public.mjs";
import { buildNumber, formatProblems, parseVersion } from "./tag.mjs";

const ROOT = join(import.meta.dirname, "..");
export const STORE_DIR = join(ROOT, "store");
export const PLATFORMS = ["android", "ios", "chrome", "firefox"];
export const PACKAGE_NAME = "com.pusharmor";
export const BUNDLE_ID = "com.pusharmor.app";
export const LOCALE = "en-US";
// App Store release after approval: the other three stores also go live when their review passes. MANUAL keeps a
// "Release this version" tap in App Store Connect.
export const IOS_RELEASE_TYPE = "AFTER_APPROVAL";
// 6.9-inch iPhone screenshots (1320x2868 or 1290x2796).
export const IOS_SCREENSHOT_TYPE = "APP_IPHONE_67";

// Listing files: store/listing/<store>/<locale>/<field>.txt. max is in
// characters, except keywords (bytes). url: must be https.
export const LISTING = {
  play: {
    title: { max: 30 },
    short_description: { max: 80 },
    full_description: { max: 4000 },
    whats_new: { max: 500 },
  },
  appstore: {
    name: { max: 30 },
    subtitle: { max: 30 },
    description: { max: 4000 },
    keywords: { max: 100, bytes: true },
    promotional_text: { max: 170 },
    privacy_url: { max: 255, url: true },
    copyright: { max: 200 },
    whats_new: { max: 4000 },
  },
};
// Play 512x512 listing icon (shared with the F-Droid metadata).
export const PLAY_ICON = join(ROOT, "release", "fdroid", "metadata", PACKAGE_NAME, LOCALE, "icon.png");
export const SCREENSHOTS = { play: "android", appstore: "ios" };
// Notes for the AMO reviewers, sent with each listed version. No
// credentials: the demo account stays in the AMO Developer Hub.
export const AMO_REVIEW_NOTES = join(STORE_DIR, "listing", "amo", "review_notes.txt");

/** Problems with the AMO reviewer notes; empty passes. */
export function amoNotesProblems(file = AMO_REVIEW_NOTES) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return ["amo/review_notes.txt: missing"];
  }
  const bad = [];
  if (!raw.trim()) bad.push("amo/review_notes.txt: empty");
  if (/[^\x09\x0a\x20-\x7e]/.test(raw)) bad.push("amo/review_notes.txt: not plain ASCII");
  bad.push(...contactProblems(raw, "amo/review_notes.txt"));
  return bad;
}

/** Contact data that must stay console-only (owner rule): phone numbers and
 *  any address at the project or company domains. */
export function contactProblems(text, where) {
  const bad = [];
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)*(?:pusharmor|ionecho)\.com\b/gi)) bad.push(where + ": address " + m[0]);
  const phone = /(?:\+\d{1,3}[ .-]?)?\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b|\+\d{1,3}[ .-]\d{2,4}[ .-]\d{3,4}[ .-]?\d{0,4}\b/g;
  for (const m of text.matchAll(phone)) bad.push(where + ": phone number " + m[0].trim());
  return bad;
}

/** Field values of one store listing (text without the final newline). */
export function readListing(store, root = STORE_DIR) {
  const dir = join(root, "listing", store, LOCALE);
  const out = {};
  for (const f of Object.keys(LISTING[store])) out[f] = readFileSync(join(dir, f + ".txt"), "utf8").replace(/\n$/, "");
  return out;
}

/** Problems with the listing text and screenshots of one store; empty passes. */
export function listingProblems(store, root = STORE_DIR) {
  const dir = join(root, "listing", store, LOCALE);
  const bad = [];
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [dir + ": missing"];
  }
  for (const f of files) if (!LISTING[store][f.replace(/\.txt$/, "")]) bad.push(store + "/" + f + ": unknown listing file");
  for (const [f, rule] of Object.entries(LISTING[store])) {
    const where = store + "/" + LOCALE + "/" + f + ".txt";
    if (!files.includes(f + ".txt")) {
      bad.push(where + ": missing");
      continue;
    }
    const raw = readFileSync(join(dir, f + ".txt"), "utf8");
    const v = raw.replace(/\n$/, "");
    if (!v.trim()) bad.push(where + ": empty");
    if (/[^\x09\x0a\x20-\x7e]/.test(raw)) bad.push(where + ": not plain ASCII");
    const n = rule.bytes ? Buffer.byteLength(v) : [...v].length;
    if (n > rule.max) bad.push(where + ": " + n + " > " + rule.max);
    if (rule.url && !/^https:\/\/[^\s]+$/.test(v)) bad.push(where + ": not one https URL");
    bad.push(...contactProblems(raw, where));
  }
  const shots = join(root, "screenshots", store, LOCALE);
  try {
    bad.push(...checkDir(SCREENSHOTS[store], shots).map((p) => store + " screenshots: " + p));
  } catch {
    bad.push(shots + ": missing");
  }
  return bad;
}

/** Screenshot files of one store in upload order. */
export function screenshotFiles(store, root = STORE_DIR) {
  const dir = join(root, "screenshots", store, LOCALE);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".png"))
    .sort()
    .map((f) => ({ name: f, path: join(dir, f), data: readFileSync(join(dir, f)) }));
}

/** -1, 0 or 1 for X.Y.Z strings. */
export function cmpVersion(x, y) {
  const a = parseVersion(x);
  const b = parseVersion(y);
  return Math.sign(a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

/** Tag and asset names Promote needs for each platform. */
export function releaseAssets(platform, version, have = new Set()) {
  // Chrome releases before the -store.zip naming have the store zip as the plain name and a -unpacked.zip.
  const oldChrome = have.has("pusharmor-chrome-" + version + "-unpacked.zip");
  return {
    android: [hashesName("android", version)],
    ios: ["pusharmor-" + version + ".ipa", hashesName("ios", version)],
    chrome: ["pusharmor-chrome-" + version + (oldChrome ? ".zip" : "-store.zip"), "pusharmor-chrome-" + version + ".hashes.txt"],
    firefox: ["pusharmor-firefox-" + version + ".zip", "pusharmor-firefox-" + version + "-source.zip", "pusharmor-firefox-" + version + ".hashes.txt"],
  }[platform];
}

/** Why a platform is skipped (a string), or "" when its tag and release are
 *  ready. release is the GitHub release object or null. */
export function releaseProblem(platform, version, tagExists, release) {
  const tag = platform + "/v" + version;
  if (!tagExists) return "no tag " + tag;
  if (!release) return "no GitHub release " + tag;
  if (release.draft) return "release " + tag + " is still a draft";
  const have = new Set((release.assets || []).map((a) => a.name));
  const missing = releaseAssets(platform, version, have).filter((n) => !have.has(n));
  return missing.length ? "release " + tag + " lacks " + missing.join(", ") : "";
}

/** Why Play production is blocked, or "". PLAY_CONTACT_OK: the
 *  owner fixed the public developer contact details in Play Console.
 *  PLAY_PUBLIC_OK: Play may leave internal testing; until
 *  then nothing targets the production, closed or open track. */
export function playGateProblem(env) {
  const bad = [];
  if (env.PLAY_CONTACT_OK !== "yes") bad.push("PLAY_CONTACT_OK is not yes (fix the public developer contact details in Play Console first)");
  if (env.PLAY_PUBLIC_OK !== "yes") bad.push("PLAY_PUBLIC_OK is not yes (Play stays on internal testing only)");
  return bad.join("; ");
}

/** The platforms without a tag of X.Y.Z. commits maps each platform to the
 *  commit of its tag, or null when it has no tag. The tags are normally on one
 *  commit; a platform that joined later may be on another commit
 *  (release/tag.mjs keeps them on one line of history). */
export function commitProblems(version, commits) {
  return { missing: PLATFORMS.filter((p) => !commits[p]) };
}

/** The platform whose tag of X.Y.Z is ref (refs/tags/<platform>/vX.Y.Z), or "". */
export function tagPlatform(ref, version) {
  return PLATFORMS.find((p) => ref === "refs/tags/" + p + "/v" + version) || "";
}

/** A promote run older than this many days cannot start a store job. */
export const PROMOTE_RUN_MAX_DAYS = 30;

/** Why store.yml must not run for platform and version (a string), or "".
 *  run is the GitHub run that started it (or null), approvals its review
 *  history: a promote.yml run on main, dispatched by hand, approved in the
 *  Environment promote, with this version and platform in its run name,
 *  still running (its dispatch job starts store.yml) or succeeded (a store
 *  rerun), and created at most PROMOTE_RUN_MAX_DAYS days before now. */
export function promoteRunProblem(run, approvals, version, platform, now = Date.now()) {
  if (!run) return "no promote run";
  if (String(run.path).split("@")[0] !== ".github/workflows/promote.yml") return "run is " + run.path + ", not promote.yml";
  if (run.head_branch !== "main") return "promote run is on " + run.head_branch + ", not main";
  if (run.event !== "workflow_dispatch") return "promote run event is " + run.event + ", not workflow_dispatch";
  if (run.status === "completed" && run.conclusion !== "success") return "promote run concluded " + run.conclusion + ", not success";
  const age = now - Date.parse(run.created_at);
  if (!(age >= 0 && age <= PROMOTE_RUN_MAX_DAYS * 86400000)) return "promote run was created " + run.created_at + ", not in the last " + PROMOTE_RUN_MAX_DAYS + " days";
  const head = "promote " + version + " ";
  const title = String(run.display_title || "");
  if (!title.startsWith(head)) return "promote run is not for " + version + " (" + title + ")";
  if (!selectedPlatforms(title.slice(head.length)).list.includes(platform)) return "promote run did not select " + platform + " (" + title + ")";
  const ok = (approvals || []).some((a) => a.state === "approved" && (a.environments || []).some((e) => e.name === "promote"));
  return ok ? "" : "promote run has no approval in the Environment promote";
}

// ---- output ----

function summary(line) {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + "\n");
}
function output(k, v) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, k + "=" + v + "\n");
}
// Store commands end with done() when X.Y.Z was promoted now or is already live
// or in review at X.Y.Z, and with skip() when it was not promoted. Only
// done() lets the workflow clear the prerelease flag that older GitHub
// releases carry (new releases are full releases).
const done = (line) => (summary(line), true);
const skip = (line) => (summary(line), false);
/** Step output clear_prerelease for the result of a store command. */
export const clearOutput = (promoted) => (promoted === true ? "true" : "false");

// ---- HTTP ----

/** Error for a fetch that threw: names the method, the URL without its query
 *  string, the message, and the underlying cause (Node hides it behind
 *  "fetch failed"). */
function fetchError(method, url, e) {
  const c = e?.cause?.code || e?.cause?.message;
  return new Error(method + " " + String(url).split("?")[0] + ": " + (e?.message || e) + (c ? " (" + c + ")" : ""));
}

/** fetch that throws on an unexpected status with the API error body. The
 *  query string is left out of the message (upload URLs carry tokens). With
 *  `timeout` (ms), a request that has no full answer by then throws. */
export async function http(method, url, { headers = {}, body, ok = [200, 201, 202, 204], timeout } = {}) {
  let r, text;
  try {
    r = await fetch(url, { method, headers, body, signal: timeout ? AbortSignal.timeout(timeout) : undefined });
    text = await r.text();
  } catch (e) {
    if (e?.name !== "TimeoutError") throw fetchError(method, url, e);
    throw new Error(method + " " + url.split("?")[0] + ": no answer in " + timeout / 1000 + " s");
  }
  if (!ok.includes(r.status)) {
    throw new Error(method + " " + url.split("?")[0] + ": HTTP " + r.status + ": " + text.slice(0, 3000));
  }
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: r.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wrap an AMO request function: when AMO answers HTTP 429, log and wait the
 *  time its message names ("Expected available in N seconds", else 60 s) plus
 *  2 s and send the request again, up to 5 times. */
export function amoRetry(amo, wait = sleep, log = console.log) {
  return async (...args) => {
    for (let n = 0; ; n++) {
      try {
        return await amo(...args);
      } catch (e) {
        const m = String(e?.message || "");
        if (n >= 5 || !/HTTP 429/.test(m)) throw e;
        const s = Number(/Expected available in (\d+) second/.exec(m)?.[1] ?? 60) + 2;
        log("AMO throttled " + args[0] + " " + args[1] + ", waiting " + s + " s (retry " + (n + 1) + " of 5)");
        await wait(s * 1000);
      }
    }
  };
}
/** Wrap a request function (App Store Connect by default): on HTTP 5xx or a network
 *  error (not on 4xx), log, wait 5, 15, then 45 s and send the
 *  request again, up to 3 retries. */
export function ascRetry(fn, wait = sleep, log = console.log, delays = [5000, 15000, 45000], label = "App Store Connect") {
  return async (...args) => {
    for (let n = 0; ; n++) {
      try {
        return await fn(...args);
      } catch (e) {
        const m = String(e?.message || "");
        const http4 = /: HTTP (\d+)/.exec(m);
        const retriable = http4 ? Number(http4[1]) >= 500 : true;
        if (n >= delays.length || !retriable) throw e;
        log(label + " " + args[0] + " " + String(args[1]).split("?")[0] + " failed (" + m.slice(0, 120) + "), waiting " + delays[n] / 1000 + " s (retry " + (n + 1) + " of " + delays.length + ")");
        await wait(delays[n]);
      }
    }
  };
}
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** The tag workflow that builds and attests the release files of a platform. */
export const RELEASE_WORKFLOW = { android: "android-release.yml", ios: "ios-release.yml", chrome: "webext-release.yml", firefox: "webext-release.yml" };

/** Name of the SHA-256 file in the GitHub release platform/vX.Y.Z. */
export function hashesName(platform, version) {
  return platform === "android" ? "pusharmor-" + version + ".hashes.txt" : "pusharmor-" + platform + "-" + version + ".hashes.txt";
}

/** gh arguments that verify the build provenance attestation of file: made by
 *  the release workflow of the platform in repository on a GitHub-hosted
 *  runner for the tag platform/vX.Y.Z. */
export function attestationArgs(file, platform, version, repository = repo()) {
  return ["attestation", "verify", file, "--repo", repository, "--signer-workflow", repository + "/.github/workflows/" + RELEASE_WORKFLOW[platform], "--source-ref", "refs/tags/" + platform + "/v" + version, "--deny-self-hosted-runners"];
}

/** Throws unless gh finds a valid build attestation for the bytes data (env GH_TOKEN). */
function verifyAttestation(data, platform, version, name) {
  const dir = mkdtempSync(join(tmpdir(), "pa-attest-"));
  try {
    const file = join(dir, name);
    writeFileSync(file, data);
    execFileSync("gh", attestationArgs(file, platform, version), { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    throw new Error(name + ": no valid build attestation of the " + platform + "/v" + version + " release workflow: " + String(e.stderr || e.message).trim().slice(0, 1000));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Bytes of a GitHub release asset, checked against the release hashes file
 *  and the build attestation of the release workflow. */
async function releaseFile(platform, version, name) {
  const base = "https://github.com/" + repo() + "/releases/download/" + platform + "/v" + version + "/";
  const dl = ascRetry(async (method, url) => {
    let r;
    try {
      r = await fetch(url);
    } catch (e) {
      throw fetchError(method, url, e);
    }
    if (!r.ok) throw new Error("download " + url.split("/").pop() + ": HTTP " + r.status);
    return Buffer.from(await r.arrayBuffer());
  }, sleep, console.log, undefined, "GitHub");
  const get = (n) => dl("GET", base + n);
  const data = await get(name);
  const hashes = (await get(hashesName(platform, version))).toString("utf8");
  const want = hashes.split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[1] === name);
  if (!want || want[0] !== sha256(data)) throw new Error(name + ": sha256 does not match the release hashes file");
  verifyAttestation(data, platform, version, name);
  return data;
}

function repo() {
  return process.env.GITHUB_REPOSITORY || "tkooda/pusharmor";
}
const gh = (path) =>
  http("GET", "https://api.github.com/repos/" + repo() + path, {
    headers: { Authorization: "Bearer " + process.env.GH_TOKEN, Accept: "application/vnd.github+json" },
    ok: [200, 404],
  });
/** Store ids of release/public.json as step outputs (WIF needs them in with:). */
function outputPublicIds() {
  const pub = loadPublic();
  for (const k of ["google_play_wif_provider", "google_play_wif_service_account", "google_cws_wif_provider", "google_cws_wif_service_account", "google_cws_publisher_id", "google_chrome_extension_id", "mozilla_firefox_addon_id"]) {
    output(k, pub[k]);
  }
}

// ---- check ----

/**
 * The platforms input of the workflow: a comma list of android, ios, chrome
 * and firefox. It must name at least one platform; an unknown name is an error.
 */
export function selectedPlatforms(raw) {
  const names = String(raw || "").split(",").map((n) => n.trim().toLowerCase()).filter(Boolean);
  const bad = names.filter((n) => !PLATFORMS.includes(n));
  if (bad.length) return { list: [], error: "unknown platform " + bad.join(", ") + " (use " + PLATFORMS.join(", ") + ")" };
  if (!names.length) return { list: [], error: "no platform selected (use " + PLATFORMS.join(", ") + ")" };
  return { list: PLATFORMS.filter((p) => names.includes(p)), error: "" };
}
async function check(version) {
  summary("### Promote " + version);
  const sel = selectedPlatforms(process.env.PLATFORMS);
  if (sel.error) throw new Error("platforms: " + sel.error);
  let any = false;
  const commits = {};
  for (const p of PLATFORMS) {
    const tag = p + "/v" + version;
    const ref = await gh("/git/ref/tags/" + tag);
    let obj = ref.status === 200 ? ref.json.object : null;
    // An annotated tag points at a tag object; its object is the commit.
    if (obj && obj.type === "tag") obj = (await gh("/git/tags/" + obj.sha)).json?.object || null;
    commits[p] = obj ? obj.sha : null;
    const rel = await gh("/releases/tags/" + tag);
    let why = releaseProblem(p, version, ref.status === 200, rel.status === 200 ? rel.json : null);
    // store.yml runs on the tag commit, so the tag must hold it.
    if (!why && sel.list.includes(p) && (await gh("/contents/.github/workflows/store.yml?ref=" + encodeURIComponent(tag))).status !== 200) {
      why = "tag " + tag + " has no .github/workflows/store.yml; promote a version tagged after it was added";
    }
    // the Play gate is tested here, before the owner approval.
    const gate = p === "android" && !why ? playGateProblem(process.env) : "";
    const off = sel.list.includes(p) ? "" : "not in platforms";
    output(p, why || gate || off ? "false" : "true");
    summary(why ? "- " + p + ": SKIP (" + why + ")" : gate ? "- " + p + ": BLOCKED (" + gate + ")" : off ? "- " + p + ": SKIP (" + off + ")" : "- " + p + ": ready (" + tag + ")");
    any ||= !why && !gate && !off;
  }
  const same = commitProblems(version, commits);
  if (same.missing.length) summary("- NOTE: " + version + " has no tag for " + same.missing.join(", ") + "; fine when that platform did not change (one shared counter, platforms skip numbers)");
  const bad = [...listingProblems("play"), ...listingProblems("appstore"), ...amoNotesProblems()];
  for (const b of bad) summary("- listing: " + b);
  if (!any) throw new Error("no selected platform is ready to promote " + version);
  if (bad.length) throw new Error("listing problems");
}

// ---- gate (store.yml) ----

/** store.yml runs on the tag <platform>/vX.Y.Z, started by promote.yml after
 *  the owner approval. Outputs the platform, the promote commit and the ids. */
async function gate(version) {
  const platform = tagPlatform(process.env.GITHUB_REF, version);
  if (!platform) throw new Error("ref " + process.env.GITHUB_REF + " is not a release tag of " + version);
  const id = String(process.env.PROMOTE_RUN || "");
  if (!/^[0-9]+$/.test(id)) throw new Error("promote_run is not a run id");
  const run = await gh("/actions/runs/" + id);
  const approvals = run.status === 200 ? (await gh("/actions/runs/" + id + "/approvals")).json : [];
  const why = promoteRunProblem(run.status === 200 ? run.json : null, approvals, version, platform);
  if (why) throw new Error(why);
  output("platform", platform);
  output("commit", run.json.head_sha);
  outputPublicIds();
  summary("- " + platform + " " + version + ": started by the approved promote run " + id);
}

// ---- Google Play ----

/** The error for a Play commit refused because changes are already in review,
 *  naming the newest other production release; "" for any other error. */
export function playInReviewProblem(err, live, code, version) {
  const m = String(err?.message || "");
  if (!/: HTTP 400: /.test(m) || !/review/i.test(m)) return "";
  const other = live.filter((r) => !(r.versionCodes || []).map(Number).includes(code));
  const top = other.sort((a, b) => Math.max(...(b.versionCodes || [0]).map(Number)) - Math.max(...(a.versionCodes || [0]).map(Number)))[0];
  const pending = top ? (top.name || "versionCode " + Math.max(...(top.versionCodes || [0]).map(Number))) : "unknown";
  return "Google Play: changes are already in review (newest production release: " + pending + "); wait for that review to finish, then promote " + version + " again";
}

async function play(version) {
  // Hard gate: the owner sets the repository variables
  // PLAY_CONTACT_OK and PLAY_PUBLIC_OK to yes.
  const gate = playGateProblem(process.env);
  if (gate) throw new Error("Play blocked: " + gate);
  const api = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/" + PACKAGE_NAME;
  const up = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/" + PACKAGE_NAME;
  const auth = { Authorization: "Bearer " + process.env.TOKEN };
  const json = { ...auth, "Content-Type": "application/json" };
  const code = buildNumber(version);
  const edit = (await http("POST", api + "/edits", { headers: json, body: "{}" })).json.id;
  if (!edit) throw new Error("edits.insert returned no id");
  const e = api + "/edits/" + edit;
  let changed = false;

  const prod = (await http("GET", e + "/tracks/production", { headers: auth, ok: [200, 404] })).json || {};
  const live = (prod.releases || []).filter((r) => r.status !== "draft");
  const codes = live.flatMap((r) => (r.versionCodes || []).map(Number));
  let track;
  let newer = false;
  if (codes.includes(code)) {
    track = "already on production";
  } else if (codes.some((c) => c > code)) {
    newer = true;
    track = "production has a newer versionCode (" + Math.max(...codes) + ")";
  } else {
    // The AAB of the GitHub release, uploaded into this edit right before the
    // review submission (the commit below); a rerun finds it on Play.
    const bundles = (await http("GET", e + "/bundles", { headers: auth })).json.bundles || [];
    if (!bundles.some((b) => b.versionCode === code)) {
      const name = "pusharmor-" + version + "-play.aab";
      const aab = await releaseFile("android", version, name).catch((err) => {
        throw new Error("Play: the AAB " + name + " of the release android/v" + version + " is missing or not verified: " + err.message);
      });
      const got = (await http("POST", up + "/edits/" + edit + "/bundles?uploadType=media", { headers: { ...auth, "Content-Type": "application/octet-stream" }, body: aab })).json?.versionCode;
      if (got !== code) throw new Error("Play: the uploaded AAB has versionCode " + got + ", want " + code);
    }
    const body = { track: "production", releases: [{ name: version, versionCodes: [String(code)], status: "completed", releaseNotes: [{ language: LOCALE, text: readListing("play").whats_new }] }] };
    await http("PUT", e + "/tracks/production", { headers: json, body: JSON.stringify(body) });
    track = "sent to production (versionCode " + code + ")";
    changed = true;
  }

  const want = readListing("play");
  const cur = (await http("GET", e + "/listings/" + LOCALE, { headers: auth, ok: [200, 404] })).json || {};
  // Listing text only; the contact details (edits.details) are never touched.
  const listing = { language: LOCALE, title: want.title, shortDescription: want.short_description, fullDescription: want.full_description };
  let text = "listing text unchanged";
  if (cur.title !== listing.title || cur.shortDescription !== listing.shortDescription || cur.fullDescription !== listing.fullDescription) {
    await http("PUT", e + "/listings/" + LOCALE, { headers: json, body: JSON.stringify(listing) });
    text = "listing text updated";
    changed = true;
  }

  const shots = screenshotFiles("play");
  const imgs = e + "/listings/" + LOCALE + "/phoneScreenshots";
  const have = ((await http("GET", imgs, { headers: auth })).json.images || []).map((i) => i.sha256);
  let images = "screenshots unchanged";
  if (have.join() !== shots.map((s) => sha256(s.data)).join()) {
    await http("DELETE", imgs, { headers: auth });
    for (const s of shots) {
      await http("POST", up + "/edits/" + edit + "/listings/" + LOCALE + "/phoneScreenshots?uploadType=media", {
        headers: { ...auth, "Content-Type": "image/png" },
        body: s.data,
      });
    }
    images = shots.length + " screenshots uploaded";
    changed = true;
  }

  const icon = readFileSync(PLAY_ICON);
  const iconUrl = e + "/listings/" + LOCALE + "/icon";
  const haveIcon = ((await http("GET", iconUrl, { headers: auth })).json.images || []).map((i) => i.sha256);
  if (haveIcon.join() !== sha256(icon)) {
    await http("DELETE", iconUrl, { headers: auth });
    await http("POST", up + "/edits/" + edit + "/listings/" + LOCALE + "/icon?uploadType=media", { headers: { ...auth, "Content-Type": "image/png" }, body: icon });
    images += "; icon uploaded";
    changed = true;
  }

  if (changed) {
    // ERROR_IF_IN_REVIEW: never cancel a review that is already running. The
    // Play API shows no review state before this point; a refused commit
    // changes nothing on Play.
    try {
      await http("POST", e + ":commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW", { headers: { ...auth, "Content-Length": "0" } });
    } catch (err) {
      const why = playInReviewProblem(err, live, code, version);
      throw why ? new Error(why) : err;
    }
  } else {
    await http("DELETE", e, { headers: auth });
  }
  const line = track + "; " + text + "; " + images;
  return newer ? skip("Play " + version + ": SKIP, " + line) : done("Play " + version + ": " + line);
}

// ---- App Store Connect ----

/** ES256 JWT for the App Store Connect API (20 minutes at most). */
export function ascToken(keyP8, keyId, issuer, now = Math.floor(Date.now() / 1000)) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = b64({ alg: "ES256", kid: keyId, typ: "JWT" }) + "." + b64({ iss: issuer, iat: now, exp: now + 900, aud: "appstoreconnect-v1" });
  const sig = sign("sha256", Buffer.from(data), { key: keyP8, dsaEncoding: "ieee-p1363" });
  return data + "." + sig.toString("base64url");
}

// appStoreVersion states: in review or live (skip), editable (fill and submit).
// READY_FOR_REVIEW is a version that was filled in but never submitted: a newer
// promote takes it over (new version string and build) instead of adding a second one.
export const ASC_DONE = ["WAITING_FOR_REVIEW", "IN_REVIEW", "PENDING_DEVELOPER_RELEASE", "PENDING_APPLE_RELEASE", "PROCESSING_FOR_APP_STORE", "READY_FOR_SALE", "READY_FOR_DISTRIBUTION", "ACCEPTED", "PREORDER_READY_FOR_SALE", "WAITING_FOR_EXPORT_COMPLIANCE"];
export const ASC_EDITABLE = ["PREPARE_FOR_SUBMISSION", "READY_FOR_REVIEW", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"];
// States of a version that was on sale; a first version rejects whatsNew.
const ASC_RELEASED = ["READY_FOR_SALE", "READY_FOR_DISTRIBUTION", "REPLACED_WITH_NEW_VERSION", "REMOVED_FROM_SALE", "DEVELOPER_REMOVED_FROM_SALE"];
const ascState = (v) => v.attributes.appVersionState || v.attributes.appStoreState;
// States of a version that waits for or is in App Review.
export const ASC_IN_REVIEW = ["WAITING_FOR_REVIEW", "IN_REVIEW"];

/** The error for another App Store version in review (it names that
 *  version), or "". versions are the IOS appStoreVersions. */
export function ascInReviewProblem(versions, version) {
  const v = versions.find((x) => x.attributes.versionString !== version && ASC_IN_REVIEW.includes(ascState(x)));
  return v ? "App Store: version " + v.attributes.versionString + " is " + ascState(v) + "; wait for that review to finish (or cancel it in App Store Connect), then promote " + version + " again" : "";
}

/** App Store Connect client, app id and IOS versions. early is the result
 *  when nothing is to be done (X.Y.Z live or in review, or a newer version
 *  there); throws when another version is in review. */
async function ascOpen(version) {
  const base = "https://api.appstoreconnect.apple.com";
  const key = process.env.ASC_API_KEY_P8;
  const asc = ascRetry((method, path, body, ok) =>
    http(method, path.startsWith("https://") ? path : base + path, {
      headers: { Authorization: "Bearer " + ascToken(key, process.env.ASC_API_KEY_ID, process.env.ASC_API_ISSUER_ID), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      ok,
    }));
  const apps = (await asc("GET", "/v1/apps?filter[bundleId]=" + BUNDLE_ID)).json.data.filter((a) => a.attributes.bundleId === BUNDLE_ID);
  if (apps.length !== 1) throw new Error("App Store Connect: no app with bundle id " + BUNDLE_ID);
  const app = apps[0].id;
  const versions = (await asc("GET", "/v1/apps/" + app + "/appStoreVersions?filter[platform]=IOS&limit=200")).json.data;
  const same = versions.find((v) => v.attributes.versionString === version);
  let early = null;
  if (same && ASC_DONE.includes(ascState(same))) {
    early = { promoted: true, line: "App Store " + version + ": already " + ascState(same) + "; nothing to do" };
  } else {
    const newer = versions.find((v) => parseVersion(v.attributes.versionString) && cmpVersion(v.attributes.versionString, version) > 0 && !ASC_EDITABLE.includes(ascState(v)));
    if (newer) early = { promoted: false, line: "App Store " + version + ": SKIP, " + newer.attributes.versionString + " is already " + ascState(newer) };
  }
  if (!early) {
    const why = ascInReviewProblem(versions, version);
    if (why) throw new Error(why);
  }
  return { asc, app, versions, same, early };
}

/** The builds of X.Y.Z on App Store Connect (build number and version). */
const ascBuilds = async (asc, app, version) => (await asc("GET", "/v1/builds?filter[app]=" + app + "&filter[version]=" + buildNumber(version) + "&filter[preReleaseVersion.version]=" + version)).json.data;

/** Max wait for App Store Connect to list and process an uploaded build. */
export const ASC_BUILD_TIMEOUT_MS = 40 * 60 * 1000;

/** The build of X.Y.Z once App Store Connect has processed it (VALID). Waits
 *  while it is not listed yet or PROCESSING; fails on any other state, when
 *  expired, or after the timeout. */
export async function ascValidBuild({ asc, app, version, sleep, now = Date.now, timeoutMs = ASC_BUILD_TIMEOUT_MS, intervalMs = 30000 }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const b = (await ascBuilds(asc, app, version))[0];
    const st = b?.attributes.processingState;
    if (b && st === "VALID" && !b.attributes.expired) return b;
    if (b && (b.attributes.expired || (st && st !== "PROCESSING"))) throw new Error("build " + buildNumber(version) + " is " + st + (b.attributes.expired ? ", expired" : ""));
    if (now() >= deadline) throw new Error("App Store: build " + version + " (" + buildNumber(version) + ") is " + (b ? st : "not on App Store Connect") + " after " + Math.round(timeoutMs / 60000) + " minutes; the store job uploads the IPA of the release ios/v" + version);
    console.log("App Store: build " + buildNumber(version) + " is " + (b ? st : "not listed yet") + ", waiting " + intervalMs / 1000 + " s");
    await sleep(intervalMs);
  }
}

/** store.yml, before the IPA upload: the review check, then the verified IPA
 *  of the release written to IPA_DIR (step output ipa) when App Store Connect
 *  does not have build X.Y.Z yet. Output ipa is empty when nothing is to be
 *  uploaded. */
export async function appstoreUpload(version) {
  const { asc, app, early } = await ascOpen(version);
  output("ipa", "");
  if (early) return summary("- " + early.line.replace(/; nothing to do$/, "") + "; no upload");
  if ((await ascBuilds(asc, app, version)).length) return summary("- App Store " + version + ": build " + buildNumber(version) + " is already on App Store Connect; no upload");
  const name = "pusharmor-" + version + ".ipa";
  const ipa = await releaseFile("ios", version, name);
  const file = join(process.env.IPA_DIR || tmpdir(), name);
  writeFileSync(file, ipa);
  output("ipa", file);
  summary("- App Store " + version + ": " + name + " of the release verified; uploading build " + buildNumber(version));
}

export async function appstore(version) {
  const { asc, app, versions, same, early } = await ascOpen(version);
  if (early) return early.promoted ? done(early.line) : skip(early.line);
  const build = String(buildNumber(version));
  const b = await ascValidBuild({ asc, app, version, sleep });
  if (b.attributes.usesNonExemptEncryption == null) throw new Error("build " + build + ": answer export compliance in App Store Connect first");

  const want = readListing("appstore");
  let v = same || versions.find((x) => ASC_EDITABLE.includes(ascState(x)));
  const attrs = { versionString: version, copyright: want.copyright, releaseType: IOS_RELEASE_TYPE };
  if (v) {
    await asc("PATCH", "/v1/appStoreVersions/" + v.id, { data: { type: "appStoreVersions", id: v.id, attributes: attrs } });
  } else {
    v = (await asc("POST", "/v1/appStoreVersions", { data: { type: "appStoreVersions", attributes: { platform: "IOS", ...attrs }, relationships: { app: { data: { type: "apps", id: app } } } } })).json.data;
  }
  await asc("PATCH", "/v1/appStoreVersions/" + v.id + "/relationships/build", { data: { type: "builds", id: b.id } });

  // Version page text.
  const locs = (await asc("GET", "/v1/appStoreVersions/" + v.id + "/appStoreVersionLocalizations")).json.data;
  // No contact field (support or marketing URL, email, phone, address): those
  // stay as set in App Store Connect (owner rule).
  const la = { description: want.description, keywords: want.keywords, promotionalText: want.promotional_text };
  // Updates need What's New; the first version of an app must not have it.
  if (versions.some((x) => x.id !== v.id && ASC_RELEASED.includes(ascState(x)))) la.whatsNew = want.whats_new;
  let loc = locs.find((l) => l.attributes.locale === LOCALE);
  if (loc) {
    await asc("PATCH", "/v1/appStoreVersionLocalizations/" + loc.id, { data: { type: "appStoreVersionLocalizations", id: loc.id, attributes: la } });
  } else {
    loc = (await asc("POST", "/v1/appStoreVersionLocalizations", { data: { type: "appStoreVersionLocalizations", attributes: { locale: LOCALE, ...la }, relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: v.id } } } } })).json.data;
  }

  // App name, subtitle and privacy URL live on the editable app info.
  const infos = (await asc("GET", "/v1/apps/" + app + "/appInfos")).json.data;
  const info = infos.find((i) => ASC_EDITABLE.includes(i.attributes.state || i.attributes.appStoreState)) || (infos.length === 1 ? infos[0] : null);
  if (!info) throw new Error("App Store Connect: no editable app info");
  const ils = (await asc("GET", "/v1/appInfos/" + info.id + "/appInfoLocalizations")).json.data;
  const il = ils.find((l) => l.attributes.locale === LOCALE);
  if (!il) throw new Error("App Store Connect: app info has no " + LOCALE + " localization");
  await asc("PATCH", "/v1/appInfoLocalizations/" + il.id, { data: { type: "appInfoLocalizations", id: il.id, attributes: { name: want.name, subtitle: want.subtitle, privacyPolicyUrl: want.privacy_url } } });

  // Screenshots: one with the same file name and checksum is kept.
  const shots = screenshotFiles("appstore");
  const sets = (await asc("GET", "/v1/appStoreVersionLocalizations/" + loc.id + "/appScreenshotSets")).json.data;
  let set = sets.find((s) => s.attributes.screenshotDisplayType === IOS_SCREENSHOT_TYPE);
  if (!set) {
    set = (await asc("POST", "/v1/appScreenshotSets", { data: { type: "appScreenshotSets", attributes: { screenshotDisplayType: IOS_SCREENSHOT_TYPE }, relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: loc.id } } } } })).json.data;
  }
  const images = await syncScreenshots({ asc, http: ascRetry(http), setId: set.id, shots, sleep });

  // App Review notes, contact details, and the demo account stay as
  // entered in App Store Connect; this script never writes them.

  // Review submission: reuse an open draft, add this version, submit.
  const open = (await asc("GET", "/v1/reviewSubmissions?filter[app]=" + app + "&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW,UNRESOLVED_ISSUES,WAITING_FOR_REVIEW,IN_REVIEW")).json.data;
  const busy = open.find((s) => ["WAITING_FOR_REVIEW", "IN_REVIEW"].includes(s.attributes.state));
  if (busy) throw new Error("another App Store submission is " + busy.attributes.state + "; wait for it or cancel it in App Store Connect");
  let sub = open[0];
  if (!sub) sub = (await asc("POST", "/v1/reviewSubmissions", { data: { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: { app: { data: { type: "apps", id: app } } } } })).json.data;
  const items = (await asc("GET", "/v1/reviewSubmissions/" + sub.id + "/items?include=appStoreVersion")).json.data;
  if (!items.some((i) => i.relationships?.appStoreVersion?.data?.id === v.id)) {
    await asc("POST", "/v1/reviewSubmissionItems", { data: { type: "reviewSubmissionItems", relationships: { reviewSubmission: { data: { type: "reviewSubmissions", id: sub.id } }, appStoreVersion: { data: { type: "appStoreVersions", id: v.id } } } } });
  }
  await asc("PATCH", "/v1/reviewSubmissions/" + sub.id, { data: { type: "reviewSubmissions", id: sub.id, attributes: { submitted: true } } });
  return done("App Store " + version + ": build " + build + " submitted for review; release " + IOS_RELEASE_TYPE + "; " + images);
}

/** Screenshot max wait for App Store Connect processing, all files together. */
export const ASC_SHOT_TIMEOUT_MS = 10 * 60 * 1000;

/** Make the App Store screenshot set hold exactly `shots`, in order.
 *  A screenshot already there with the same file name and checksum that is
 *  processed or still processing is kept (so a rerun reuses the uploads of an
 *  earlier attempt); every other one is deleted. Missing files are uploaded.
 *  Then it waits until App Store Connect has processed each one (COMPLETE),
 *  and fails on FAILED or after the timeout. */
export async function syncScreenshots({ asc, http, setId, shots, sleep, now = Date.now, timeoutMs = ASC_SHOT_TIMEOUT_MS, intervalMs = 5000 }) {
  const md5 = (d) => createHash("md5").update(d).digest("hex");
  const have = (await asc("GET", "/v1/appScreenshotSets/" + setId + "/appScreenshots")).json.data;
  const ids = new Map();
  let changed = false;
  for (const h of have) {
    const a = h.attributes || {};
    const s = shots.find((x) => x.name === a.fileName && md5(x.data) === a.sourceFileChecksum);
    const state = (a.assetDeliveryState || {}).state;
    if (s && !ids.has(s.name) && (state === "COMPLETE" || state === "UPLOAD_COMPLETE")) {
      ids.set(s.name, h.id);
    } else {
      await asc("DELETE", "/v1/appScreenshots/" + h.id);
      changed = true;
    }
  }
  let uploaded = 0;
  for (const s of shots) {
    if (ids.has(s.name)) continue;
    const r = (await asc("POST", "/v1/appScreenshots", { data: { type: "appScreenshots", attributes: { fileName: s.name, fileSize: s.data.length }, relationships: { appScreenshotSet: { data: { type: "appScreenshotSets", id: setId } } } } })).json.data;
    for (const op of r.attributes.uploadOperations) {
      const headers = Object.fromEntries((op.requestHeaders || []).map((h) => [h.name, h.value]));
      await http(op.method, op.url, { headers, body: s.data.subarray(op.offset, op.offset + op.length) });
    }
    await asc("PATCH", "/v1/appScreenshots/" + r.id, { data: { type: "appScreenshots", id: r.id, attributes: { uploaded: true, sourceFileChecksum: md5(s.data) } } });
    ids.set(s.name, r.id);
    uploaded++;
    changed = true;
  }
  const deadline = now() + timeoutMs;
  for (const s of shots) {
    for (;;) {
      const st = (await asc("GET", "/v1/appScreenshots/" + ids.get(s.name))).json.data.attributes.assetDeliveryState || {};
      if (st.state === "COMPLETE") break;
      if (st.state === "FAILED") throw new Error(s.name + ": screenshot processing FAILED " + JSON.stringify(st.errors || []));
      if (now() >= deadline) throw new Error(s.name + ": screenshot still " + (st.state || "not processed") + " after " + Math.round(timeoutMs / 60000) + " minutes " + JSON.stringify(st.errors || []));
      await sleep(intervalMs);
    }
  }
  const order = shots.map((s) => ids.get(s.name));
  if (!changed && have.map((h) => h.id).join() === order.join()) return "screenshots unchanged";
  await asc("PATCH", "/v1/appScreenshotSets/" + setId + "/relationships/appScreenshots", { data: order.map((id) => ({ type: "appScreenshots", id })) });
  return uploaded + " screenshots uploaded, " + (shots.length - uploaded) + " reused";
}

// ---- Chrome Web Store (public item) ----

async function chrome(version) {
  const pub = loadPublic();
  const api = "https://chromewebstore.googleapis.com";
  const item = "publishers/" + pub.google_cws_publisher_id + "/items/" + pub.google_chrome_extension_id;
  if (pub.google_chrome_extension_id === pub.google_chrome_beta_extension_id) throw new Error("public Chrome id equals the Beta id");
  const auth = { Authorization: "Bearer " + process.env.TOKEN };
  const getRetry = ascRetry(http, sleep, console.log, undefined, "Chrome Web Store");
  const status = async () => (await getRetry("GET", api + "/v2/" + item + ":fetchStatus", { headers: auth })).json;
  const crx = (r) => (r?.distributionChannels || []).map((c) => c.crxVersion).filter(Boolean);

  const s = await status();
  const live = crx(s.publishedItemRevisionStatus);
  const sub = s.submittedItemRevisionStatus;
  if (live.includes(version)) return done("Chrome " + version + ": already live; nothing to do");
  if (sub && crx(sub).includes(version) && ["PENDING_REVIEW", "STAGED"].includes(sub.state)) return done("Chrome " + version + ": already " + sub.state + "; nothing to do");
  const newer = [...live, ...crx(sub)].filter((x) => parseVersion(x) && cmpVersion(x, version) > 0);
  if (newer.length) return skip("Chrome " + version + ": SKIP, store already has " + newer[0]);
  if (sub && sub.state === "PENDING_REVIEW") throw new Error("Chrome Web Store: version " + (crx(sub).join(",") || "unknown") + " is in review (PENDING_REVIEW); wait for that review to finish (or cancel it in the dashboard), then promote " + version + " again");

  const zip = await releaseFile("chrome", version, "pusharmor-chrome-" + version + "-store.zip").catch(() => releaseFile("chrome", version, "pusharmor-chrome-" + version + ".zip"));
  let r = (await getRetry("POST", api + "/upload/v2/" + item + ":upload", { headers: { ...auth, "Content-Type": "application/zip" }, body: zip })).json;
  let state = r.uploadState;
  for (let i = 0; state === "IN_PROGRESS" && i < 30; i++) {
    await sleep(10000);
    state = (await status()).lastAsyncUploadState;
  }
  if (state !== "SUCCEEDED") throw new Error("Chrome upload: " + state + " " + JSON.stringify(r).slice(0, 2000));
  if (r.crxVersion && r.crxVersion !== version) throw new Error("Chrome upload reports version " + r.crxVersion);
  r = (await http("POST", api + "/v2/" + item + ":publish", { headers: { ...auth, "Content-Length": "0" } })).json;
  const st = (r && r.state) || "";
  if (!st || ["ITEM_STATE_UNSPECIFIED", "REJECTED", "CANCELLED"].includes(st)) throw new Error("Chrome publish: " + JSON.stringify(r).slice(0, 2000));
  return done("Chrome " + version + ": public zip uploaded and submitted (" + st + ")");
}

// ---- Firefox AMO (listed add-on) ----

/** HS256 JWT for the AMO API (one per request, 5 minutes at most). */
export function amoToken(issuer, secret, now = Math.floor(Date.now() / 1000)) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = b64({ alg: "HS256", typ: "JWT" }) + "." + b64({ iss: issuer, jti: randomUUID(), iat: now, exp: now + 240 });
  return data + "." + createHmac("sha256", secret).update(data).digest("base64url");
}

/** Replace the AMO listing previews with `shots`, in order: upload each one
 *  (position = its index, `gap` ms apart to stay under the AMO throttle),
 *  then delete every preview that was there before. AMO re-encodes previews,
 *  so an unchanged set cannot be detected by content. A run that already
 *  uploaded the set is recognised by ids: when the listing holds more than
 *  shots.length previews and the newest shots.length ids (the last upload)
 *  carry the positions 0..N-1 in id order, those are kept, the rest deleted,
 *  and nothing is uploaded. A failed upload leaves the old previews in place. */
export async function syncAmoPreviews({ amo, id, shots, wait = sleep, gap = 15000, log = console.log }) {
  const old = ((await amo("GET", "/addon/" + id + "/")).json.previews || []).slice().sort((a, b) => a.id - b.id);
  const n = shots.length;
  log("AMO previews: " + old.length + " on the listing, " + n + " screenshots");
  const del = async (list) => {
    for (const p of list) {
      log("AMO previews: deleting preview " + p.id);
      await amo("DELETE", "/addon/" + id + "/previews/" + p.id + "/");
    }
  };
  if (old.length > n) {
    const newest = old.slice(old.length - n);
    if (newest.every((p, i) => Number(p.position) === i)) {
      log("AMO previews: the newest " + n + " are the screenshots, nothing to upload");
      await del(old.slice(0, old.length - n));
      return "previews already uploaded, " + (old.length - n) + " old previews removed";
    }
  }
  for (const [i, s] of shots.entries()) {
    if (i > 0) {
      log("AMO previews: waiting " + gap / 1000 + " s before the next upload");
      await wait(gap);
    }
    log("AMO previews: uploading " + s.name + " at position " + i);
    const f = new FormData();
    f.append("image", new Blob([s.data], { type: "image/png" }), s.name);
    f.append("position", String(i));
    await amo("POST", "/addon/" + id + "/previews/", f);
  }
  await del(old);
  return n + " previews uploaded, " + old.length + " old previews removed";
}

const AMO_TIMEOUT_MS = 60000;
// AMO file states of a listed version that waits for review.
export const AMO_IN_REVIEW = ["unreviewed", "nominated"];

/** The error for another listed AMO version that waits for review (it names
 *  that version), or "". versions are the AMO version objects. */
export function amoInReviewProblem(versions, version) {
  const v = versions.find((x) => x.version !== version && x.channel === "listed" && AMO_IN_REVIEW.includes(x.file?.status));
  return v ? "Firefox AMO: version " + v.version + " is in review (" + v.file.status + "); wait for that review to finish, then promote " + version + " again" : "";
}

export async function firefox(version) {
  const api = "https://addons.mozilla.org/api/v5/addons";
  const id = encodeURIComponent(loadPublic().mozilla_firefox_addon_id);
  const amo = amoRetry((method, path, body, ok) =>
    http(method, api + path, { headers: { Authorization: "JWT " + amoToken(process.env.MOZILLA_AMO_JWT_ISSUER, process.env.MOZILLA_AMO_JWT_SECRET) }, body, ok, timeout: AMO_TIMEOUT_MS }));

  // The listing previews: the plain AMO screenshots (store/screenshots/amo).
  const previews = () => syncAmoPreviews({ amo, id, shots: screenshotFiles("amo") });
  // 401 and 403 (a wrong or expired AMO credential) throw with their status.
  if ((await amo("GET", "/addon/" + id + "/", undefined, [200, 404])).status !== 200) {
    throw new Error("Firefox: the listed add-on is not on AMO yet; create it by hand once (RELEASING.md, Firefox)");
  }
  const versions = [];
  for (let url = "/addon/" + id + "/versions/?filter=all_with_unlisted&page_size=50"; url; ) {
    console.log("AMO: reading the versions list (" + versions.length + " so far)");
    const j = (await amo("GET", url)).json;
    versions.push(...j.results);
    url = j.next ? j.next.slice(api.length) : "";
  }
  const same = versions.find((x) => x.version === version);
  if (same) {
    const st = same.channel + ", " + (same.file?.status || "unknown");
    // Only a listed version that AMO did not disable counts as promoted.
    if (same.channel === "listed" && same.file?.status !== "disabled") return done("Firefox " + version + ": already on AMO (" + st + "); " + (await previews()));
    return skip("Firefox " + version + ": SKIP, " + version + " is already on AMO (" + st + ")");
  }
  const newer = versions.find((x) => x.channel === "listed" && parseVersion(x.version) && cmpVersion(x.version, version) > 0);
  if (newer) return skip("Firefox " + version + ": SKIP, AMO already has " + newer.version);
  const why = amoInReviewProblem(versions, version);
  if (why) throw new Error(why);

  const zip = await releaseFile("firefox", version, "pusharmor-firefox-" + version + ".zip");
  const src = await releaseFile("firefox", version, "pusharmor-firefox-" + version + "-source.zip");
  const form = new FormData();
  form.append("upload", new Blob([zip]), "pusharmor-firefox-" + version + ".zip");
  form.append("channel", "listed");
  let u = (await amo("POST", "/upload/", form)).json;
  for (let i = 0; !u.processed && i < 60; i++) {
    await sleep(10000);
    u = (await amo("GET", "/upload/" + u.uuid + "/")).json;
  }
  if (!u.processed || !u.valid) throw new Error("Firefox upload not valid: " + JSON.stringify(u.validation || u).slice(0, 3000));
  if (u.version !== version) throw new Error("Firefox upload is version " + u.version);
  const vf = new FormData();
  vf.append("upload", u.uuid);
  vf.append("source", new Blob([src]), "pusharmor-firefox-" + version + "-source.zip");
  // Notes for the reviewers; the demo account is in the Developer Hub.
  vf.append("approval_notes", readFileSync(AMO_REVIEW_NOTES, "utf8").trim());
  await amo("POST", "/addon/" + id + "/versions/", vf);
  return done("Firefox " + version + ": public zip and source submitted as a listed version; " + (await previews()));
}

const COMMANDS = { check, gate, play, "appstore-upload": appstoreUpload, appstore, chrome, firefox };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, version] = process.argv.slice(2);
  const bad = COMMANDS[cmd] ? formatProblems("android", version || "") : ["usage: node release/promote.mjs <" + Object.keys(COMMANDS).join("|") + "> X.Y.Z"];
  if (bad.length) {
    console.error(bad.join("\n"));
    process.exit(2);
  }
  COMMANDS[cmd](version).then((r) => {
    if (!["check", "gate", "appstore-upload"].includes(cmd)) output("clear_prerelease", clearOutput(r));
  }, (e) => {
    summary("- " + cmd + " " + version + ": FAILED: " + e.message.split("\n")[0].slice(0, 300));
    console.error(e.message);
    process.exit(1);
  });
}
