// Release bundle check for deploy.sh: builds the Worker bundle with
// `wrangler deploy --dry-run --outdir <tmp>` (no upload) and fails when it holds test
// code or a test or debug route (owner ruling: no test hooks in any public release build).
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

/** Returns ["file: string", ...] for every hit in the bundle directory. */
export function scanDir(dir) {
  const hits = [];
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile() || e.name.endsWith(".map")) continue;
    const p = join(e.parentPath ?? e.path, e.name);
    for (const s of scan(readFileSync(p, "latin1"))) hits.push(p.slice(dir.length + 1) + ": " + s);
  }
  return hits;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const worker = join(root, "server", "worker");
  const wrangler = process.env.WRANGLER || join(worker, "node_modules", ".bin", "wrangler");
  const out = mkdtempSync(join(tmpdir(), "pa-bundle-"));
  try {
    execFileSync(wrangler, ["deploy", "--dry-run", "--outdir", out], { cwd: worker, stdio: ["ignore", "ignore", "inherit"] });
    const files = readdirSync(out, { recursive: true });
    if (!files.some((f) => /\.m?js$/.test(f))) {
      console.error("bundle check: wrangler wrote no .js bundle");
      process.exit(1);
    }
    const hits = scanDir(out);
    if (hits.length) {
      console.error("bundle check: test code or test routes in the Worker bundle:\n" + hits.map((h) => "  - " + h).join("\n"));
      process.exit(1);
    }
    console.log("bundle check: ok");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
