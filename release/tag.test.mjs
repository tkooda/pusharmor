// Release tag rule. Run: node --test release/tag.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildNumber, ciJobs, repoName, ciProblems, ciState, formatProblems, parseTag, stampProblems, tagProblems } from "./tag.mjs";

const REPO = join(import.meta.dirname, "..");
const CLI = join(import.meta.dirname, "tag.mjs");

test("tag names: <platform>/vX.Y.Z only, no rc tags, no leading zeros", () => {
  assert.deepEqual(parseTag("chrome/v1.2.3"), { platform: "chrome", version: "1.2.3" });
  assert.deepEqual(parseTag("cli/v0.0.19"), { platform: "cli", version: "0.0.19" });
  assert.deepEqual(parseTag("worker/v0.0.10"), { platform: "worker", version: "0.0.10" });
  for (const t of ["chrome/v1.2", "chrome/v1.2.3-rc1", "chrome/1.2.3", "chrome-v1.2.3", "site/v1.2.3", "chrome/v1.02.3", "chrome/v1.2.3 ", "v1.2.3"]) {
    assert.equal(parseTag(t), null, t);
  }
});

test("format: minor and patch <= 999, major <= 2099, known platform", () => {
  assert.deepEqual(formatProblems("ios", "2099.999.999"), []);
  assert.deepEqual(formatProblems("ios", "1.1000.0"), ["1.1000.0: minor and patch must be <= 999"]);
  assert.deepEqual(formatProblems("ios", "2100.0.0"), ["2100.0.0: major must be <= 2099"]);
  assert.deepEqual(formatProblems("site", "1.0.0"), ['unknown platform "site" (one of android, ios, chrome, firefox, worker, cli)']);
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
  // Between releases /download keeps the SHA-256 of the released pusharmor.py.
  assert.deepEqual(stampProblems(REPO, v).filter((l) => !l.startsWith("site/public/download.html holds " + v + " / ")), []);
});

test("the version comment on line 2 of pusharmor.py must match VERSION", (t) => {
  const { d, bin } = scratch();
  t.after(() => [d, bin].forEach((p) => rmSync(p, { recursive: true, force: true })));
  const py = join(d, "client/cli/pusharmor.py");
  const v = /^VERSION = "([^"]*)"$/m.exec(readFileSync(py, "utf8"))[1];
  assert.equal(readFileSync(py, "utf8").split("\n")[1], "# PushArmor command-line client, version " + v);
  writeFileSync(py, readFileSync(py, "utf8").replace(/^(# PushArmor command-line client, version ).*$/m, "$19.9.9"));
  assert.deepEqual(stampProblems(d, v).filter((l) => l.startsWith("client/cli/")), ["client/cli/pusharmor.py holds " + v + " / 9.9.9, want " + v + " / " + v]);
});

test("ci-ok: any successful run or attempt counts; running, missing and failed jobs do not", () => {
  const c = "e".repeat(40);
  const ok = { status: "completed", conclusion: "success" };
  const bad = { status: "completed", conclusion: "failure" };
  const run = { status: "in_progress", conclusion: null };
  assert.equal(ciState(c, [bad, ok, run]), "ok");
  assert.equal(ciState(c, [bad, run]), "pending");
  assert.equal(ciState(c, []), "no ci-ok job of the ci workflow ran on commit eeeeeeeeeeee (push it to main and wait for CI)");
  assert.equal(ciState(c, [bad, { status: "completed", conclusion: "cancelled" }]), "ci-ok of the ci workflow did not succeed on commit eeeeeeeeeeee (failure, cancelled)");
});

test("ci-ok: gh api reads the push runs of ci.yml on the commit and the ci-ok jobs of each", () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    return args[1].includes("/jobs") ? (args[1].includes("/7/") ? "completed\tfailure\n" : "in_progress\t\ncompleted\tsuccess\n") : "7\n8\n";
  };
  assert.deepEqual(ciJobs("abc", gh, "o/r"), [
    { status: "completed", conclusion: "failure" },
    { status: "in_progress", conclusion: null },
    { status: "completed", conclusion: "success" },
  ]);
  assert.equal(calls[0][0], "repos/o/r/actions/workflows/ci.yml/runs?event=push&per_page=100&head_sha=abc");
  assert.deepEqual(calls[1].slice(0, 2), ["--paginate", "repos/o/r/actions/runs/7/jobs?filter=all&per_page=100"]);
  assert.match(calls[1][3], /select\(\.name == "ci-ok"\)/);
  assert.equal(repoName({ GITHUB_REPOSITORY: "a/b", GH_REPO: "c/d" }), "a/b");
  assert.equal(repoName({ GH_REPO: "c/d" }), "c/d");
  for (const u of ["git@github_alias:tkooda/pusharmor.git", "https://github.com/tkooda/pusharmor", "ssh://git@github.com/tkooda/pusharmor.git/"]) {
    assert.equal(repoName({}, () => u), "tkooda/pusharmor", u);
  }
  assert.throws(() => repoName({}, () => "../repo"), /set GH_REPO/);
});

test("ci-ok wait: polls a running CI and a failing gh api until the deadline, stops on a result", () => {
  const c = "f".repeat(40);
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: (ms) => { t += ms; } };
  };
  const seq = (...states) => { let i = 0; return () => { const s = states[Math.min(i++, states.length - 1)]; if (s instanceof Error) throw s; return s; }; };
  const running = [{ status: "queued", conclusion: null }];
  const done = [{ status: "completed", conclusion: "success" }];
  let k = clock();
  assert.deepEqual(ciProblems(c, { waitMs: 600000, list: seq(running, Object.assign(new Error("x"), { stderr: "HTTP 502" }), done), ...k }), []);
  assert.equal(k.now(), 120000);
  k = clock();
  assert.deepEqual(ciProblems(c, { waitMs: 300000, list: seq(running), ...k }), ["ci-ok of the ci workflow is still running on commit ffffffffffff after 5 minutes"]);
  assert.equal(k.now(), 300000);
  k = clock();
  assert.deepEqual(ciProblems(c, { waitMs: 300000, list: seq(running, [{ status: "completed", conclusion: "failure" }]), ...k }), ["ci-ok of the ci workflow did not succeed on commit ffffffffffff (failure)"]);
  assert.equal(k.now(), 60000);
  // No wait (tag mode): one look.
  k = clock();
  assert.deepEqual(ciProblems(c, { list: seq(running), ...k }), ["ci-ok of the ci workflow is still running on commit ffffffffffff; wait for it and rerun"]);
  assert.deepEqual(ciProblems(c, { list: seq(new Error("spawnSync gh ENOENT")), ...k }), ["could not read the ci runs with gh api: spawnSync gh ENOENT"]);
  assert.equal(k.now(), 0);
});

// A scratch repo holding copies of the version files, and a fake gh on PATH that
// answers one ci run whose ci-ok jobs are ci.jobs (status TAB conclusion lines).
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "pa-tag-"));
  for (const f of ["release/version.properties", "client/chrome/manifest.json", "client/firefox/manifest.json", "client/ios/project.yml", "client/cli/pusharmor.py", "site/public/download.html"]) {
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
  const bin = mkdtempSync(join(tmpdir(), "pa-tag-bin-"));
  writeFileSync(join(bin, "gh"), '#!/bin/sh\ncase "$*" in\n  */jobs*) printf "%s" "$FAKE_GH_JOBS" ;;\n  *) echo 101 ;;\nesac\n');
  chmodSync(join(bin, "gh"), 0o755);
  const ci = { jobs: "completed\tsuccess\n" };
  const run = (...a) => spawnSync("node", [CLI, ...a], { cwd: d, encoding: "utf8", env: { ...process.env, PATH: bin + ":" + process.env.PATH, GH_REPO: "o/r", GITHUB_REPOSITORY: "", FAKE_GH_JOBS: ci.jobs, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  return { d, git, run, ci, bin };
}

test("CLI: stamp, commit, tag; second platform at the same commit; check mode", (t) => {
  const { d, git, run, bin } = scratch();
  t.after(() => [d, bin].forEach((p) => rmSync(p, { recursive: true, force: true })));
  assert.equal(run().status, 2);
  let r = run("android", "1.2.3");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /stamped 1\.2\.3/);
  assert.deepEqual(stampProblems(d, "1.2.3"), []);
  assert.match(readFileSync(join(d, "release/version.properties"), "utf8"), /^versionCode=1002003$/m);
  assert.match(readFileSync(join(d, "client/ios/project.yml"), "utf8"), /CURRENT_PROJECT_VERSION: "1002003"/);
  assert.match(readFileSync(join(d, "client/cli/pusharmor.py"), "utf8"), /^VERSION = "1\.2\.3"$/m);
  assert.match(readFileSync(join(d, "client/cli/pusharmor.py"), "utf8"), /^# PushArmor command-line client, version 1\.2\.3$/m);
  const page = readFileSync(join(d, "site/public/download.html"), "utf8");
  assert.ok(page.includes('href="https://github.com/tkooda/pusharmor/releases/download/cli/v1.2.3/pusharmor.py"'));
  assert.ok(!/releases\/download\/cli\/v(?!1\.2\.3\/)/.test(page));
  assert.ok(page.includes('<code id="cli-sha256">' + createHash("sha256").update(readFileSync(join(d, "client/cli/pusharmor.py"))).digest("hex") + "</code>"));
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

test("CLI check: /download holds the SHA-256 of pusharmor.py at the commit", (t) => {
  const { d, git, run, bin } = scratch();
  t.after(() => [d, bin].forEach((p) => rmSync(p, { recursive: true, force: true })));
  run("cli", "1.3.0");
  git("commit", "-q", "-am", "release 1.3.0");
  git("tag", "-a", "cli/v1.3.0", "-m", "cli 1.3.0");
  let r = run("--check", "cli/v1.3.0");
  assert.equal(r.status, 0, r.stderr);
  const py = join(d, "client/cli/pusharmor.py");
  writeFileSync(py, readFileSync(py, "utf8") + "\n");
  git("commit", "-q", "-am", "edit pusharmor.py");
  git("tag", "-f", "-a", "cli/v1.3.0", "-m", "cli 1.3.0");
  r = run("--check", "cli/v1.3.0");
  assert.equal(r.status, 1);
  const sha = createHash("sha256").update(readFileSync(py)).digest("hex");
  assert.match(r.stderr, new RegExp("site/public/download\\.html holds 1\\.3\\.0 / [0-9a-f]{64}, want 1\\.3\\.0 / " + sha));
});

test("CLI check: a rerun of an older tag ignores tags created after it", (t) => {
  const { d, git, run, bin } = scratch();
  t.after(() => [d, bin].forEach((p) => rmSync(p, { recursive: true, force: true })));
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

test("CLI: no tag unless ci-ok succeeded on HEAD; --ci checks the commit of the tag", (t) => {
  const { d, git, run, ci, bin } = scratch();
  t.after(() => [d, bin].forEach((p) => rmSync(p, { recursive: true, force: true })));
  // A version far above the repo version files, so the stamp always changes them.
  run("ios", "90.0.7");
  git("commit", "-q", "-am", "release 90.0.7");
  const head = git("rev-parse", "HEAD").slice(0, 12);
  for (const [jobs, want] of [
    ["completed\tfailure\n", "ci-ok of the ci workflow did not succeed on commit " + head + " (failure)"],
    ["", "no ci-ok job of the ci workflow ran on commit " + head],
    ["in_progress\t\n", "ci-ok of the ci workflow is still running on commit " + head + "; wait for it and rerun"],
  ]) {
    ci.jobs = jobs;
    const r = run("ios", "90.0.7");
    assert.equal(r.status, 1, jobs);
    assert.ok(r.stderr.includes(want), r.stderr);
    assert.equal(git("tag", "-l"), "");
  }
  ci.jobs = "completed\tfailure\ncompleted\tsuccess\n";
  let r = run("ios", "90.0.7");
  assert.equal(r.status, 0, r.stderr);
  r = run("--ci", "ios/v90.0.7");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "ci-ok succeeded on " + head);
  ci.jobs = "completed\tcancelled\n";
  r = run("--ci", "ios/v90.0.7");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ci-ok of the ci workflow did not succeed on commit [0-9a-f]{12} \(cancelled\)/);
  r = run("--ci", "ios/v90.0.8");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tag ios\/v90\.0\.8 does not exist/);
  // --check reads git only: it passes without gh.
  ci.jobs = "";
  assert.equal(run("--check", "ios/v90.0.7").status, 0);
});
