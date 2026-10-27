// Release tags (owner ruling Q209 B): <platform>/vX.Y.Z, one shared version line.
//   node release/tag.mjs PLATFORM X.Y.Z   owner: stamp the version files, or tag HEAD
//   node release/tag.mjs --check TAG       release jobs: the checked-out tag obeys
//                                          the rules; prints X.Y.Z
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
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PLATFORMS = ["android", "ios", "chrome", "firefox", "worker"];

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
  if (!own) git(["tag", "-a", name, "-m", platform + " " + version, head]);
  console.log((own ? "tag exists: " : "tagged: ") + name + " at " + head.slice(0, 12));
  console.log("push it to start the " + platform + " release: git push origin " + name);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "--check") check(args[1]);
  else if (args.length === 2 && !args[0].startsWith("-")) tagHead(args[0], args[1]);
  else {
    console.error("usage: node release/tag.mjs PLATFORM X.Y.Z | --check PLATFORM/vX.Y.Z");
    process.exit(2);
  }
}
