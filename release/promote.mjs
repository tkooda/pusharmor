// Promote (workflow promote.yml, owner rulings Q241 A and Q242 A): sends the
// already tested build of version X.Y.Z to the public channel of one store.
// Nothing is rebuilt: Play promotes the internal-track versionCode, App Store
// submits the TestFlight build, Chrome and Firefox upload the public zip of the
// GitHub prerelease. Every command is safe to rerun: it skips a version that is
// already live or in review.
//   node release/promote.mjs check X.Y.Z      tags, prereleases, listings
//   node release/promote.mjs play X.Y.Z       env TOKEN (androidpublisher)
//   node release/promote.mjs appstore X.Y.Z   env ASC_API_KEY_P8, ASC_API_KEY_ID, ASC_API_ISSUER_ID
//   node release/promote.mjs chrome X.Y.Z     env TOKEN (chromewebstore)
//   node release/promote.mjs firefox X.Y.Z    env MOZILLA_AMO_JWT_ISSUER, MOZILLA_AMO_JWT_SECRET
// Each command writes short result lines to the job summary.
import { createHash, createHmac, randomUUID, sign } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
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
// App Store release after approval: the build was tested on TestFlight, and the
// other three stores also go live when their review passes. MANUAL keeps a
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
  },
  appstore: {
    name: { max: 30 },
    subtitle: { max: 30 },
    description: { max: 4000 },
    keywords: { max: 100, bytes: true },
    promotional_text: { max: 170 },
    support_url: { max: 255, url: true },
    marketing_url: { max: 255, url: true },
    privacy_url: { max: 255, url: true },
    copyright: { max: 200 },
    review_notes: { max: 4000 },
  },
};
export const SCREENSHOTS = { play: "android", appstore: "ios" };

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
export function releaseAssets(platform, version) {
  return {
    android: [],
    ios: [],
    chrome: ["pusharmor-chrome-" + version + ".zip", "pusharmor-chrome-" + version + ".hashes.txt"],
    firefox: ["pusharmor-firefox-" + version + ".zip", "pusharmor-firefox-" + version + "-source.zip", "pusharmor-firefox-" + version + ".hashes.txt"],
  }[platform];
}

/** Why a platform is skipped (a string), or "" when its tag and prerelease are
 *  ready. release is the GitHub release object or null. */
export function releaseProblem(platform, version, tagExists, release) {
  const tag = platform + "/v" + version;
  if (!tagExists) return "no tag " + tag;
  if (!release) return "no GitHub release " + tag;
  if (release.draft) return "release " + tag + " is still a draft";
  const have = new Set((release.assets || []).map((a) => a.name));
  const missing = releaseAssets(platform, version).filter((n) => !have.has(n));
  return missing.length ? "release " + tag + " lacks " + missing.join(", ") : "";
}

// ---- output ----

function summary(line) {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + "\n");
}
function output(k, v) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, k + "=" + v + "\n");
}

// ---- HTTP ----

/** fetch that throws on an unexpected status with the API error body. The
 *  query string is left out of the message (upload URLs carry tokens). */
async function http(method, url, { headers = {}, body, ok = [200, 201, 202, 204] } = {}) {
  const r = await fetch(url, { method, headers, body });
  const text = await r.text();
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
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** Bytes of a GitHub release asset, checked against the release hashes file. */
async function releaseFile(platform, version, name) {
  const base = "https://github.com/" + repo() + "/releases/download/" + platform + "/v" + version + "/";
  const get = async (n) => {
    const r = await fetch(base + n);
    if (!r.ok) throw new Error("download " + n + ": HTTP " + r.status);
    return Buffer.from(await r.arrayBuffer());
  };
  const data = await get(name);
  const hashes = (await get("pusharmor-" + platform + "-" + version + ".hashes.txt")).toString("utf8");
  const want = hashes.split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[1] === name);
  if (!want || want[0] !== sha256(data)) throw new Error(name + ": sha256 does not match the release hashes file");
  return data;
}

function repo() {
  return process.env.GITHUB_REPOSITORY || "tkooda/pusharmor";
}

// ---- check ----

async function check(version) {
  const gh = (path) =>
    http("GET", "https://api.github.com/repos/" + repo() + path, {
      headers: { Authorization: "Bearer " + process.env.GH_TOKEN, Accept: "application/vnd.github+json" },
      ok: [200, 404],
    });
  summary("### Promote " + version);
  let any = false;
  for (const p of PLATFORMS) {
    const tag = p + "/v" + version;
    const ref = await gh("/git/ref/tags/" + tag);
    const rel = await gh("/releases/tags/" + tag);
    const why = releaseProblem(p, version, ref.status === 200, rel.status === 200 ? rel.json : null);
    output(p, why ? "false" : "true");
    summary(why ? "- " + p + ": SKIP (" + why + ")" : "- " + p + ": ready (" + tag + ")");
    any ||= !why;
  }
  const bad = [...listingProblems("play"), ...listingProblems("appstore")];
  for (const b of bad) summary("- listing: " + b);
  const pub = loadPublic();
  for (const k of ["google_play_wif_provider", "google_play_wif_service_account", "google_cws_wif_provider", "google_cws_wif_service_account", "google_cws_publisher_id", "google_chrome_extension_id", "mozilla_firefox_addon_id"]) {
    output(k, pub[k]);
  }
  if (!any) throw new Error("no platform has tag and release " + version);
  if (bad.length) throw new Error("listing problems");
}

// ---- Google Play ----

async function play(version) {
  // Hard gate (I414): the owner sets the repository variable PLAY_CONTACT_OK to
  // yes once the public developer contact details in Play Console are fixed.
  if (process.env.PLAY_CONTACT_OK !== "yes") throw new Error("Play blocked: fix the developer contact details in Play Console, then set the repository variable PLAY_CONTACT_OK to yes");
  const api = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/" + PACKAGE_NAME;
  const up = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/" + PACKAGE_NAME;
  const auth = { Authorization: "Bearer " + process.env.TOKEN };
  const json = { ...auth, "Content-Type": "application/json" };
  const code = buildNumber(version);
  const edit = (await http("POST", api + "/edits", { headers: json, body: "{}" })).json.id;
  if (!edit) throw new Error("edits.insert returned no id");
  const e = api + "/edits/" + edit;
  let changed = false;

  const bundles = (await http("GET", e + "/bundles", { headers: auth })).json.bundles || [];
  if (!bundles.some((b) => b.versionCode === code)) throw new Error("versionCode " + code + " is not on Play; tag android/v" + version + " uploads it");
  const prod = (await http("GET", e + "/tracks/production", { headers: auth, ok: [200, 404] })).json || {};
  const live = (prod.releases || []).filter((r) => r.status !== "draft");
  const codes = live.flatMap((r) => (r.versionCodes || []).map(Number));
  let track;
  if (codes.includes(code)) {
    track = "already on production";
  } else if (codes.some((c) => c > code)) {
    track = "SKIP: production has a newer versionCode (" + Math.max(...codes) + ")";
  } else {
    const body = { track: "production", releases: [{ name: version, versionCodes: [String(code)], status: "completed" }] };
    await http("PUT", e + "/tracks/production", { headers: json, body: JSON.stringify(body) });
    track = "sent to production (versionCode " + code + ")";
    changed = true;
  }

  const want = readListing("play");
  const cur = (await http("GET", e + "/listings/" + LOCALE, { headers: auth, ok: [200, 404] })).json || {};
  const listing = { language: LOCALE, title: want.title, shortDescription: want.short_description, fullDescription: want.full_description };
  let text = "listing text unchanged";
  if (cur.title !== listing.title || cur.shortDescription !== listing.shortDescription || cur.fullDescription !== listing.fullDescription) {
    await http("PUT", e + "/listings/" + LOCALE, { headers: json, body: JSON.stringify({ ...cur, ...listing }) });
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

  if (changed) {
    // ERROR_IF_IN_REVIEW: never cancel a review that is already running.
    await http("POST", e + ":commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW", { headers: { ...auth, "Content-Length": "0" } });
  } else {
    await http("DELETE", e, { headers: auth });
  }
  summary("Play " + version + ": " + track + "; " + text + "; " + images);
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
export const ASC_DONE = ["WAITING_FOR_REVIEW", "IN_REVIEW", "PENDING_DEVELOPER_RELEASE", "PENDING_APPLE_RELEASE", "PROCESSING_FOR_APP_STORE", "READY_FOR_SALE", "READY_FOR_DISTRIBUTION", "ACCEPTED", "PREORDER_READY_FOR_SALE", "WAITING_FOR_EXPORT_COMPLIANCE"];
export const ASC_EDITABLE = ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"];
const ascState = (v) => v.attributes.appVersionState || v.attributes.appStoreState;

async function appstore(version) {
  const base = "https://api.appstoreconnect.apple.com";
  const key = process.env.ASC_API_KEY_P8;
  const asc = (method, path, body, ok) =>
    http(method, path.startsWith("https://") ? path : base + path, {
      headers: { Authorization: "Bearer " + ascToken(key, process.env.ASC_API_KEY_ID, process.env.ASC_API_ISSUER_ID), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      ok,
    });
  const build = String(buildNumber(version));

  const apps = (await asc("GET", "/v1/apps?filter[bundleId]=" + BUNDLE_ID)).json.data.filter((a) => a.attributes.bundleId === BUNDLE_ID);
  if (apps.length !== 1) throw new Error("App Store Connect: no app with bundle id " + BUNDLE_ID);
  const app = apps[0].id;

  const builds = (await asc("GET", "/v1/builds?filter[app]=" + app + "&filter[version]=" + build + "&filter[preReleaseVersion.version]=" + version)).json.data;
  const b = builds[0];
  if (!b) throw new Error("no TestFlight build " + version + " (" + build + "); tag ios/v" + version + " uploads it");
  if (b.attributes.processingState !== "VALID" || b.attributes.expired) throw new Error("build " + build + " is " + b.attributes.processingState + (b.attributes.expired ? ", expired" : ""));
  if (b.attributes.usesNonExemptEncryption == null) throw new Error("build " + build + ": answer export compliance in App Store Connect first");

  const versions = (await asc("GET", "/v1/apps/" + app + "/appStoreVersions?filter[platform]=IOS&limit=200")).json.data;
  const same = versions.find((v) => v.attributes.versionString === version);
  if (same && ASC_DONE.includes(ascState(same))) {
    summary("App Store " + version + ": already " + ascState(same) + "; nothing to do");
    return;
  }
  const newer = versions.find((v) => parseVersion(v.attributes.versionString) && cmpVersion(v.attributes.versionString, version) > 0 && !ASC_EDITABLE.includes(ascState(v)));
  if (newer) {
    summary("App Store " + version + ": SKIP, " + newer.attributes.versionString + " is already " + ascState(newer));
    return;
  }

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
  const la = { description: want.description, keywords: want.keywords, promotionalText: want.promotional_text, supportUrl: want.support_url, marketingUrl: want.marketing_url };
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

  // Screenshots: replaced only when the file names or checksums differ.
  const shots = screenshotFiles("appstore");
  const sets = (await asc("GET", "/v1/appStoreVersionLocalizations/" + loc.id + "/appScreenshotSets")).json.data;
  let set = sets.find((s) => s.attributes.screenshotDisplayType === IOS_SCREENSHOT_TYPE);
  if (!set) {
    set = (await asc("POST", "/v1/appScreenshotSets", { data: { type: "appScreenshotSets", attributes: { screenshotDisplayType: IOS_SCREENSHOT_TYPE }, relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: loc.id } } } } })).json.data;
  }
  const md5 = (d) => createHash("md5").update(d).digest("hex");
  const have = (await asc("GET", "/v1/appScreenshotSets/" + set.id + "/appScreenshots")).json.data;
  const sig = (list) => list.map((x) => x.join(":")).join(",");
  let images = "screenshots unchanged";
  if (sig(have.map((s) => [s.attributes.fileName, s.attributes.sourceFileChecksum])) !== sig(shots.map((s) => [s.name, md5(s.data)]))) {
    for (const s of have) await asc("DELETE", "/v1/appScreenshots/" + s.id);
    for (const s of shots) {
      const r = (await asc("POST", "/v1/appScreenshots", { data: { type: "appScreenshots", attributes: { fileName: s.name, fileSize: s.data.length }, relationships: { appScreenshotSet: { data: { type: "appScreenshotSets", id: set.id } } } } })).json.data;
      for (const op of r.attributes.uploadOperations) {
        const headers = Object.fromEntries((op.requestHeaders || []).map((h) => [h.name, h.value]));
        await http(op.method, op.url, { headers, body: s.data.subarray(op.offset, op.offset + op.length) });
      }
      await asc("PATCH", "/v1/appScreenshots/" + r.id, { data: { type: "appScreenshots", id: r.id, attributes: { uploaded: true, sourceFileChecksum: md5(s.data) } } });
      for (let i = 0; ; i++) {
        const st = (await asc("GET", "/v1/appScreenshots/" + r.id)).json.data.attributes.assetDeliveryState || {};
        if (st.state === "COMPLETE") break;
        if (st.state === "FAILED" || i >= 36) throw new Error(s.name + ": screenshot " + (st.state || "not processed") + " " + JSON.stringify(st.errors || []));
        await sleep(5000);
      }
    }
    images = shots.length + " screenshots uploaded";
  }

  // App Review notes only. Contact details and the demo account stay as
  // entered in App Store Connect (owner rule: never in the repo or the API).
  const rd = (await asc("GET", "/v1/appStoreVersions/" + v.id + "/appStoreReviewDetail", undefined, [200, 404])).json;
  if (rd && rd.data) {
    await asc("PATCH", "/v1/appStoreReviewDetails/" + rd.data.id, { data: { type: "appStoreReviewDetails", id: rd.data.id, attributes: { notes: want.review_notes } } });
  } else {
    await asc("POST", "/v1/appStoreReviewDetails", { data: { type: "appStoreReviewDetails", attributes: { notes: want.review_notes }, relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: v.id } } } } });
  }

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
  summary("App Store " + version + ": build " + build + " submitted for review; release " + IOS_RELEASE_TYPE + "; " + images);
}

// ---- Chrome Web Store (public item) ----

async function chrome(version) {
  const pub = loadPublic();
  const api = "https://chromewebstore.googleapis.com";
  const item = "publishers/" + pub.google_cws_publisher_id + "/items/" + pub.google_chrome_extension_id;
  if (pub.google_chrome_extension_id === pub.google_chrome_beta_extension_id) throw new Error("public Chrome id equals the Beta id");
  const auth = { Authorization: "Bearer " + process.env.TOKEN };
  const status = async () => (await http("GET", api + "/v2/" + item + ":fetchStatus", { headers: auth })).json;
  const crx = (r) => (r?.distributionChannels || []).map((c) => c.crxVersion).filter(Boolean);

  const s = await status();
  const live = crx(s.publishedItemRevisionStatus);
  const sub = s.submittedItemRevisionStatus;
  if (live.includes(version)) return summary("Chrome " + version + ": already live; nothing to do");
  if (sub && crx(sub).includes(version) && ["PENDING_REVIEW", "STAGED"].includes(sub.state)) return summary("Chrome " + version + ": already " + sub.state + "; nothing to do");
  const newer = [...live, ...crx(sub)].filter((x) => parseVersion(x) && cmpVersion(x, version) > 0);
  if (newer.length) return summary("Chrome " + version + ": SKIP, store already has " + newer[0]);
  if (sub && sub.state === "PENDING_REVIEW") throw new Error("Chrome: version " + crx(sub).join(",") + " is in review; cancel it in the dashboard first");

  const zip = await releaseFile("chrome", version, "pusharmor-chrome-" + version + ".zip");
  let r = (await http("POST", api + "/upload/v2/" + item + ":upload", { headers: { ...auth, "Content-Type": "application/zip" }, body: zip })).json;
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
  summary("Chrome " + version + ": public zip uploaded and submitted (" + st + ")");
}

// ---- Firefox AMO (listed add-on) ----

/** HS256 JWT for the AMO API (one per request, 5 minutes at most). */
export function amoToken(issuer, secret, now = Math.floor(Date.now() / 1000)) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = b64({ alg: "HS256", typ: "JWT" }) + "." + b64({ iss: issuer, jti: randomUUID(), iat: now, exp: now + 240 });
  return data + "." + createHmac("sha256", secret).update(data).digest("base64url");
}

async function firefox(version) {
  const api = "https://addons.mozilla.org/api/v5/addons";
  const id = encodeURIComponent(loadPublic().mozilla_firefox_addon_id);
  const amo = (method, path, body, ok) =>
    http(method, api + path, { headers: { Authorization: "JWT " + amoToken(process.env.MOZILLA_AMO_JWT_ISSUER, process.env.MOZILLA_AMO_JWT_SECRET) }, body, ok });

  if ((await amo("GET", "/addon/" + id + "/", undefined, [200, 401, 403, 404])).status !== 200) {
    throw new Error("Firefox: the listed add-on is not on AMO yet; create it by hand once (RELEASING.md, Firefox)");
  }
  const versions = [];
  for (let url = "/addon/" + id + "/versions/?filter=all_with_unlisted&page_size=50"; url; ) {
    const j = (await amo("GET", url)).json;
    versions.push(...j.results);
    url = j.next ? j.next.slice(api.length) : "";
  }
  const same = versions.find((x) => x.version === version);
  if (same) return summary("Firefox " + version + ": already on AMO (" + same.channel + ", " + (same.file?.status || "unknown") + "); nothing to do");
  const newer = versions.find((x) => x.channel === "listed" && parseVersion(x.version) && cmpVersion(x.version, version) > 0);
  if (newer) return summary("Firefox " + version + ": SKIP, AMO already has " + newer.version);

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
  await amo("POST", "/addon/" + id + "/versions/", vf);
  summary("Firefox " + version + ": public zip and source submitted as a listed version");
}

const COMMANDS = { check, play, appstore, chrome, firefox };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, version] = process.argv.slice(2);
  const bad = COMMANDS[cmd] ? formatProblems("android", version || "") : ["usage: node release/promote.mjs <" + Object.keys(COMMANDS).join("|") + "> X.Y.Z"];
  if (bad.length) {
    console.error(bad.join("\n"));
    process.exit(2);
  }
  COMMANDS[cmd](version).catch((e) => {
    summary("- " + cmd + " " + version + ": FAILED: " + e.message.split("\n")[0].slice(0, 300));
    console.error(e.message);
    process.exit(1);
  });
}
