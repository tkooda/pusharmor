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
