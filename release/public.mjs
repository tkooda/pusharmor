// Public build ids from the tracked release/public.json (meanings in
// release/names.json "public_keys"). Release builds fail when a needed value is
// missing, empty or a PLACEHOLDER, or a CI dummy without PA_CI_DUMMY=1; dev
// builds work with the placeholders.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLIC_PATH = join(dirname(fileURLToPath(import.meta.url)), "public.json");

/** The parsed file. Throws when it is missing or not valid JSON. */
export function loadPublic(path = PUBLIC_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** True when v (a string or a list) holds a PLACEHOLDER, or a CI dummy without PA_CI_DUMMY=1. */
export function isUnset(v, env = process.env) {
  const s = JSON.stringify(v);
  return /placeholder/i.test(s) || (/ci-fork-dummy/i.test(s) && env.PA_CI_DUMMY !== "1");
}

/** One line per needed key that is missing, empty, a PLACEHOLDER or a CI dummy (see isUnset). */
export function publicProblems(keys, pub = loadPublic(), env = process.env) {
  const bad = [];
  for (const k of keys) {
    const v = pub[k];
    const empty = v === undefined || v === null || (typeof v === "string" && v.trim() === "") ||
      (Array.isArray(v) && (v.length === 0 || v.some((x) => typeof x !== "string" || x.trim() === "")));
    if (empty) bad.push("release/public.json: " + k + " is missing or empty");
    else if (/placeholder/i.test(JSON.stringify(v))) bad.push("release/public.json: " + k + " is a PLACEHOLDER");
    else if (isUnset(v, env)) bad.push("release/public.json: " + k + " is a CI dummy (allowed only with PA_CI_DUMMY=1)");
  }
  return bad;
}
