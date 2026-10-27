// Release preflight for deploy.sh.
//   node preflight.mjs [REPO_ROOT]              file checks; never calls wrangler
//   node preflight.mjs --dashboard [REPO_ROOT]  read-only wrangler check of the dashboard vars
// Exits 1 and lists every offending key. Deployment ids are Cloudflare dashboard
// variables (keep_vars keeps them on deploy); the repo wrangler.jsonc must not hold them.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const dashboard = args.includes("--dashboard");
const rootArg = args.find((a) => a !== "--dashboard");
const root = resolve(rootArg || join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const problems = [];

// Set in the Cloudflare dashboard (Worker > Settings > Variables and Secrets), never in the repo.
const DASHBOARD_VARS = [
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

function fileChecks() {
  const f = "server/worker/wrangler.jsonc";
  const w = jsonc(f);
  function checkBlock(b, label) {
    const dbs = b.d1_databases || [];
    if (!Array.isArray(dbs) || dbs.length === 0) problems.push(f + ": " + label + "d1_databases has no entry");
    for (const d of Array.isArray(dbs) ? dbs : []) {
      if (d.database_id !== undefined) {
        problems.push(f + ": " + label + "d1_databases " + d.binding + " has a database_id; remove it (wrangler finds the id by database_name)");
      } else if (typeof d.database_name !== "string" || d.database_name === "") {
        problems.push(f + ": " + label + "d1_databases " + d.binding + " has no database_name");
      }
    }
    const vars = b.vars || {};
    for (const k of DASHBOARD_VARS) {
      if (k in vars) problems.push(f + ": " + label + "vars." + k + " must not be in the repo; set it in the Cloudflare dashboard");
    }
    for (const [k, v] of Object.entries(vars)) {
      if (hasPlaceholder(v)) problems.push(f + ": " + label + "vars." + k + " is a PLACEHOLDER");
    }
  }
  if (w) {
    if (w.keep_vars !== true) problems.push(f + ": keep_vars must be true (a deploy would delete the dashboard vars)");
    checkBlock(w, "");
    for (const [name, e] of Object.entries(w.env || {})) checkBlock(e || {}, "env." + name + ".");
  }
  const m = jsonc("server/deploy/maintenance/wrangler.jsonc");
  if (m && m.keep_vars !== true) problems.push("server/deploy/maintenance/wrangler.jsonc: keep_vars must be true (a deploy would delete the dashboard vars)");
}

// Read-only: "deployments status" and "versions view" never change the Worker.
function dashboardChecks() {
  const wrangler = process.env.WRANGLER || join(root, "server", "worker", "node_modules", ".bin", "wrangler");
  const cwd = join(root, "server", "worker");
  const run = (a) => JSON.parse(execFileSync(wrangler, a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
  let status;
  try { status = run(["deployments", "status", "--json"]); } catch (e) {
    problems.push("wrangler deployments status failed (" + e.message.split("\n")[0] + "); is the Worker created and are you logged in?");
    return;
  }
  const ids = (status.versions || []).map((v) => v.version_id).filter(Boolean);
  if (!ids.length) { problems.push("dashboard: no deployed version found"); return; }
  for (const id of ids) {
    let v;
    try { v = run(["versions", "view", id, "--json"]); } catch (e) {
      problems.push("wrangler versions view " + id + " failed (" + e.message.split("\n")[0] + ")");
      continue;
    }
    const vars = {};
    for (const b of (v.resources && v.resources.bindings) || []) {
      if (b.type === "plain_text") vars[b.name] = b.text;
      else if (b.type === "json") vars[b.name] = JSON.stringify(b.json);
    }
    for (const k of DASHBOARD_VARS) {
      if (isEmpty(vars[k])) problems.push("dashboard: version " + id + " var " + k + " is missing or empty");
      else if (hasPlaceholder(vars[k])) problems.push("dashboard: version " + id + " var " + k + " is a PLACEHOLDER");
    }
  }
}

if (dashboard) dashboardChecks(); else fileChecks();

if (problems.length) {
  console.error("release preflight failed; fix these before a deploy:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log(dashboard ? "dashboard preflight passed." : "release preflight passed.");
