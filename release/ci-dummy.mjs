// CI only (pull requests from forks): rewrites release/public.json in place,
// replacing every PLACEHOLDER value with a labeled dummy "ci-fork-dummy-<key>",
// so a run with PA_CI_DUMMY=1 proves the release builds compile. Release jobs
// never run this or set PA_CI_DUMMY. The Firefox add-on id dummy keeps the
// email-like id form. Run: node release/ci-dummy.mjs [FILE]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PUBLIC_PATH } from "./public.mjs";

const SUFFIX = { mozilla_firefox_addon_id: "@pusharmor.com" };

/** Returns [new object, list of changed keys]. */
export function dummyValues(pub) {
  const out = {};
  const changed = [];
  for (const [k, v] of Object.entries(pub)) {
    const d = "ci-fork-dummy-" + k + (SUFFIX[k] || "");
    const one = (x) => (typeof x === "string" && /placeholder/i.test(x) ? d : x);
    out[k] = k.startsWith("_") ? v : Array.isArray(v) ? v.map(one) : one(v);
    if (JSON.stringify(out[k]) !== JSON.stringify(v)) changed.push(k);
  }
  return [out, changed];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2] || PUBLIC_PATH;
  const [out, changed] = dummyValues(JSON.parse(readFileSync(path, "utf8")));
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  console.log(changed.length ? "ci-dummy: " + changed.join(", ") : "ci-dummy: no PLACEHOLDER value");
}
