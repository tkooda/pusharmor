// release/public.mjs gate rule and release/ci-dummy.mjs. Run: node --test release/public.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPublic, publicProblems } from "./public.mjs";
import { dummyValues } from "./ci-dummy.mjs";

const PUB = loadPublic();
const KEYS = Object.keys(PUB).filter((k) => !k.startsWith("_"));

test("every committed value is a PLACEHOLDER until the owner fills it", () => {
  for (const k of KEYS) assert.match(JSON.stringify(PUB[k]), /PLACEHOLDER/, k);
  assert.deepEqual(publicProblems(KEYS, PUB, {}).length, KEYS.length);
});

test("gate: missing, empty and PLACEHOLDER values fail; real values pass", () => {
  const pub = { a: "", b: [], c: [""], d: "placeholder_x", e: ["AB:CD", "PLACEHOLDER"], f: "real", g: ["AB:CD"] };
  assert.deepEqual(publicProblems(["a", "b", "c", "d", "e", "f", "g", "h"], pub, {}), [
    "release/public.json: a is missing or empty",
    "release/public.json: b is missing or empty",
    "release/public.json: c is missing or empty",
    "release/public.json: d is a PLACEHOLDER",
    "release/public.json: e is a PLACEHOLDER",
    "release/public.json: h is missing or empty"
  ]);
});

test("gate: a CI dummy fails unless PA_CI_DUMMY=1; a PLACEHOLDER fails even then", () => {
  const pub = { a: "ci-fork-dummy-a", b: ["ci-fork-dummy-b"], c: "PLACEHOLDER_C" };
  assert.deepEqual(publicProblems(["a", "b"], pub, {}), [
    "release/public.json: a is a CI dummy (allowed only with PA_CI_DUMMY=1)",
    "release/public.json: b is a CI dummy (allowed only with PA_CI_DUMMY=1)"
  ]);
  assert.deepEqual(publicProblems(["a", "b"], pub, { PA_CI_DUMMY: "true" }).length, 2);
  assert.deepEqual(publicProblems(["a", "b"], pub, { PA_CI_DUMMY: "1" }), []);
  assert.deepEqual(publicProblems(["c"], pub, { PA_CI_DUMMY: "1" }), ["release/public.json: c is a PLACEHOLDER"]);
});

test("ci-dummy replaces every PLACEHOLDER with a labeled dummy and keeps the rest", () => {
  const [out, changed] = dummyValues({ _doc: "PLACEHOLDER text", a: "PLACEHOLDER_A", b: ["X", "PLACEHOLDER_B"], c: "real", mozilla_firefox_addon_id: "PLACEHOLDER" });
  assert.deepEqual(out, { _doc: "PLACEHOLDER text", a: "ci-fork-dummy-a", b: ["X", "ci-fork-dummy-b"], c: "real", mozilla_firefox_addon_id: "ci-fork-dummy-mozilla_firefox_addon_id@pusharmor.com" });
  assert.deepEqual(changed, ["a", "b", "mozilla_firefox_addon_id"]);
});

test("ci-dummy on a copy of release/public.json: the gate then passes only with PA_CI_DUMMY=1", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pa-ci-dummy-"));
  try {
    const p = join(tmp, "public.json");
    writeFileSync(p, JSON.stringify(PUB));
    const r = spawnSync("node", [join(import.meta.dirname, "ci-dummy.mjs"), p], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ci-dummy: android_release_cert_sha256, /);
    const pub = JSON.parse(readFileSync(p, "utf8"));
    assert.deepEqual(publicProblems(KEYS, pub, { PA_CI_DUMMY: "1" }), []);
    assert.equal(publicProblems(KEYS, pub, {}).length, KEYS.length);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("--check CLI: fails on PLACEHOLDER keys and on any PA_CI_DUMMY; passes on real values", () => {
  const cli = join(import.meta.dirname, "public.mjs");
  const run = (args, env) => spawnSync("node", [cli, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  assert.equal(run([], {}).status, 2);
  assert.equal(run(["--check"], {}).status, 2);
  const r = run(["--check", "apple_team_id", "google_cws_publisher_id"], {});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /apple_team_id is a PLACEHOLDER/);
  assert.match(r.stderr, /google_cws_publisher_id is a PLACEHOLDER/);
  const tmp = mkdtempSync(join(tmpdir(), "pa-public-check-"));
  try {
    // a copy of public.mjs next to a public.json with real values
    writeFileSync(join(tmp, "public.mjs"), readFileSync(cli));
    writeFileSync(join(tmp, "public.json"), JSON.stringify({ a: "real", b: ["AB:CD"], c: "ci-fork-dummy-c" }));
    const ok = spawnSync("node", [join(tmp, "public.mjs"), "--check", "a", "b"], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /release values check: ok \(a, b\)/);
    const dummy = spawnSync("node", [join(tmp, "public.mjs"), "--check", "a", "c"], { encoding: "utf8", env: { PATH: process.env.PATH, PA_CI_DUMMY: "1" } });
    assert.equal(dummy.status, 1);
    assert.match(dummy.stderr, /PA_CI_DUMMY is set/);
    const empty = spawnSync("node", [join(tmp, "public.mjs"), "--check", "a"], { encoding: "utf8", env: { PATH: process.env.PATH, PA_CI_DUMMY: "" } });
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /PA_CI_DUMMY is set/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
