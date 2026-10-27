// Header snapshot against a local "wrangler dev" (the pinned, project-local wrangler).
// Compares each response with the _headers rules: CSP per path, HSTS, nosniff, exactly one
// CSP header. Skips (with a note) when wrangler cannot start here.
// Run: node --test site/tools/test/   (needs "npm ci" in site/ first)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { headersFor, listFiles, parseHeaders, urlPath } from "../site-lib.mjs";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUB = join(SITE, "public");
const BIN = join(SITE, "node_modules", ".bin", "wrangler");
const PORT = 18000 + Math.floor(Math.random() * 2000);
let proc = null;
let up = false;
let why = "";

function get(path, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method, headers: { "Sec-Fetch-Mode": "navigate" } }, (res) => {
      const raw = {};
      for (let i = 0; i < res.rawHeaders.length; i += 2) (raw[res.rawHeaders[i].toLowerCase()] ||= []).push(res.rawHeaders[i + 1]);
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, raw }));
    });
    req.on("error", reject);
    req.end(method === "POST" ? "M" : undefined);
  });
}

before(async () => {
  if (!existsSync(BIN)) { why = "site/node_modules missing (run npm ci in site/)"; return; }
  proc = spawn(BIN, ["dev", "--ip", "127.0.0.1", "--port", String(PORT)], {
    cwd: SITE, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  proc.stdout.on("data", (d) => { log += d; });
  proc.stderr.on("data", (d) => { log += d; });
  const end = Date.now() + 45000;
  while (Date.now() < end && proc.exitCode === null) {
    try {
      await get("/robots.txt");
      up = true;
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  why = "wrangler dev did not start: " + log.slice(-400);
});

after(() => { if (proc) proc.kill("SIGTERM"); });

test("header snapshot: every path matches _headers, one CSP, HSTS, nosniff", async (t) => {
  if (!up) { t.skip(why); return; }
  const rules = parseHeaders(readFileSync(join(PUB, "_headers"), "utf8"));
  const paths = listFiles(PUB).filter((f) => !f.startsWith("_")).map(urlPath);
  for (const p of paths) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    const want = headersFor(rules, p);
    assert.equal((r.raw["content-security-policy"] || []).length, 1, p + ": CSP count");
    assert.deepEqual(r.raw["content-security-policy"], want["content-security-policy"], p);
    assert.deepEqual(r.raw["strict-transport-security"], ["max-age=63072000; includeSubDomains"], p);
    assert.deepEqual(r.raw["x-content-type-options"], ["nosniff"], p);
    assert.deepEqual(r.raw["cache-control"], want["cache-control"], p);
    assert.deepEqual(r.raw["x-robots-tag"], want["x-robots-tag"], p);
    assert.deepEqual(r.raw["referrer-policy"], ["no-referrer"], p);
  }
});

test("content types", async (t) => {
  if (!up) { t.skip(why); return; }
  const want = {
    "/fx/sw.js": "text/javascript",
    "/.well-known/security.txt": "text/plain; charset=utf-8",
    "/fdroid/android.txt": "text/plain; charset=utf-8",
    "/.well-known/assetlinks.json": "application/json"
  };
  for (const [p, ct] of Object.entries(want)) {
    const r = await get(p);
    assert.deepEqual(r.raw["content-type"], [ct], p);
  }
});

test("404s: /fx/fwd (POST and GET), unknown path, config files", async (t) => {
  if (!up) { t.skip(why); return; }
  // The doc expects 404; the local assets server answers a POST with 405. Either is an HTTP
  // response, which the SW treats as "not caught by the add-on".
  assert.ok([404, 405].includes((await get("/fx/fwd", "POST")).status));
  assert.equal((await get("/fx/fwd")).status, 404);
  const nf = await get("/no-such-page");
  assert.equal(nf.status, 404);
  assert.equal(nf.raw["content-security-policy"].length, 1);
  for (const p of ["/package.json", "/wrangler.jsonc", "/_headers", "/_redirects"]) assert.equal((await get(p)).status, 404, p);
});
