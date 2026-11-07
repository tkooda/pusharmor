// Release tag rule. Run: node --test release/tag.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GATE, SHARED, betaXpiUrl, buildNumber, ciRuns, repoName, ciProblems, gateState, formatProblems, parseTag, stampProblems, tagProblems } from "./tag.mjs";

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

test("one stamp commit per platform: the tags of a version follow one line of history", () => {
  // history: a (android/v1.0.0) -> b -> c -> d (worker/v1.0.1); x is on a side branch.
  const order = ["a", "b", "c", "d"].map((c) => c.repeat(40));
  const anc = (x, y) => order.includes(x) && order.includes(y) && order.indexOf(x) < order.indexOf(y);
  const tags = [
    { name: "android/v1.0.0", commit: order[0] },
    { name: "ios/v1.0.0", commit: order[1] },
    { name: "worker/v1.0.1", commit: order[3] },
  ];
  // chrome joins 1.0.0 on its own stamp commit c, after android and ios, before 1.0.1.
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

test("the committed version files of each platform agree with each other", () => {
  // a release stamps only the platforms it tags, so platforms may hold different versions.
  const read = (f) => readFileSync(join(REPO, f), "utf8");
  const held = {
    android: read("release/version.properties").match(/^versionName=(.*)$/m)[1],
    ios: read("client/ios/project.yml").match(/^ *MARKETING_VERSION: "(.*)"$/m)[1],
    chrome: JSON.parse(read("client/chrome/manifest.json")).version,
    firefox: JSON.parse(read("client/firefox/manifest.json")).version,
    cli: read("client/cli/pusharmor.py").match(/^VERSION = "([^"]*)"$/m)[1],
  };
  for (const [p, v] of Object.entries(held)) {
    // Between releases /download keeps the SHA-256 of the released pusharmor.py.
    assert.deepEqual(stampProblems(REPO, v, [p]).filter((l) => p !== "cli" || !l.startsWith("site/public/download.html holds " + v + " / ")), [], p);
  }
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

test("an Android stamp check fails when fdroid/android.txt holds another version", (t) => {
  const { d, bin } = scratch();
  t.after(() => [d, bin].forEach((p) => rmSync(p, { recursive: true, force: true })));
  const v = /^versionName=(.*)$/m.exec(readFileSync(join(d, "release/version.properties"), "utf8"))[1];
  writeFileSync(join(d, "site/public/fdroid/android.txt"), "0.0.0\n0\n");
  assert.deepEqual(stampProblems(d, v, ["android"]), ["site/public/fdroid/android.txt holds 0.0.0 / 0, want " + v + " / " + buildNumber(v)]);
});

test("an Android stamp check fails when an APK URL or file name on /download holds another version", (t) => {
  const { d, bin } = scratch();
  t.after(() => [d, bin].forEach((p) => rmSync(p, { recursive: true, force: true })));
  const v = /^versionName=(.*)$/m.exec(readFileSync(join(d, "release/version.properties"), "utf8"))[1];
  const f = join(d, "site/public/download.html");
  const page = readFileSync(f, "utf8");
  assert.deepEqual(stampProblems(d, v, ["android"]), []);
  writeFileSync(f, page.replace("pusharmor-" + v + "-play.apk</a>", "pusharmor-0.0.1-play.apk</a>"));
  assert.deepEqual(stampProblems(d, v, ["android"]), ["site/public/download.html holds " + v + " / " + v + ", 0.0.1, want " + v + " / " + v]);
  writeFileSync(f, page.replace("/android/v" + v + "/pusharmor-" + v + "-foss.apk", "/android/v0.0.1/pusharmor-" + v + "-foss.apk"));
  assert.deepEqual(stampProblems(d, v, ["android"]), ["site/public/download.html holds 0.0.1, " + v + " / " + v + ", want " + v + " / " + v]);
});

test("a Firefox stamp check fails when fx/beta/updates.json points at another XPI", (t) => {
  const { d, bin } = scratch();
  t.after(() => [d, bin].forEach((p) => rmSync(p, { recursive: true, force: true })));
  const f = join(d, "site/public/fx/beta/updates.json");
  const v = Object.values(JSON.parse(readFileSync(f, "utf8")).addons)[0].updates[0].version;
  assert.deepEqual(stampProblems(d, v, ["firefox"]), []);
  writeFileSync(f, readFileSync(f, "utf8").replace("/firefox/v" + v + "/", "/firefox/v0.0.1/"));
  assert.deepEqual(stampProblems(d, v, ["firefox"]), ["site/public/fx/beta/updates.json holds " + v + " / " + betaXpiUrl(v).replace("/firefox/v" + v + "/", "/firefox/v0.0.1/") + ", want " + v + " / " + betaXpiUrl(v)]);
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

// A scratch repo holding copies of the version files, and a fake gh on PATH that
// answers one completed ci run whose jobs are ci.jobs (name TAB status TAB
// conclusion lines).
const tsv = (jobs) => jobs.map((j) => [j.name, j.status, j.conclusion || ""].join("\t") + "\n").join("");

function scratch() {
  const d = mkdtempSync(join(tmpdir(), "pa-tag-"));
  for (const f of ["release/version.properties", "client/chrome/manifest.json", "client/firefox/manifest.json", "client/ios/project.yml", "client/cli/pusharmor.py", "site/public/download.html", "site/public/fdroid/android.txt", "site/public/fx/beta/updates.json", "server/worker/package.json", "server/worker/package-lock.json"]) {
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
  writeFileSync(join(bin, "gh"), '#!/bin/sh\ncase "$*" in\n  */jobs*) printf "%s" "$FAKE_GH_JOBS" ;;\n  *) printf "101\\tcompleted\\n" ;;\nesac\n');
  chmodSync(join(bin, "gh"), 0o755);
  const ci = { jobs: tsv(okJobs()) };
  const run = (...a) => spawnSync("node", [CLI, ...a], { cwd: d, encoding: "utf8", env: { ...process.env, PATH: bin + ":" + process.env.PATH, GH_REPO: "o/r", GITHUB_REPOSITORY: "", FAKE_GH_JOBS: ci.jobs, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  return { d, git, run, ci, bin };
}

test("CLI: stamp, commit, tag; second platform at the same commit or a later one; check mode", (t) => {
  const { d, git, run, bin } = scratch();
  t.after(() => [d, bin].forEach((p) => rmSync(p, { recursive: true, force: true })));
  assert.equal(run().status, 2);
  let r = run("1.2.3", "all", "cli");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /stamped 1\.2\.3/);
  assert.deepEqual(stampProblems(d, "1.2.3", ["android", "ios", "chrome", "firefox", "cli"]), []);
  assert.match(readFileSync(join(d, "release/version.properties"), "utf8"), /^versionCode=1002003$/m);
  assert.match(readFileSync(join(d, "client/ios/project.yml"), "utf8"), /CURRENT_PROJECT_VERSION: "1002003"/);
  assert.equal(readFileSync(join(d, "site/public/fdroid/android.txt"), "utf8"), "1.2.3\n1002003\n");
  const beta = Object.values(JSON.parse(readFileSync(join(d, "site/public/fx/beta/updates.json"), "utf8")).addons)[0].updates;
  assert.deepEqual(beta, [{ version: "1.2.3", update_link: "https://github.com/tkooda/pusharmor/releases/download/firefox/v1.2.3/pusharmor-firefox-beta-1.2.3.xpi" }]);
  assert.match(readFileSync(join(d, "client/cli/pusharmor.py"), "utf8"), /^VERSION = "1\.2\.3"$/m);
  assert.match(readFileSync(join(d, "client/cli/pusharmor.py"), "utf8"), /^# PushArmor command-line client, version 1\.2\.3$/m);
  const page = readFileSync(join(d, "site/public/download.html"), "utf8");
  assert.ok(page.includes('href="https://github.com/tkooda/pusharmor/releases/download/cli/v1.2.3/pusharmor.py"'));
  assert.ok(!/releases\/download\/cli\/v(?!1\.2\.3\/)/.test(page));
  assert.ok(page.includes('<code id="cli-sha256">' + createHash("sha256").update(readFileSync(join(d, "client/cli/pusharmor.py"))).digest("hex") + "</code>"));
  for (const k of ["foss", "play"]) {
    assert.ok(page.includes('href="https://github.com/tkooda/pusharmor/releases/download/android/v1.2.3/pusharmor-1.2.3-' + k + '.apk">pusharmor-1.2.3-' + k + ".apk</a>"), k);
    assert.ok(page.includes('aria-label="Show QR code for pusharmor-1.2.3-' + k + '.apk"'), k);
  }
  assert.ok(page.includes("apksigner verify --print-certs pusharmor-1.2.3-foss.apk"));
  assert.ok(!/releases\/download\/android\/v(?!1\.2\.3\/)/.test(page));
  assert.ok(!/pusharmor-(?!1\.2\.3-)[0-9][^"<\s/]*-(foss|play)\.apk/.test(page));
  // The APK and certificate SHA-256 values are not stamped (CI signs the APKs later).
  const hashes = (h) => ["apk-foss-sha256", "apk-play-sha256", "apk-cert-sha256"].map((id) => new RegExp('<code id="' + id + '">([^<]*)<').exec(h)[1]);
  assert.deepEqual(hashes(page), hashes(readFileSync(join(REPO, "site/public/download.html"), "utf8")));
  git("commit", "-q", "-am", "release 1.2.3");
  r = run("android", "1.2.3");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /tagged: android\/v1\.2\.3/);
  assert.equal(git("cat-file", "-t", "android/v1.2.3"), "tag");
  assert.equal(run("ios", "1.2.3").status, 0);
  r = run("--check", "ios/v1.2.3");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "1.2.3");

  // A later commit may take 1.2.3 for another platform (one stamp commit per
  // platform), and an older version is refused before stamping.
  git("commit", "-q", "--allow-empty", "-m", "next");
  r = run("chrome", "1.2.3");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /tagged: chrome\/v1\.2\.3/);
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
  run("0.1.0", "chrome", "worker");
  git("commit", "-q", "-am", "release 0.1.0");
  const env = (date) => ({ ...process.env, GIT_COMMITTER_DATE: date, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  execFileSync("git", ["tag", "-a", "chrome/v0.1.0", "-m", "w"], { cwd: d, env: env("2026-01-01T00:00:00Z") });
  const first = git("rev-parse", "HEAD");
  run("0.2.0", "chrome");
  git("commit", "-q", "-am", "release 0.2.0");
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
  const { d, git, run, ci, bin } = scratch();
  t.after(() => [d, bin].forEach((p) => rmSync(p, { recursive: true, force: true })));
  // A version far above the repo version files, so the stamp always changes them.
  run("ios", "90.0.7");
  git("commit", "-q", "-am", "release 90.0.7");
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
  run("1.4.0", "chrome");
  git("commit", "-q", "-am", "release 1.4.0");
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

test("platform subset: only those version files change; numbers are shared and never reused", (t) => {
  const { d, git, run, bin } = scratch();
  t.after(() => [d, bin].forEach((p) => rmSync(p, { recursive: true, force: true })));
  const read = (f) => readFileSync(join(d, f), "utf8");
  const page = read("site/public/download.html");
  const fdroid = read("site/public/fdroid/android.txt");
  let r = run("1.2.3", "chrome", "firefox");
  assert.match(read("site/public/fx/beta/updates.json"), /"version": "1\.2\.3"/);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /stamped 1\.2\.3 into the version files of chrome, firefox/);
  assert.match(r.stdout, /git commit -am "release 1\.2\.3"\)/);
  assert.match(read("client/chrome/manifest.json"), /"version": "1\.2\.3"/);
  assert.match(read("client/firefox/manifest.json"), /"version": "1\.2\.3"/);
  assert.ok(!/^versionName=1\.2\.3$/m.test(read("release/version.properties")));
  assert.ok(!/MARKETING_VERSION: "1\.2\.3"/.test(read("client/ios/project.yml")));
  assert.ok(!/VERSION = "1\.2\.3"/.test(read("client/cli/pusharmor.py")));
  assert.equal(read("site/public/download.html"), page);
  assert.equal(read("site/public/fdroid/android.txt"), fdroid);
  git("commit", "-q", "-am", "release 1.2.3");
  r = run("1.2.3", "chrome", "firefox");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git("tag", "-l").split("\n").join(" "), "chrome/v1.2.3 firefox/v1.2.3");
  // The other tags check against their own files only, and a skipped platform stays quiet.
  assert.equal(run("--check", "chrome/v1.2.3").status, 0);
  // Without a platform, or with an unknown one, nothing is tagged.
  assert.equal(run("1.2.3").status, 2);
  assert.equal(run("1.2.3", "nope").status, 1);
  // A lower number than the highest tag is refused.
  git("commit", "-q", "--allow-empty", "-m", "next");
  r = run("1.2.2", "android");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /1\.2\.2 is not greater than the existing tag/);
  // One stamp commit per platform: android joins 1.2.3 on its own later commit.
  r = run("1.2.3", "android");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /stamped 1\.2\.3 into the version files of android/);
  git("commit", "-q", "-am", "release 1.2.3 android");
  assert.equal(run("android", "1.2.3").status, 0);
  assert.equal(run("--check", "android/v1.2.3").status, 0);
  // Next release, worker alone; after it, nothing joins 1.2.3 any more.
  assert.equal(run("1.2.4", "worker").status, 1);
  assert.match(read("server/worker/package.json"), /"version": "1\.2\.4"/);
  assert.equal(JSON.parse(read("server/worker/package-lock.json")).packages[""].version, "1.2.4");
  git("commit", "-q", "-am", "release 1.2.4 worker");
  assert.equal(run("worker", "1.2.4").status, 0);
  assert.equal(run("--check", "worker/v1.2.4").status, 0);
  r = run("1.2.3", "ios");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /1\.2\.3 is not greater than the existing tag worker\/v1\.2\.4/);
  assert.equal(git("tag", "-l", "ios/*"), "");
});

test("one release commit: all platforms stamped in one change, every tag on that one commit", (t) => {
  const { d, git, run, bin } = scratch();
  t.after(() => [d, bin].forEach((p) => rmSync(p, { recursive: true, force: true })));
  const read = (f) => readFileSync(join(d, f), "utf8");
  let r = run("1.5.0", "all", "cli");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /into the version files of android, ios, chrome, firefox, cli/);
  assert.match(r.stdout, /git commit -am "release 1\.5\.0"\)/);
  assert.match(r.stdout, /node release\/tag\.mjs 1\.5\.0 android ios chrome firefox cli/);
  assert.match(read("client/ios/project.yml"), /MARKETING_VERSION: "1\.5\.0"/);
  assert.match(read("client/cli/pusharmor.py"), /VERSION = "1\.5\.0"/);
  assert.match(read("release/version.properties"), /^versionName=1\.5\.0$/m);
  git("commit", "-q", "-am", "release 1.5.0");
  r = run("1.5.0", "all", "cli");
  assert.equal(r.status, 0, r.stderr);
  const head = git("rev-parse", "HEAD");
  const names = ["android", "ios", "chrome", "firefox", "cli"].map((p) => p + "/v1.5.0");
  for (const n of names) {
    assert.equal(git("rev-parse", n + "^{commit}"), head);
    assert.equal(run("--check", n).status, 0, n);
  }
  // Rerun is idempotent.
  assert.equal(run("1.5.0", "all", "cli").status, 0);
});
