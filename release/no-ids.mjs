// Fails if a tracked text file, or the message of any commit reachable from
// HEAD, holds an internal tracking id: a question id in parentheses, a question
// id followed by a ruling letter or after "per", a standalone issue id, a
// review id (upper-case word, dash, two digits), or a session trailer line.
// The patterns are written so this file does not match itself; the test file
// builds its examples by concatenation for the same reason.
// Run: node release/no-ids.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Characters that may touch an id. Base64 (/ + =), dotted and dashed names
// (Android resource ids, versions, IPv6 after ::) and identifier text are not ids.
const PATTERNS = [
  /\(Q\d+\)/g,
  /(?<![\w/+=.:-])Q\d+ [A-H](?![\w-])/g,
  /\bper Q\d+\b/g,
  /(?<![\w/+=.:#-])I\d{2,4}(?![\w/+=-])/g,
  // SHA-256, UTF-16 and RFC-8291 have more or fewer digits, or are allowed below.
  /(?<![\w/+=.:-])[A-Z]{2,}-\d{2}(?![\w/+=.-])/g,
  new RegExp("Claude" + "-Session", "g")
];
// Standard names that have the review-id shape.
const ALLOWED = new Set(["UTF-16", "UTF-32"]);

/** Returns every id-like match in text. */
export function idHits(text) {
  const hits = [];
  for (const re of PATTERNS) for (const m of text.matchAll(re)) if (!ALLOWED.has(m[0])) hits.push(m[0]);
  return hits;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bad = [];
  for (const f of git(["ls-files", "-z"]).split("\0").filter(Boolean)) {
    let buf;
    try { buf = readFileSync(f); } catch { continue; }
    if (buf.includes(0)) continue;
    buf.toString("utf8").split("\n").forEach((line, i) => {
      for (const h of idHits(line)) bad.push(f + ":" + (i + 1) + ": " + h);
    });
  }
  for (const rec of git(["log", "--format=%H%x00%B%x01", "HEAD"]).split("\x01")) {
    const [sha, body = ""] = rec.replace(/^\n/, "").split("\0");
    for (const h of idHits(body)) bad.push("commit " + sha.slice(0, 12) + ": " + h);
  }
  if (bad.length) {
    console.log(bad.join("\n"));
    console.log("internal tracking ids above: keep them out of files and commit messages");
    process.exit(1);
  }
  console.log("no-ids: tree and history clean");
}
