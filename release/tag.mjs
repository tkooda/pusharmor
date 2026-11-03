// Release tags: <platform>/vX.Y.Z, one shared version line.
//   node release/tag.mjs X.Y.Z PLATFORM...  owner: stamp the version files of those
//                                          platforms, or tag HEAD (PLATFORM X.Y.Z with
//                                          one platform also works; "all" = android
//                                          ios chrome firefox; platforms are required)
//   node release/tag.mjs --check TAG       release jobs: the checked-out tag obeys
//                                          the rules; prints X.Y.Z
//   node release/tag.mjs --ci TAG          first release job: the release gate of the
//                                          tag's platform passed on the commit of TAG
//                                          (waits for a running CI)
// Rules: a commit carries one version; the tags of X.Y.Z (one stamp commit per
// platform) are on commits of one line of history, and versions grow along it; a
// new version (no tag of it yet) is greater than every existing tag; the version
// files at the commit hold X.Y.Z
// (stampProblems), /download holds the SHA-256 of pusharmor.py at the commit, and
// /fdroid/android.txt holds the Android versionName and versionCode, and
// /fx/beta/updates.json points at the Firefox Beta XPI of X.Y.Z.
// One shared counter, but a release tags only the platforms that changed:
// platforms skip numbers, so each platform's version files are stamped and checked
// for that platform alone. Android versionCode and the iOS build number are
// buildNumber(X.Y.Z) = X * 1000000 + Y * 1000 + Z, so they grow with the version.
// Tag mode fetches the tags of origin first (when a remote origin exists). When
// the version files do not hold X.Y.Z it writes them and stops: commit, then
// rerun. Otherwise it creates the annotated tag at HEAD; the owner pushes it.
// --check compares only with tags created no later than TAG (a rerun after newer
// tags still passes) and wants an annotated tag (tag mode makes one).
// Release gate (per platform): tag mode and --ci need one push run of the ci
// workflow (ci.yml) on the commit whose jobs of the platform (GATE) and of the
// shared checks (repo: ASCII, no-ids and the other whole-repo checks; vectors) all
// ran and succeeded; a component that was skipped is not a pass. Another
// platform's jobs do not count, so a slow platform never holds up the others.
// They read it with gh api (GH_TOKEN with actions: read; --check needs no token).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLIENTS = ["android", "ios", "chrome", "firefox"];
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
 * isAncestor(a, b): commit a is an earlier commit in the history of commit b.
 * Each platform has its own stamp commit, so the tags of X.Y.Z may be on several
 * commits, as long as they are on one line of history: a tag of X.Y.Z on a
 * commit that is neither before nor after this one is a problem. Other versions:
 * a tag on an earlier commit must be lower, a tag on a later commit higher.
 */
export function tagProblems(version, commit, tags, isAncestor = () => false) {
  const bad = [];
  // A version already bound to this commit is not new: another platform may join it.
  const bound = tags.some((t) => parseTag(t.name)?.version === version && t.commit === commit);
  for (const t of tags) {
    const p = parseTag(t.name);
    if (!p || t.commit === commit) {
      if (p && p.version !== version) bad.push("the commit already carries version " + p.version + " (tag " + t.name + ")");
      continue;
    }
    const before = isAncestor(t.commit, commit);
    const after = !before && isAncestor(commit, t.commit);
    if (p.version === version) {
      if (!before && !after) bad.push(version + " is bound to commit " + t.commit.slice(0, 12) + " by tag " + t.name + ", which is not in the history of this commit");
    } else if (after) {
      if (cmp(version, p.version) >= 0) bad.push(version + " is not lower than the tag " + t.name + " on a later commit");
    } else if ((before || !bound) && cmp(version, p.version) <= 0) {
      bad.push(version + " is not greater than the existing tag " + t.name);
    }
  }
  return bad;
}

const cliSha256 = (root) => createHash("sha256").update(readFileSync(join(root, "client/cli/pusharmor.py"))).digest("hex");

// The version files, relative to the repo root: how to read and write X.Y.Z there.
const FILES = [
  {
    path: "release/version.properties",
    platforms: ["android"],
    get: (s) => [/^versionName=(.*)$/m.exec(s)?.[1], /^versionCode=(.*)$/m.exec(s)?.[1]],
    want: (v) => [v, String(buildNumber(v))],
    set: (s, v) => s.replace(/^versionName=.*$/m, "versionName=" + v).replace(/^versionCode=.*$/m, "versionCode=" + buildNumber(v)),
  },
  {
    path: "client/cli/pusharmor.py",
    platforms: ["cli"],
    get: (s) => [/^VERSION = "([^"]*)"$/m.exec(s)?.[1], /^# PushArmor command-line client, version (.*)$/m.exec(s)?.[1]],
    want: (v) => [v, v],
    set: (s, v) => s.replace(/^VERSION = "[^"]*"$/m, 'VERSION = "' + v + '"').replace(/^(# PushArmor command-line client, version ).*$/m, "$1" + v),
  },
  ...["chrome", "firefox"].map((pl) => ({
    path: "client/" + pl + "/manifest.json",
    platforms: [pl],
    get: (s) => [JSON.parse(s).version],
    want: (v) => [v],
    set: (s, v) => s.replace(/("version": )"[^"]*"/, "$1" + JSON.stringify(v)),
  })),
  {
    path: "client/ios/project.yml",
    platforms: ["ios"],
    get: (s) => [/^ *MARKETING_VERSION: "(.*)"$/m.exec(s)?.[1], /^ *CURRENT_PROJECT_VERSION: "(.*)"$/m.exec(s)?.[1]],
    want: (v) => [v, String(buildNumber(v))],
    set: (s, v) => s.replace(/^( *MARKETING_VERSION: ).*$/m, '$1"' + v + '"').replace(/^( *CURRENT_PROJECT_VERSION: ).*$/m, '$1"' + buildNumber(v) + '"'),
  },
  // The Worker: the version of its npm package and of the lockfile root (both
  // lockfile entries), so a worker release has a stamp commit like the clients.
  {
    path: "server/worker/package.json",
    platforms: ["worker"],
    get: (s) => [JSON.parse(s).version],
    want: (v) => [v],
    set: (s, v) => s.replace(/("version": )"[^"]*"/, "$1" + JSON.stringify(v)),
  },
  {
    path: "server/worker/package-lock.json",
    platforms: ["worker"],
    get: (s) => [JSON.parse(s).version, JSON.parse(s).packages[""].version],
    want: (v) => [v, v],
    set: (s, v) => {
      let n = 0;
      return s.replace(/("version": )"[^"]*"/g, (m, k) => (n++ < 2 ? k + JSON.stringify(v) : m));
    },
  },
  // The F-Droid update check (UpdateCheckMode HTTP): versionName, then versionCode.
  {
    path: "site/public/fdroid/android.txt",
    platforms: ["android"],
    get: (s) => s.split("\n").slice(0, 2),
    want: (v) => [v, String(buildNumber(v))],
    set: (s, v) => v + "\n" + buildNumber(v) + "\n",
  },
  // The command-line row of /download: X.Y.Z in each release asset URL and the
  // SHA-256 of pusharmor.py (stamp writes pusharmor.py first).
  {
    path: "site/public/download.html",
    platforms: ["cli"],
    get: (s) => [[...new Set([...s.matchAll(/\/releases\/download\/cli\/v([^/"<]*)\/pusharmor\.py/g)].map((m) => m[1]))].join(", "), /<code id="cli-sha256">([^<]*)<\/code>/.exec(s)?.[1]],
    want: (v, root) => [v, cliSha256(root)],
    set: (s, v, root) => s.replaceAll(/(\/releases\/download\/cli\/v)[^/"<]*(\/pusharmor\.py)/g, "$1" + v + "$2").replace(/(<code id="cli-sha256">)[^<]*/, "$1" + cliSha256(root)),
  },
  // The APK rows of /download: X.Y.Z in the foss and play release URLs (tag
  // android/vX.Y.Z) and in each APK file name (link text, QR label, command).
  // The SHA-256 values are known only after CI signs the APKs: not stamped.
  {
    path: "site/public/download.html",
    platforms: ["android"],
    get: (s) => [
      [...new Set([...s.matchAll(/\/releases\/download\/android\/v([^/"<]*)\//g)].map((m) => m[1]))].join(", "),
      [...new Set([...s.matchAll(/pusharmor-([0-9][^"<\s/]*)-(?:foss|play)\.apk/g)].map((m) => m[1]))].join(", "),
    ],
    want: (v) => [v, v],
    set: (s, v) => s.replaceAll(/(\/releases\/download\/android\/v)[^/"<]*\//g, "$1" + v + "/").replaceAll(/pusharmor-[0-9][^"<\s/]*-(foss|play)\.apk/g, "pusharmor-" + v + "-$1.apk"),
  },
  // The self-hosted update manifest of the Firefox Beta add-on: X.Y.Z and the
  // URL of the signed Beta XPI of the tag firefox/vX.Y.Z.
  {
    path: "site/public/fx/beta/updates.json",
    platforms: ["firefox"],
    get: (s) => {
      const u = Object.values(JSON.parse(s).addons)[0].updates[0];
      return [u.version, u.update_link];
    },
    want: (v) => [v, betaXpiUrl(v)],
    set: (s, v) => {
      const j = JSON.parse(s);
      const u = Object.values(j.addons)[0].updates[0];
      u.version = v;
      u.update_link = betaXpiUrl(v);
      return JSON.stringify(j, null, 2) + "\n";
    },
  },
];

const filesOf = (platforms) => FILES.filter((f) => f.platforms.some((p) => platforms.includes(p)));

/** The URL of the signed Firefox Beta XPI of X.Y.Z in GitHub Releases. */
export function betaXpiUrl(v) {
  return "https://github.com/tkooda/pusharmor/releases/download/firefox/v" + v + "/pusharmor-firefox-beta-" + v + ".xpi";
}

/** One line per version file of platforms under root that does not hold X.Y.Z. */
export function stampProblems(root, version, platforms = PLATFORMS) {
  const bad = [];
  for (const f of filesOf(platforms)) {
    const got = f.get(readFileSync(join(root, f.path), "utf8"));
    const want = f.want(version, root);
    if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(f.path + " holds " + got.join(" / ") + ", want " + want.join(" / "));
  }
  return bad;
}

/** Writes X.Y.Z into the version files of platforms under root. */
export function stamp(root, version, platforms = PLATFORMS) {
  for (const f of filesOf(platforms)) {
    const p = join(root, f.path);
    writeFileSync(p, f.set(readFileSync(p, "utf8"), version, root));
  }
}

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();

/** a is an earlier commit in the history of b (git merge-base --is-ancestor). */
function isAncestor(a, b) {
  if (a === b) return false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", a, b], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Every tag of the repo: { name, commit, date (unix seconds), annotated }. */
function allTags() {
  const out = git(["for-each-ref", "--format=%(refname:strip=2)%09%(objecttype)%09%(objectname)%09%(*objectname)%09%(creatordate:unix)", "refs/tags"]);
  return out.split("\n").filter(Boolean).map((l) => {
    const [name, type, obj, peeled, date] = l.split("\t");
    return { name, commit: peeled || obj, date: Number(date), annotated: type === "tag" };
  });
}

// The ci.yml jobs a release of each platform needs on its commit, by the job id of
// the called workflow in ci.yml (job names "<id> / <name>"): the platform's own
// jobs, plus the site checks where the stamp writes files under site/.
export const GATE = {
  android: ["android", "site"],
  ios: ["ios"],
  chrome: ["webext"],
  firefox: ["webext", "site"],
  worker: ["worker"],
  cli: ["cli", "site"],
};
// The shared checks every release needs: repo.yml (ASCII, no-ids, ...) and the vectors.
export const SHARED = ["repo", "vectors"];
export const gateGroups = (platform) => [...SHARED, ...GATE[platform]];

const ghApi = (args) => execFileSync("gh", ["api", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** OWNER/REPO: GITHUB_REPOSITORY (Actions), GH_REPO, or the path of the origin URL. */
export function repoName(env = process.env, origin = () => git(["remote", "get-url", "origin"])) {
  const r = env.GITHUB_REPOSITORY || env.GH_REPO || /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(origin())?.[1];
  if (!r) throw new Error("set GH_REPO=OWNER/REPO (no GitHub repository in the origin URL)");
  return r;
}

/** The ci workflow's push runs on commit: [{ status, jobs: [{ name, status, conclusion }] }],
 *  the jobs of the latest attempt of each run. */
export function ciRuns(commit, gh = ghApi, repo = repoName()) {
  const runs = gh(["repos/" + repo + "/actions/workflows/ci.yml/runs?event=push&per_page=100&head_sha=" + commit, "--jq", ".workflow_runs[] | [.id, .status] | @tsv"]);
  return runs.split("\n").filter(Boolean).map((l) => {
    const [id, status] = l.split("\t");
    const out = gh(["--paginate", "repos/" + repo + "/actions/runs/" + id + "/jobs?filter=latest&per_page=100", "--jq", '.jobs[] | [.name, .status, .conclusion // ""] | @tsv']);
    const jobs = out.split("\n").filter(Boolean).map((j) => {
      const [name, st, conclusion] = j.split("\t");
      return { name, status: st, conclusion: conclusion || null };
    });
    return { status, jobs };
  });
}

/** "ok", "pending" (a needed job still runs), or the problem with the release gate
 *  of platform on commit. A run passes when every group of gateGroups(platform)
 *  has a job that succeeded and none that ended otherwise (a job a component
 *  skips by design, such as the iOS 17 job on a push, is fine; a whole skipped
 *  component is not). Any run passing is enough. */
export function gateState(platform, commit, runs) {
  const groups = gateGroups(platform);
  const why = [];
  let pending = false;
  for (const r of runs) {
    const bad = [];
    let wait = false;
    for (const g of groups) {
      const js = r.jobs.filter((j) => j.name.startsWith(g + " / "));
      const failed = js.filter((j) => j.status === "completed" && j.conclusion !== "success" && j.conclusion !== "skipped");
      if (failed.length) bad.push(failed.map((j) => j.name + ": " + j.conclusion).join(", "));
      else if (js.some((j) => j.status !== "completed") || (r.status !== "completed" && !js.length)) wait = true;
      else if (!js.some((j) => j.conclusion === "success")) bad.push(g + " did not run (skipped)");
    }
    if (!bad.length && !wait) return "ok";
    if (bad.length) why.push(bad.join("; "));
    else pending = true;
  }
  if (pending) return "pending";
  const at = " on commit " + commit.slice(0, 12);
  if (!runs.length) return "no run of the ci workflow on commit " + commit.slice(0, 12) + " (push it to an internal/ branch and wait for CI)";
  return "the " + platform + " release gate (" + groups.join(", ") + ") did not pass" + at + ": " + why.join(" | ");
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * [] when the release gate of platform passed on commit, else one problem. Polls
 * every intervalMs while a needed job runs or gh api fails, until waitMs has
 * passed (0: one look).
 */
export function ciProblems(platform, commit, { waitMs = 0, intervalMs = 15000, list = ciRuns, sleep = sleepMs, now = Date.now, log = () => {} } = {}) {
  const end = now() + waitMs;
  for (;;) {
    let state;
    try {
      state = gateState(platform, commit, list(commit));
    } catch (e) {
      state = "could not read the ci runs with gh api: " + String(e.stderr || e.message).trim();
    }
    if (state === "ok") return [];
    const retry = state === "pending" || state.startsWith("could not read");
    if (!retry || now() + intervalMs > end) {
      if (state === "pending") return ["the " + platform + " jobs of the ci workflow are still running on commit " + commit.slice(0, 12) + (waitMs ? " after " + Math.round(waitMs / 60000) + " minutes" : "; wait for them and rerun")];
      return [state];
    }
    log("waiting for the " + platform + " release gate on " + commit.slice(0, 12) + ": " + state);
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
  bad.push(...tagProblems(p.version, self.commit, tags.filter((t) => t.name !== tag && t.date <= self.date), isAncestor));
  bad.push(...stampProblems(git(["rev-parse", "--show-toplevel"]), p.version, [p.platform]));
  if (bad.length) fail(bad);
  console.log(p.version);
}

// The release gate of the first release job: waits up to 40 minutes for a running CI.
function checkCi(tag) {
  const p = parseTag(tag);
  if (!p) fail([JSON.stringify(tag) + " is not <platform>/vX.Y.Z (" + PLATFORMS.join(", ") + ")"]);
  let commit;
  try {
    commit = git(["rev-parse", "--verify", "-q", "refs/tags/" + tag + "^{commit}"]);
  } catch {
    fail(["tag " + tag + " does not exist"]);
  }
  const bad = ciProblems(p.platform, commit, { waitMs: 40 * 60000, log: (m) => console.error(m) });
  if (bad.length) fail(bad);
  console.log("the " + p.platform + " release gate (" + gateGroups(p.platform).join(", ") + ") passed on " + commit.slice(0, 12));
}

function tagHead(platforms, version) {
  const bad = platforms.flatMap((p) => formatProblems(p, version));
  if (bad.length) fail([...new Set(bad)]);
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
  const names = platforms.map((p) => p + "/v" + version);
  const head = git(["rev-parse", "HEAD"]);
  if (stampProblems(root, version, platforms).length) {
    // A new stamp commit, a child of HEAD: X.Y.Z must be new and greater than every
    // tag of any platform, or a version whose tags are in the history of HEAD.
    const NEW = "(new commit)";
    const bad = tagProblems(version, NEW, tags, (a, b) => (b === NEW ? a === head || isAncestor(a, head) : isAncestor(a, b)));
    if (bad.length) fail(bad);
    stamp(root, version, platforms);
    console.log("stamped " + version + " into the version files of " + platforms.join(", ") + "; nothing tagged.");
    console.log("review and commit them (git commit -am \"release " + version + " " + platforms.join(" ") + "\"), then rerun:");
    console.log("  node release/tag.mjs " + version + " " + platforms.join(" "));
    process.exit(1);
  }
  const bad2 = tagProblems(version, head, tags.filter((t) => !names.includes(t.name)), isAncestor);
  for (const n of names) {
    const own = tags.find((t) => t.name === n);
    if (own && own.commit !== head) bad2.push("tag " + n + " already exists at another commit");
  }
  if (bad2.length) fail(bad2);
  const ci = platforms.flatMap((p) => ciProblems(p, head));
  if (ci.length) fail(ci);
  for (const n of names) {
    const own = tags.some((t) => t.name === n);
    if (!own) git(["tag", "-a", n, "-m", n.replace("/v", " "), head]);
    console.log((own ? "tag exists: " : "tagged: ") + n + " at " + head.slice(0, 12));
  }
  // GitHub starts no workflow for a push of more than three tags at once.
  console.log("push each tag on its own to start its release:");
  for (const n of names) console.log("  git push origin " + n);
}

/** { version, platforms } from "X.Y.Z PLATFORM..." or "PLATFORM X.Y.Z", or null. */
export function parseTagArgs(args) {
  const v = args.filter((a) => /^[0-9]/.test(a));
  const rest = args.filter((a) => !/^[0-9]/.test(a));
  if (v.length !== 1 || !rest.length || args.some((a) => a.startsWith("-"))) return null;
  const platforms = [...new Set(rest.flatMap((a) => (a === "all" ? CLIENTS : [a])))];
  return { version: v[0], platforms };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "--check") check(args[1]);
  else if (args.length === 2 && args[0] === "--ci") checkCi(args[1]);
  else if (parseTagArgs(args)) tagHead(parseTagArgs(args).platforms, parseTagArgs(args).version);
  else {
    console.error("usage: node release/tag.mjs X.Y.Z PLATFORM... (or all) | --check PLATFORM/vX.Y.Z | --ci PLATFORM/vX.Y.Z");
    process.exit(2);
  }
}
