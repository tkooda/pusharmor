// Promote helper (owner rulings Q241 A, Q242 A).
// Run: node --test release/promote.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { AMO_REVIEW_NOTES, amoNotesProblems, amoToken, ascToken, clearOutput, cmpVersion, commitProblems, contactProblems, listingProblems, playGateProblem, readListing, releaseAssets, releaseProblem } from "./promote.mjs";

const ROOT = join(import.meta.dirname, "..");

// I414, I442 and owner ruling Q251: Play production needs both repository
// variables PLAY_CONTACT_OK and PLAY_PUBLIC_OK set to yes.
test("Play is gated on PLAY_CONTACT_OK and PLAY_PUBLIC_OK (I414, I442, Q251)", () => {
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
