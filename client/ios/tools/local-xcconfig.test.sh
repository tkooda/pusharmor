#!/bin/sh
# Test for local-xcconfig.sh. Run: sh client/ios/tools/local-xcconfig.test.sh
here="$(cd "$(dirname "$0")" && pwd)"
d="$(mktemp -d)"; trap 'rm -rf "$d"' EXIT
mkdir -p "$d/tools" "$d/Config"
cp "$here/local-xcconfig.sh" "$d/tools/"
s="$d/tools/local-xcconfig.sh"
fail=0
expect() { # name want-status local-json-path
  sh "$s" "$3" >/dev/null 2>"$d/err"; got=$?
  if [ "$got" != "$2" ]; then echo "FAIL $1: status $got, want $2"; cat "$d/err"; fail=1; else echo "ok $1"; fi
}
expect missing 1 "$d/none.json"
expect example 1 "$here/../../../release/local.example.json"
[ -f "$d/Config/Local.xcconfig" ] && { echo "FAIL: file written on error"; fail=1; }
printf '{"ios_development_team":"ABCDE12345","ios_google_client_id":"12-ab.apps.googleusercontent.com"}' > "$d/good.json"
expect good 0 "$d/good.json"
want='DEVELOPMENT_TEAM = ABCDE12345
GOOGLE_IOS_CLIENT_ID = 12-ab.apps.googleusercontent.com
GOOGLE_CALLBACK_SCHEME = com.googleusercontent.apps.12-ab'
if [ "$(grep -v '^//' "$d/Config/Local.xcconfig")" = "$want" ]; then echo "ok content"; else echo "FAIL content"; fail=1; fi
printf '{"ios_development_team":"ABCDE12345","ios_google_client_id":"12-ab"}' > "$d/bad.json"
expect bad-client-id 1 "$d/bad.json"
exit $fail
