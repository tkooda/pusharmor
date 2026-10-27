// Rewrites the SRI integrity attributes and the CSP script-src hashes in site/public.
// Run before a site PR: node site/tools/hashes.mjs   (--check: report only, exit 1 if stale)
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeHashUpdates } from "./site-lib.mjs";

const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const check = process.argv.includes("--check");
const updates = computeHashUpdates(pub);
for (const [rel, content] of Object.entries(updates)) {
  if (check) console.log("stale: " + rel);
  else {
    writeFileSync(join(pub, rel), content);
    console.log("updated: " + rel);
  }
}
if (check && Object.keys(updates).length) process.exit(1);
