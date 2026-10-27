// Release preflight tests. Run: node --test server/deploy/
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function tree() {
  const d = mkdtempSync(join(tmpdir(), "pa-deploy-"));
  mkdirSync(join(d, "server", "worker"), { recursive: true });
  mkdirSync(join(d, "release"));
  cpSync(join(REPO, "server", "deploy"), join(d, "server", "deploy"), { recursive: true });
  cpSync(join(REPO, "server", "worker", "wrangler.jsonc"), join(d, "server", "worker", "wrangler.jsonc"));
  cpSync(join(REPO, "release", "names.json"), join(d, "release", "names.json"));
  return d;
}

const DASHBOARD_VARS = Object.keys(JSON.parse(readFileSync(join(REPO, "release", "names.json"), "utf8")).cloudflare_vars);

// Stub wrangler: logs every call; answers the two read-only calls with the given dashboard vars.
function stub(d, vars) {
  const bin = join(d, "bin");
  mkdirSync(bin);
  const bindings = Object.entries(vars).map(([name, text]) => ({ type: "plain_text", name, text }));
  bindings.push({ type: "secret_text", name: "VAPID_PRIVATE_JWK" });
  writeFileSync(join(d, "status.json"), JSON.stringify({ versions: [{ version_id: "v1", percentage: 100 }] }));
  writeFileSync(join(d, "version.json"), JSON.stringify({ id: "v1", resources: { bindings } }));
  const w = join(bin, "wrangler");
  writeFileSync(w, '#!/bin/sh\necho "$@" >> "' + join(d, "calls.log") + '"\n' +
    'case "$1 $2" in\n' +
    '  "deployments status") cat "' + join(d, "status.json") + '" ;;\n' +
    '  "versions view") cat "' + join(d, "version.json") + '" ;;\n' +
    'esac\nexit 0\n');
  chmodSync(w, 0o755);
  return w;
}

const all = () => Object.fromEntries(DASHBOARD_VARS.map((k) => [k, k.startsWith("GOOGLE_AUD") ? '["a"]' : "x"]));
const calls = (d) => readFileSync(join(d, "calls.log"), "utf8").trim().split("\n");

function run(d, w) {
  return spawnSync("bash", [join(d, "server", "deploy", "deploy.sh"), "worker/v9.9.9"], {
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "acct", WRANGLER: w }
  });
}

test("committed wrangler configs pass the file preflight (no ids, keep_vars true)", () => {
  const r = spawnSync("node", [join(REPO, "server", "deploy", "preflight.mjs"), REPO], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("deploy.sh aborts on missing dashboard vars after read-only wrangler calls only", () => {
  const d = tree();
  try {
    const vars = all();
    delete vars.GOOGLE_FCM_PROJECT_ID;
    vars.AWS_SES_MAIL_FROM = "";
    vars.APPLE_APNS_TOPIC = "PLACEHOLDER_TOPIC";
    vars.GOOGLE_AUD_WEB = "[]";
    const w = stub(d, vars);
    const r = run(d, w);
    assert.notEqual(r.status, 0);
    assert.deepEqual(calls(d), ["deployments status --json", "versions view v1 --json"]);
    assert.match(r.stderr, /var GOOGLE_FCM_PROJECT_ID is missing or empty/);
    assert.match(r.stderr, /var AWS_SES_MAIL_FROM is missing or empty/);
    assert.match(r.stderr, /var GOOGLE_AUD_WEB is missing or empty/);
    assert.match(r.stderr, /var APPLE_APNS_TOPIC is a PLACEHOLDER/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("dashboard preflight passes with every var set", () => {
  const d = tree();
  try {
    const w = stub(d, all());
    const r = spawnSync("node", [join(d, "server", "deploy", "preflight.mjs"), "--dashboard", d], {
      encoding: "utf8", env: { ...process.env, WRANGLER: w }
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(calls(d), ["deployments status --json", "versions view v1 --json"]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("file preflight aborts on an id in the repo config or a missing keep_vars, before any wrangler call", () => {
  const d = tree();
  try {
    const wp = join(d, "server", "worker", "wrangler.jsonc");
    const mp = join(d, "server", "deploy", "maintenance", "wrangler.jsonc");
    const parse = (p) => JSON.parse(readFileSync(p, "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"));
    const j = parse(wp);
    j.vars.AWS_SES_MAIL_FROM = "codes@example.com";
    j.d1_databases[0].database_id = "11111111-2222-3333-4444-555555555555";
    delete j.keep_vars;
    j.env = { staging: { d1_databases: [{ binding: "DB", database_name: "x" }], vars: { X: "PLACEHOLDER_X" } } };
    writeFileSync(wp, JSON.stringify(j));
    const m = parse(mp);
    delete m.keep_vars;
    writeFileSync(mp, JSON.stringify(m));
    const w = stub(d, all());
    const r = run(d, w);
    assert.notEqual(r.status, 0);
    assert.throws(() => calls(d), "wrangler was called");
    assert.match(r.stderr, /vars\.AWS_SES_MAIL_FROM must not be in the repo/);
    assert.match(r.stderr, /DB has a database_id/);
    assert.match(r.stderr, /wrangler\.jsonc: keep_vars must be true/);
    assert.match(r.stderr, /maintenance\/wrangler\.jsonc: keep_vars must be true/);
    assert.match(r.stderr, /env\.staging\.vars\.X is a PLACEHOLDER/);
    delete j.d1_databases;
    writeFileSync(wp, JSON.stringify(j));
    const r2 = spawnSync("node", [join(d, "server", "deploy", "preflight.mjs"), d], { encoding: "utf8" });
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /d1_databases has no entry/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
