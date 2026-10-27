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
