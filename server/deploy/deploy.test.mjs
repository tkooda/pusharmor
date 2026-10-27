// Release preflight tests. Run: node --test server/deploy/
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  cpSync(join(REPO, "release", "constants.json"), join(d, "release", "constants.json"));
  return d;
}

function filled(d) {
  const wp = join(d, "server", "worker", "wrangler.jsonc");
  let w = readFileSync(wp, "utf8").replace(/0{8}-0{4}-0{4}-0{4}-0{12}/, "11111111-2222-3333-4444-555555555555");
  w = w.replace(/"(FCM_PROJECT_ID|APNS_TOPIC|APNS_KEY_ID|APNS_TEAM_ID|VAPID_PUBLIC_KEY|VAPID_SUB|SES_REGION|MAIL_FROM|SES_CONFIG_SET|APPLE_AUD_WEB|APPLE_AUD_NATIVE|OAUTH_REDIRECT_CHROME)": ""/g, '"$1": "x"');
  w = w.replace(/"(GOOGLE_AUD_WEB|GOOGLE_AUD_NATIVE)": "\[\]"/g, '"$1": "[\\"a\\"]"');
  writeFileSync(wp, w);
  const c = JSON.parse(readFileSync(join(d, "release", "constants.json"), "utf8"));
  c.release_cert_sha256 = "AA"; c.chrome_extension_id = "abc"; c.chrome_dev_key = "k";
  c.firefox_addon_id = "id@pusharmor.com"; c.vapid_public_key = "v";
  writeFileSync(join(d, "release", "constants.json"), JSON.stringify(c));
}

function stub(d) {
  const bin = join(d, "bin");
  mkdirSync(bin);
  const w = join(bin, "wrangler");
  writeFileSync(w, '#!/bin/sh\necho "$@" >> "' + join(d, "calls.log") + '"\nexit 0\n');
  chmodSync(w, 0o755);
  return w;
}

function run(d, w) {
  return spawnSync("bash", [join(d, "server", "deploy", "deploy.sh"), "9.9.9"], {
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "acct", WRANGLER: w }
  });
}

test("deploy.sh aborts on the committed placeholders before any wrangler call", () => {
  const d = tree();
  try {
    const w = stub(d);
    const r = run(d, w);
    assert.notEqual(r.status, 0);
    assert.equal(existsSync(join(d, "calls.log")), false, "wrangler was called");
    for (const k of ["database_id", "FCM_PROJECT_ID", "APNS_TOPIC", "VAPID_PUBLIC_KEY", "SES_REGION", "MAIL_FROM",
      "GOOGLE_AUD_WEB", "APPLE_AUD_NATIVE", "OAUTH_REDIRECT_CHROME", "release_cert_sha256", "chrome_extension_id"]) {
      assert.ok(r.stderr.includes(k), "missing in output: " + k);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("preflight passes with every value filled, and names a PLACEHOLDER value", () => {
  const d = tree();
  try {
    filled(d);
    const pre = join(d, "server", "deploy", "preflight.mjs");
    let r = spawnSync("node", [pre, d], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const wp = join(d, "server", "worker", "wrangler.jsonc");
    writeFileSync(wp, readFileSync(wp, "utf8").replace('"MAIL_FROM": "x"', '"MAIL_FROM": "PLACEHOLDER_MAIL"'));
    r = spawnSync("node", [pre, d], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /vars\.MAIL_FROM is a PLACEHOLDER/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
