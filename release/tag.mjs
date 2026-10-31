// Release tags (owner ruling Q209 B): <platform>/vX.Y.Z, one shared version line.
//   node release/tag.mjs PLATFORM X.Y.Z   owner: stamp the version files, or tag HEAD
//   node release/tag.mjs --check TAG       release jobs: the checked-out tag obeys
//                                          the rules; prints X.Y.Z
//   node release/tag.mjs --ci TAG          first release job: ci-ok is green on the
//                                          commit of TAG (waits for a running CI)
// Rules: a version is bound to one commit (every tag of X.Y.Z points at the same
// commit, and a commit carries one version); a new version (no tag of it yet) is
// greater than every existing tag; the version files at the commit hold X.Y.Z
// (stampProblems).
// Platforms may skip numbers. Android versionCode and the iOS build number are
// buildNumber(X.Y.Z) = X * 1000000 + Y * 1000 + Z, so they grow with the version.
// Tag mode fetches the tags of origin first (when a remote origin exists). When
// the version files do not hold X.Y.Z it writes them and stops: commit, then
// rerun. Otherwise it creates the annotated tag at HEAD; the owner pushes it.
// --check compares only with tags created no later than TAG (a rerun after newer
// tags still passes) and wants an annotated tag (tag mode makes one).
// CI gate (owner ruling Q215 C): tag mode and --ci need a successful ci-ok job of
// the ci workflow (ci.yml, push event) on the commit; any run or attempt counts.
// They read it with gh api (GH_TOKEN with actions: read; --check needs no token).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PLATFORMS = ["android", "ios", "chrome", "firefox", "worker", "cli"];

/** [major, minor, patch] of X.Y.Z (no leading zeros), or null. */
export function parseVersion(v) {
  const m = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(v);
  return m ? m.slice(1).map(Number) : null;
}

/** { platform, version } of a <platform>/vX.Y.Z tag name, or null. */
export function parseTag(name) {
  const m = /^([a-z]+)\/v(.+)$/.exec(name);
  return m && PLATFORMS.includes(m[1]) && parseVersion(m[2]) ? { platform: m[1], version: m[2] } : null;
}

/** Android versionCode and iOS build number of X.Y.Z. */
export function buildNumber(version) {
  const [a, b, c] = parseVersion(version);
  return a * 1000000 + b * 1000 + c;
}

function cmp(x, y) {
  const a = parseVersion(x);
  const b = parseVersion(y);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Problems with X.Y.Z itself. Play caps versionCode at 2100000000. */
export function formatProblems(platform, version) {
  if (!PLATFORMS.includes(platform)) return ["unknown platform " + JSON.stringify(platform) + " (one of " + PLATFORMS.join(", ") + ")"];
  const v = parseVersion(version);
  if (!v) return [JSON.stringify(version) + " is not X.Y.Z (numbers without leading zeros)"];
  const bad = [];
  if (v[1] > 999 || v[2] > 999) bad.push(version + ": minor and patch must be <= 999");
  if (v[0] > 2099) bad.push(version + ": major must be <= 2099");
  return bad;
}

/**
 * Problems with giving `commit` the version `version`. tags: [{ name, commit }] of
 * the existing tags to compare with (names that are not <platform>/vX.Y.Z are ignored).
 */
export function tagProblems(version, commit, tags) {
  const bad = [];
  // A version already bound to this commit is not new: another platform may join it.
  const bound = tags.some((t) => parseTag(t.name)?.version === version && t.commit === commit);
  for (const t of tags) {
    const p = parseTag(t.name);
    if (!p) continue;
    if (p.version === version) {
      if (t.commit !== commit) bad.push(version + " is bound to commit " + t.commit.slice(0, 12) + " by tag " + t.name);
    } else if (t.commit === commit) {
      bad.push("the commit already carries version " + p.version + " (tag " + t.name + ")");
    } else if (!bound && cmp(version, p.version) <= 0) {
      bad.push(version + " is not greater than the existing tag " + t.name);
    }
  }
  return bad;
}

// The version files, relative to the repo root: how to read and write X.Y.Z there.
const FILES = [
  {
    path: "release/version.properties",
    get: (s) => [/^versionName=(.*)$/m.exec(s)?.[1], /^versionCode=(.*)$/m.exec(s)?.[1]],
    want: (v) => [v, String(buildNumber(v))],
    set: (s, v) => s.replace(/^versionName=.*$/m, "versionName=" + v).replace(/^versionCode=.*$/m, "versionCode=" + buildNumber(v)),
  },
  {
    path: "client/cli/pusharmor.py",
    get: (s) => [/^VERSION = "([^"]*)"$/m.exec(s)?.[1], /^# PushArmor command-line client, version (.*)$/m.exec(s)?.[1]],
    want: (v) => [v, v],
    set: (s, v) => s.replace(/^VERSION = "[^"]*"$/m, 'VERSION = "' + v + '"').replace(/^(# PushArmor command-line client, version ).*$/m, "$1" + v),
  },
  ...["client/chrome/manifest.json", "client/firefox/manifest.json"].map((path) => ({
    path,
    get: (s) => [JSON.parse(s).version],
    want: (v) => [v],
    set: (s, v) => s.replace(/("version": )"[^"]*"/, "$1" + JSON.stringify(v)),
  })),
  {
    path: "client/ios/project.yml",
    get: (s) => [/^ *MARKETING_VERSION: "(.*)"$/m.exec(s)?.[1], /^ *CURRENT_PROJECT_VERSION: "(.*)"$/m.exec(s)?.[1]],
    want: (v) => [v, String(buildNumber(v))],
    set: (s, v) => s.replace(/^( *MARKETING_VERSION: ).*$/m, '$1"' + v + '"').replace(/^( *CURRENT_PROJECT_VERSION: ).*$/m, '$1"' + buildNumber(v) + '"'),
  },
];

/** One line per version file under root that does not hold X.Y.Z. */
export function stampProblems(root, version) {
  const bad = [];
  for (const f of FILES) {
    const got = f.get(readFileSync(join(root, f.path), "utf8"));
    const want = f.want(version);
    if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(f.path + " holds " + got.join(" / ") + ", want " + want.join(" / "));
  }
  return bad;
}

/** Writes X.Y.Z into every version file under root. */
export function stamp(root, version) {
  for (const f of FILES) {
    const p = join(root, f.path);
    writeFileSync(p, f.set(readFileSync(p, "utf8"), version));
  }
}

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();

/** Every tag of the repo: { name, commit, date (unix seconds), annotated }. */
function allTags() {
  const out = git(["for-each-ref", "--format=%(refname:strip=2)%09%(objecttype)%09%(objectname)%09%(*objectname)%09%(creatordate:unix)", "refs/tags"]);
  return out.split("\n").filter(Boolean).map((l) => {
    const [name, type, obj, peeled, date] = l.split("\t");
    return { name, commit: peeled || obj, date: Number(date), annotated: type === "tag" };
  });
}

export const CI_JOB = "ci-ok";

const ghApi = (args) => execFileSync("gh", ["api", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** OWNER/REPO: GITHUB_REPOSITORY (Actions), GH_REPO, or the path of the origin URL. */
export function repoName(env = process.env, origin = () => git(["remote", "get-url", "origin"])) {
  const r = env.GITHUB_REPOSITORY || env.GH_REPO || /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(origin())?.[1];
  if (!r) throw new Error("set GH_REPO=OWNER/REPO (no GitHub repository in the origin URL)");
  return r;
}

/** { status, conclusion } of every ci-ok job of the ci workflow's push runs on commit. */
export function ciJobs(commit, gh = ghApi, repo = repoName()) {
  const runs = gh(["repos/" + repo + "/actions/workflows/ci.yml/runs?event=push&per_page=100&head_sha=" + commit, "--jq", ".workflow_runs[].id"]);
  const jobs = [];
  for (const id of runs.split("\n").filter(Boolean)) {
    const out = gh(["--paginate", "repos/" + repo + "/actions/runs/" + id + "/jobs?filter=all&per_page=100", "--jq", '.jobs[] | select(.name == "' + CI_JOB + '") | [.status, .conclusion // ""] | @tsv']);
    for (const l of out.split("\n").filter(Boolean)) {
      const [status, conclusion] = l.split("\t");
      jobs.push({ status, conclusion: conclusion || null });
    }
  }
  return jobs;
}

/** "ok", "pending" (a ci-ok job still runs), or the problem with the ci-ok jobs of commit. */
export function ciState(commit, jobs) {
  if (jobs.some((j) => j.status === "completed" && j.conclusion === "success")) return "ok";
  if (jobs.some((j) => j.status !== "completed")) return "pending";
  const at = " on commit " + commit.slice(0, 12);
  if (!jobs.length) return "no " + CI_JOB + " job of the ci workflow ran" + at + " (push it to main and wait for CI)";
  return CI_JOB + " of the ci workflow did not succeed" + at + " (" + jobs.map((j) => j.conclusion).join(", ") + ")";
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * [] when ci-ok succeeded on commit, else one problem. Polls every intervalMs while
 * a ci-ok job runs or gh api fails, until waitMs has passed (0: one look).
 */
export function ciProblems(commit, { waitMs = 0, intervalMs = 60000, list = ciJobs, sleep = sleepMs, now = Date.now, log = () => {} } = {}) {
  const end = now() + waitMs;
  for (;;) {
    let state;
    try {
      state = ciState(commit, list(commit));
    } catch (e) {
      state = "could not read the ci runs with gh api: " + String(e.stderr || e.message).trim();
    }
    if (state === "ok") return [];
    const retry = state === "pending" || state.startsWith("could not read");
    if (!retry || now() + intervalMs > end) {
      if (state === "pending") return [CI_JOB + " of the ci workflow is still running on commit " + commit.slice(0, 12) + (waitMs ? " after " + Math.round(waitMs / 60000) + " minutes" : "; wait for it and rerun")];
      return [state];
    }
    log("waiting for " + CI_JOB + " on " + commit.slice(0, 12) + ": " + state);
    sleep(intervalMs);
  }
}

function fail(bad) {
  console.error("release tag check failed:\n" + bad.map((b) => "  - " + b).join("\n"));
  process.exit(1);
}

function check(tag) {
  const p = parseTag(tag);
  if (!p) fail([JSON.stringify(tag) + " is not <platform>/vX.Y.Z (" + PLATFORMS.join(", ") + ")"]);
  const bad = formatProblems(p.platform, p.version);
  const tags = allTags();
  const self = tags.find((t) => t.name === tag);
  if (!self) fail(["tag " + tag + " does not exist"]);
  if (!self.annotated) bad.push(tag + " is a lightweight tag; create release tags with node release/tag.mjs");
  if (self.commit !== git(["rev-parse", "HEAD"])) bad.push("HEAD is not the commit of " + tag);
  bad.push(...tagProblems(p.version, self.commit, tags.filter((t) => t.name !== tag && t.date <= self.date)));
  bad.push(...stampProblems(git(["rev-parse", "--show-toplevel"]), p.version));
  if (bad.length) fail(bad);
  console.log(p.version);
}

// The ci-ok gate of the first release job: waits up to 40 minutes for a running CI.
function checkCi(tag) {
  let commit;
  try {
    commit = git(["rev-parse", "--verify", "-q", "refs/tags/" + tag + "^{commit}"]);
  } catch {
    fail(["tag " + tag + " does not exist"]);
  }
  const bad = ciProblems(commit, { waitMs: 40 * 60000, log: (m) => console.error(m) });
  if (bad.length) fail(bad);
  console.log(CI_JOB + " succeeded on " + commit.slice(0, 12));
}

function tagHead(platform, version) {
  const bad = formatProblems(platform, version);
  if (bad.length) fail(bad);
  const root = git(["rev-parse", "--show-toplevel"]);
  if (git(["status", "--porcelain"]) !== "") fail(["the working tree is not clean"]);
  if (git(["remote"]).split("\n").includes("origin")) {
    try {
      execFileSync("git", ["fetch", "--quiet", "--tags", "origin"], { stdio: "inherit" });
    } catch {
      fail(["could not fetch the tags of origin"]);
    }
  }
  const tags = allTags();
  const name = platform + "/v" + version;
  const head = git(["rev-parse", "HEAD"]);
  if (stampProblems(root, version).length) {
    // A new release commit: X.Y.Z must be new and greater than every tag.
    const bad = tagProblems(version, "(new commit)", tags);
    if (bad.length) fail(bad);
    stamp(root, version);
    console.log("stamped " + version + " into the version files; nothing tagged.");
    console.log("review and commit them (git commit -am \"release " + version + "\"), then rerun:");
    console.log("  node release/tag.mjs " + platform + " " + version);
    process.exit(1);
  }
  const bad2 = tagProblems(version, head, tags.filter((t) => t.name !== name));
  const own = tags.find((t) => t.name === name);
  if (own && own.commit !== head) bad2.push("tag " + name + " already exists at another commit");
  if (bad2.length) fail(bad2);
  const ci = ciProblems(head);
  if (ci.length) fail(ci);
  if (!own) git(["tag", "-a", name, "-m", platform + " " + version, head]);
  console.log((own ? "tag exists: " : "tagged: ") + name + " at " + head.slice(0, 12));
  console.log("push it to start the " + platform + " release: git push origin " + name);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "--check") check(args[1]);
  else if (args.length === 2 && args[0] === "--ci") checkCi(args[1]);
  else if (args.length === 2 && !args[0].startsWith("-")) tagHead(args[0], args[1]);
  else {
    console.error("usage: node release/tag.mjs PLATFORM X.Y.Z | --check PLATFORM/vX.Y.Z | --ci PLATFORM/vX.Y.Z");
    process.exit(2);
  }
}
