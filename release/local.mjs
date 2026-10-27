// Release build ids from release/local.json: one git-ignored file per owner
// (template: release/local.example.json). Release builds fail when it is
// missing or a needed value is empty or a PLACEHOLDER; dev builds do not need it.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LOCAL_PATH = join(dirname(fileURLToPath(import.meta.url)), "local.json");

/** The parsed file, or null when it does not exist. Throws on invalid JSON. */
export function loadLocal(path = LOCAL_PATH) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

/** One line per needed key that is missing, empty or a PLACEHOLDER. */
export function localProblems(local, keys, path = LOCAL_PATH) {
  if (!local) return [path + " is missing; copy release/local.example.json and fill it"];
  const bad = [];
  for (const k of keys) {
    const v = local[k];
    const empty = v === undefined || v === null || (typeof v === "string" && v.trim() === "") ||
      (Array.isArray(v) && (v.length === 0 || v.some((x) => typeof x !== "string" || x.trim() === "")));
    if (empty) bad.push("release/local.json: " + k + " is missing or empty");
    else if (/placeholder/i.test(JSON.stringify(v))) bad.push("release/local.json: " + k + " is a PLACEHOLDER");
  }
  return bad;
}
