#!/bin/sh
# Test for check-release-values.sh. Run: sh client/ios/tools/check-release-values.test.sh
here="$(cd "$(dirname "$0")" && pwd)"
s="$here/check-release-values.sh"
d="$(mktemp -d)"; trap 'rm -rf "$d"' EXIT
mkdir "$d/App"
fail=0
expect() { # name want-status, rest is env
  name="$1"; want="$2"; shift 2
  env -i PATH="$PATH" SRCROOT="$d" "$@" sh "$s" >/dev/null 2>"$d/err"; got=$?
  if [ "$got" != "$want" ]; then echo "FAIL $name: status $got, want $want"; fail=1; else echo "ok $name"; fi
}
GOOD="DEVELOPMENT_TEAM=ABCDE12345 GOOGLE_IOS_CLIENT_ID=1-x GOOGLE_CALLBACK_SCHEME=com.googleusercontent.apps.1-x"
printf '<key>aps-environment</key>\n<string>production</string>\n' > "$d/App/PushArmor.entitlements"
expect debug-empty 0 CONFIGURATION=Debug
expect release-empty 1 CONFIGURATION=Release
expect release-good 0 CONFIGURATION=Release $GOOD
expect release-placeholder 1 CONFIGURATION=Release DEVELOPMENT_TEAM=PLACEHOLDER_TEAM GOOGLE_IOS_CLIENT_ID=1-x GOOGLE_CALLBACK_SCHEME=s
DUMMY="DEVELOPMENT_TEAM=ci-fork-dummy-apple_team_id GOOGLE_IOS_CLIENT_ID=1-x GOOGLE_CALLBACK_SCHEME=s"
expect release-dummy 1 CONFIGURATION=Release $DUMMY
expect release-dummy-allowed 0 CONFIGURATION=Release PA_CI_DUMMY=1 $DUMMY
expect release-placeholder-dummy-flag 1 CONFIGURATION=Release PA_CI_DUMMY=1 DEVELOPMENT_TEAM=PLACEHOLDER_TEAM GOOGLE_IOS_CLIENT_ID=1-x GOOGLE_CALLBACK_SCHEME=s
printf '<key>aps-environment</key>\n<string>development</string>\n' > "$d/App/PushArmor.entitlements"
expect release-aps-dev 1 CONFIGURATION=Release $GOOD
printf '<key>aps-environment</key>\n<string>$(APS_ENVIRONMENT)</string>\n' > "$d/App/PushArmor.entitlements"
expect release-aps-setting-prod 0 CONFIGURATION=Release APS_ENVIRONMENT=production $GOOD
expect release-aps-setting-dev 1 CONFIGURATION=Release APS_ENVIRONMENT=development $GOOD
expect release-aps-setting-unset 1 CONFIGURATION=Release $GOOD
expect debug-aps-setting-dev 0 CONFIGURATION=Debug APS_ENVIRONMENT=development
printf '<key>com.apple.developer.applesignin</key>\n<array/>\n' > "$d/App/PushArmor.entitlements"
expect release-aps-missing 1 CONFIGURATION=Release $GOOD
rm "$d/App/PushArmor.entitlements"
expect release-no-entitlements 1 CONFIGURATION=Release $GOOD
expect debug-no-entitlements 0 CONFIGURATION=Debug
exit $fail
