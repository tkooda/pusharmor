// Promote workflow and its helper (owner rulings Q241 A, Q242 A).
// Run: node --test release/promote.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { amoToken, ascToken, cmpVersion, contactProblems, listingProblems, readListing, releaseAssets, releaseProblem } from "./promote.mjs";

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
    for (const x of perms) assert.match(x, /^(contents: read|id-token: write)$/, name + ": " + x);
  }
  assert.match(jobs.get("approve"), /permissions: \{\}/);
  for (const j of ["appstore", "firefox"]) assert.doesNotMatch(jobs.get(j), /id-token/, j);
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
  // App Review contact details and the demo account stay console-only.
  assert.doesNotMatch(src, /contact(FirstName|LastName|Phone|Email)|demoAccount/);
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
