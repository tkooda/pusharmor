// Public build ids from the tracked release/public.json (meanings in
// release/names.json "public_keys"). Release builds fail when a needed value is
// missing, empty or a PLACEHOLDER, or a CI dummy without PA_CI_DUMMY=1, and when
// a Firefox add-on id is not a lowercase GUID in braces; dev builds work with the
// placeholders.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLIC_PATH = join(dirname(fileURLToPath(import.meta.url)), "public.json");

/** The parsed file. Throws when it is missing or not valid JSON. */
export function loadPublic(path = PUBLIC_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Firefox add-on (gecko) ids are lowercase GUIDs in braces. Two reserved fake
// GUIDs: the committed manifest placeholder and the CI fork dummies (ci-dummy.mjs).
export const GECKO_KEYS = ["mozilla_firefox_addon_id", "mozilla_firefox_beta_addon_id"];
export const GECKO_ID_RE = /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/;
export const GECKO_PLACEHOLDER_ID = "{00000000-0000-0000-0000-000000000000}";
export const GECKO_DUMMY_IDS = {
  mozilla_firefox_addon_id: "{00000000-0000-0000-0000-000000000001}",
  mozilla_firefox_beta_addon_id: "{00000000-0000-0000-0000-000000000002}"
};

/** True when the text holds a PLACEHOLDER (the placeholder gecko id included). */
export function isPlaceholder(s) {
  return /placeholder/i.test(s) || s.includes(GECKO_PLACEHOLDER_ID);
}

/** True when the text holds a CI dummy (the dummy gecko ids included). */
export function isDummy(s) {
  return /ci-fork-dummy/i.test(s) || Object.values(GECKO_DUMMY_IDS).some((d) => s.includes(d));
}

/** True when v (a string or a list) holds a PLACEHOLDER, or a CI dummy without PA_CI_DUMMY=1. */
export function isUnset(v, env = process.env) {
  const s = JSON.stringify(v);
  return isPlaceholder(s) || (isDummy(s) && env.PA_CI_DUMMY !== "1");
}

/** One line per needed key that is missing, empty, a PLACEHOLDER or a CI dummy (see isUnset). */
export function publicProblems(keys, pub = loadPublic(), env = process.env) {
  const bad = [];
  for (const k of keys) {
    const v = pub[k];
    const empty = v === undefined || v === null || (typeof v === "string" && v.trim() === "") ||
      (Array.isArray(v) && (v.length === 0 || v.some((x) => typeof x !== "string" || x.trim() === "")));
    if (empty) bad.push("release/public.json: " + k + " is missing or empty");
    else if (isPlaceholder(JSON.stringify(v))) bad.push("release/public.json: " + k + " is a PLACEHOLDER");
    else if (isUnset(v, env)) bad.push("release/public.json: " + k + " is a CI dummy (allowed only with PA_CI_DUMMY=1)");
    else if (GECKO_KEYS.includes(k) && !GECKO_ID_RE.test(v)) bad.push("release/public.json: " + k + " is not a lowercase GUID {xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}");
  }
  return bad;
}

// Release jobs: node release/public.mjs --check KEY... exits 1 and lists every
// needed key that publicProblems reports, and fails when PA_CI_DUMMY is set at all.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [flag, ...keys] = process.argv.slice(2);
  if (flag !== "--check" || keys.length === 0) {
    console.error("usage: node release/public.mjs --check KEY...");
    process.exit(2);
  }
  const bad = process.env.PA_CI_DUMMY !== undefined ? ["PA_CI_DUMMY is set; a release job never sets it"] : [];
  bad.push(...publicProblems(keys));
  if (bad.length) {
    console.error("release values check failed:\n" + bad.map((b) => "  - " + b).join("\n"));
    process.exit(1);
  }
  console.log("release values check: ok (" + keys.join(", ") + ")");
}
