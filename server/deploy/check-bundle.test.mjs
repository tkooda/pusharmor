// Bundle check tests. Run: node --test server/deploy/
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FORBIDDEN, scan, unknown } from "./check-bundle.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "check-bundle.mjs");
const WORKER = join(HERE, "..", "worker");
const ROUTES_JSON = join(WORKER, "routes.json");
const ALLOW = JSON.parse(readFileSync(ROUTES_JSON, "utf8"));

test("scan finds each forbidden string and passes clean code", () => {
  assert.deepEqual(scan('export default { fetch(r) { return route("/v1/peers", r); } };'), []);
  for (const s of FORBIDDEN) assert.deepEqual(scan("x = '" + s + "';"), [s], s);
  assert.deepEqual(scan('import { env } from "cloudflare:test"; if (p === "/debug/x") {}'), ["cloudflare:test", "/debug"]);
});

test("unknown flags /v1 literals and x-pa- names not in the allow-list", () => {
  const allow = { routes: ["GET /v1/peers", "POST /v1/auth/google/callback"], x_pa_headers: ["X-PA-Real"] };
  assert.deepEqual(unknown('if (p === "/v1/peers") {} h.get("x-pa-real"); u = `/v1/auth/${n}/callback`;', allow), []);
  assert.deepEqual(unknown('{ method: "POST", path: "/v1/reset-state", handler: h }', allow), ["/v1/reset-state"]);
  assert.deepEqual(unknown('if (r.headers.get("X-PA-Skip-Auth")) return ok;', allow), ["X-PA-Skip-Auth"]);
  assert.deepEqual(unknown("u = `/v1/${n}`; v = '/v1';", allow), ["/v1/", "/v1"]);
});

// Stub wrangler: writes the given bundle files into the --outdir it is called with.
function run(files) {
  const d = mkdtempSync(join(tmpdir(), "pa-check-bundle-"));
  mkdirSync(join(d, "server", "worker"), { recursive: true });
  cpSync(ROUTES_JSON, join(d, "server", "worker", "routes.json"));
  writeFileSync(join(d, "files.json"), JSON.stringify(files));
  const w = join(d, "wrangler");
  writeFileSync(w, "#!/usr/bin/env node\n" +
    'const fs = require("fs"), path = require("path");\n' +
    'const out = process.argv[process.argv.indexOf("--outdir") + 1];\n' +
    'if (!process.argv.includes("--dry-run")) process.exit(3);\n' +
    'for (const [n, t] of Object.entries(JSON.parse(fs.readFileSync(' + JSON.stringify(join(d, "files.json")) + ', "utf8")))) {\n' +
    '  fs.mkdirSync(path.dirname(path.join(out, n)), { recursive: true }); fs.writeFileSync(path.join(out, n), t);\n' +
    "}\n");
  chmodSync(w, 0o755);
  const r = spawnSync(process.execPath, [SCRIPT, d], { env: { ...process.env, WRANGLER: w }, encoding: "utf8" });
  rmSync(d, { recursive: true, force: true });
  return r;
}

test("a clean bundle passes; the source map is not scanned", () => {
  const r = run({ "index.js": "export default {};", "index.js.map": '{"sources":["../test/setup.ts"],"x":"vitest"}' });
  assert.equal(r.status, 0, r.stderr);
});

test("a bundle with test code or a test route fails and names the hit", () => {
  let r = run({ "index.js": "export function resetHealth() {}" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /index\.js: resetHealth/);
  r = run({ "index.js": "export default {};", "chunks/a.js": 'if (path === "/__reset") {}' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a\.js: \/__/);
});

test("a planted route or x-pa- header not in routes.json fails and names it", () => {
  let r = run({ "index.js": 'const R = [{ method: "GET", path: "/v1/peers" }, { method: "POST", path: "/v1/reset-state" }];' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /index\.js: \/v1\/reset-state/);
  r = run({ "index.js": 'if (req.headers.get("x-pa-skip-auth") === "1") return next();' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /index\.js: x-pa-skip-auth/);
});

test("every pinned route path in a bundle passes", () => {
  const paths = ALLOW.routes.map((x) => JSON.stringify(x.split(" ")[1])).join(", ");
  const r = run({ "index.js": "export const P = [" + paths + "];" });
  assert.equal(r.status, 0, r.stderr);
});

const WRANGLER = join(WORKER, "node_modules", ".bin", "wrangler");
test("the real wrangler --dry-run bundle of the Worker passes", { skip: !existsSync(WRANGLER) && "wrangler not installed" }, () => {
  const r = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, WRANGLER }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /bundle check: ok/);
});

test("no .js bundle written fails", () => {
  const r = run({});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no \.js bundle/);
});
