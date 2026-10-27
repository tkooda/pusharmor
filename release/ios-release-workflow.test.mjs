// ios-release.yml: SwiftPM packages, setup-node and repo node scripts never share
// a job with a GitHub Environment, its secrets or id-token.
// Run: node --test release/ios-release-workflow.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const wf = readFileSync(join(REPO, ".github", "workflows", "ios-release.yml"), "utf8");
const jobs = new Map();
{
  const body = wf.slice(wf.indexOf("\njobs:\n"));
  const parts = body.split(/^ {2}([a-z0-9-]+):\n/m);
  for (let i = 1; i < parts.length; i += 2) jobs.set(parts[i], parts[i + 1]);
}
const privileged = (b) => /^ {4}environment:/m.test(b) || /id-token: write/.test(b) || /\$\{\{ secrets\./.test(b);

test("build-ios holds no Environment, secret or id-token; sign-ios and publish-ios follow it", () => {
  const build = jobs.get("build-ios");
  const sign = jobs.get("sign-ios");
  const publish = jobs.get("publish-ios");
  assert.ok(build && sign && publish);
  assert.equal(privileged(build), false);
  assert.match(build, /^ {4}permissions:\n {6}contents: read\n {4}\S/m);
  assert.match(build, /-resolvePackageDependencies/);
  assert.match(sign, /^ {4}environment: ios-release$/m);
  assert.match(sign, /^ {4}needs: build-ios$/m);
  assert.match(sign, /^ {4}permissions:\n {6}contents: read\n {4}\S/m);
  assert.match(sign, /shasum -a 256 -c --strict/);
  assert.match(publish, /^ {4}needs: \[build-ios, sign-ios\]$/m);
  assert.match(publish, /sha256sum -c --strict/);
});

test("no privileged job resolves packages, builds, or runs node, npm or setup-node", () => {
  for (const [name, b] of jobs) {
    if (!privileged(b)) continue;
    assert.doesNotMatch(b, /resolvePackageDependencies|xcodebuild (archive|build)|xcodegen|setup-node/, name);
    assert.doesNotMatch(b, /\b(node|npm|npx|swift) /, name);
  }
});

test("only publish-ios holds id-token, and it runs no xcodebuild", () => {
  for (const [name, b] of jobs) {
    if (/id-token/.test(b)) assert.equal(name, "publish-ios");
  }
  assert.doesNotMatch(jobs.get("publish-ios"), /xcodebuild|secrets\./);
});
