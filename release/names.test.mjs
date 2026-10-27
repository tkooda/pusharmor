// Every list of deployment names equals release/names.json. Run: node --test release/names.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
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

test("every Cloudflare name is a field of the Worker Env", () => {
  const env = readFileSync(join(REPO, "server", "worker", "src", "env.ts"), "utf8");
  for (const k of [...keys(names.cloudflare_vars), ...keys(names.cloudflare_secrets)]) {
    assert.match(env, new RegExp("^\\s+" + k + ": string;$", "m"), k);
  }
});

test("release/constants.json holds no public build id", () => {
  const c = JSON.parse(readFileSync(join(REPO, "release", "constants.json"), "utf8"));
  for (const k of Object.keys(names.public_keys)) assert.equal(k in c, false, k);
});
