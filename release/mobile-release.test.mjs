// Mobile release workflows: invariants the first runs depend on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const FLAGS = 'CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO PROVISIONING_PROFILE_SPECIFIER=';

test("ios-release archive sets AppIdentifierPrefix and checks the groups", () => {
  const y = read(".github/workflows/ios-release.yml");
  assert.match(y, /CURRENT_PROJECT_VERSION="\$BUILD" AppIdentifierPrefix="\$TEAM\."/);
  assert.ok(y.includes(FLAGS));
  assert.ok(y.includes('check-archive-groups.sh "$RUNNER_TEMP/PushArmor.xcarchive" "$TEAM"'));
});

test("ios.yml dispatch runs the same archive line and checks", () => {
  const y = read(".github/workflows/ios.yml");
  assert.ok(y.includes(FLAGS));
  assert.ok(y.includes('AppIdentifierPrefix="$TEAM."'));
  assert.ok(y.includes('check-archive-groups.sh "$RUNNER_TEMP/PushArmor.xcarchive" "$TEAM"'));
});

test("android-release: the Play upload is its own job after the GitHub prerelease", () => {
  const y = read(".github/workflows/android-release.yml");
  const pub = y.slice(y.indexOf("\n  android-rel-publish:"), y.indexOf("\n  android-rel-play:"));
  const play = y.slice(y.indexOf("\n  android-rel-play:"));
  assert.ok(pub.length > 0 && play.length > 0);
  assert.ok(pub.includes("gh release create"));
  assert.ok(!pub.includes("androidpublisher"), "no Play call in the GitHub release job");
  assert.match(play, /needs: \[android-rel-build, android-rel-publish\]/);
  assert.match(play, /environment: android-release/);
  assert.match(play, /id-token: write/);
  assert.ok(!/contents: write/.test(play), "the Play job needs no contents: write");
  assert.ok(play.includes("bundles.upload") || play.includes("/bundles?uploadType=media"));
});

test("android-release: jarsigner takes the signature algorithm from the upload key", () => {
  const y = read(".github/workflows/android-release.yml");
  assert.ok(y.includes("jarsigner -keystore"));
  assert.ok(!/^ *-sigalg /m.test(y) && !/jarsigner .*-sigalg/.test(y));
});

test("webext-release: CWS upload and publish are their own jobs after the Chrome prerelease", () => {
  const y = read(".github/workflows/webext-release.yml");
  const job = (n) => { const i = y.indexOf("\n  " + n + ":"); assert.ok(i >= 0, n); const r = y.slice(i + 1); const k = r.search(/\n  [a-z-]+:\n/); return k < 0 ? r : r.slice(0, k); };
  const pub = job("publish-chrome");
  const up = job("cws-upload-chrome");
  const ps = job("cws-publish-chrome");
  assert.ok(pub.includes("gh release create") && !pub.includes("chromewebstore.googleapis.com"));
  assert.match(up, /needs: \[build-chrome, publish-chrome\]/);
  assert.ok(up.includes(":upload") && !up.includes(":publish"));
  assert.match(ps, /needs: \[build-chrome, cws-upload-chrome\]/);
  assert.ok(ps.includes('curl -sS --fail-with-body -H "Content-Length: 0" "$@"'), "the bodyless publish POST sends Content-Length");
  for (const j of [up, ps]) {
    assert.match(j, /environment: chrome-release/);
    assert.ok(!/contents: write/.test(j));
  }
});
