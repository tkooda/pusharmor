// Release tag rule, asserted by every release job: the tag is <comp>-vX.Y.Z (no rc
// tags), minor and patch are <= 999, and the version is greater than every other
// existing tag of that component. Prints X.Y.Z on success.
//   node release/tag.mjs COMP TAG     (reads the tags with git tag -l)
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const COMPONENTS = ["android", "ios", "chrome", "firefox", "worker"];

/** [major, minor, patch] numbers of a <comp>-vX.Y.Z tag, or null. */
export function parseTag(comp, tag) {
  const m = new RegExp("^" + comp + "-v([0-9]+)\\.([0-9]+)\\.([0-9]+)$").exec(tag);
  return m ? m.slice(1).map(Number) : null;
}

/** One line per broken rule; existing holds every tag name of the repo (others are ignored). */
export function tagProblems(comp, tag, existing) {
  if (!COMPONENTS.includes(comp)) return ["unknown component " + JSON.stringify(comp)];
  const v = parseTag(comp, tag);
  if (!v) return [JSON.stringify(tag) + " does not match " + comp + "-vX.Y.Z"];
  const bad = [];
  if (v[1] > 999 || v[2] > 999) bad.push(tag + ": minor and patch must be <= 999");
  for (const t of existing) {
    const o = parseTag(comp, t);
    if (!o || t === tag) continue;
    const cmp = v[0] - o[0] || v[1] - o[1] || v[2] - o[2];
    if (cmp <= 0) bad.push(tag + " is not greater than the existing tag " + t);
  }
  return bad;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [comp, tag] = process.argv.slice(2);
  if (!comp || !tag) {
    console.error("usage: node release/tag.mjs COMP TAG");
    process.exit(2);
  }
  const existing = execFileSync("git", ["tag", "-l", comp + "-v*"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const bad = tagProblems(comp, tag, existing);
  if (bad.length) {
    console.error("release tag check failed:\n" + bad.map((b) => "  - " + b).join("\n"));
    process.exit(1);
  }
  console.log(parseTag(comp, tag).join("."));
}
