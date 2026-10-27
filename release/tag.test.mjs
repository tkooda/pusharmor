// Release tag rule. Run: node --test release/tag.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildNumber, formatProblems, parseTag, stampProblems, tagProblems } from "./tag.mjs";

const REPO = join(import.meta.dirname, "..");
const CLI = join(import.meta.dirname, "tag.mjs");

test("tag names: <platform>/vX.Y.Z only, no rc tags, no leading zeros", () => {
  assert.deepEqual(parseTag("chrome/v1.2.3"), { platform: "chrome", version: "1.2.3" });
  assert.deepEqual(parseTag("worker/v0.0.10"), { platform: "worker", version: "0.0.10" });
  for (const t of ["chrome/v1.2", "chrome/v1.2.3-rc1", "chrome/1.2.3", "chrome-v1.2.3", "site/v1.2.3", "chrome/v1.02.3", "chrome/v1.2.3 ", "v1.2.3"]) {
    assert.equal(parseTag(t), null, t);
  }
});

test("format: minor and patch <= 999, major <= 2099, known platform", () => {
  assert.deepEqual(formatProblems("ios", "2099.999.999"), []);
  assert.deepEqual(formatProblems("ios", "1.1000.0"), ["1.1000.0: minor and patch must be <= 999"]);
  assert.deepEqual(formatProblems("ios", "2100.0.0"), ["2100.0.0: major must be <= 2099"]);
  assert.deepEqual(formatProblems("site", "1.0.0"), ['unknown platform "site" (one of android, ios, chrome, firefox, worker)']);
  assert.equal(formatProblems("ios", "1.0").length, 1);
});

test("build number grows with the version and fits Play's versionCode cap", () => {
  assert.equal(buildNumber("0.0.1"), 1);
  assert.equal(buildNumber("1.2.3"), 1002003);
  assert.equal(buildNumber("2099.999.999"), 2099999999);
  assert.ok(buildNumber("0.1.0") > buildNumber("0.0.999"));
});

test("one version per commit, one commit per version, new versions greater than every tag", () => {
  const tags = [
    { name: "android/v0.0.9", commit: "a".repeat(40) },
    { name: "ios/v0.0.10", commit: "b".repeat(40) },
    { name: "chrome/v0.0.10", commit: "b".repeat(40) },
    { name: "android-v9.0.0", commit: "c".repeat(40) },
  ];
  assert.deepEqual(tagProblems("0.0.11", "d".repeat(40), tags), []);
  assert.deepEqual(tagProblems("0.0.10", "b".repeat(40), tags), []);
  assert.deepEqual(tagProblems("0.0.10", "d".repeat(40), tags), [
    "0.0.10 is bound to commit bbbbbbbbbbbb by tag ios/v0.0.10",
    "0.0.10 is bound to commit bbbbbbbbbbbb by tag chrome/v0.0.10",
  ]);
  assert.deepEqual(tagProblems("0.0.12", "b".repeat(40), tags), [
    "the commit already carries version 0.0.10 (tag ios/v0.0.10)",
    "the commit already carries version 0.0.10 (tag chrome/v0.0.10)",
  ]);
  assert.deepEqual(tagProblems("0.0.8", "d".repeat(40), tags), [
    "0.0.8 is not greater than the existing tag android/v0.0.9",
    "0.0.8 is not greater than the existing tag ios/v0.0.10",
    "0.0.8 is not greater than the existing tag chrome/v0.0.10",
  ]);
});

test("another platform may join a version already bound to the commit, also after newer tags", () => {
  const tags = [
    { name: "android/v1.0.0", commit: "a".repeat(40) },
    { name: "worker/v1.0.1", commit: "b".repeat(40) },
  ];
  assert.deepEqual(tagProblems("1.0.0", "a".repeat(40), tags), []);
  assert.deepEqual(tagProblems("1.0.0", "c".repeat(40), tags), [
    "1.0.0 is bound to commit aaaaaaaaaaaa by tag android/v1.0.0",
    "1.0.0 is not greater than the existing tag worker/v1.0.1",
  ]);
  assert.deepEqual(tagProblems("0.9.0", "c".repeat(40), tags), [
    "0.9.0 is not greater than the existing tag android/v1.0.0",
    "0.9.0 is not greater than the existing tag worker/v1.0.1",
  ]);
});

test("the committed version files agree with each other", () => {
  const v = readFileSync(join(REPO, "release/version.properties"), "utf8").match(/^versionName=(.*)$/m)[1];
  assert.deepEqual(stampProblems(REPO, v), []);
});

// A scratch repo holding copies of the version files.
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "pa-tag-"));
  for (const f of ["release/version.properties", "client/chrome/manifest.json", "client/firefox/manifest.json", "client/ios/project.yml"]) {
    mkdirSync(join(d, dirname(f)), { recursive: true });
    cpSync(join(REPO, f), join(d, f));
  }
  const git = (...a) => execFileSync("git", a, { cwd: d, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "tag.gpgSign", "false");
  git("config", "commit.gpgSign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const run = (...a) => spawnSync("node", [CLI, ...a], { cwd: d, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  return { d, git, run };
}

test("CLI: stamp, commit, tag; second platform at the same commit; check mode", (t) => {
  const { d, git, run } = scratch();
  t.after(() => rmSync(d, { recursive: true, force: true }));
  assert.equal(run().status, 2);
  let r = run("android", "1.2.3");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /stamped 1\.2\.3/);
  assert.deepEqual(stampProblems(d, "1.2.3"), []);
  assert.match(readFileSync(join(d, "release/version.properties"), "utf8"), /^versionCode=1002003$/m);
  assert.match(readFileSync(join(d, "client/ios/project.yml"), "utf8"), /CURRENT_PROJECT_VERSION: "1002003"/);
  git("commit", "-q", "-am", "release 1.2.3");
  r = run("android", "1.2.3");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /tagged: android\/v1\.2\.3/);
  assert.equal(git("cat-file", "-t", "android/v1.2.3"), "tag");
  assert.equal(run("ios", "1.2.3").status, 0);
  r = run("--check", "ios/v1.2.3");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "1.2.3");

  // A later commit cannot take 1.2.3, and an older version is refused before stamping.
  git("commit", "-q", "--allow-empty", "-m", "next");
  r = run("chrome", "1.2.3");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /1\.2\.3 is bound to commit/);
  r = run("chrome", "1.2.2");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /1\.2\.2 is not greater than the existing tag android\/v1\.2\.3/);
  assert.equal(git("status", "--porcelain"), "");
  r = run("--check", "android/v1.2.3");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /HEAD is not the commit of android\/v1\.2\.3/);

  // Check mode: a lightweight tag and version files that differ fail.
  git("tag", "firefox/v1.2.4");
  r = run("--check", "firefox/v1.2.4");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /lightweight tag/);
  assert.match(r.stderr, /client\/firefox\/manifest\.json holds 1\.2\.3, want 1\.2\.4/);
  r = run("--check", "chrome-v1.2.3");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not <platform>\/vX\.Y\.Z/);
});

test("CLI check: a rerun of an older tag ignores tags created after it", (t) => {
  const { d, git, run } = scratch();
  t.after(() => rmSync(d, { recursive: true, force: true }));
  run("worker", "0.1.0");
  git("commit", "-q", "-am", "release 0.1.0");
  const env = (date) => ({ ...process.env, GIT_COMMITTER_DATE: date, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  execFileSync("git", ["tag", "-a", "worker/v0.1.0", "-m", "w"], { cwd: d, env: env("2026-01-01T00:00:00Z") });
  const first = git("rev-parse", "HEAD");
  run("worker", "0.2.0");
  git("commit", "-q", "-am", "release 0.2.0");
  execFileSync("git", ["tag", "-a", "worker/v0.2.0", "-m", "w"], { cwd: d, env: env("2026-02-01T00:00:00Z") });
  git("checkout", "-q", "--detach", first);
  let r = run("--check", "worker/v0.1.0");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "0.1.0");

  // A new platform tag of 0.1.0 at its commit, made after worker/v0.2.0.
  r = run("android", "0.1.0");
  assert.equal(r.status, 0, r.stderr);
  r = run("--check", "android/v0.1.0");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "0.1.0");
});
