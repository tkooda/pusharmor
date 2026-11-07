// Promote helper.
// Run: node --test release/promote.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { AMO_REVIEW_NOTES, PLAY_ICON, IOS_SCREENSHOT_TYPE, amoNotesProblems, amoRetry, ascRetry, amoToken, appstore, ascToken, attestationArgs, clearOutput, cmpVersion, commitProblems, contactProblems, http, listingProblems, playGateProblem, readListing, releaseAssets, screenshotFiles, firefox, promoteRunProblem, releaseProblem, selectedPlatforms, syncAmoPreviews, syncScreenshots, tagPlatform } from "./promote.mjs";

const ROOT = join(import.meta.dirname, "..");

// Play production needs both repository
// variables PLAY_CONTACT_OK and PLAY_PUBLIC_OK set to yes.
test("Play is gated on PLAY_CONTACT_OK and PLAY_PUBLIC_OK", () => {
  const src = readFileSync(join(ROOT, "release", "promote.mjs"), "utf8");
  assert.match(src, /async function play\(version\) \{\n(?: {2}\/\/.*\n)*  const gate = playGateProblem\(process\.env\);\n  if \(gate\) throw/);
  const check = src.slice(src.indexOf("async function check("), src.indexOf("\n}\n", src.indexOf("async function check(")));
  assert.match(check, /playGateProblem\(process\.env\)/);
  assert.match(check, /BLOCKED/);
  assert.equal(playGateProblem({ PLAY_CONTACT_OK: "yes", PLAY_PUBLIC_OK: "yes" }), "");
  assert.match(playGateProblem({ PLAY_CONTACT_OK: "yes" }), /PLAY_PUBLIC_OK/);
  assert.doesNotMatch(playGateProblem({ PLAY_CONTACT_OK: "yes" }), /PLAY_CONTACT_OK/);
  assert.match(playGateProblem({ PLAY_PUBLIC_OK: "yes", PLAY_CONTACT_OK: "YES" }), /PLAY_CONTACT_OK/);
  assert.match(playGateProblem({}), /PLAY_CONTACT_OK.*PLAY_PUBLIC_OK/);
});

test("promote.mjs never logs a secret", () => {
  const src = readFileSync(join(ROOT, "release", "promote.mjs"), "utf8");
  assert.doesNotMatch(src, /console\.(log|error)\([^)]*(TOKEN|ASC_API_KEY|AMO_JWT|keyP8|secret)/);
});

test("idempotence guards are present in every store command", () => {
  const src = readFileSync(join(ROOT, "release", "promote.mjs"), "utf8");
  const body = (fn) => src.slice(src.indexOf("async function " + fn + "("), src.indexOf("\n}\n", src.indexOf("async function " + fn + "(")));
  assert.match(body("play"), /already on production/);
  assert.match(body("play"), /production has a newer versionCode/);
  assert.match(body("play"), /ERROR_IF_IN_REVIEW/);
  assert.match(body("appstore"), /ASC_DONE\.includes/);
  assert.match(body("appstore"), /nothing to do/);
  assert.match(body("chrome"), /already live; nothing to do/);
  assert.match(body("chrome"), /PENDING_REVIEW/);
  assert.match(body("firefox"), /already on AMO/);
  for (const fn of ["play", "appstore", "chrome", "firefox"]) assert.match(body(fn), /SKIP/, fn);
});

// Owner rule: no contact field (email, phone, website, address) is set or
// overwritten through any store API; they stay as set in the consoles.
test("no contact-field keys in the store API payloads", () => {
  const src = readFileSync(join(ROOT, "release", "promote.mjs"), "utf8");
  for (const fn of ["play", "appstore", "chrome", "firefox"]) {
    const i = src.indexOf("async function " + fn + "(");
    const code = src
      .slice(i, src.indexOf("\n}\n", i))
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    // Object keys and fields of any payload, and the Play contact resource.
    assert.doesNotMatch(code, /\b(contact\w*|demoAccount\w*|support\w*Url|marketing\w*|website\w*|e-?mail\w*|phone\w*|address\w*)["']?\s*:/i, fn);
    assert.doesNotMatch(code, /\.(contact\w*|supportUrl|marketingUrl|website|email|phone|address)\b/i, fn);
    assert.doesNotMatch(code, /["/]details\b|appStoreReviewDetail\b[^"]*"\s*,\s*\{[^}]*contact/i, fn);
  }
  for (const f of readdirSync(join(ROOT, "store", "listing", "appstore", "en-US"))) assert.doesNotMatch(f, /support|marketing|contact|email|phone|address|website/, f);
  for (const f of readdirSync(join(ROOT, "store", "listing", "play", "en-US"))) assert.doesNotMatch(f, /support|marketing|contact|email|phone|address|website/, f);
});

test("release checks: tag, published release and the needed assets", () => {
  const rel = (names, draft = false) => ({ draft, assets: names.map((name) => ({ name })) });
  assert.equal(releaseProblem("chrome", "1.2.3", false, null), "no tag chrome/v1.2.3");
  assert.equal(releaseProblem("chrome", "1.2.3", true, null), "no GitHub release chrome/v1.2.3");
  assert.equal(releaseProblem("ios", "1.2.3", true, rel([], true)), "release ios/v1.2.3 is still a draft");
  assert.match(releaseProblem("chrome", "1.2.3", true, rel(["pusharmor-chrome-1.2.3-store.zip"])), /lacks pusharmor-chrome-1\.2\.3\.hashes\.txt/);
  assert.match(releaseProblem("chrome", "1.2.3", true, rel(["pusharmor-chrome-1.2.3.zip"])), /lacks pusharmor-chrome-1\.2\.3-store\.zip/);
  assert.equal(releaseProblem("chrome", "1.2.3", true, rel(["pusharmor-chrome-1.2.3.zip", "pusharmor-chrome-1.2.3-unpacked.zip", "pusharmor-chrome-1.2.3.hashes.txt"])), "");
  assert.equal(releaseProblem("firefox", "1.2.3", true, rel(releaseAssets("firefox", "1.2.3"))), "");
  assert.equal(releaseProblem("android", "1.2.3", true, rel([])), "");
  assert.equal(cmpVersion("0.0.10", "0.0.9"), 1);
  assert.equal(cmpVersion("0.0.9", "0.0.9"), 0);
  assert.equal(cmpVersion("0.1.0", "1.0.0"), -1);
});

test("the store listings in the repo pass the store limits", () => {
  assert.deepEqual(listingProblems("play"), []);
  assert.deepEqual(listingProblems("appstore"), []);
  for (const s of ["play", "appstore"]) {
    const l = readListing(s);
    const d = l.full_description || l.description;
    assert.match(d, /\nMade by Ion Echo, LLC\.$/, s);
    assert.doesNotMatch(d, /\bfiles? (are|is) sent|send(s)? files\b/i, s);
  }
});

test("the contact check finds phone numbers and project or company addresses", () => {
  const at = "@";
  assert.equal(contactProblems("mail support" + at + "pusharmor.com", "x").length, 1);
  assert.equal(contactProblems("dev" + at + "ionecho.com", "x").length, 1);
  assert.equal(contactProblems("call (555) " + "123-4567", "x").length, 1);
  assert.equal(contactProblems("call 555-" + "123-4567", "x").length, 1);
  assert.equal(contactProblems("call +44 20 " + "7946 0958", "x").length, 1);
  assert.deepEqual(contactProblems("2026-10-29 build 1000012 1320x2868 a" + at + "example.com v0.0.12", "x"), []);
});

// Owner rule: no address at the project or company domains and no phone number
// in any listing or release file (the Firefox ids are GUIDs, read from
// release/public.json by the code).
test("no phone number or project or company address in listing and release files", () => {
  const files = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (!/\.(png|jpg|zip)$/.test(f)) files.push(p);
    }
  };
  for (const d of ["store", "release", ".github/workflows"]) walk(join(ROOT, d));
  files.push(join(ROOT, "RELEASING.md"));
  const bad = files.flatMap((p) => contactProblems(readFileSync(p, "utf8"), relative(ROOT, p)));
  assert.deepEqual(bad, []);
});

test("store tokens: App Store ES256 and AMO HS256", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const t = ascToken(pem, "KEYID", "ISSUER", 1000).split(".");
  assert.deepEqual(JSON.parse(Buffer.from(t[0], "base64url")), { alg: "ES256", kid: "KEYID", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(t[1], "base64url")), { iss: "ISSUER", iat: 1000, exp: 1900, aud: "appstoreconnect-v1" });
  assert.ok(verify("sha256", Buffer.from(t[0] + "." + t[1]), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(t[2], "base64url")));
  const a = amoToken("user:1:2", "s3cret", 1000).split(".");
  const claims = JSON.parse(Buffer.from(a[1], "base64url"));
  assert.equal(claims.iss, "user:1:2");
  assert.ok(claims.exp - claims.iat <= 300 && claims.jti);
});

// a SKIP (the store has a newer version, or the same version in another
// channel) never clears the prerelease flag; only a promotion now or the same
// version already live or in review does.
test("store commands report clear_prerelease only for this version", () => {
  const src = readFileSync(join(ROOT, "release", "promote.mjs"), "utf8");
  for (const fn of ["play", "appstore", "chrome", "firefox"]) {
    const i = src.indexOf("async function " + fn + "(");
    const code = src.slice(i, src.indexOf("\n}\n", i));
    for (const l of code.split("\n").filter((x) => /SKIP/.test(x))) assert.match(l, /return skip\(|: skip\(|\? skip\(/, fn + ": " + l.trim());
    assert.doesNotMatch(code, /return summary\(|\n {4}return;\n/, fn);
    assert.match(code, /\n {2}return [^\n]*\bdone\([^\n]*;$/, fn);
  }
  assert.equal(clearOutput(true), "true");
  assert.equal(clearOutput(false), "false");
  assert.equal(clearOutput(undefined), "false");
});

// tags of X.Y.Z may be on different commits (a platform may join later);
// missing platforms are listed.
test("promote check: tags of X.Y.Z may be on different commits, missing platforms listed", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  assert.deepEqual(commitProblems("1.2.3", { android: a, ios: a, chrome: a, firefox: a }), { missing: [] });
  assert.deepEqual(commitProblems("1.2.3", { android: a, ios: null, chrome: a, firefox: null }), { missing: ["ios", "firefox"] });
  assert.deepEqual(commitProblems("1.2.3", { android: a, ios: b, chrome: a, firefox: a }), { missing: [] });
  assert.deepEqual(commitProblems("1.2.3", { android: null, ios: null, chrome: null, firefox: null }).missing, ["android", "ios", "chrome", "firefox"]);
  const src = readFileSync(join(ROOT, "release", "promote.mjs"), "utf8");
  const check = src.slice(src.indexOf("async function check("), src.indexOf("\n}\n", src.indexOf("async function check(")));
  assert.match(check, /commitProblems\(version, /);
});

// the AMO listed version carries reviewer notes from the repo (no
// credentials: the demo account stays in the Developer Hub).
test("AMO listed version: approval notes from store/listing/amo/review_notes.txt", () => {
  assert.equal(relative(ROOT, AMO_REVIEW_NOTES), join("store", "listing", "amo", "review_notes.txt"));
  assert.deepEqual(amoNotesProblems(), []);
  const notes = readFileSync(AMO_REVIEW_NOTES, "utf8");
  assert.match(notes, /Email me a code/);
  assert.match(notes, /reviewer email address\s+given in the Whiteboard/);
  assert.match(notes, /Android app|second Firefox profile/);
  assert.match(notes, /Right-click/);
  assert.doesNotMatch(notes, /password\s*[:=]|@gmail\.com/i);
  const src = readFileSync(join(ROOT, "release", "promote.mjs"), "utf8");
  const ff = src.slice(src.indexOf("async function firefox("), src.indexOf("\n}\n", src.indexOf("async function firefox(")));
  assert.match(ff, /vf\.append\("approval_notes", readFileSync\(AMO_REVIEW_NOTES, "utf8"\)\.trim\(\)\);\n {2}await amo\("POST", "\/addon\/" \+ id \+ "\/versions\/", vf\)/);
  const check = src.slice(src.indexOf("async function check("), src.indexOf("\n}\n", src.indexOf("async function check(")));
  assert.match(check, /\.\.\.amoNotesProblems\(\)/);
});

test("AMO: a refused credential fails with its HTTP status, not as a missing add-on", async (t) => {
  const real = globalThis.fetch;
  const env = { ...process.env };
  t.after(() => {
    globalThis.fetch = real;
    process.env = env;
  });
  process.env.MOZILLA_AMO_JWT_ISSUER = "user:1:2";
  process.env.MOZILLA_AMO_JWT_SECRET = "s";
  for (const status of [401, 403]) {
    globalThis.fetch = async () => new Response('{"detail":"Unauthorized"}', { status });
    await assert.rejects(firefox("0.0.1"), new RegExp("HTTP " + status));
  }
  globalThis.fetch = async () => new Response("{}", { status: 404 });
  await assert.rejects(firefox("0.0.1"), /not on AMO yet/);
});

test("promote runs only the platforms named in the platforms input", () => {
  assert.deepEqual(selectedPlatforms("firefox"), { list: ["firefox"], error: "" });
  assert.deepEqual(selectedPlatforms(" Firefox , chrome,"), { list: ["chrome", "firefox"], error: "" });
  assert.match(selectedPlatforms("").error, /no platform/);
  assert.match(selectedPlatforms(" , ").error, /no platform/);
  assert.match(selectedPlatforms(undefined).error, /no platform/);
  assert.match(selectedPlatforms("firefox,all").error, /unknown platform all/);
  const src = readFileSync(join(ROOT, "release", "promote.mjs"), "utf8");
  const check = src.slice(src.indexOf("async function check("), src.indexOf("\n}\n", src.indexOf("async function check(")));
  assert.match(check, /selectedPlatforms\(process\.env\.PLATFORMS\)/);
  const wf = readFileSync(join(ROOT, ".github", "workflows", "promote.yml"), "utf8");
  const input = wf.slice(wf.indexOf("      platforms:"), wf.indexOf("\npermissions:"));
  assert.match(input, /required: true/);
  assert.doesNotMatch(input, /default:/);
  assert.match(wf, /PLATFORMS: \$\{\{ inputs\.platforms \}\}/);
  for (const p of ["android", "ios", "chrome", "firefox"]) {
    assert.match(wf, new RegExp("\\n {10}" + p.toUpperCase() + ": \\$\\{\\{ needs\\.check\\.outputs\\." + p + " \\}\\}\\n"));
    assert.match(wf, new RegExp('"' + p + ':\\$' + p.toUpperCase() + '"'));
  }
  assert.match(wf, /\[ "\$\{pair#\*:\}" = "true" \] \|\| continue\n/);
});

// The store Environments allow only their own release tags, so promote never
// names them: after the approval it starts store.yml on each platform tag
// (workflow_dispatch with ref <platform>/vX.Y.Z), and only that run gets the
// store secrets. store.yml checks that an approved promote run on main started it.
test("promote starts store.yml on the platform tags and holds no store secret", () => {
  const promote = readFileSync(join(ROOT, ".github", "workflows", "promote.yml"), "utf8");
  const code = promote.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.doesNotMatch(code, /secrets\./);
  assert.doesNotMatch(code, /id-token/);
  assert.deepEqual([...code.matchAll(/environment: (\S+)/g)].map((m) => m[1]), ["promote"]);
  assert.match(code, /\n  dispatch:\n {4}name: .*\n {4}needs: \[check, approve\]\n/);
  assert.match(code, /\n {4}permissions:\n {6}actions: write\n {4}steps:/);
  assert.match(code, /gh workflow run store\.yml --repo "\$GITHUB_REPOSITORY" --ref "\$p\/v\$VERSION" -f version="\$VERSION" -f promote_run="\$GITHUB_RUN_ID"/);
  assert.match(code, /\nrun-name: promote \$\{\{ inputs\.version \}\} \$\{\{ inputs\.platforms \}\}\n/);

  const store = readFileSync(join(ROOT, ".github", "workflows", "store.yml"), "utf8");
  assert.match(store, /\non:\n {2}workflow_dispatch:\n/);
  assert.doesNotMatch(store.slice(store.indexOf("\non:"), store.indexOf("\npermissions:")), /\n {2}(push|schedule|workflow_call|repository_dispatch):/);
  for (const [job, p, env] of [["play", "android", "android-release"], ["appstore", "ios", "ios-release"], ["chrome", "chrome", "chrome-release"], ["firefox", "firefox", "firefox-release"]]) {
    const i = store.indexOf("\n  " + job + ":\n");
    assert.ok(i > 0, job);
    const body = store.slice(i, store.indexOf("\n\n  ", i + 1) > 0 ? store.indexOf("\n\n  ", i + 1) : undefined);
    assert.match(body, new RegExp("\\n {4}needs: gate\\n {4}if: needs\\.gate\\.outputs\\.platform == '" + p + "' && startsWith\\(github\\.ref, 'refs/tags/" + p + "/v'\\)\\n"), job);
    assert.match(body, new RegExp("\\n {4}environment: " + env + "\\n"), job);
    assert.match(body, /\n {10}ref: \$\{\{ needs\.gate\.outputs\.commit \}\}\n/, job);
    assert.match(body, new RegExp("run: node release/promote\\.mjs " + job + " \"\\$VERSION\""), job);
  }
  assert.match(store, /\n  gate:\n(?: {4}.*\n|\n)*? {4}permissions:\n {6}actions: read\n {6}contents: read\n/);
  assert.match(store, /run: node release\/promote\.mjs gate "\$VERSION"/);
});

test("public zips and the Firefox source zip need the build attestation of their release workflow", () => {
  assert.deepEqual(attestationArgs("/t/a.zip", "firefox", "1.2.3", "o/r"), [
    "attestation", "verify", "/t/a.zip", "--repo", "o/r", "--signer-workflow", "o/r/.github/workflows/webext-release.yml", "--source-ref", "refs/tags/firefox/v1.2.3", "--deny-self-hosted-runners",
  ]);
  const src = readFileSync(join(ROOT, "release", "promote.mjs"), "utf8");
  const rf = src.slice(src.indexOf("async function releaseFile("), src.indexOf("\n}\n", src.indexOf("async function releaseFile(")));
  assert.match(rf, /verifyAttestation\(data, platform, version, name\);\n {2}return data;/);
  const ff = src.slice(src.indexOf("async function firefox("), src.indexOf("\n}\n", src.indexOf("async function firefox(")));
  assert.match(ff, /const src = await releaseFile\("firefox", version, "pusharmor-firefox-" \+ version \+ "-source\.zip"\)/);
  // The release workflow attests every file that promote sends.
  const rel = readFileSync(join(ROOT, ".github", "workflows", "webext-release.yml"), "utf8");
  const subjects = [...rel.matchAll(/attest-build-provenance@[0-9a-f]{40}.*\n(?: {8}.*\n)*? {10}subject-path: \|\n((?: {12}.*\n)+)/g)].map((m) => m[1]).join("");
  for (const out of ["steps.files.outputs.zip", "steps.files.outputs.src"]) assert.ok(subjects.includes(out), out);
  const store = readFileSync(join(ROOT, ".github", "workflows", "store.yml"), "utf8");
  for (const job of ["chrome", "firefox"]) {
    const i = store.indexOf("\n  " + job + ":\n");
    const body = store.slice(i, store.indexOf("\n\n  ", i + 1) > 0 ? store.indexOf("\n\n  ", i + 1) : undefined);
    assert.match(body, /\n {6}attestations: read\n/, job);
    assert.match(body, /\n {10}GH_TOKEN: \$\{\{ github\.token \}\}\n {8}run: node release\/promote\.mjs /, job);
  }
});

test("store.yml runs only for the tag of its platform and an approved promote run", () => {
  assert.equal(tagPlatform("refs/tags/firefox/v1.2.3", "1.2.3"), "firefox");
  assert.equal(tagPlatform("refs/tags/android/v1.2.3", "1.2.3"), "android");
  assert.equal(tagPlatform("refs/tags/firefox/v1.2.4", "1.2.3"), "");
  assert.equal(tagPlatform("refs/heads/main", "1.2.3"), "");
  assert.equal(tagPlatform("refs/tags/cli/v1.2.3", "1.2.3"), "");
  const run = { path: ".github/workflows/promote.yml", head_branch: "main", event: "workflow_dispatch", display_title: "promote 1.2.3 chrome, firefox", head_sha: "a".repeat(40), status: "in_progress", created_at: new Date().toISOString() };
  const ok = [{ state: "approved", environments: [{ name: "promote" }] }];
  assert.equal(promoteRunProblem(run, ok, "1.2.3", "firefox"), "");
  assert.match(promoteRunProblem(run, ok, "1.2.3", "android"), /android/);
  assert.match(promoteRunProblem(run, ok, "1.2.4", "firefox"), /1\.2\.4/);
  assert.match(promoteRunProblem({ ...run, display_title: "promote 1.2.3x firefox" }, ok, "1.2.3", "firefox"), /1\.2\.3/);
  assert.match(promoteRunProblem({ ...run, head_branch: "dev" }, ok, "1.2.3", "firefox"), /main/);
  assert.match(promoteRunProblem({ ...run, path: ".github/workflows/store.yml" }, ok, "1.2.3", "firefox"), /promote\.yml/);
  assert.match(promoteRunProblem({ ...run, event: "push" }, ok, "1.2.3", "firefox"), /workflow_dispatch/);
  assert.match(promoteRunProblem(run, [], "1.2.3", "firefox"), /approv/);
  assert.match(promoteRunProblem(run, [{ state: "rejected", environments: [{ name: "promote" }] }], "1.2.3", "firefox"), /approv/);
  assert.match(promoteRunProblem(run, [{ state: "approved", environments: [{ name: "other" }] }], "1.2.3", "firefox"), /approv/);
  assert.match(promoteRunProblem(null, ok, "1.2.3", "firefox"), /no promote run/);
  assert.equal(promoteRunProblem({ ...run, status: "completed", conclusion: "success" }, ok, "1.2.3", "firefox"), "");
  assert.match(promoteRunProblem({ ...run, status: "completed", conclusion: "failure" }, ok, "1.2.3", "firefox"), /failure/);
  assert.match(promoteRunProblem({ ...run, status: "completed", conclusion: "cancelled" }, ok, "1.2.3", "firefox"), /cancelled/);
  const day = 86400000;
  const at = (d) => new Date(Date.parse("2026-01-31T00:00:00Z") - d * day).toISOString();
  const now = Date.parse("2026-01-31T00:00:00Z");
  assert.equal(promoteRunProblem({ ...run, created_at: at(30) }, ok, "1.2.3", "firefox", now), "");
  assert.match(promoteRunProblem({ ...run, created_at: at(31) }, ok, "1.2.3", "firefox", now), /30 days/);
  assert.match(promoteRunProblem({ ...run, created_at: at(-1) }, ok, "1.2.3", "firefox", now), /30 days/);
  assert.match(promoteRunProblem({ ...run, created_at: undefined }, ok, "1.2.3", "firefox", now), /30 days/);
});

// Fake App Store Connect screenshot API. `states` gives, per file name, the
// assetDeliveryState values that successive GETs of that screenshot return
// (the last one repeats).
function fakeAsc(have, states) {
  const shots = new Map(have.map((h) => [h.id, { ...h, polls: 0 }]));
  const calls = [];
  let next = 1;
  const asc = async (method, path, body) => {
    calls.push(method + " " + path);
    let m;
    if (method === "GET" && /\/appScreenshotSets\/set1\/appScreenshots$/.test(path)) {
      return { json: { data: [...shots.values()].map((s) => ({ id: s.id, attributes: { fileName: s.name, sourceFileChecksum: s.sum, assetDeliveryState: { state: s.state } } })) } };
    }
    if (method === "DELETE" && (m = path.match(/^\/v1\/appScreenshots\/(.+)$/))) return shots.delete(m[1]), { json: null };
    if (method === "POST" && path === "/v1/appScreenshots") {
      const id = "new" + next++;
      shots.set(id, { id, name: body.data.attributes.fileName, state: "AWAITING_UPLOAD", polls: 0 });
      return { json: { data: { id, attributes: { uploadOperations: [{ method: "PUT", url: "https://upload.example/" + id, offset: 0, length: body.data.attributes.fileSize }] } } } };
    }
    if (method === "PATCH" && (m = path.match(/^\/v1\/appScreenshots\/(.+)$/))) {
      const s = shots.get(m[1]);
      s.sum = body.data.attributes.sourceFileChecksum;
      s.state = "UPLOAD_COMPLETE";
      return { json: null };
    }
    if (method === "GET" && (m = path.match(/^\/v1\/appScreenshots\/(.+)$/))) {
      const s = shots.get(m[1]);
      const seq = states[s.name] || ["COMPLETE"];
      const state = s.state === "COMPLETE" ? "COMPLETE" : seq[Math.min(s.polls++, seq.length - 1)];
      return { json: { data: { attributes: { assetDeliveryState: { state, errors: state === "FAILED" ? [{ code: "IMAGE_BAD" }] : [] } } } } };
    }
    if (method === "PATCH" && path === "/v1/appScreenshotSets/set1/relationships/appScreenshots") return { json: null };
    throw new Error("unexpected " + method + " " + path);
  };
  const http = async (method, url) => (calls.push(method + " upload"), { json: null });
  return { asc, http, calls, shots };
}

test("App Store screenshots: waits for processing, fails on FAILED, reuses earlier uploads", async () => {
  const md5 = (d) => createHash("md5").update(d).digest("hex");
  const files = ["01-a.png", "02-b.png", "03-c.png"].map((name) => ({ name, data: Buffer.from(name) }));
  let clock = 0;
  const opts = { setId: "set1", shots: files, sleep: async (ms) => void (clock += ms), now: () => clock };

  // UPLOAD_COMPLETE for a while, then COMPLETE: passes.
  let f = fakeAsc([], { "02-b.png": ["UPLOAD_COMPLETE", "UPLOAD_COMPLETE", "UPLOAD_COMPLETE", "COMPLETE"] });
  assert.equal(await syncScreenshots({ ...f, ...opts }), "3 screenshots uploaded, 0 reused");
  assert.equal(f.calls.filter((c) => c === "POST /v1/appScreenshots").length, 3);
  assert.ok(f.calls.includes("PATCH /v1/appScreenshotSets/set1/relationships/appScreenshots"));

  // FAILED: fails with the errors.
  clock = 0;
  f = fakeAsc([], { "02-b.png": ["UPLOAD_COMPLETE", "FAILED"] });
  await assert.rejects(syncScreenshots({ ...f, ...opts }), /02-b\.png: screenshot processing FAILED .*IMAGE_BAD/);

  // Never done: fails after the timeout.
  clock = 0;
  f = fakeAsc([], { "02-b.png": ["UPLOAD_COMPLETE"] });
  await assert.rejects(syncScreenshots({ ...f, ...opts }), /02-b\.png: screenshot still UPLOAD_COMPLETE after 10 minutes/);
  assert.ok(clock >= 10 * 60 * 1000 && clock < 11 * 60 * 1000);

  // Rerun after a failed attempt: matching uploads are kept, a stale or failed
  // one and a duplicate are deleted, only the missing file is uploaded.
  clock = 0;
  f = fakeAsc([
    { id: "old1", name: "01-a.png", sum: md5(files[0].data), state: "COMPLETE" },
    { id: "old2", name: "02-b.png", sum: md5(files[1].data), state: "UPLOAD_COMPLETE" },
    { id: "old3", name: "02-b.png", sum: md5(files[1].data), state: "UPLOAD_COMPLETE" },
    { id: "old4", name: "03-c.png", sum: md5(files[2].data), state: "FAILED" },
  ], { "02-b.png": ["UPLOAD_COMPLETE", "COMPLETE"] });
  assert.equal(await syncScreenshots({ ...f, ...opts }), "1 screenshots uploaded, 2 reused");
  assert.deepEqual([...f.shots.keys()].sort(), ["new1", "old1", "old2"]);
  assert.ok(f.calls.includes("DELETE /v1/appScreenshots/old3") && f.calls.includes("DELETE /v1/appScreenshots/old4"));

  // Nothing to do: no write.
  f = fakeAsc(files.map((s, i) => ({ id: "c" + i, name: s.name, sum: md5(s.data), state: "COMPLETE" })), {});
  assert.equal(await syncScreenshots({ ...f, ...opts }), "screenshots unchanged");
  assert.deepEqual(f.calls.filter((c) => !c.startsWith("GET")), []);
});

test("App Store requests: retried on HTTP 5xx and network errors, not on 4xx", async () => {
  const waits = [];
  const wait = async (ms) => void waits.push(ms);
  let n = 0;
  const flaky = ascRetry(async () => { if (++n < 4) throw new Error("POST https://x/v1/appScreenshots: HTTP 500: boom"); return "ok"; }, wait, () => {});
  assert.equal(await flaky("POST", "/v1/appScreenshots"), "ok");
  assert.deepEqual(waits, [5000, 15000, 45000]);
  n = -10;
  await assert.rejects(ascRetry(async () => { throw new Error("POST u: HTTP 503: x"); }, wait, () => {})("POST", "/p"), /HTTP 503/);
  let net = 0;
  assert.equal(await ascRetry(async () => { if (net++ < 1) throw new TypeError("fetch failed"); return "ok"; }, wait, () => {})("GET", "/p"), "ok");
  let c = 0;
  await assert.rejects(ascRetry(async () => { c++; throw new Error("GET u: HTTP 409: x"); }, wait, () => {})("GET", "/p"), /HTTP 409/);
  assert.equal(c, 1);
});

test("App Store screenshots: a run that dies midway resumes and uploads only the missing files", async () => {
  const files = ["01-a.png", "02-b.png", "03-c.png"].map((name) => ({ name, data: Buffer.from(name) }));
  const opts = { setId: "set1", shots: files, sleep: async () => {}, now: () => 0 };
  let f = fakeAsc([], {});
  let posts = 0;
  const dying = async (m, p, b) => { if (m === "POST" && p === "/v1/appScreenshots" && ++posts === 3) throw new Error("POST u: HTTP 500: boom"); return f.asc(m, p, b); };
  await assert.rejects(syncScreenshots({ ...opts, asc: dying, http: f.http }), /HTTP 500/);
  assert.equal(f.shots.size, 2);
  f.calls.length = 0;
  assert.equal(await syncScreenshots({ ...opts, asc: f.asc, http: f.http }), "1 screenshots uploaded, 2 reused");
  assert.equal(f.calls.filter((c) => c === "POST /v1/appScreenshots").length, 1);
  assert.equal(f.calls.filter((c) => c.startsWith("DELETE")).length, 0);
});

test("AMO previews: every screenshot is uploaded in order before the old previews are deleted", async () => {
  const calls = [];
  const amo = async (method, path, body) => {
    calls.push([method, path, body instanceof FormData ? [body.get("image").name, body.get("position")] : undefined]);
    if (method === "GET") return { json: { previews: [{ id: 7, position: 0 }, { id: 9, position: 1 }] } };
    if (method === "POST" && path.endsWith("/previews/") && body.get("image").name === "fail.png") throw new Error("HTTP 400");
    return { json: {} };
  };
  const shots = [{ name: "01-a.png", data: Buffer.from("a") }, { name: "02-b.png", data: Buffer.from("b") }];
  assert.equal(await syncAmoPreviews({ amo, id: "x", shots, wait: async () => {} }), "2 previews uploaded, 2 old previews removed");
  assert.deepEqual(calls, [
    ["GET", "/addon/x/", undefined],
    ["POST", "/addon/x/previews/", ["01-a.png", "0"]],
    ["POST", "/addon/x/previews/", ["02-b.png", "1"]],
    ["DELETE", "/addon/x/previews/7/", undefined],
    ["DELETE", "/addon/x/previews/9/", undefined],
  ]);
  calls.length = 0;
  await assert.rejects(syncAmoPreviews({ amo, id: "x", shots: [shots[0], { name: "fail.png", data: Buffer.from("c") }], wait: async () => {} }), /HTTP 400/);
  assert.ok(!calls.some((c) => c[0] === "DELETE"), "old previews deleted after a failed upload");
});

function fakeAmoListing(previews) {
  const calls = [];
  const amo = async (method, path, body) => {
    calls.push(method + " " + path.replace("/addon/x/previews/", "").replace("/addon/x/", "") + (body instanceof FormData ? " " + body.get("position") : ""));
    return { json: method === "GET" ? { previews } : {} };
  };
  return { amo, calls };
}
const twoShots = [{ name: "01-a.png", data: Buffer.from("a") }, { name: "02-b.png", data: Buffer.from("b") }];

test("AMO previews: a listing already holding the new set only deletes the old previews", async () => {
  const f = fakeAmoListing([{ id: 5, position: 0 }, { id: 6, position: 1 }, { id: 20, position: 0 }, { id: 21, position: 1 }]);
  assert.match(await syncAmoPreviews({ amo: f.amo, id: "x", shots: twoShots, wait: async () => assert.fail("slept") }), /2 old previews removed/);
  assert.deepEqual(f.calls, ["GET ", "DELETE 5/", "DELETE 6/"]);
  // exactly the set: nothing newer or older, so it is replaced as usual
  const g = fakeAmoListing([{ id: 20, position: 0 }, { id: 21, position: 1 }]);
  await syncAmoPreviews({ amo: g.amo, id: "x", shots: twoShots, wait: async () => {} });
  assert.equal(g.calls.filter((c) => c.startsWith("POST")).length, 2);
});

test("AMO previews: a clean listing uploads the set 15 s apart", async () => {
  const f = fakeAmoListing([]);
  const waits = [];
  assert.equal(await syncAmoPreviews({ amo: f.amo, id: "x", shots: twoShots, wait: async (ms) => void waits.push(ms) }), "2 previews uploaded, 0 old previews removed");
  assert.deepEqual(f.calls, ["GET ", "POST  0", "POST  1"]);
  assert.deepEqual(waits, [15000]);
});

test("AMO previews: a partial newest set is not trusted and the full set is uploaded", async () => {
  const f = fakeAmoListing([{ id: 5, position: 0 }, { id: 6, position: 1 }, { id: 20, position: 0 }]);
  await syncAmoPreviews({ amo: f.amo, id: "x", shots: twoShots, wait: async () => {} });
  assert.deepEqual(f.calls, ["GET ", "POST  0", "POST  1", "DELETE 5/", "DELETE 6/", "DELETE 20/"]);
});

test("AMO previews: HTTP 429 waits through the injected sleep and the sync completes", async () => {
  const waits = [];
  let throttled = 1;
  const f = fakeAmoListing([]);
  const amo = amoRetry(async (m, p, b) => {
    if (m === "POST" && throttled-- > 0) throw new Error("POST: HTTP 429: Expected available in 3 seconds");
    return f.amo(m, p, b);
  }, async (ms) => void waits.push(ms));
  await syncAmoPreviews({ amo, id: "x", shots: twoShots, wait: async (ms) => void waits.push(ms) });
  assert.deepEqual(waits, [5000, 15000]);
  assert.deepEqual(f.calls, ["GET ", "POST  0", "POST  1"]);
});

test("the Firefox store job sends store/screenshots/amo as the AMO previews", () => {
  const src = readFileSync(join(ROOT, "release", "promote.mjs"), "utf8");
  const ff = src.slice(src.indexOf("async function firefox("), src.indexOf("\n}\n", src.indexOf("async function firefox(")));
  assert.match(ff, /syncAmoPreviews\(\{ amo, id, shots: screenshotFiles\("amo"\) \}\)/);
  assert.equal((ff.match(/await previews\(\)/g) || []).length, 2);
  assert.ok(readdirSync(join(ROOT, "store", "screenshots", "amo", "en-US")).filter((f) => f.endsWith(".png")).length > 0);
});

test("AMO calls wait the named time plus 2 s and retry on HTTP 429, at most 5 times", async () => {
  const waits = [];
  let n = 0;
  const amo = amoRetry(async () => {
    if (n++ < 1) throw new Error('POST /x: HTTP 429: {"detail":"Request was throttled. Expected available in 56 seconds."}');
    return { status: 201 };
  }, async (ms) => void waits.push(ms));
  assert.equal((await amo("POST", "/x")).status, 201);
  assert.deepEqual(waits, [58000]);
  waits.length = 0;
  n = 0;
  const always = amoRetry(async () => (n++, Promise.reject(new Error("GET /x: HTTP 429: {}"))), async (ms) => void waits.push(ms));
  await assert.rejects(always("GET", "/x"), /HTTP 429/);
  assert.equal(n, 6);
  assert.deepEqual(waits, [62000, 62000, 62000, 62000, 62000]);
  const other = amoRetry(async () => { throw new Error("HTTP 400"); }, async () => assert.fail("slept"));
  await assert.rejects(other("GET", "/x"), /HTTP 400/);
});

test("AMO: a throttled call and every preview action log a progress line", async () => {
  const lines = [];
  let n = 0;
  const amo = amoRetry(async () => {
    if (n++ < 1) throw new Error("DELETE /x: HTTP 429: Expected available in 56 seconds");
    return { json: {} };
  }, async () => {}, (l) => lines.push(l));
  await amo("DELETE", "/addon/x/previews/5/");
  assert.deepEqual(lines, ["AMO throttled DELETE /addon/x/previews/5/, waiting 58 s (retry 1 of 5)"]);
  lines.length = 0;
  const f = fakeAmoListing([{ id: 5, position: 0 }, { id: 20, position: 0 }, { id: 21, position: 1 }]);
  await syncAmoPreviews({ amo: f.amo, id: "x", shots: twoShots, wait: async () => {}, log: (l) => lines.push(l) });
  assert.deepEqual(lines, ["AMO previews: 3 on the listing, 2 screenshots", "AMO previews: the newest 2 are the screenshots, nothing to upload", "AMO previews: deleting preview 5"]);
  lines.length = 0;
  await syncAmoPreviews({ amo: fakeAmoListing([]).amo, id: "x", shots: twoShots, wait: async () => {}, log: (l) => lines.push(l) });
  assert.deepEqual(lines, ["AMO previews: 0 on the listing, 2 screenshots", "AMO previews: uploading 01-a.png at position 0", "AMO previews: waiting 15 s before the next upload", "AMO previews: uploading 02-b.png at position 1"]);
});

test("AMO: a request with no answer in the timeout fails instead of hanging", async (t) => {
  const real = globalThis.fetch;
  t.after(() => (globalThis.fetch = real));
  globalThis.fetch = (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  await assert.rejects(http("GET", "https://amo.test/addon/x/?t=secret", { timeout: 50 }), /^Error: GET https:\/\/amo\.test\/addon\/x\/: no answer in 0\.05 s$/);
  const src = readFileSync(join(ROOT, "release", "promote.mjs"), "utf8");
  assert.match(src, /const AMO_TIMEOUT_MS = 60000;/);
  assert.match(src, /body, ok, timeout: AMO_TIMEOUT_MS \}\)\)/);
});

/** Fake App Store Connect for appstore(): app, a valid build of the version,
 *  the given IOS appStoreVersions, and listing, screenshots, review detail and
 *  review submission as already in place. Returns the recorded calls. */
function fakeAscApi(t, versions) {
  const real = globalThis.fetch;
  const env = { ...process.env };
  t.after(() => {
    globalThis.fetch = real;
    process.env = env;
  });
  delete process.env.GITHUB_STEP_SUMMARY;
  process.env.ASC_API_KEY_P8 = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" });
  process.env.ASC_API_KEY_ID = "KEY";
  process.env.ASC_API_ISSUER_ID = "ISSUER";
  const md5 = (d) => createHash("md5").update(d).digest("hex");
  const shots = screenshotFiles("appstore").map((f) => ({ id: "shot-" + f.name, attributes: { fileName: f.name, sourceFileChecksum: md5(f.data), assetDeliveryState: { state: "COMPLETE" } } }));
  const routes = [
    ["GET", /^\/v1\/apps\?/, { data: [{ id: "app1", attributes: { bundleId: "com.pusharmor.app" } }] }],
    ["GET", /^\/v1\/builds\?/, { data: [{ id: "build-new", attributes: { processingState: "VALID", expired: false, usesNonExemptEncryption: false } }] }],
    ["GET", /^\/v1\/apps\/app1\/appStoreVersions\?/, { data: versions }],
    ["POST", /^\/v1\/appStoreVersions$/, { data: { id: "v-created" } }],
    ["GET", /^\/v1\/appStoreVersions\/[^/]+\/appStoreVersionLocalizations$/, { data: [{ id: "loc1", attributes: { locale: "en-US" } }] }],
    ["GET", /^\/v1\/apps\/app1\/appInfos$/, { data: [{ id: "info1", attributes: { state: "PREPARE_FOR_SUBMISSION" } }] }],
    ["GET", /^\/v1\/appInfos\/info1\/appInfoLocalizations$/, { data: [{ id: "il1", attributes: { locale: "en-US" } }] }],
    ["GET", /^\/v1\/appStoreVersionLocalizations\/loc1\/appScreenshotSets$/, { data: [{ id: "set1", attributes: { screenshotDisplayType: IOS_SCREENSHOT_TYPE } }] }],
    ["GET", /^\/v1\/appScreenshotSets\/set1\/appScreenshots$/, { data: shots }],
    ["GET", /^\/v1\/appScreenshots\//, { data: { attributes: { assetDeliveryState: { state: "COMPLETE" } } } }],
    ["GET", /^\/v1\/appStoreVersions\/[^/]+\/appStoreReviewDetail$/, { data: { id: "rd1" } }],
    ["GET", /^\/v1\/reviewSubmissions\?/, { data: [] }],
    ["POST", /^\/v1\/reviewSubmissions$/, { data: { id: "sub1" } }],
    ["GET", /^\/v1\/reviewSubmissions\/sub1\/items/, { data: [] }],
    ["PATCH", /./, {}],
    ["POST", /^\/v1\/reviewSubmissionItems$/, {}],
  ];
  const calls = [];
  globalThis.fetch = async (url, { method, body }) => {
    const path = url.replace("https://api.appstoreconnect.apple.com", "");
    calls.push({ method, path, body: body === undefined ? undefined : JSON.parse(body) });
    const r = routes.find(([m, re]) => m === method && re.test(path));
    if (!r) throw new Error("fake ASC: unexpected " + method + " " + path);
    return new Response(JSON.stringify(r[2]), { status: 200 });
  };
  return calls;
}
const ascVersion = (id, versionString, state) => ({ id, attributes: { versionString, appVersionState: state, platform: "IOS" } });

test("App Store: an unsubmitted editable version takes the new version string and build; no second version is created", async (t) => {
  for (const state of ["PREPARE_FOR_SUBMISSION", "READY_FOR_REVIEW", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"]) {
    const calls = fakeAscApi(t, [ascVersion("v-live", "0.0.20", "READY_FOR_DISTRIBUTION"), ascVersion("v-old", "0.0.26", state)]);
    assert.equal(await appstore("0.0.29"), true, state);
    assert.equal(calls.filter((c) => c.method === "POST" && c.path === "/v1/appStoreVersions").length, 0, state);
    const patch = calls.find((c) => c.method === "PATCH" && c.path === "/v1/appStoreVersions/v-old");
    assert.equal(patch?.body.data.attributes.versionString, "0.0.29", state);
    const build = calls.find((c) => c.path === "/v1/appStoreVersions/v-old/relationships/build");
    assert.deepEqual(build?.body, { data: { type: "builds", id: "build-new" } }, state);
    assert.ok(calls.findIndex((c) => c === patch) < calls.findIndex((c) => c === build), state);
    assert.ok(!calls.some((c) => c.method === "PATCH" && c.path === "/v1/appStoreVersions/v-live"), state);
  }
});

test("App Store: a new version is created when none is editable; a version with the right string is kept", async (t) => {
  let calls = fakeAscApi(t, [ascVersion("v-live", "0.0.20", "READY_FOR_DISTRIBUTION")]);
  assert.equal(await appstore("0.0.29"), true);
  const post = calls.filter((c) => c.method === "POST" && c.path === "/v1/appStoreVersions");
  assert.equal(post.length, 1);
  assert.equal(post[0].body.data.attributes.versionString, "0.0.29");
  assert.ok(calls.some((c) => c.path === "/v1/appStoreVersions/v-created/relationships/build"));

  calls = fakeAscApi(t, [ascVersion("v-same", "0.0.29", "PREPARE_FOR_SUBMISSION")]);
  assert.equal(await appstore("0.0.29"), true);
  assert.ok(!calls.some((c) => c.method === "POST" && c.path === "/v1/appStoreVersions"));
  assert.equal(calls.find((c) => c.method === "PATCH" && c.path === "/v1/appStoreVersions/v-same")?.body.data.attributes.versionString, "0.0.29");
  assert.ok(calls.some((c) => c.path === "/v1/appStoreVersions/v-same/relationships/build"));

  calls = fakeAscApi(t, [ascVersion("v-review", "0.0.29", "WAITING_FOR_REVIEW")]);
  assert.equal(await appstore("0.0.29"), true);
  assert.ok(!calls.some((c) => c.method !== "GET"));
});

test("App Store submit never writes the App Review notes", () => {
  const src = readFileSync(join(ROOT, "release", "promote.mjs"), "utf8");
  assert.doesNotMatch(src, /appStoreReviewDetails/);
  assert.doesNotMatch(src, /want\.review_notes/);
  assert.ok(!readdirSync(join(ROOT, "store", "listing", "appstore", "en-US")).includes("review_notes.txt"));
});

test("Play sync replaces the 512 icon from the F-Droid metadata file", () => {
  const src = readFileSync(join(ROOT, "release", "promote.mjs"), "utf8");
  assert.equal(relative(ROOT, PLAY_ICON), join("release", "fdroid", "metadata", "com.pusharmor", "en-US", "icon.png"));
  assert.match(src, /"\/icon\?uploadType=media"/);
  const png = readFileSync(PLAY_ICON);
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 512);
});

test("App Store: whatsNew is sent for an update and left out for a first version", async (t) => {
  const want = readListing("appstore").whats_new;
  assert.ok(want.length > 0);
  let calls = fakeAscApi(t, [ascVersion("v-live", "0.0.20", "READY_FOR_DISTRIBUTION")]);
  await appstore("0.0.29");
  const patch = calls.find((c) => c.method === "PATCH" && c.path === "/v1/appStoreVersionLocalizations/loc1");
  assert.equal(patch.body.data.attributes.whatsNew, want);
  assert.ok(calls.findIndex((c) => c === patch) < calls.findIndex((c) => c.path === "/v1/reviewSubmissionItems"));
  calls = fakeAscApi(t, [ascVersion("v-first", "0.0.28", "PREPARE_FOR_SUBMISSION")]);
  await appstore("0.0.29");
  const first = calls.find((c) => c.method === "PATCH" && c.path === "/v1/appStoreVersionLocalizations/loc1");
  assert.ok(!("whatsNew" in first.body.data.attributes));
});

test("Play production release carries the What's New text", () => {
  const src = readFileSync(join(ROOT, "release", "promote.mjs"), "utf8");
  assert.match(src, /releaseNotes: \[\{ language: LOCALE, text: readListing\("play"\)\.whats_new \}\]/);
  assert.ok(readListing("play").whats_new.length <= 500);
});
