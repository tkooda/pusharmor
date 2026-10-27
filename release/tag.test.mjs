// Release tag rule. Run: node --test release/tag.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseTag, tagProblems } from "./tag.mjs";

test("format: <comp>-vX.Y.Z only, no rc tags, no other component", () => {
  assert.deepEqual(parseTag("chrome", "chrome-v1.2.3"), [1, 2, 3]);
  for (const t of ["chrome-v1.2", "chrome-v1.2.3-rc1", "chrome-1.2.3", "firefox-v1.2.3", "chrome-v1.2.3 ", "xchrome-v1.2.3"]) {
    assert.equal(parseTag("chrome", t), null, t);
    assert.equal(tagProblems("chrome", t, []).length, 1, t);
  }
  assert.deepEqual(tagProblems("site", "site-v1.0.0", []), ['unknown component "site"']);
});

test("minor and patch <= 999; major is free", () => {
  assert.deepEqual(tagProblems("ios", "ios-v1000.999.999", []), []);
  assert.deepEqual(tagProblems("ios", "ios-v1.1000.0", []), ["ios-v1.1000.0: minor and patch must be <= 999"]);
  assert.deepEqual(tagProblems("ios", "ios-v1.0.1000", []), ["ios-v1.0.1000: minor and patch must be <= 999"]);
});

test("greater than every other tag of the component, compared as numbers", () => {
  const tags = ["android-v0.0.9", "android-v0.0.10", "chrome-v9.0.0", "android-v0.1.0-rc1"];
  assert.deepEqual(tagProblems("android", "android-v0.0.11", tags), []);
  assert.deepEqual(tagProblems("android", "android-v0.0.11", [...tags, "android-v0.0.11"]), []);
  assert.deepEqual(tagProblems("android", "android-v0.0.10", tags), []);
  assert.deepEqual(tagProblems("android", "android-v0.0.9", tags), ["android-v0.0.9 is not greater than the existing tag android-v0.0.10"]);
  assert.deepEqual(tagProblems("android", "android-v0.0.2", ["android-v0.0.2", "android-v0.0.02"]), ["android-v0.0.2 is not greater than the existing tag android-v0.0.02"]);
});

test("CLI: usage error, unknown tag form fails", () => {
  const cli = join(import.meta.dirname, "tag.mjs");
  assert.equal(spawnSync("node", [cli], { encoding: "utf8" }).status, 2);
  const r = spawnSync("node", [cli, "chrome", "chrome-v1.2"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not match chrome-vX\.Y\.Z/);
});
