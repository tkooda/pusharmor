// Release workflows upload to test channels only (owner ruling Q209 B): every
// GitHub release is a prerelease, never a draft, and a promoted release is never
// changed. Run: node --test release/release-workflows.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WF = join(import.meta.dirname, "..", ".github", "workflows");
const read = (f) => readFileSync(join(WF, f), "utf8");

test("release workflows create prereleases only and refuse a promoted release", () => {
  for (const f of ["android-release.yml", "ios-release.yml", "webext-release.yml"]) {
    const wf = read(f);
    assert.doesNotMatch(wf, /--draft/, f);
    const creates = wf.match(/gh release create .*/g) ?? [];
    assert.ok(creates.length > 0, f);
    for (const c of creates) assert.match(c, /--prerelease --verify-tag/, f);
    assert.match(wf, /--jq '\.isPrerelease or \.isDraft'/, f);
    assert.match(wf, /refusing to change its assets/, f);
  }
});

test("each release workflow runs on its <platform>/v* tags and checks the tag first", () => {
  for (const [f, platforms] of [["android-release.yml", ["android"]], ["ios-release.yml", ["ios"]], ["webext-release.yml", ["chrome", "firefox"]], ["worker-release.yml", ["worker"]]]) {
    const wf = read(f);
    const tags = [...wf.matchAll(/^ {6}- "([a-z]+)\/v\*"$/gm)].map((m) => m[1]);
    assert.deepEqual(tags, platforms, f);
    assert.match(wf, /^ {2}tag:\n/m, f);
    assert.match(wf, /run: node release\/tag\.mjs --check "\$TAG"/, f);
    // ci-ok gate (owner ruling Q215 C) in the tag job, after the git-only --check.
    const job = wf.slice(wf.indexOf("\n  tag:\n"), wf.indexOf("\n  vectors:\n"));
    assert.match(job, /^ {4}timeout-minutes: 45\n {4}permissions:\n {6}contents: read\n {6}actions: read\n/m, f);
    assert.match(job, /GH_TOKEN: \$\{\{ github\.token \}\}\n {8}run: node release\/tag\.mjs --ci "\$TAG"\n/, f);
    assert.ok(job.indexOf("--check") < job.indexOf("--ci"), f);
    assert.match(wf, /^ {2}vectors:\n {4}needs: tag$/m, f);
  }
});

test("the Play upload stays on the internal track; iOS uploads to App Store Connect without a review submission", () => {
  const android = read("android-release.yml");
  assert.match(android, /track: "internal"/);
  assert.doesNotMatch(android, /production|"beta"|"alpha"/);
  const ios = read("ios-release.yml");
  assert.doesNotMatch(ios, /appStoreVersionSubmissions|reviewSubmissions|betaAppReviewSubmissions/);
});

test("collect picks the tag of the version the store serves now, not the newest tag", () => {
  const wf = read("collect.yml");
  assert.doesNotMatch(wf, /sort -V|tail -n 1/);
  const store = wf.indexOf("id: store");
  const find = wf.indexOf("id: find");
  assert.ok(store > 0 && find > store);
  assert.match(wf, /\.current_version\.version/);
  assert.match(wf, /\.current_version\.file\.url/);
  assert.match(wf, /read\("manifest\.json"\)\)\.get\("version"/);
  assert.match(wf, /tag="\$BROWSER\/v\$VERSION"/);
  assert.match(wf, /VERSION: \$\{\{ steps\.store\.outputs\.version \}\}/);
});

test("attest steps are skipped while the repo is private", () => {
  for (const f of ["android-release.yml", "ios-release.yml", "webext-release.yml"]) {
    const wf = read(f);
    const steps = [...wf.matchAll(/^( +)- uses: actions\/attest-build-provenance@.*\n((?:\1  .*\n)+)/gm)];
    assert.ok(steps.length > 0, f);
    for (const s of steps) assert.match(s[2], /^ +if: \$\{\{ !github\.event\.repository\.private \}\}$/m, f);
    assert.doesNotMatch(wf, /steps\.attest/, f);
  }
});
