// ci.yml change detection: a push run diffs from the newest successful ci push
// run, so commits whose queued run a newer push cancelled are still covered.
// Run: node --test release/ci-workflow.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CI = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"), "utf8");

// the run: | block of the detect step, unindented
function detectScript() {
  const lines = CI.split("\n");
  let i = lines.findIndex((l) => /- id: detect$/.test(l));
  assert.ok(i >= 0);
  while (!/^\s+run: \|$/.test(lines[i])) i++;
  const ind = lines[i].search(/\S/) + 2;
  const out = [];
  for (i++; i < lines.length && (lines[i].trim() === "" || lines[i].search(/\S/) >= ind); i++) out.push(lines[i].slice(ind));
  return out.join("\n");
}

function scratch(t) {
  const d = mkdtempSync(join(tmpdir(), "pa-ci-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...a) => execFileSync("git", a, { cwd: join(d, "r"), encoding: "utf8", env }).trim();
  mkdirSync(join(d, "r", "client", "android"), { recursive: true });
  mkdirSync(join(d, "bin"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgSign", "false");
  const commit = (f) => {
    writeFileSync(join(d, "r", f), f + Math.random());
    git("add", "-A");
    git("commit", "-q", "-m", f);
    return git("rev-parse", "HEAD");
  };
  // fake gh: prints $FAKE_BASE, or fails when it is unset
  writeFileSync(join(d, "bin", "gh"), '#!/bin/sh\n[ -n "$FAKE_BASE" ] || exit 1\nprintf "%s\\n" "$FAKE_BASE"\n');
  chmodSync(join(d, "bin", "gh"), 0o755);
  writeFileSync(join(d, "detect.sh"), detectScript());
  const detect = (before, base) => {
    const o = join(d, "out");
    writeFileSync(o, "");
    const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", join(d, "detect.sh")], {
      cwd: join(d, "r"),
      encoding: "utf8",
      env: { ...env, PATH: join(d, "bin") + ":" + process.env.PATH, EVENT: "push", BEFORE: before, GITHUB_OUTPUT: o, GITHUB_REPOSITORY: "o/r", FAKE_BASE: base ?? "" },
    });
    assert.equal(r.status, 0, r.stderr);
    return Object.fromEntries(readFileSync(o, "utf8").trim().split("\n").map((l) => l.split("=")));
  };
  return { commit, detect };
}

test("push: a cancelled run's commits are covered by diffing from the last successful run", (t) => {
  const { commit, detect } = scratch(t);
  const c0 = commit("README.md");
  const c1 = commit("client/android/a.kt"); // its queued run was cancelled
  const c2 = commit("LICENSE"); // HEAD, before = c1
  assert.equal(detect(c1, c0).android, "true");
  assert.equal(detect(c1, c0).ios, "false");
  // no usable base (gh fails, not an ancestor, or HEAD itself): before..HEAD
  assert.equal(detect(c1, undefined).android, "false");
  assert.equal(detect(c1, "f".repeat(40)).android, "false");
  assert.equal(detect(c1, "not-a-sha").android, "false");
  assert.equal(detect(c1, c2).android, "false");
  assert.equal(detect(c0, undefined).android, "true");
  // unknown before and no base: everything runs
  assert.equal(detect("0".repeat(40), undefined).ios, "true");
});
