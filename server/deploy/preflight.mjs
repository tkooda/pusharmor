// Release preflight for deploy.sh. Usage: node preflight.mjs [REPO_ROOT]
// Exits 1 and lists every offending key when a release value is still a
// placeholder or empty. It reads files only; it never calls wrangler.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const problems = [];

const REQUIRED_VARS = [
  "FCM_PROJECT_ID", "APNS_TOPIC", "APNS_KEY_ID", "APNS_TEAM_ID",
  "VAPID_PUBLIC_KEY", "VAPID_SUB",
  "SES_REGION", "MAIL_FROM", "SES_CONFIG_SET",
  "GOOGLE_AUD_WEB", "GOOGLE_AUD_NATIVE", "APPLE_AUD_WEB", "APPLE_AUD_NATIVE",
  "OAUTH_REDIRECT_CHROME"
];
const ZERO_ID = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;

function jsonc(rel) {
  const p = join(root, rel);
  if (!existsSync(p)) { problems.push(rel + ": file not found"); return null; }
  const s = readFileSync(p, "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  try { return JSON.parse(s); } catch (e) { problems.push(rel + ": not valid JSON (" + e.message + ")"); return null; }
}

function isEmpty(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "" || t === "[]") return true;
    if (t.startsWith("[")) {
      try { const a = JSON.parse(t); return Array.isArray(a) && a.every((x) => isEmpty(x)); } catch { return false; }
    }
    return false;
  }
  if (Array.isArray(v)) return v.every((x) => isEmpty(x));
  return false;
}

const hasPlaceholder = (v) => JSON.stringify(v).toLowerCase().includes("placeholder");

const w = jsonc("server/worker/wrangler.jsonc");
if (w) {
  for (const d of w.d1_databases || []) {
    if (typeof d.database_id !== "string" || ZERO_ID.test(d.database_id) || hasPlaceholder(d.database_id)) {
      problems.push("server/worker/wrangler.jsonc: d1_databases " + d.binding + " database_id is unset (" + d.database_id + ")");
    }
  }
  const vars = w.vars || {};
  for (const k of REQUIRED_VARS) {
    if (isEmpty(vars[k])) problems.push("server/worker/wrangler.jsonc: vars." + k + " is empty");
  }
  for (const [k, v] of Object.entries(vars)) {
    if (hasPlaceholder(v)) problems.push("server/worker/wrangler.jsonc: vars." + k + " is a PLACEHOLDER");
  }
}

const c = jsonc("release/constants.json");
if (c) {
  for (const [k, v] of Object.entries(c)) {
    if (hasPlaceholder(v) || isEmpty(v)) problems.push("release/constants.json: " + k + " is a placeholder or empty");
  }
}

if (problems.length) {
  console.error("release preflight failed; fill these values before a deploy:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("release preflight passed.");
