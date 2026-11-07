// Release tag rule. Run: node --test release/tag.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEV_VERSION, GATE, SHARED, buildNumber, buildVersion, ciRuns, repoName, ciProblems, gateState, formatProblems, parseTag, tagProblems } from "./tag.mjs";

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
    "0.0.10 is bound to commit bbbbbbbbbbbb by tag ios/v0.0.10, which is not in the history of this commit",
    "0.0.10 is bound to commit bbbbbbbbbbbb by tag chrome/v0.0.10, which is not in the history of this commit",
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
    "1.0.0 is bound to commit aaaaaaaaaaaa by tag android/v1.0.0, which is not in the history of this commit",
    "1.0.0 is not greater than the existing tag worker/v1.0.1",
  ]);
  assert.deepEqual(tagProblems("0.9.0", "c".repeat(40), tags), [
    "0.9.0 is not greater than the existing tag android/v1.0.0",
    "0.9.0 is not greater than the existing tag worker/v1.0.1",
  ]);
});

test("the tags of a version follow one line of history", () => {
  // history: a (android/v1.0.0) -> b -> c -> d (worker/v1.0.1); x is on a side branch.
  const order = ["a", "b", "c", "d"].map((c) => c.repeat(40));
  const anc = (x, y) => order.includes(x) && order.includes(y) && order.indexOf(x) < order.indexOf(y);
  const tags = [
    { name: "android/v1.0.0", commit: order[0] },
    { name: "ios/v1.0.0", commit: order[1] },
    { name: "worker/v1.0.1", commit: order[3] },
  ];
  // chrome joins 1.0.0 on a later commit c, after android and ios, before 1.0.1.
  assert.deepEqual(tagProblems("1.0.0", order[2], tags, anc), []);
  // ... but not after a commit that already has a higher version.
  assert.deepEqual(tagProblems("1.0.0", "e".repeat(40), tags, (x, y) => anc(x, y) || (order.includes(x) && y === "e".repeat(40))), [
    "1.0.0 is not greater than the existing tag worker/v1.0.1",
  ]);
  // nor on a side branch.
  assert.deepEqual(tagProblems("1.0.0", "x".repeat(40), tags, anc), [
    "1.0.0 is bound to commit aaaaaaaaaaaa by tag android/v1.0.0, which is not in the history of this commit",
    "1.0.0 is bound to commit bbbbbbbbbbbb by tag ios/v1.0.0, which is not in the history of this commit",
    "1.0.0 is not greater than the existing tag worker/v1.0.1",
  ]);
  // A version on an earlier commit than a lower version is refused.
  assert.deepEqual(tagProblems("1.0.2", order[2], tags, anc), ["1.0.2 is not lower than the tag worker/v1.0.1 on a later commit"]);
  // A commit still carries one version.
  assert.deepEqual(tagProblems("1.0.1", order[1], tags, anc), ["the commit already carries version 1.0.0 (tag ios/v1.0.0)"]);
});

test("a platform joining a bound version must not have a newer tag of its own", () => {
  const tags = [
    { name: "android/v1.0.0", commit: "a".repeat(40) },
    { name: "ios/v1.0.1", commit: "b".repeat(40) },
  ];
  assert.deepEqual(tagProblems("1.0.0", "a".repeat(40), tags, undefined, ["ios"]), ["ios already has the newer tag ios/v1.0.1"]);
  assert.deepEqual(tagProblems("1.0.0", "a".repeat(40), tags, undefined, ["chrome"]), []);
});


test("the repo holds the dev version: no version is committed for a release", () => {
  const read = (f) => readFileSync(join(REPO, f), "utf8");
  assert.equal(JSON.parse(read("client/chrome/manifest.json")).version, DEV_VERSION);
  assert.equal(JSON.parse(read("client/firefox/manifest.json")).version, DEV_VERSION);
  assert.match(read("client/ios/project.yml"), /^ *MARKETING_VERSION: "0\.0\.0"$/m);
  assert.match(read("client/ios/project.yml"), /^ *CURRENT_PROJECT_VERSION: "1"$/m);
  const py = read("client/cli/pusharmor.py");
  assert.match(py, /^VERSION = "0\.0\.0"$/m);
  assert.equal(py.split("\n")[1], "# PushArmor command-line client, version 0.0.0");
  // cli-release writes the tag's version over exactly these two lines.
  const wf = read(".github/workflows/cli-release.yml");
  assert.ok(wf.includes('s/^VERSION = \\"0\\.0\\.0\\"\\$/VERSION = \\"$v\\"/'), "cli-release stamp of VERSION");
  assert.ok(wf.includes("2s/^# PushArmor command-line client, version 0\\.0\\.0\\$/"), "cli-release stamp of line 2");
});

test("build version: PA_VERSION, else the source archive tag, else the tag at HEAD, else 0.0.0", (t) => {
  const { d, git, bin } = scratch();
  t.after(() => [d, bin].forEach((p) => rmSync(p, { recursive: true, force: true })));
  const env = {};
  assert.equal(buildVersion("chrome", d, env), "0.0.0");
  git("tag", "-a", "chrome/v1.2.3", "-m", "chrome 1.2.3");
  git("tag", "-a", "android/v1.2.3", "-m", "android 1.2.3");
  assert.equal(buildVersion("chrome", d, env), "1.2.3");
  assert.equal(buildVersion("firefox", d, env), "0.0.0");
  assert.equal(buildVersion("firefox", d, { PA_VERSION: "1.2.4" }), "1.2.4");
  assert.throws(() => buildVersion("firefox", d, { PA_VERSION: "1.2" }), /not X\.Y\.Z/);
  git("commit", "-q", "--allow-empty", "-m", "next");
  assert.equal(buildVersion("chrome", d, env), "0.0.0");
  // A source archive has no .git; release/source-tag.txt names its tag.
  const src = mkdtempSync(join(tmpdir(), "pa-src-"));
  t.after(() => rmSync(src, { recursive: true, force: true }));
  assert.equal(buildVersion("firefox", src, env), "0.0.0");
  mkdirSync(join(src, "release"));
  writeFileSync(join(src, "release", "source-tag.txt"), "firefox/v1.3.0\n");
  assert.equal(buildVersion("firefox", src, env), "1.3.0");
  assert.equal(buildVersion("chrome", src, env), "0.0.0");
});

// Jobs of one ci run: every gate group succeeded unless overridden.
const okJobs = () => [...SHARED, "android", "android-emulator", "ios", "webext", "site", "worker", "cli"].map((g) => ({ name: g + " / job", status: "completed", conclusion: "success" }));
const withJob = (jobs, name, status, conclusion) => [...jobs.filter((j) => j.name !== name), { name, status, conclusion }];

test("release gate: each platform needs its own jobs and the shared checks to succeed, not ci-ok", () => {
  const c = "e".repeat(40);
  assert.deepEqual(GATE, { android: ["android", "android-emulator", "site"], ios: ["ios"], chrome: ["webext"], firefox: ["webext", "site"], worker: ["worker"], cli: ["cli", "site"] });
  assert.deepEqual(SHARED, ["repo", "vectors"]);
  const ok = okJobs();
  for (const p of Object.keys(GATE)) assert.equal(gateState(p, c, [{ status: "completed", jobs: ok }]), "ok", p);
  // A slow or failed iOS job holds up iOS only.
  const iosRunning = withJob(ok, "ios / job", "in_progress", null);
  assert.equal(gateState("android", c, [{ status: "in_progress", jobs: iosRunning }]), "ok");
  assert.equal(gateState("ios", c, [{ status: "in_progress", jobs: iosRunning }]), "pending");
  const iosFailed = withJob(ok, "ios / job", "completed", "failure");
  assert.equal(gateState("chrome", c, [{ status: "completed", jobs: iosFailed }]), "ok");
  assert.equal(gateState("ios", c, [{ status: "completed", jobs: iosFailed }]), "the ios release gate (repo, vectors, ios) did not pass on commit eeeeeeeeeeee: ios / job: failure");
  // A shared check failing fails every platform; a cancelled job is not a pass.
  assert.match(gateState("worker", c, [{ status: "completed", jobs: withJob(ok, "repo / job", "completed", "cancelled") }]), /: repo \/ job: cancelled$/);
  // A whole component skipped (one caller job "<id>", no "<id> / ..." jobs) is not a pass.
  const skipped = [...ok.filter((j) => !j.name.startsWith("worker / ")), { name: "worker", status: "completed", conclusion: "skipped" }];
  assert.equal(gateState("worker", c, [{ status: "completed", jobs: skipped }]), "the worker release gate (repo, vectors, worker) did not pass on commit eeeeeeeeeeee: worker did not run (skipped)");
  // A job the component skips by design is fine while another of its jobs succeeded.
  assert.equal(gateState("ios", c, [{ status: "completed", jobs: [...ok, { name: "ios / iOS 17", status: "completed", conclusion: "skipped" }] }]), "ok");
  // Component jobs not created yet in a running run: wait.
  assert.equal(gateState("cli", c, [{ status: "in_progress", jobs: ok.filter((j) => !j.name.startsWith("cli / ")) }]), "pending");
  // Any run passing is enough; a failed run and a running one make "pending".
  assert.equal(gateState("ios", c, [{ status: "completed", jobs: iosFailed }, { status: "completed", jobs: ok }]), "ok");
  assert.equal(gateState("ios", c, [{ status: "completed", jobs: iosFailed }, { status: "in_progress", jobs: iosRunning }]), "pending");
  assert.equal(gateState("ios", c, []), "no run of the ci workflow on commit eeeeeeeeeeee (push it to an internal/ branch and wait for CI)");
});

test("release gate: gh api reads the push runs of ci.yml on the commit and the latest jobs of each", () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    return args[1].includes("/jobs") ? (args[1].includes("/7/") ? "ios / a\tcompleted\tfailure\n" : "ios / a\tin_progress\t\nrepo / b\tcompleted\tsuccess\n") : "7\tcompleted\n8\tin_progress\n";
  };
  assert.deepEqual(ciRuns("abc", gh, "o/r"), [
    { status: "completed", jobs: [{ name: "ios / a", status: "completed", conclusion: "failure" }] },
    { status: "in_progress", jobs: [{ name: "ios / a", status: "in_progress", conclusion: null }, { name: "repo / b", status: "completed", conclusion: "success" }] },
  ]);
  assert.equal(calls[0][0], "repos/o/r/actions/workflows/ci.yml/runs?event=push&per_page=100&head_sha=abc");
  assert.deepEqual(calls[1].slice(0, 2), ["--paginate", "repos/o/r/actions/runs/7/jobs?filter=latest&per_page=50"]);
  assert.equal(repoName({ GITHUB_REPOSITORY: "a/b", GH_REPO: "c/d" }), "a/b");
  assert.equal(repoName({ GH_REPO: "c/d" }), "c/d");
  for (const u of ["git@github_alias:tkooda/pusharmor.git", "https://github.com/tkooda/pusharmor", "ssh://git@github.com/tkooda/pusharmor.git/"]) {
    assert.equal(repoName({}, () => u), "tkooda/pusharmor", u);
  }
  assert.throws(() => repoName({}, () => "../repo"), /set GH_REPO/);
});

test("release gate wait: polls a running CI and a failing gh api until the deadline, stops on a result", () => {
  const c = "f".repeat(40);
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: (ms) => { t += ms; } };
  };
  const seq = (...states) => { let i = 0; return () => { const s = states[Math.min(i++, states.length - 1)]; if (s instanceof Error) throw s; return s; }; };
  const running = [{ status: "in_progress", jobs: withJob(okJobs(), "ios / job", "queued", null) }];
  const done = [{ status: "completed", jobs: okJobs() }];
  const failed = [{ status: "completed", jobs: withJob(okJobs(), "ios / job", "completed", "failure") }];
  let k = clock();
  assert.deepEqual(ciProblems("ios", c, { waitMs: 600000, list: seq(running, Object.assign(new Error("x"), { stderr: "HTTP 502" }), done), ...k }), []);
  assert.equal(k.now(), 30000);
  k = clock();
  assert.deepEqual(ciProblems("ios", c, { waitMs: 300000, list: seq(running), ...k }), ["the ios jobs of the ci workflow are still running on commit ffffffffffff after 5 minutes"]);
  assert.equal(k.now(), 300000);
  k = clock();
  assert.deepEqual(ciProblems("ios", c, { waitMs: 300000, list: seq(running, failed), ...k }), ["the ios release gate (repo, vectors, ios) did not pass on commit ffffffffffff: ios / job: failure"]);
  assert.equal(k.now(), 15000);
  // The running iOS job does not hold up Android.
  assert.deepEqual(ciProblems("android", c, { list: seq(running), ...k }), []);
  // No wait (tag mode): one look.
  k = clock();
  assert.deepEqual(ciProblems("ios", c, { list: seq(running), ...k }), ["the ios jobs of the ci workflow are still running on commit ffffffffffff; wait for them and rerun"]);
  assert.deepEqual(ciProblems("ios", c, { list: seq(new Error("spawnSync gh ENOENT")), ...k }), ["could not read the ci runs with gh api: spawnSync gh ENOENT"]);
  assert.equal(k.now(), 0);
});

// A scratch repo with one commit, and a fake gh on PATH that answers one
// completed ci run whose jobs are ci.jobs (name TAB status TAB conclusion lines).
const tsv = (jobs) => jobs.map((j) => [j.name, j.status, j.conclusion || ""].join("\t") + "\n").join("");

function scratch() {
  const d = mkdtempSync(join(tmpdir(), "pa-tag-"));
  writeFileSync(join(d, "README"), "scratch\n");
  const git = (...a) => execFileSync("git", a, { cwd: d, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "tag.gpgSign", "false");
  git("config", "commit.gpgSign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const bin = mkdtempSync(join(tmpdir(), "pa-tag-bin-"));
  writeFileSync(join(bin, "gh"), '#!/bin/sh\ncase "$*" in\n  */jobs*) printf "%s" "$FAKE_GH_JOBS" ;;\n  *) printf "101\\tcompleted\\n" ;;\nesac\n');
  chmodSync(join(bin, "gh"), 0o755);
  const ci = { jobs: tsv(okJobs()) };
  const run = (...a) => spawnSync("node", [CLI, ...a], { cwd: d, encoding: "utf8", env: { ...process.env, PATH: bin + ":" + process.env.PATH, GH_REPO: "o/r", GITHUB_REPOSITORY: "", FAKE_GH_JOBS: ci.jobs, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  return { d, git, run, ci, bin };
}

test("CLI: tag HEAD; second platform at the same commit or a later one; check mode", (t) => {
  const { d, git, run, bin } = scratch();
  t.after(() => [d, bin].forEach((p) => rmSync(p, { recursive: true, force: true })));
  assert.equal(run().status, 2);
  let r = run("android", "1.2.3");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /tagged: android\/v1\.2\.3/);
  assert.match(r.stdout, /git push origin android\/v1\.2\.3/);
  assert.equal(git("cat-file", "-t", "android/v1.2.3"), "tag");
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(git("rev-list", "--count", "HEAD"), "1");
  assert.equal(run("ios", "1.2.3").status, 0);
  r = run("--check", "ios/v1.2.3");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "1.2.3");

  // A later commit may take 1.2.3 for another platform, and an older version is refused.
  git("commit", "-q", "--allow-empty", "-m", "next");
  r = run("chrome", "1.2.3");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /tagged: chrome\/v1\.2\.3/);
  r = run("chrome", "1.2.2");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /1\.2\.2 is not greater than the existing tag android\/v1\.2\.3/);
  r = run("--check", "android/v1.2.3");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /HEAD is not the commit of android\/v1\.2\.3/);
  // A commit carries one version.
  r = run("firefox", "1.2.4");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the commit already carries version 1\.2\.3 \(tag chrome\/v1\.2\.3\)/);

  // Check mode: a lightweight tag fails.
  git("commit", "-q", "--allow-empty", "-m", "next");
  git("tag", "firefox/v1.2.4");
  r = run("--check", "firefox/v1.2.4");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /lightweight tag/);
  r = run("--check", "chrome-v1.2.3");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not <platform>\/vX\.Y\.Z/);
  // A dirty tree is refused.
  writeFileSync(join(d, "README"), "changed\n");
  r = run("ios", "1.2.5");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the working tree is not clean/);
});

test("CLI check: a rerun of an older tag ignores tags created after it", (t) => {
  const { d, git, run, bin } = scratch();
  t.after(() => [d, bin].forEach((p) => rmSync(p, { recursive: true, force: true })));
  const env = (date) => ({ ...process.env, GIT_COMMITTER_DATE: date, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  execFileSync("git", ["tag", "-a", "chrome/v0.1.0", "-m", "w"], { cwd: d, env: env("2026-01-01T00:00:00Z") });
  const first = git("rev-parse", "HEAD");
  git("commit", "-q", "--allow-empty", "-m", "next");
  execFileSync("git", ["tag", "-a", "chrome/v0.2.0", "-m", "w"], { cwd: d, env: env("2026-02-01T00:00:00Z") });
  git("checkout", "-q", "--detach", first);
  let r = run("--check", "chrome/v0.1.0");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "0.1.0");

  // A new platform tag of 0.1.0 at its commit, made after chrome/v0.2.0.
  r = run("worker", "0.1.0");
  assert.equal(r.status, 0, r.stderr);
  r = run("--check", "worker/v0.1.0");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "0.1.0");
});

test("CLI: no tag unless the platform's release gate passed on HEAD; --ci checks the commit of the tag", (t) => {
  const { git, run, ci, d, bin } = scratch();
  t.after(() => [d, bin].forEach((p) => rmSync(p, { recursive: true, force: true })));
  const head = git("rev-parse", "HEAD").slice(0, 12);
  for (const [jobs, want] of [
    [withJob(okJobs(), "ios / job", "completed", "failure"), "the ios release gate (repo, vectors, ios) did not pass on commit " + head + ": ios / job: failure"],
    [withJob(okJobs(), "vectors / job", "completed", "cancelled"), "the ios release gate (repo, vectors, ios) did not pass on commit " + head + ": vectors / job: cancelled"],
    [[...okJobs().filter((j) => !j.name.startsWith("ios / ")), { name: "ios", status: "completed", conclusion: "skipped" }], "ios did not run (skipped)"],
    [withJob(okJobs(), "ios / job", "in_progress", null), "the ios jobs of the ci workflow are still running on commit " + head + "; wait for them and rerun"],
  ]) {
    ci.jobs = tsv(jobs);
    const r = run("ios", "90.0.7");
    assert.equal(r.status, 1, ci.jobs);
    assert.ok(r.stderr.includes(want), r.stderr);
    assert.equal(git("tag", "-l"), "");
  }
  // ci-ok failing for another platform's job does not hold up iOS.
  ci.jobs = tsv(withJob(okJobs(), "android / job", "completed", "failure"));
  let r = run("ios", "90.0.7");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /git push origin ios\/v90\.0\.7/);
  r = run("--ci", "ios/v90.0.7");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "the ios release gate (repo, vectors, ios) passed on " + head);
  ci.jobs = tsv(withJob(okJobs(), "ios / job", "completed", "cancelled"));
  r = run("--ci", "ios/v90.0.7");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the ios release gate \(repo, vectors, ios\) did not pass on commit [0-9a-f]{12}: ios \/ job: cancelled/);
  r = run("--ci", "ios/v90.0.8");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tag ios\/v90\.0\.8 does not exist/);
  // --check reads git only: it passes without gh.
  ci.jobs = "";
  assert.equal(run("--check", "ios/v90.0.7").status, 0);
});

test("CLI: no tag and no check pass for a commit that is not on origin/main", (t) => {
  const { d, git, run, bin } = scratch();
  const origin = mkdtempSync(join(tmpdir(), "pa-tag-origin-"));
  t.after(() => [d, bin, origin].forEach((p) => rmSync(p, { recursive: true, force: true })));
  git("init", "-q", "--bare", origin);
  git("remote", "add", "origin", origin);
  git("push", "-q", "origin", "main");
  git("checkout", "-q", "-b", "x");
  git("commit", "-q", "--allow-empty", "-m", "x");
  git("push", "-q", "origin", "x");
  let r = run("1.4.0", "chrome");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /HEAD is not on origin\/main/);
  assert.equal(git("tag", "-l"), "");
  git("tag", "-a", "chrome/v1.4.0", "-m", "chrome 1.4.0");
  r = run("--check", "chrome/v1.4.0");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /HEAD is not on origin\/main/);
  git("tag", "-d", "chrome/v1.4.0");
  git("push", "-q", "origin", "x:main");
  r = run("1.4.0", "chrome");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(run("--check", "chrome/v1.4.0").status, 0);
});

test("platform subset: numbers are shared and never reused", (t) => {
  const { git, run, d, bin } = scratch();
  t.after(() => [d, bin].forEach((p) => rmSync(p, { recursive: true, force: true })));
  let r = run("1.2.3", "chrome", "firefox");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git("tag", "-l").split("\n").join(" "), "chrome/v1.2.3 firefox/v1.2.3");
  assert.equal(run("--check", "chrome/v1.2.3").status, 0);
  // Without a platform, or with an unknown one, nothing is tagged.
  assert.equal(run("1.2.3").status, 2);
  assert.equal(run("1.2.3", "nope").status, 1);
  // A lower number than the highest tag is refused.
  git("commit", "-q", "--allow-empty", "-m", "next");
  r = run("1.2.2", "android");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /1\.2\.2 is not greater than the existing tag/);
  // android joins 1.2.3 on a later commit.
  assert.equal(run("android", "1.2.3").status, 0);
  assert.equal(run("--check", "android/v1.2.3").status, 0);
  // Next release, worker alone; after it, nothing joins 1.2.3 any more.
  git("commit", "-q", "--allow-empty", "-m", "next");
  assert.equal(run("worker", "1.2.4").status, 0);
  assert.equal(run("--check", "worker/v1.2.4").status, 0);
  r = run("1.2.3", "ios");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the commit already carries version 1\.2\.4/);
  git("commit", "-q", "--allow-empty", "-m", "next");
  r = run("1.2.3", "ios");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /1\.2\.3 is not greater than the existing tag worker\/v1\.2\.4/);
  assert.equal(git("tag", "-l", "ios/*"), "");
});

test("one release: every tag of a version on one commit, nothing committed", (t) => {
  const { git, run, d, bin } = scratch();
  t.after(() => [d, bin].forEach((p) => rmSync(p, { recursive: true, force: true })));
  const head = git("rev-parse", "HEAD");
  const r = run("1.5.0", "all", "cli");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.equal(git("status", "--porcelain"), "");
  const names = ["android", "ios", "chrome", "firefox", "cli"].map((p) => p + "/v1.5.0");
  for (const n of names) {
    assert.equal(git("rev-parse", n + "^{commit}"), head);
    assert.equal(run("--check", n).status, 0, n);
    assert.ok(r.stdout.includes("git push origin " + n), n);
  }
  // Rerun is idempotent.
  const again = run("1.5.0", "all", "cli");
  assert.equal(again.status, 0);
  assert.match(again.stdout, /tag exists: android\/v1\.5\.0/);
});
