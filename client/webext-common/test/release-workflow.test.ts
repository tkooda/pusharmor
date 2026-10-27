import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// webext-release.yml: npm packages and repo scripts never share a job with a
// GitHub Environment, its secrets or id-token (issue: build split per browser).
const repo = join(import.meta.dirname, "..", "..", "..");
const wf = readFileSync(join(repo, ".github", "workflows", "webext-release.yml"), "utf8");
const jobs = new Map<string, string>();
{
  const body = wf.slice(wf.indexOf("\njobs:\n"));
  const parts = body.split(/^ {2}([a-z0-9-]+):\n/m);
  for (let i = 1; i < parts.length; i += 2) jobs.set(parts[i]!, parts[i + 1]!);
}
const privileged = (b: string) => /^ {4}environment:/m.test(b) || /id-token: write/.test(b) || /\$\{\{ secrets\./.test(b);

test("each browser has a build job and a publish job in its Environment", () => {
  for (const [b, env, needs] of [["chrome", "chrome-release", "build-chrome"], ["firefox", "firefox-release", "\\[build-firefox, submit-firefox\\]"]]) {
    const build = jobs.get("build-" + b);
    const publish = jobs.get("publish-" + b);
    assert.ok(build && publish, b);
    assert.equal(privileged(build), false, "build-" + b);
    assert.match(build, /^ {4}permissions:\n {6}contents: read\n {4}\S/m, "build-" + b);
    assert.match(publish, new RegExp("^ {4}environment: " + env + "$", "m"));
    assert.match(publish, new RegExp("^ {4}needs: " + needs + "$", "m"));
  }
});

test("no job with an Environment, secrets or id-token runs npm ci of the webext package or a repo script", () => {
  for (const [name, b] of jobs) {
    if (!privileged(b)) continue;
    assert.doesNotMatch(b, /\bnode (release|client|build\.mjs|check-release|-e|-p)\b/, name);
    const lines = b.split("\n");
    lines.forEach((l, i) => {
      if (/\bnpm (ci|install|run|exec)\b/.test(l)) {
        assert.match(l, /run: npm ci --ignore-scripts$/, name + ": " + l);
        assert.match(lines[i - 1]!, /working-directory: client\/webext-common\/amo-sign$/, name + ": " + l);
      }
    });
  }
});

test("no job with id-token runs npm or npx; submit-firefox has contents: read only", () => {
  for (const [name, b] of jobs) {
    if (/id-token: write/.test(b)) assert.doesNotMatch(b, /\b(npm|npx) /, name);
  }
  const submit = jobs.get("submit-firefox");
  assert.ok(submit);
  assert.match(submit, /^ {4}environment: firefox-release$/m);
  assert.match(submit, /^ {4}needs: build-firefox$/m);
  assert.match(submit, /^ {4}permissions:\n {6}contents: read\n {4}\S/m);
  assert.doesNotMatch(submit, /id-token/);
  assert.match(submit, /sha256sum -c --strict/);
});

test("CI uploads only to the test channels: private Chrome Beta item, unlisted Firefox Beta add-on, GitHub prerelease", () => {
  const chrome = jobs.get("publish-chrome")!;
  assert.match(chrome, /ITEM: \$\{\{ needs\.build-chrome\.outputs\.google_chrome_beta_extension_id \}\}/);
  assert.match(chrome, /ZIP: \$\{\{ steps\.files\.outputs\.beta \}\}/);
  assert.doesNotMatch(wf, /outputs\.google_chrome_extension_id|STAGED_PUBLISH|--channel listed/);
  assert.match(jobs.get("submit-firefox")!, /--channel unlisted/);
  assert.doesNotMatch(wf, /--draft/);
  const creates = wf.match(/gh release create .*/g) ?? [];
  assert.equal(creates.length, 2);
  for (const c of creates) assert.match(c, /--prerelease --verify-tag/);
  for (const b of ["chrome", "firefox"]) assert.match(jobs.get("publish-" + b)!, /refusing to change its assets/);
});

test("amo-sign pins only web-ext, at an exact version, with lockfile integrity", () => {
  const dir = join(repo, "client", "webext-common", "amo-sign");
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(pkg.dependencies), ["web-ext"]);
  assert.equal(pkg.devDependencies, undefined);
  assert.match(pkg.dependencies["web-ext"], /^\d+\.\d+\.\d+$/);
  const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"));
  assert.equal(lock.packages["node_modules/web-ext"].version, pkg.dependencies["web-ext"]);
  for (const [k, p] of Object.entries(lock.packages as Record<string, { integrity?: string }>)) {
    if (k) assert.match(p.integrity ?? "", /^sha512-/, k);
  }
});
