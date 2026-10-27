#!/bin/sh
# Test for public-xcconfig.sh. Run: sh client/ios/tools/public-xcconfig.test.sh
here="$(cd "$(dirname "$0")" && pwd)"
d="$(mktemp -d)"; trap 'rm -rf "$d"' EXIT
mkdir -p "$d/tools" "$d/Config"
cp "$here/public-xcconfig.sh" "$d/tools/"
s="$d/tools/public-xcconfig.sh"
fail=0
expect() { # name want-status public-json-path [env]
  name="$1"; want="$2"; f="$3"; shift 3
  env -u PA_CI_DUMMY "$@" sh "$s" "$f" >/dev/null 2>"$d/err"; got=$?
  if [ "$got" != "$want" ]; then echo "FAIL $name: status $got, want $want"; cat "$d/err"; fail=1; else echo "ok $name"; fi
}
expect missing 1 "$d/none.json"
expect committed 1 "$here/../../../release/public.json"
[ -f "$d/Config/Public.xcconfig" ] && { echo "FAIL: file written on error"; fail=1; }
printf '{"apple_team_id":"ABCDE12345","google_ios_client_id":"12-ab.apps.googleusercontent.com"}' > "$d/good.json"
expect good 0 "$d/good.json"
want='DEVELOPMENT_TEAM = ABCDE12345
GOOGLE_IOS_CLIENT_ID = 12-ab.apps.googleusercontent.com
GOOGLE_CALLBACK_SCHEME = com.googleusercontent.apps.12-ab'
if [ "$(grep -v '^//' "$d/Config/Public.xcconfig")" = "$want" ]; then echo "ok content"; else echo "FAIL content"; fail=1; fi
printf '{"apple_team_id":"ABCDE12345","google_ios_client_id":"12-ab"}' > "$d/bad.json"
expect bad-client-id 1 "$d/bad.json"
printf '{"apple_team_id":"ci-fork-dummy-apple_team_id","google_ios_client_id":"ci-fork-dummy-google_ios_client_id"}' > "$d/dummy.json"
expect dummy-without-flag 1 "$d/dummy.json"
expect dummy-with-flag 0 "$d/dummy.json" PA_CI_DUMMY=1
exit $fail
