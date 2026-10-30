// Static site checks (component-website-r1 section 9, component-ci-r1 section 4.2).
// Run: node --test site/tools/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  attrs, checkWranglerConfig, computeHashUpdates, cspDirectives, externalLoads, headersFor,
  inlineScripts, listFiles, pageText, parseHeaders, parseJsonc, placeholderFiles, resolvePath, sha256b64, tags,
  unescapeAttr, urlPath
} from "../site-lib.mjs";
import { PUBLIC_PATH, loadPublic } from "../../../release/public.mjs";
import { spawnSync } from "node:child_process";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUB = join(SITE, "public");
const REPO = join(SITE, "..");
const FIX = join(SITE, "tools", "test", "fixtures");
const SITE_NAME = "pusharmor-site";
const TURNSTILE_HOST = "https://challenges.cloudflare.com";
// Cloudflare documented Turnstile test sitekey: always passes, visible widget.
const TURNSTILE_TEST_SITEKEY = "1x00000000000000000000AA";

// PA_RELEASE=1 turns every placeholder skip into a failure and enables the release checks.
const RELEASE = process.env.PA_RELEASE === "1";

const files = listFiles(PUB);
const htmlFiles = files.filter((f) => f.endsWith(".html"));
const read = (rel) => readFileSync(join(PUB, rel), "utf8");
const text = (rel) => pageText(read(rel));
const rules = parseHeaders(read("_headers"));

function siteFiles() {
  const out = [];
  for (const rel of listFiles(SITE)) {
    if (rel.startsWith("node_modules/") || rel.startsWith(".wrangler/") || rel.startsWith("dist/")) continue;
    out.push(rel);
  }
  return out;
}

test("every site file is ASCII", () => {
  for (const rel of siteFiles()) {
    if (/\.(png|ico|webp)$/.test(rel)) continue; // binary images
    const buf = readFileSync(join(SITE, rel));
    const bad = buf.findIndex((b) => b > 127);
    assert.equal(bad, -1, rel + " has a non-ASCII byte at " + bad);
  }
});

test("every page has lang=en, no inline event handlers, no inline style", () => {
  for (const rel of htmlFiles) {
    const html = read(rel);
    assert.match(html, /<html lang="en">/, rel);
    assert.doesNotMatch(html, /<[^>]*\son[a-z]+\s*=/i, rel + ": inline event handler");
    assert.doesNotMatch(html, /<style\b|\sstyle\s*=/i, rel + ": inline style");
  }
});

test("inline scripts only on /auth/android and /auth/done", () => {
  for (const rel of htmlFiles) {
    const n = inlineScripts(read(rel)).length;
    if (rel === "auth/android.html" || rel === "auth/done.html") assert.equal(n, 1, rel);
    else assert.equal(n, 0, rel);
  }
});

test("internal links and resources resolve", () => {
  for (const rel of htmlFiles) {
    const html = read(rel);
    const refs = [];
    for (const [name, key] of [["a", "href"], ["link", "href"], ["script", "src"], ["img", "src"], ["iframe", "src"]]) {
      for (const t of tags(html, name)) if (t.attrs[key] !== undefined) refs.push(unescapeAttr(t.attrs[key]));
    }
    for (const r of refs) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(r) || r.startsWith("//")) continue;
      if (r.startsWith("#")) {
        assert.ok(html.includes(' id="' + r.slice(1) + '"'), rel + ": no target for " + r);
        continue;
      }
      assert.ok(r.startsWith("/"), rel + ": use site-absolute links: " + r);
      assert.ok(resolvePath(files, r), rel + ": broken link " + r);
    }
  }
  for (const rel of files.filter((f) => f.endsWith(".js"))) {
    for (const m of read(rel).matchAll(/importScripts\(\s*"([^"]+)"\s*\)/g)) assert.ok(resolvePath(files, m[1]), rel + ": " + m[1]);
  }
});

test("SRI and CSP hashes are current (run node site/tools/hashes.mjs)", () => {
  assert.deepEqual(Object.keys(computeHashUpdates(PUB)), []);
});

test("every script and link tag carries a correct SRI integrity", () => {
  for (const rel of htmlFiles) {
    for (const name of ["script", "link"]) {
      for (const t of tags(read(rel), name)) {
        const ref = name === "script" ? t.attrs.src : t.attrs.href;
        if (ref === undefined) continue;
        if (rel === "turnstile.html" && ref.startsWith(TURNSTILE_HOST + "/")) continue;
        assert.ok(ref.startsWith("/"), rel + ": external " + ref);
        const want = "sha256-" + sha256b64(readFileSync(join(PUB, resolvePath(files, ref))));
        assert.equal(t.attrs.integrity, want, rel + ": " + ref);
      }
    }
  }
});

test("every page script hash is in its page CSP; no-JS pages get no script-src", () => {
  for (const rel of htmlFiles) {
    const html = read(rel);
    const h = headersFor(rules, urlPath(rel));
    const d = cspDirectives(h["content-security-policy"][0]);
    const need = [];
    for (const t of tags(html, "script")) {
      if (t.attrs.src && t.attrs.src.startsWith("/")) need.push("'sha256-" + sha256b64(readFileSync(join(PUB, resolvePath(files, t.attrs.src)))) + "'");
    }
    for (const s of inlineScripts(html)) need.push("'sha256-" + sha256b64(s) + "'");
    const hasScript = tags(html, "script").length > 0;
    if (!hasScript) assert.equal(d["script-src"], undefined, rel + ": no-JS page has script-src");
    for (const n of need) assert.ok(d["script-src"].includes(n), rel + ": CSP lacks " + n);
  }
});

test("auth pages: hash-only script-src, no 'self'", () => {
  for (const p of ["/auth/done", "/auth/android"]) {
    const d = cspDirectives(headersFor(rules, p)["content-security-policy"][0]);
    assert.equal(d["script-src"].length, 1, p);
    assert.match(d["script-src"][0], /^'sha256-/, p);
  }
});

test("no third-party loaded resource except Turnstile on /turnstile", () => {
  for (const rel of htmlFiles) {
    for (const u of externalLoads(read(rel))) {
      assert.ok(rel === "turnstile.html" && u.startsWith(TURNSTILE_HOST + "/"), rel + ": external load " + u);
    }
  }
  // CSP hosts: only Turnstile on /turnstile and the API on /delete-account (connect-src).
  for (const r of rules) {
    for (const l of r.lines) {
      if (l.name !== "content-security-policy") continue;
      for (const [dir, toks] of Object.entries(cspDirectives(l.value))) {
        for (const tok of toks) {
          if (!/^https?:/.test(tok)) continue;
          const ok = (r.path === "/turnstile" && tok === TURNSTILE_HOST && (dir === "script-src" || dir === "frame-src")) ||
            (r.path === "/delete-account" && tok === "https://api.pusharmor.com" && dir === "connect-src");
          assert.ok(ok, r.path + ": " + dir + " " + tok);
        }
      }
    }
  }
  // JS files fetch only same-origin or the API (delete-account path via pa-web.js).
  for (const rel of files.filter((f) => f.endsWith(".js"))) {
    for (const m of read(rel).matchAll(/https?:\/\/[a-z0-9.-]+/gi)) {
      assert.ok(["https://pusharmor.com", "https://api.pusharmor.com"].includes(m[0]), rel + ": " + m[0]);
    }
  }
});

test("external-host check ignores plain <a href> (WEB6-02)", () => {
  assert.deepEqual(externalLoads('<a href="https://github.com/tkooda/pusharmor">x</a>'), []);
  assert.deepEqual(externalLoads('<img src="https://example.com/a.png">'), ["https://example.com/a.png"]);
  assert.deepEqual(externalLoads('<script src="//cdn.example.com/x.js"></script>'), ["//cdn.example.com/x.js"]);
});

test("_headers: <= 100 rules, lines <= 2000 chars, exactly one CSP per path", () => {
  assert.ok(rules.length <= 100, "rule count " + rules.length);
  for (const line of read("_headers").split("\n")) assert.ok(line.length <= 2000);
  const paths = files.filter((f) => !f.startsWith("_")).map(urlPath).concat(["/fx/fwd", "/nope"]);
  for (const p of paths) {
    const h = headersFor(rules, p);
    assert.equal((h["content-security-policy"] || []).length, 1, p + " CSP count");
    assert.equal((h["cache-control"] || []).length, 1, p + " Cache-Control count");
    assert.deepEqual(h["strict-transport-security"], ["max-age=63072000; includeSubDomains"], p);
    assert.deepEqual(h["x-content-type-options"], ["nosniff"], p);
    assert.deepEqual(h["referrer-policy"], ["no-referrer"], p);
    const d = cspDirectives(h["content-security-policy"][0]);
    assert.deepEqual(d["default-src"], ["'none'"], p);
    assert.deepEqual(d["base-uri"], ["'none'"], p);
    assert.deepEqual(d["form-action"], ["'none'"], p);
  }
});

test("per-path headers", () => {
  const ts = headersFor(rules, "/turnstile");
  assert.deepEqual(ts["cache-control"], ["no-store"]);
  assert.deepEqual(ts["x-robots-tag"], ["noindex"]);
  const tsd = cspDirectives(ts["content-security-policy"][0]);
  assert.deepEqual(tsd["frame-src"], [TURNSTILE_HOST]);
  assert.equal(tsd["frame-ancestors"][0], "'self'");
  assert.ok(tsd["frame-ancestors"].includes("moz-extension:"));
  for (const p of ["/fx/setup", "/fx/open", "/fx/sw.js"]) {
    const h = headersFor(rules, p);
    assert.deepEqual(h["x-robots-tag"], ["noindex"], p);
    assert.deepEqual(h["cache-control"], ["no-cache"], p);
    const d = cspDirectives(h["content-security-policy"][0]);
    assert.deepEqual(d["worker-src"], ["'self'"]);
    assert.deepEqual(d["connect-src"], ["'self'"]);
    assert.deepEqual(d["frame-ancestors"], ["'none'"]);
  }
  assert.deepEqual(headersFor(rules, "/fx/sw.js")["content-type"], ["text/javascript"]);
  for (const p of ["/auth/done", "/auth/android"]) {
    const h = headersFor(rules, p);
    assert.deepEqual(h["cache-control"], ["no-store"], p);
    assert.deepEqual(h["x-robots-tag"], ["noindex"], p);
  }
  const del = cspDirectives(headersFor(rules, "/delete-account")["content-security-policy"][0]);
  assert.deepEqual(del["connect-src"], ["https://api.pusharmor.com"]);
  assert.deepEqual(del["frame-src"], ["'self'"]);
  assert.deepEqual(headersFor(rules, "/.well-known/security.txt")["content-type"], ["text/plain; charset=utf-8"]);
  for (const p of ["/", "/privacy", "/how-to"]) assert.equal(headersFor(rules, p)["x-robots-tag"], undefined, p);
});

test("robots.txt disallows /turnstile, /auth/, /fx/", () => {
  const lines = read("robots.txt").split("\n");
  for (const p of ["/turnstile", "/auth/", "/fx/"]) assert.ok(lines.includes("Disallow: " + p), p);
});

test("site/wrangler.jsonc has only the allowed keys", () => {
  assert.deepEqual(checkWranglerConfig(parseJsonc(readFileSync(join(SITE, "wrangler.jsonc"), "utf8")), SITE_NAME), []);
});

test("wrangler fixture with d1_databases fails", () => {
  const errs = checkWranglerConfig(parseJsonc(readFileSync(join(FIX, "wrangler-d1.jsonc"), "utf8")), SITE_NAME);
  assert.ok(errs.includes("key not allowed: d1_databases"), errs.join("; "));
});

test("wrangler fixture with the allowed routes entry passes", () => {
  assert.deepEqual(checkWranglerConfig(parseJsonc(readFileSync(join(FIX, "wrangler-routes-ok.jsonc"), "utf8")), SITE_NAME), []);
});

test("wrangler fixture with another route fails", () => {
  const errs = checkWranglerConfig(parseJsonc(readFileSync(join(FIX, "wrangler-extra-route.jsonc"), "utf8")), SITE_NAME);
  assert.ok(errs.length > 0);
});

test("site/package.json: private, no scripts, wrangler only at an exact version; node pin", () => {
  const pkg = JSON.parse(readFileSync(join(SITE, "package.json"), "utf8"));
  assert.equal(pkg.private, true);
  assert.equal(pkg.scripts, undefined);
  assert.equal(pkg.dependencies, undefined);
  assert.deepEqual(Object.keys(pkg.devDependencies), ["wrangler"]);
  assert.match(pkg.devDependencies.wrangler, /^\d+\.\d+\.\d+$/);
  const lock = JSON.parse(readFileSync(join(SITE, "package-lock.json"), "utf8"));
  assert.equal(lock.packages["node_modules/wrangler"].version, pkg.devDependencies.wrangler);
  assert.match(readFileSync(join(SITE, ".node-version"), "utf8"), /^\d+\.\d+\.\d+\n$/);
});

test("site wrangler version equals the Worker's", (t) => {
  const p = join(REPO, "server", "worker", "package.json");
  if (!existsSync(p)) { t.skip("server/worker/package.json not present yet"); return; }
  const w = JSON.parse(readFileSync(p, "utf8"));
  const site = JSON.parse(readFileSync(join(SITE, "package.json"), "utf8")).devDependencies.wrangler;
  assert.equal((w.devDependencies || {}).wrangler, site);
});

test("assetlinks.json is valid and names com.pusharmor", () => {
  const a = JSON.parse(read(".well-known/assetlinks.json"));
  assert.equal(a.length, 1);
  assert.deepEqual(a[0].relation, ["delegate_permission/common.handle_all_urls"]);
  assert.equal(a[0].target.namespace, "android_app");
  assert.equal(a[0].target.package_name, "com.pusharmor");
  for (const f of a[0].target.sha256_cert_fingerprints) assert.match(f, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
});

// Builds site/public into a temp dir with the given public file; returns {dir, r}.
function buildCopy(publicPath, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pa-site-build-"));
  const r = spawnSync("node", [join(SITE, "tools", "build.mjs"), "--out", dir, "--public", publicPath],
    { encoding: "utf8", env: { ...process.env, PA_CI_DUMMY: "", ...env } });
  return { dir, r };
}

// Writes a copy of release/public.json with every value a PLACEHOLDER (same keys and
// shapes) into dir and returns its path, so the guards stay tested once real values land.
function placeholderPublic(dir) {
  const lp = join(dir, "public.json");
  const ph = (k) => "PLACEHOLDER_" + k.toUpperCase();
  writeFileSync(lp, JSON.stringify(Object.fromEntries(Object.entries(loadPublic()).map(([k, v]) =>
    [k, k.startsWith("_") ? v : Array.isArray(v) ? [ph(k)] : ph(k)]))));
  return lp;
}

test("wrangler.jsonc runs tools/build.mjs on deploy, and the build skips for wrangler dev", () => {
  const cfg = readFileSync(join(SITE, "wrangler.jsonc"), "utf8");
  assert.match(cfg, /"build"\s*:\s*\{\s*"command"\s*:\s*"node tools\/build\.mjs"\s*\}/);
  const { dir, r } = buildCopy(PUBLIC_PATH, { WRANGLER_COMMAND: "dev" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ids not filled for wrangler dev/);
  assert.deepEqual(placeholderFiles(dir).length, 4);
  const tmp = mkdtempSync(join(tmpdir(), "pa-public-"));
  const d = buildCopy(placeholderPublic(tmp), { WRANGLER_COMMAND: "deploy" });
  assert.notEqual(d.r.status, 0);
  assert.match(d.r.stderr, /is a PLACEHOLDER/);
  rmSync(dir, { recursive: true, force: true });
  rmSync(d.dir, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

test("committed site files hold the placeholders, not ids (release/public.json fills them at build)", () => {
  assert.deepEqual(placeholderFiles(PUB).sort(), [
    "site/public/_headers: CHROME_BETA_EXTENSION_ID",
    "site/public/_headers: CHROME_EXTENSION_ID",
    "site/public/js/fx-setup.js: PLACEHOLDER",
    "site/public/turnstile.html: PLACEHOLDER"
  ]);
  assert.deepEqual(JSON.parse(read(".well-known/assetlinks.json"))[0].target.sha256_cert_fingerprints, []);
});

test("site build fills every id from a public file and leaves current hashes", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pa-public-"));
  const fp = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase()).join(":");
  const lp = join(tmp, "public.json");
  writeFileSync(lp, JSON.stringify({
    cloudflare_turnstile_sitekey: TURNSTILE_TEST_SITEKEY, webpush_vapid_public_key: "BTestVapidKey", google_chrome_extension_id: "abcdefghijklmnopabcdefghijklmnop",
    google_chrome_beta_extension_id: "ponmlkjihgfedcbaponmlkjihgfedcba",
    android_release_cert_sha256: [fp.toLowerCase()]
  }));
  const { dir, r } = buildCopy(lp);
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(placeholderFiles(dir), []);
    assert.deepEqual(computeHashUpdates(dir), {});
    assert.ok(readFileSync(join(dir, "turnstile.html"), "utf8").includes('data-sitekey="' + TURNSTILE_TEST_SITEKEY + '"'));
    assert.ok(readFileSync(join(dir, "js", "fx-setup.js"), "utf8").includes('VAPID_PUBLIC_KEY = "BTestVapidKey"'));
    assert.ok(readFileSync(join(dir, "_headers"), "utf8").includes("chrome-extension://abcdefghijklmnopabcdefghijklmnop chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba"));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, ".well-known", "assetlinks.json"), "utf8"))[0].target.sha256_cert_fingerprints, [fp]);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true }); }
});

test("site build writes a gitignored output dir and leaves the git tree clean (I429)", (t) => {
  if (!existsSync(join(REPO, ".git"))) { t.skip("not a git checkout"); return; }
  const git = (...a) => spawnSync("git", ["-C", REPO, ...a], { encoding: "utf8" });
  assert.equal(git("check-ignore", "-q", "site/dist/index.html").status, 0, "site/dist must be gitignored");
  assert.equal(parseJsonc(readFileSync(join(SITE, "wrangler.jsonc"), "utf8")).assets.directory, "./dist");
  const before = git("status", "--porcelain").stdout;
  const tmp = mkdtempSync(join(tmpdir(), "pa-public-"));
  const out = join(tmp, "out");
  const lp = placeholderPublic(tmp);
  assert.equal(spawnSync("node", [join(REPO, "release", "ci-dummy.mjs"), lp]).status, 0);
  try {
    const r = spawnSync("node", [join(SITE, "tools", "build.mjs"), "--out", out, "--public", lp],
      { encoding: "utf8", env: { ...process.env, PA_CI_DUMMY: "1" } });
    assert.equal(git("status", "--porcelain").stdout, before, "the build changed tracked files");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(placeholderFiles(out), []);
    assert.equal(placeholderFiles(PUB).length, 4);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("site build fails on a missing public file or on placeholders", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pa-public-"));
  const ph = placeholderPublic(tmp);
  try {
    for (const lp of [join(tmpdir(), "pa-no-such-public.json"), ph]) {
      const { dir, r } = buildCopy(lp);
      try {
        assert.equal(r.status, 1, lp);
        assert.match(r.stderr, lp === ph ? /cloudflare_turnstile_sitekey is a PLACEHOLDER/ : /ENOENT/);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("site build takes the CI dummies only with PA_CI_DUMMY=1", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pa-public-"));
  const lp = placeholderPublic(tmp);
  assert.equal(spawnSync("node", [join(REPO, "release", "ci-dummy.mjs"), lp]).status, 0);
  try {
    const no = buildCopy(lp);
    rmSync(no.dir, { recursive: true, force: true });
    assert.equal(no.r.status, 1);
    assert.match(no.r.stderr, /cloudflare_turnstile_sitekey is a CI dummy/);
    const { dir, r } = buildCopy(lp, { PA_CI_DUMMY: "1" });
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(placeholderFiles(dir), []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("placeholder scan names a file that holds only a PLACEHOLDER token", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pa-ph-"));
  try {
    writeFileSync(join(tmp, "ok.html"), '<input placeholder="you@example.com">');
    writeFileSync(join(tmp, "turnstile.html"), '<div data-sitekey="TURNSTILE_SITEKEY_PLACEHOLDER"></div>');
    assert.deepEqual(placeholderFiles(tmp), ["site/public/turnstile.html: PLACEHOLDER"]);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("PA_RELEASE=1: release/public.json builds the site with no placeholder; fdroid version set", (t) => {
  if (!RELEASE) { t.skip("PA_RELEASE=1 not set"); return; }
  const bad = [];
  const { dir, r } = buildCopy(PUBLIC_PATH);
  try {
    if (r.status !== 0) bad.push("site build: " + r.stderr.trim());
    else {
      bad.push(...placeholderFiles(dir));
      const a = JSON.parse(readFileSync(join(dir, ".well-known", "assetlinks.json"), "utf8"));
      if (!a[0].target.sha256_cert_fingerprints.length) bad.push("assetlinks.json: empty sha256_cert_fingerprints");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  if (read("fdroid/android.txt").split("\n")[0] === "0.0.0") bad.push("fdroid/android.txt: version 0.0.0");
  assert.deepEqual(bad, []);
});

test("security.txt: Contact, Expires (> 30 days, <= 1 year), Canonical", () => {
  const s = read(".well-known/security.txt");
  assert.match(s, /^Contact: https:\/\/github\.com\/tkooda\/pusharmor\/security\/advisories\/new$/m);
  assert.ok(!/@|mailto:/i.test(s), "no email address in security.txt");
  assert.match(s, /^Canonical: https:\/\/pusharmor\.com\/\.well-known\/security\.txt$/m);
  const m = /^Expires: (\S+)$/m.exec(s);
  assert.ok(m, "Expires");
  const exp = Date.parse(m[1]);
  const day = 86400000;
  assert.ok(exp - Date.now() > 30 * day, "Expires is within 30 days: renew security.txt");
  assert.ok(exp - Date.now() <= 366 * day, "Expires is more than 1 year ahead");
});

test("fdroid/android.txt: 2 lines, versionName then versionCode", () => {
  const lines = read("fdroid/android.txt").split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[2], "");
  assert.match(lines[0], /^\d+\.\d+\.\d+$/);
  assert.match(lines[1], /^\d+$/);
});

test("retention: 4 weeks on /privacy; stored list", () => {
  assert.ok(text("privacy.html").includes("4 weeks"));
  const p = text("privacy.html");
  for (const s of ["platform", "paused", "approve messages", "last-active month",
    "We will never sell or share your data. The services below run parts of PushArmor for us and only ever see the minimum needed to do their part.",
    "We do not store your email address. We keep only a one-way hash of it, which cannot be turned back into the address.",
    "If an address is banned for abuse, we store its account ID so it stays banned, even after the account is deleted.",
    "PushArmor is operated by Ion Echo, LLC at PushArmor.com."]) {
    assert.ok(p.includes(s), "privacy lacks: " + s);
  }
  for (const s of ["rate limiter", "server database", "peer row", "1 minute"]) assert.ok(!p.includes(s), "privacy has server detail: " + s);
});

test("minimum age 13 on /terms and /privacy (Q227 A)", () => {
  assert.ok(text("terms.html").includes("You must be at least 13 years old to use PushArmor."));
  assert.ok(text("privacy.html").includes("PushArmor is for people aged 13 and over."));
});

test("download: every Android channel, release asset names, certificate fingerprint (I385)", () => {
  const t = text("download.html");
  for (const c of ["Google Play", "F-Droid", "Obtainium, from GitHub Releases", "APK from GitHub Releases (below)"]) {
    assert.ok(t.includes(c + " Coming soon"), "download lacks: " + c);
  }
  for (const s of ["pusharmor-0.0.X-play.apk", "pusharmor-0.0.X-foss.apk", "Signing certificate (SHA-256 fingerprint)"]) {
    assert.ok(t.includes(s), "download lacks: " + s);
  }
});

test("FAQ texts (I258, I264, I272, WEB6-04) and fixed lines", () => {
  const how = text("how-to.html");
  const sup = text("support.html");
  assert.ok(how.includes("Devices stay paired until you remove one."));
  assert.ok(!how.includes("10 min"));
  const both = how + " " + sup;
  for (const m of ["14 days", "10 tries", "24 hours", "15 minutes"]) assert.ok(!both.includes(m), "mechanics: " + m);
  assert.ok(both.includes("wants to pair"));
  assert.ok(both.includes("Tap Cancel pairing on its row"));
  assert.ok(!both.includes("Remove it on this device first"));
  assert.ok(both.includes("that device is removed from the account"));
  assert.ok(/" ?Name wants to pair again\. Tap Cancel pairing on its row, then pair\."/.test(both), "Pair again quote closes");
  assert.ok(sup.includes("On Android, each paired device has its own notification channel, so you can set sound and importance per device in the system settings."));
  assert.ok(!sup.includes("Only email addresses with plain ASCII characters are supported."));
  assert.ok(sup.includes("No email sign-in code arrived?"));
  const sec = text("security.html");
  assert.ok(sec.includes("The push service and our relay server can show a notification with text of their choosing on every platform; verified content appears only after your device decrypts it."));
  assert.ok(sec.includes("The vendor sees the size of a message (padded to a few standard sizes, called size buckets) and its urgency level, not its content."));
  const del = text("delete-account.html");
  for (const s of ["You can also delete your account from the apps.",
    "Deleted right away: all your devices, with their keys, names, and notification addresses.",
    "Not deleted: messages already on your other devices, and messages still waiting to be delivered, which expire within 7 days.",
    "If the address was banned for abuse, we store its account ID so it stays banned."]) {
    assert.ok(del.includes(s), "delete-account lacks: " + s);
  }
  for (const s of ["one-way code", "keyed hash", "ban flag", "vendors", "4 weeks", "No login"]) assert.ok(!del.includes(s), "delete-account jargon: " + s);
  assert.ok(text("auth/done.html").includes("Returning to PushArmor... If this tab stays open, the add-on did not receive the sign-in: check it is enabled, then retry"));
});

test("every page footer links the public source repository", () => {
  for (const rel of htmlFiles) {
    const hrefs = tags(read(rel), "a").map((t) => t.attrs.href);
    assert.ok(hrefs.includes("https://github.com/tkooda/pusharmor"), rel);
  }
});

test("/auth/android intent link: package, absolute https fallback (WEB6-03)", () => {
  const html = read("auth/android.html");
  const a = tags(html, "a").find((t) => t.attrs.id === "return");
  assert.match(a.attrs.href, /^intent:\/\/pusharmor\.com\/auth\/android#Intent;scheme=https;package=com\.pusharmor;S\.browser_fallback_url=https%3A%2F%2Fpusharmor\.com%2Fdownload;end$/);
  const script = inlineScripts(html)[0];
  assert.ok(script.includes("S.browser_fallback_url=https%3A%2F%2Fpusharmor.com%2Fdownload;end"));
  assert.ok(script.includes('history.replaceState(null,"",location.pathname)'));
  assert.ok(text("auth/android.html").includes("Tap to return to PushArmor"));
  assert.ok(text("auth/android.html").includes("Do not have the app? Get PushArmor"));
  assert.equal(inlineScripts(read("auth/done.html"))[0], 'history.replaceState(null, "", location.pathname);');
});

test("API URLs use /v1/ paths; OAuth on the site uses r=web, purpose delete-account", () => {
  const js = read("js/delete-account.js") + read("js/pa-web.js");
  for (const m of js.matchAll(/"(\/[a-z][^"]*)"/g)) {
    if (m[1].startsWith("/v1/") || m[1].startsWith("/turnstile")) continue;
    assert.fail("non-/v1/ API path: " + m[1]);
  }
  assert.ok(js.includes('"/v1/auth/" + provider + "?k="'));
  assert.ok(js.includes('"&r=web&p=" + PURPOSE'));
});

test("delete-account page: labelled inputs, aria-live status, same-origin Turnstile iframe", () => {
  const html = read("delete-account.html");
  for (const t of tags(html, "input")) {
    assert.ok(tags(html, "label").some((l) => l.attrs.for === t.attrs.id), "label for " + t.attrs.id);
  }
  assert.match(html, /id="status"[^>]*aria-live="polite"/);
  const f = tags(html, "iframe")[0];
  assert.equal(f.attrs.src, "/turnstile#o=https://pusharmor.com");
});

test("Turnstile sitekey is in one place; a temp copy swaps in the test key", () => {
  const hits = [];
  for (const rel of files) if (read(rel).includes("data-sitekey=")) hits.push(rel);
  assert.deepEqual(hits, ["turnstile.html"]);
  const tags1 = tags(read("turnstile.html"), "div").filter((t) => "data-sitekey" in t.attrs);
  assert.equal(tags1.length, 1);
  const tmp = mkdtempSync(join(tmpdir(), "pa-site-"));
  try {
    cpSync(PUB, tmp, { recursive: true });
    const p = join(tmp, "turnstile.html");
    const swapped = readFileSync(p, "utf8").replace(/data-sitekey="[^"]*"/, 'data-sitekey="' + TURNSTILE_TEST_SITEKEY + '"');
    writeFileSync(p, swapped);
    assert.equal(tags(swapped, "div").find((t) => "data-sitekey" in t.attrs).attrs["data-sitekey"], TURNSTILE_TEST_SITEKEY);
    assert.deepEqual(Object.keys(computeHashUpdates(tmp)), [], "swap must not change any hash");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("Turnstile page returns tokens only to allowed origins", () => {
  const js = read("js/turnstile.js");
  assert.ok(js.includes("/^chrome-extension:\\/\\/[a-p]{32}$/"));
  assert.ok(js.includes("/^moz-extension:\\/\\/[0-9a-f-]{36}$/"));
  assert.ok(js.includes("/^https:\\/\\/pusharmor\\.com$/"));
  assert.ok(js.includes('action: "email"'));
});

test("Firefox: SW forward URL; manifest lists equal FIREFOX-MATCH-LIST and release constants (I271)", (t) => {
  const sw = read("fx/sw.js");
  const fwd = /FORWARD_URL = "([^"]+)"/.exec(sw)[1];
  assert.equal(fwd, "https://pusharmor.com/fx/fwd");
  const manifestPath = join(REPO, "client", "firefox", "manifest.json");
  const constPath = join(REPO, "release", "constants.json");
  if (!existsSync(manifestPath) || !existsSync(constPath)) {
    t.skip("client/firefox/manifest.json or release/constants.json not present yet");
    return;
  }
  const MATCHES = [
    "https://pusharmor.com/fx/setup", "https://pusharmor.com/fx/setup?*",
    "https://pusharmor.com/fx/open", "https://pusharmor.com/fx/open?*",
    "https://pusharmor.com/auth/done", "https://pusharmor.com/auth/done?*"
  ];
  const HOSTS = ["https://api.pusharmor.com/*", "https://pusharmor.com/fx/fwd"];
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  const consts = JSON.parse(readFileSync(constPath, "utf8"));
  const manMatches = (man.content_scripts || []).flatMap((c) => c.matches);
  // MV2: host permissions are the URL entries in "permissions".
  const manHosts = (man.permissions || []).filter((x) => typeof x === "string" && x.includes("://"));
  assert.deepEqual(manMatches, consts.firefox_content_scripts_matches);
  assert.deepEqual(manHosts, consts.firefox_host_permissions);
  assert.deepEqual(manMatches, MATCHES);
  assert.deepEqual(manHosts, HOSTS);
  for (const m of MATCHES) assert.ok(!m.includes("delete-account"));
  let found = false;
  for (const rel of listFiles(join(REPO, "client", "firefox"))) {
    if (rel.includes("node_modules/") || !/\.(m?js|json)$/.test(rel)) continue;
    const s = readFileSync(join(REPO, "client", "firefox", rel), "utf8");
    if (s.includes("pusharmor.com/fx/fwd")) {
      found = true;
      for (const m of s.matchAll(/https:\/\/pusharmor\.com\/fx\/fwd[^"'\s]*/g)) assert.equal(m[0], fwd, rel);
    }
  }
  assert.ok(found, "client/firefox does not name the forward URL");
});

test("attrs parser sanity", () => {
  assert.deepEqual(attrs(' a="1" b=\'2\' c=3 d'), { a: "1", b: "2", c: "3", d: "" });
  assert.equal(readdirSync(PUB).includes("_headers"), true);
});

test("every page embedding /turnstile is named in the privacy text", () => {
  const pages = htmlFiles.filter((f) => /<iframe[^>]*src="\/turnstile[#"]/.test(read(f)));
  assert.ok(pages.includes("delete-account.html"));
  const p = text("privacy.html");
  assert.ok(p.includes("Cloudflare's bot check (Turnstile) runs on the email sign-in page and on the delete-account page only"));
  for (const f of pages) {
    const name = f.replace(/\.html$/, "");
    if (name === "delete-account") continue;
    assert.ok(p.includes(name), "privacy does not name " + name);
  }
});

test("delete-account init: a hash without ticket= is cleared with a retry message", () => {
  const js = read("js/delete-account.js");
  assert.ok(/h\.length > 1\) \{\s*history\.replaceState\(null, "", location\.pathname\);\s*await restart\("Sign-in did not finish/.test(js));
});

test("delete-account init: an OAuth #error=<word> hash is handled by the generic hash branch (I306)", () => {
  const js = read("js/delete-account.js");
  // The ticket branch is keyed on "ticket="; any other non-empty hash (#error=cancelled, #error=failed) is cleared with the retry text.
  assert.ok(js.indexOf('h.indexOf("ticket=") >= 0') < js.indexOf("h.length > 1"));
  assert.ok(!/ticket=/.test(js.slice(js.indexOf("h.length > 1"), js.indexOf('await restart("");'))));
  assert.ok(js.includes('"Sign-in did not finish. Try again."'));
});
