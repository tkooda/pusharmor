// Promote helper.
// Run: node --test release/promote.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { AMO_REVIEW_NOTES, amoNotesProblems, amoToken, ascToken, attestationArgs, clearOutput, cmpVersion, commitProblems, contactProblems, listingProblems, playGateProblem, readListing, releaseAssets, firefox, promoteRunProblem, releaseProblem, selectedPlatforms, syncAmoPreviews, syncScreenshots, tagPlatform } from "./promote.mjs";

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
  assert.match(releaseProblem("chrome", "1.2.3", true, rel(["pusharmor-chrome-1.2.3.zip"])), /lacks pusharmor-chrome-1\.2\.3\.hashes\.txt/);
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

// each platform has its own stamp commit: tags of X.Y.Z may differ in commit;
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
  assert.match(notes, /Continue with Google/);
  assert.match(notes, /demo account given in the Developer Hub/);
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

test("AMO previews: every screenshot is uploaded in order before the old previews are deleted", async () => {
  const calls = [];
  const amo = async (method, path, body) => {
    calls.push([method, path, body instanceof FormData ? [body.get("image").name, body.get("position")] : undefined]);
    if (method === "GET") return { json: { previews: [{ id: 7 }, { id: 9 }] } };
    if (method === "POST" && path.endsWith("/previews/") && body.get("image").name === "fail.png") throw new Error("HTTP 400");
    return { json: {} };
  };
  const shots = [{ name: "01-a.png", data: Buffer.from("a") }, { name: "02-b.png", data: Buffer.from("b") }];
  assert.equal(await syncAmoPreviews({ amo, id: "x", shots }), "2 previews uploaded, 2 old previews removed");
  assert.deepEqual(calls, [
    ["GET", "/addon/x/", undefined],
    ["POST", "/addon/x/previews/", ["01-a.png", "0"]],
    ["POST", "/addon/x/previews/", ["02-b.png", "1"]],
    ["DELETE", "/addon/x/previews/7/", undefined],
    ["DELETE", "/addon/x/previews/9/", undefined],
  ]);
  calls.length = 0;
  await assert.rejects(syncAmoPreviews({ amo, id: "x", shots: [shots[0], { name: "fail.png", data: Buffer.from("c") }] }), /HTTP 400/);
  assert.ok(!calls.some((c) => c[0] === "DELETE"), "old previews deleted after a failed upload");
});

test("the Firefox store job sends store/screenshots/amo as the AMO previews", () => {
  const src = readFileSync(join(ROOT, "release", "promote.mjs"), "utf8");
  const ff = src.slice(src.indexOf("async function firefox("), src.indexOf("\n}\n", src.indexOf("async function firefox(")));
  assert.match(ff, /syncAmoPreviews\(\{ amo, id, shots: screenshotFiles\("amo"\) \}\)/);
  assert.equal((ff.match(/await previews\(\)/g) || []).length, 2);
  assert.ok(readdirSync(join(ROOT, "store", "screenshots", "amo", "en-US")).filter((f) => f.endsWith(".png")).length > 0);
});
