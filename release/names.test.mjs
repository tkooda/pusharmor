// Every list of deployment names equals release/names.json. Run: node --test release/names.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const names = JSON.parse(readFileSync(join(REPO, "release", "names.json"), "utf8"));
const keys = (o) => Object.keys(o).sort();

test("release/public.json has exactly the public_keys and a _doc", () => {
  const pub = JSON.parse(readFileSync(join(REPO, "release", "public.json"), "utf8"));
  assert.equal(typeof pub._doc, "string");
  assert.deepEqual(keys(pub).filter((k) => k !== "_doc"), keys(names.public_keys));
});

test("server/worker/.dev.vars.example names exactly the Cloudflare vars and secrets", () => {
  const ex = readFileSync(join(REPO, "server", "worker", ".dev.vars.example"), "utf8");
  const listed = ex.split("\n").filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => l.split("=")[0]).sort();
  assert.deepEqual(listed, [...keys(names.cloudflare_vars), ...keys(names.cloudflare_secrets)].sort());
});

const ALL_CF = () => [...keys(names.cloudflare_vars), ...keys(names.cloudflare_fixed_vars), ...keys(names.cloudflare_secrets)].sort();

test("every Cloudflare name is a field of the Worker Env, and no other string field exists", () => {
  const env = readFileSync(join(REPO, "server", "worker", "src", "env.ts"), "utf8");
  const fields = [...env.matchAll(/^\s+([A-Z][A-Z0-9_]*): string;$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(fields, ALL_CF());
});

test("the vars in server/worker/wrangler.jsonc equal cloudflare_fixed_vars", () => {
  const s = readFileSync(join(REPO, "server", "worker", "wrangler.jsonc"), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.deepEqual(keys(JSON.parse(s).vars), keys(names.cloudflare_fixed_vars));
});

test("Cloudflare names carry a vendor prefix or PA_", () => {
  for (const k of ALL_CF()) assert.match(k, /^(PA_|GOOGLE_|APPLE_|WEBPUSH_|AWS_|CLOUDFLARE_)/, k);
});

test("no old (unprefixed) Cloudflare name remains in the server or release files", () => {
  const OLD = ["FCM_PROJECT_ID", "APNS_TOPIC", "APNS_KEY_ID", "APNS_TEAM_ID", "VAPID_PUBLIC_KEY", "VAPID_SUB",
    "SES_REGION", "MAIL_FROM", "SES_CONFIG_SET", "APPLE_AUD_WEB", "APPLE_AUD_NATIVE", "OAUTH_REDIRECT_CHROME",
    "ALLOWED_PUSH_ENDPOINT_PREFIXES", "PUSH_TTL_SECONDS", "PUSH_PAIR_TTL_SECONDS", "TURNSTILE_HOSTNAME",
    "TURNSTILE_ACTION", "OAUTH_REDIRECT_FIREFOX", "OAUTH_REDIRECT_ANDROID", "OAUTH_REDIRECT_WEB", "WEB_ORIGINS",
    "ID_SECRET", "CODE_SECRET", "CONFIRM_SECRET", "TOKEN_SECRET", "TURNSTILE_SECRET", "SES_ACCESS_KEY_ID",
    "SES_SECRET_ACCESS_KEY", "FCM_SA_EMAIL", "FCM_SA_KEY_ID", "FCM_SA_PRIVATE_KEY", "APNS_KEY_P8", "VAPID_PRIVATE_KEY"];
  const re = new RegExp("\\b(" + OLD.join("|") + ")\\b");
  const files = execFileSync("git", ["ls-files", "server", "release"], { cwd: REPO, encoding: "utf8" })
    .split("\n").filter((f) => f && !f.endsWith("package-lock.json") && f !== "release/names.test.mjs");
  for (const f of files) {
    const lines = readFileSync(join(REPO, f), "utf8").split("\n");
    lines.forEach((l, i) => assert.doesNotMatch(l, re, f + ":" + (i + 1)));
  }
});

test("github_secrets name their GitHub Environment", () => {
  for (const [k, v] of Object.entries(names.github_secrets)) assert.match(v, /GitHub Environment: (ios-release|android-sign|firefox-release)$/, k);
});

test("release/constants.json holds no public build id", () => {
  const c = JSON.parse(readFileSync(join(REPO, "release", "constants.json"), "utf8"));
  for (const k of Object.keys(names.public_keys)) assert.equal(k in c, false, k);
});

test("each release workflow uses only its own store's Workload Identity values", () => {
  const wf = (f) => readFileSync(join(REPO, ".github", "workflows", f), "utf8");
  const webext = wf("webext-release.yml");
  const android = wf("android-release.yml");
  assert.match(webext, /google_cws_wif_provider/);
  assert.doesNotMatch(webext, /google_play_/);
  assert.match(android, /google_play_wif_provider/);
  assert.doesNotMatch(android, /google_cws_/);
});
