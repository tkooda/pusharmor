// release/public.mjs gate rule and release/ci-dummy.mjs. Run: node --test release/public.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GECKO_DUMMY_IDS, GECKO_PLACEHOLDER_ID, publicProblems } from "./public.mjs";
import { dummyValues } from "./ci-dummy.mjs";

// A fixture with every public key set to a PLACEHOLDER, so the tests do not
// depend on which values the owner has filled into the tracked release/public.json.
const NAMES = JSON.parse(readFileSync(join(import.meta.dirname, "names.json"), "utf8"));
const KEYS = Object.keys(NAMES.public_keys).sort();
const PUB = { _doc: "PLACEHOLDER fixture", ...Object.fromEntries(KEYS.map((k) => [k, "PLACEHOLDER_" + k.toUpperCase()])) };

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

test("gate: a Firefox add-on id must be a lowercase GUID in braces; the reserved fake ids are a PLACEHOLDER or a CI dummy", () => {
  const ok = "{03381876-62cc-4ce1-8cb9-c22567d00ca6}";
  for (const id of [ok, "{549aa960-212f-41ba-b28c-7d7d1662bb57}"]) assert.deepEqual(publicProblems(["mozilla_firefox_addon_id"], { mozilla_firefox_addon_id: id }, {}), []);
  for (const id of ["beta@example.org", ok.toUpperCase(), ok.slice(1, -1), ok + " ", "{" + ok + "}"]) {
    assert.deepEqual(publicProblems(["mozilla_firefox_beta_addon_id"], { mozilla_firefox_beta_addon_id: id }, {}),
      ["release/public.json: mozilla_firefox_beta_addon_id is not a lowercase GUID {xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}"], id);
  }
  assert.deepEqual(publicProblems(["other"], { other: "not-a-guid" }, {}), []);
  assert.deepEqual(publicProblems(["mozilla_firefox_addon_id"], { mozilla_firefox_addon_id: GECKO_PLACEHOLDER_ID }, { PA_CI_DUMMY: "1" }),
    ["release/public.json: mozilla_firefox_addon_id is a PLACEHOLDER"]);
  const dummy = { mozilla_firefox_beta_addon_id: GECKO_DUMMY_IDS.mozilla_firefox_beta_addon_id };
  assert.deepEqual(publicProblems(["mozilla_firefox_beta_addon_id"], dummy, {}),
    ["release/public.json: mozilla_firefox_beta_addon_id is a CI dummy (allowed only with PA_CI_DUMMY=1)"]);
  assert.deepEqual(publicProblems(["mozilla_firefox_beta_addon_id"], dummy, { PA_CI_DUMMY: "1" }), []);
});

test("ci-dummy replaces every PLACEHOLDER with a labeled dummy and keeps the rest", () => {
  const [out, changed] = dummyValues({ _doc: "PLACEHOLDER text", a: "PLACEHOLDER_A", b: ["X", "PLACEHOLDER_B"], c: "real", mozilla_firefox_addon_id: "PLACEHOLDER" });
  assert.deepEqual(out, { _doc: "PLACEHOLDER text", a: "ci-fork-dummy-a", b: ["X", "ci-fork-dummy-b"], c: "real", mozilla_firefox_addon_id: GECKO_DUMMY_IDS.mozilla_firefox_addon_id });
  assert.match(GECKO_DUMMY_IDS.mozilla_firefox_addon_id, /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/);
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
  const tmp = mkdtempSync(join(tmpdir(), "pa-public-check-"));
  try {
    // a copy of public.mjs next to a public.json with only PLACEHOLDER values
    const pl = join(tmp, "placeholders");
    mkdirSync(pl);
    writeFileSync(join(pl, "public.mjs"), readFileSync(cli));
    writeFileSync(join(pl, "public.json"), JSON.stringify(PUB));
    const r = spawnSync("node", [join(pl, "public.mjs"), "--check", "apple_team_id", "google_cws_publisher_id"], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /apple_team_id is a PLACEHOLDER/);
    assert.match(r.stderr, /google_cws_publisher_id is a PLACEHOLDER/);
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
