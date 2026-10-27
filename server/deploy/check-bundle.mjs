// Release bundle check for deploy.sh: builds the Worker bundle with
// `wrangler deploy --dry-run --outdir <tmp>` (no upload) and fails when it holds test
// code or a test or debug route (owner ruling: no test hooks in any public release build).
// Structural check: every "/v1/..." string literal in the bundle must be a path in the pinned
// allow-list server/worker/routes.json (the Worker test routes.test.ts pins the router table to
// it), and every "x-pa-..." name (any case) must be in its x_pa_headers list.
//   node check-bundle.mjs [REPO_ROOT]
// Env: WRANGLER (default server/worker/node_modules/.bin/wrangler).
// Source maps are skipped: they are not uploaded as code.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FORBIDDEN = [
  "resetHealth",
  "clearTokens",
  "clearJwks",
  "TEST_MIGRATIONS",
  "TEST_SECRETS",
  "cloudflare:test",
  "vitest",
  "miniflare",
  "/test",
  "/debug",
  "/__",
];

/** Returns the forbidden strings found in the text. */
export function scan(text) {
  return FORBIDDEN.filter((s) => text.includes(s));
}

/**
 * Returns the "/v1/..." literals and "x-pa-..." names in the text that the allow-list
 * { routes: ["METHOD /path", ...], x_pa_headers: [...] } does not hold. A template literal
 * cut at "${" passes only when it is a prefix of an allowed path.
 */
export function unknown(text, allow) {
  const paths = new Set(allow.routes.map((r) => r.slice(r.indexOf(" ") + 1)));
  const headers = new Set(allow.x_pa_headers.map((h) => h.toLowerCase()));
  const hits = new Set();
  for (const m of text.matchAll(/["'`](\/v1(?:\/[^"'`\s$]*)?)(\$\{)?/g)) {
    const ok = m[2] ? [...paths].some((p) => p.startsWith(m[1]) && m[1].length > 4) : paths.has(m[1]);
    if (!ok) hits.add(m[1]);
  }
  for (const m of text.matchAll(/x-pa-[a-z0-9-]*/gi)) if (!headers.has(m[0].toLowerCase())) hits.add(m[0]);
  return [...hits];
}

/** Returns ["file: string", ...] for every hit in the bundle directory. */
export function scanDir(dir, allow) {
  const hits = [];
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile() || e.name.endsWith(".map")) continue;
    const p = join(e.parentPath ?? e.path, e.name);
    const text = readFileSync(p, "latin1");
    for (const s of [...scan(text), ...unknown(text, allow)]) hits.push(p.slice(dir.length + 1) + ": " + s);
  }
  return hits;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const worker = join(root, "server", "worker");
  const wrangler = process.env.WRANGLER || join(worker, "node_modules", ".bin", "wrangler");
  const allow = JSON.parse(readFileSync(join(worker, "routes.json"), "utf8"));
  const out = mkdtempSync(join(tmpdir(), "pa-bundle-"));
  try {
    execFileSync(wrangler, ["deploy", "--dry-run", "--outdir", out], { cwd: worker, stdio: ["ignore", "ignore", "inherit"] });
    const files = readdirSync(out, { recursive: true });
    if (!files.some((f) => /\.m?js$/.test(f))) {
      console.error("bundle check: wrangler wrote no .js bundle");
      process.exit(1);
    }
    const hits = scanDir(out, allow);
    if (hits.length) {
      console.error("bundle check: test code, a test route, or a route or x-pa- header not in server/worker/routes.json in the Worker bundle:\n" + hits.map((h) => "  - " + h).join("\n"));
      process.exit(1);
    }
    console.log("bundle check: ok");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
