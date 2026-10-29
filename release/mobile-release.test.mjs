// Mobile release workflows: invariants the first runs depend on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const ARCHIVE = 'bash client/ios/tools/release-archive.sh "$RUNNER_TEMP/PushArmor.xcarchive" "$TEAM" "$VERSION" "$BUILD"';

test("ios-release archives with tools/release-archive.sh (unsigned, codesign ad-hoc, group check)", () => {
  const y = read(".github/workflows/ios-release.yml");
  assert.ok(y.includes(ARCHIVE));
  assert.ok(!/xcodebuild archive/.test(y), "the archive line lives in the script only");
  const sh = read("client/ios/tools/release-archive.sh");
  assert.ok(sh.includes("CODE_SIGNING_ALLOWED=NO"), "xcodebuild refuses ad-hoc signing for the device SDK");
  assert.ok(sh.includes('AppIdentifierPrefix="$team."'));
  assert.ok(sh.includes("--generate-entitlement-der"));
  assert.ok(sh.includes('check-archive-groups.sh "$archive" "$team"'));
  assert.ok(sh.includes("[A-Z0-9]{10}"), "TEAM is validated");
  const chk = read("client/ios/tools/check-archive-groups.sh");
  assert.ok(chk.includes("aps-environment"));
  assert.ok(y.includes("application-identifier") && y.includes("aps-environment"));
});

test("ios.yml dispatch runs the same release archive script", () => {
  const y = read(".github/workflows/ios.yml");
  assert.ok(y.includes('bash tools/release-archive.sh "$RUNNER_TEMP/PushArmor.xcarchive" "$TEAM"'));
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

test("android-release: the bodyless edits:commit POST sends Content-Length (I406)", () => {
  const y = read(".github/workflows/android-release.yml");
  assert.ok(y.includes('call -X POST -H "$auth" -H "Content-Length: 0" "$api/edits/$edit:commit"'));
});
