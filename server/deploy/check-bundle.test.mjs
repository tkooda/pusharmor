// Bundle check tests. Run: node --test server/deploy/
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FORBIDDEN, scan } from "./check-bundle.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-bundle.mjs");

test("scan finds each forbidden string and passes clean code", () => {
  assert.deepEqual(scan('export default { fetch(r) { return route("/v1/peers", r); } };'), []);
  for (const s of FORBIDDEN) assert.deepEqual(scan("x = '" + s + "';"), [s], s);
  assert.deepEqual(scan('import { env } from "cloudflare:test"; if (p === "/debug/x") {}'), ["cloudflare:test", "/debug"]);
});

// Stub wrangler: writes the given bundle files into the --outdir it is called with.
function run(files) {
  const d = mkdtempSync(join(tmpdir(), "pa-check-bundle-"));
  mkdirSync(join(d, "server", "worker"), { recursive: true });
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

test("no .js bundle written fails", () => {
  const r = run({});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no \.js bundle/);
});
