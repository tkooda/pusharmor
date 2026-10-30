// Promote workflow and its helper (owner rulings Q241 A, Q242 A).
// Run: node --test release/promote.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { AMO_REVIEW_NOTES, amoNotesProblems, amoToken, ascToken, clearOutput, cmpVersion, commitProblems, contactProblems, listingProblems, playGateProblem, readListing, releaseAssets, releaseProblem } from "./promote.mjs";

const ROOT = join(import.meta.dirname, "..");
const WF = join(ROOT, ".github", "workflows");
const wf = readFileSync(join(WF, "promote.yml"), "utf8");
const jobs = new Map(
  wf
    .slice(wf.search(/^jobs:\n/m))
    .split(/^ {2}(?=[a-z0-9-]+:\n)/m)
    .slice(1)
    .map((b) => [b.split(":")[0], b]),
);
const STORE_JOBS = ["play", "appstore", "chrome", "firefox"];

test("promote runs on manual dispatch only, from main", () => {
  const on = wf.slice(wf.indexOf("\non:\n"), wf.indexOf("\npermissions:"));
  assert.match(on, /^\non:\n {2}workflow_dispatch:\n/);
  assert.doesNotMatch(on, /\n {2}(push|pull_request|pull_request_target|schedule|workflow_run|release|repository_dispatch):/);
  assert.match(jobs.get("check"), /if: github\.ref == 'refs\/heads\/main'/);
  // The input reaches scripts only through env, never pasted into a run line.
  assert.match(wf, /\nenv:\n {2}VERSION: \$\{\{ inputs\.version \}\}\n/);
  for (const line of wf.split("\n").filter((l) => /^\s+run:/.test(l) || /^\s{10,}\S/.test(l))) assert.doesNotMatch(line, /\$\{\{ (inputs|github\.event)\./, line);
});

test("every action is pinned to a full commit SHA", () => {
  const uses = [...wf.matchAll(/uses: (\S+)(.*)/g)];
  assert.ok(uses.length > 0);
  for (const [, ref, rest] of uses) {
    assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, ref);
    assert.match(rest, /^ # v\d/, ref);
  }
});

test("minimal permissions: none at the top, each job lists its own", () => {
  assert.match(wf, /\npermissions: \{\}\n/);
  for (const [name, b] of jobs) {
    const p = /\n {4}permissions:(.*)\n((?: {6}.*\n)*)/.exec(b);
    assert.ok(p, name + ": no permissions block");
    const perms = p[1].trim() === "{}" ? [] : p[2].trim().split("\n").map((l) => l.trim());
    for (const x of perms) assert.match(x, /^(contents: read|contents: write|id-token: write)$/, name + ": " + x);
  }
  assert.match(jobs.get("approve"), /permissions: \{\}/);
  for (const j of ["appstore", "firefox"]) assert.doesNotMatch(jobs.get(j), /id-token/, j);
});

test("each store job clears its own prerelease flag as its last step", () => {
  const tags = { play: "android", appstore: "ios", chrome: "chrome", firefox: "firefox" };
  for (const [j, t] of Object.entries(tags)) {
    const b = jobs.get(j);
    assert.match(b, /\n {4}permissions:\n {6}contents: write\n/, j);
    assert.match(b, new RegExp("run: gh release edit \"" + t + "/v\\$VERSION\" --repo \"\\$GITHUB_REPOSITORY\" --prerelease=false\\n*$"), j);
    assert.doesNotMatch(b, /\n {6}- (if|continue-on-error)/, j);
    // I438: the clear step runs only when promote.mjs reports that this
    // version was promoted now or is live or in review at that version.
    assert.match(b, /\n {6}- id: promote\n {8}name: [^\n]+\n(?: {8}.*\n| {10}.*\n)* {8}run: node release\/promote\.mjs \w+ "\$VERSION"\n/, j);
    assert.match(b, /\n {6}- name: Clear the GitHub prerelease flag\n {8}if: steps\.promote\.outputs\.clear_prerelease == 'true'\n/, j);
  }
  for (const j of ["check", "approve"]) assert.doesNotMatch(jobs.get(j), /contents: write/, j);
});

test("every store job waits for the owner approval in Environment promote", () => {
  const a = jobs.get("approve");
  assert.match(a, /\n {4}environment: promote\n/);
  assert.match(a, /\n {4}needs: check\n/);
  for (const j of STORE_JOBS) {
    const b = jobs.get(j);
    assert.ok(b, j);
    assert.match(b, /\n {4}needs: \[check, approve\]\n/, j);
    assert.match(b, /\n {4}environment: (android|ios|chrome|firefox)-release\n/, j);
  }
  assert.deepEqual([...jobs.keys()].sort(), ["approve", "check", ...STORE_JOBS].sort());
});

test("each store job skips a platform without tag and prerelease", () => {
  const out = { play: "android", appstore: "ios", chrome: "chrome", firefox: "firefox" };
  for (const j of STORE_JOBS) assert.match(jobs.get(j), new RegExp("\\n {4}if: needs\\.check\\.outputs\\." + out[j] + " == 'true'\\n"), j);
});

// I414, I442 and owner ruling Q251: Play production needs both repository
// variables PLAY_CONTACT_OK and PLAY_PUBLIC_OK set to yes. The check job tests
// them BEFORE the owner approval (Play shows BLOCKED and its job is skipped);
// the play job and promote.mjs test them again.
test("Play is gated on PLAY_CONTACT_OK and PLAY_PUBLIC_OK before the approval (I414, I442, Q251)", () => {
  const vars = /PLAY_CONTACT_OK: \$\{\{ vars\.PLAY_CONTACT_OK \}\}\n {10}PLAY_PUBLIC_OK: \$\{\{ vars\.PLAY_PUBLIC_OK \}\}\n/;
  const c = jobs.get("check");
  assert.match(c, vars);
  assert.match(c, /\n {8}run: node release\/promote\.mjs check "\$VERSION"\n/);
  const b = jobs.get("play");
  const steps = b.split(/\n {6}- /).slice(1);
  assert.match(steps[0], /^name: Play contact details and public release allowed\n/);
  assert.match(steps[0], vars);
  assert.match(steps[0], /if \[ "\$PLAY_CONTACT_OK" != "yes" \] \|\| \[ "\$PLAY_PUBLIC_OK" != "yes" \]; then\n[^\n]*\n {12}exit 1\n/);
  assert.match(b, /TOKEN: \$\{\{ steps\.auth\.outputs\.access_token \}\}\n {10}PLAY_CONTACT_OK: \$\{\{ vars\.PLAY_CONTACT_OK \}\}\n {10}PLAY_PUBLIC_OK: \$\{\{ vars\.PLAY_PUBLIC_OK \}\}\n {8}run: node release\/promote\.mjs play/);
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

test("secrets reach only their own store job and are never echoed", () => {
  const own = { appstore: /secrets\.ASC_API_(KEY_P8|KEY_ID|ISSUER_ID)/g, firefox: /secrets\.MOZILLA_AMO_JWT_(ISSUER|SECRET)/g };
  for (const [name, b] of jobs) {
    const all = b.match(/secrets\.\w+/g) || [];
    const ok = own[name] ? b.match(own[name]) || [] : [];
    assert.equal(all.length, ok.length, name + " uses another job's secret");
  }
  assert.doesNotMatch(wf, /(echo|printf|cat)\b[^\n]*(secrets\.|\$TOKEN|\$ASC_|\$MOZILLA_)/);
  assert.doesNotMatch(wf, /set -x/);
  const src = readFileSync(join(ROOT, "release", "promote.mjs"), "utf8");
  assert.doesNotMatch(src, /console\.(log|error)\([^)]*(TOKEN|ASC_API_KEY|AMO_JWT|keyP8|secret)/);
});

test("only promote.yml and the release workflows use the release Environments", () => {
  for (const f of readdirSync(WF)) {
    const t = readFileSync(join(WF, f), "utf8");
    const envs = [...t.matchAll(/environment: ([\w-]+)/g)].map((m) => m[1]);
    if (!envs.length) continue;
    assert.ok(/-release\.yml$/.test(f) || f === "promote.yml", f + " uses " + envs.join(", "));
  }
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

// I438: a SKIP (the store has a newer version, or the same version in another
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

// I439: every tag of X.Y.Z must point at one commit; missing platforms are listed.
test("promote check: all tags of X.Y.Z on one commit, missing platforms listed", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  assert.deepEqual(commitProblems("1.2.3", { android: a, ios: a, chrome: a, firefox: a }), { error: "", missing: [] });
  assert.deepEqual(commitProblems("1.2.3", { android: a, ios: null, chrome: a, firefox: null }), { error: "", missing: ["ios", "firefox"] });
  const r = commitProblems("1.2.3", { android: a, ios: b, chrome: a, firefox: a });
  assert.match(r.error, /^tags of 1\.2\.3 are on different commits: /);
  assert.match(r.error, /android\/v1\.2\.3 aaaaaaaaaaaa/);
  assert.match(r.error, /ios\/v1\.2\.3 bbbbbbbbbbbb/);
  assert.deepEqual(commitProblems("1.2.3", { android: null, ios: null, chrome: null, firefox: null }).missing, ["android", "ios", "chrome", "firefox"]);
  const src = readFileSync(join(ROOT, "release", "promote.mjs"), "utf8");
  const check = src.slice(src.indexOf("async function check("), src.indexOf("\n}\n", src.indexOf("async function check(")));
  assert.match(check, /commitProblems\(version, /);
  assert.match(check, /if \(same\.error\) throw new Error\(same\.error\)/);
});

// I440: the AMO listed version carries reviewer notes from the repo (no
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
