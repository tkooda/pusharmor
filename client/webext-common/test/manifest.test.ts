import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const client = join(import.meta.dirname, "..", "..");
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const constants = read(join(client, "..", "release", "constants.json"));
const localPath = join(client, "..", "release", "local.json");
const local = existsSync(localPath) ? read(localPath) : null;
const chrome = read(join(client, "chrome", "manifest.json"));
const firefox = read(join(client, "firefox", "manifest.json"));

// FIREFOX-MATCH-LIST (component-webext section 6, I271)
const MATCHES = [
  "https://pusharmor.com/fx/setup",
  "https://pusharmor.com/fx/setup?*",
  "https://pusharmor.com/fx/open",
  "https://pusharmor.com/fx/open?*",
  "https://pusharmor.com/auth/done",
  "https://pusharmor.com/auth/done?*",
];
const HOSTS = ["https://api.pusharmor.com/*", "https://pusharmor.com/fx/fwd"];

test("Firefox matches and host permissions equal FIREFOX-MATCH-LIST and release/constants.json", () => {
  assert.equal(firefox.content_scripts.length, 1);
  assert.deepEqual(firefox.content_scripts[0].matches, MATCHES);
  assert.deepEqual(constants.firefox_content_scripts_matches, MATCHES);
  const hosts = firefox.permissions.filter((p: string) => p.includes("://"));
  assert.deepEqual(hosts, HOSTS);
  assert.deepEqual(constants.firefox_host_permissions, HOSTS);
});

test("Firefox data_collection_permissions present; the committed gecko id is a placeholder (the build sets it)", () => {
  const g = firefox.browser_specific_settings.gecko;
  assert.deepEqual(g.data_collection_permissions.required, ["personallyIdentifyingInfo", "personalCommunications"]);
  assert.equal(g.id, "placeholder-addon-id@pusharmor.com");
  assert.equal(g.strict_min_version, "140.0");
  assert.equal(firefox.browser_specific_settings.gecko_android.strict_min_version, "142.0");
  assert.equal(firefox.manifest_version, 2);
  assert.deepEqual(firefox.background, { page: "background.html", persistent: true });
});

test("Chrome manifest: MV3, no key in the committed or release manifest, permissions as designed", () => {
  assert.equal(chrome.manifest_version, 3);
  assert.equal(chrome.minimum_chrome_version, "121");
  assert.equal("key" in chrome, false);
  assert.deepEqual(chrome.permissions, ["notifications", "contextMenus", "storage", "activeTab", "identity", "alarms", "unlimitedStorage", "scripting"]);
  assert.deepEqual(chrome.host_permissions, ["https://api.pusharmor.com/*"]);
  assert.equal("tabs" in chrome.permissions, false);
  const built = join(client, "chrome", "dist", "unpacked", "manifest.json");
  if (existsSync(built) && !existsSync(join(client, "chrome", "dist", "pusharmor-chrome-dev.zip"))) assert.equal("key" in read(built), false);
});

test("Chrome extension id equals the id derived from the dev key (once both are real in release/local.json)", () => {
  const key = (local?.chrome_dev_key ?? "PLACEHOLDER") as string;
  const id = (local?.chrome_extension_id ?? "PLACEHOLDER") as string;
  if (key.startsWith("PLACEHOLDER") || id.startsWith("PLACEHOLDER")) return;
  const h = createHash("sha256").update(Buffer.from(key, "base64")).digest();
  let derived = "";
  for (const b of h.subarray(0, 16)) derived += String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15));
  assert.equal(derived, id);
});

test("release build fails before any output when the local file is missing or holds placeholders", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pa-webext-"));
  try {
    const example = join(client, "..", "release", "local.example.json");
    for (const lp of [join(tmp, "none.json"), example]) {
      const r = spawnSync("node", [join(import.meta.dirname, "..", "build.mjs"), "--local", lp], { encoding: "utf8" });
      assert.equal(r.status, 1, lp);
      assert.match(r.stderr, lp === example ? /vapid_public_key is a PLACEHOLDER/ : /is missing; copy release\/local\.example\.json/);
      assert.doesNotMatch(r.stdout, /built/);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "dist" || n.startsWith(".")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

test("no sync storage anywhere in the extension sources", () => {
  const needle = "storage" + ".sync";
  for (const dir of ["webext-common", "chrome", "firefox"]) {
    for (const f of walk(join(client, dir))) assert.ok(!readFileSync(f, "utf8").includes(needle), f);
  }
});
