#!/bin/bash
# Release bundle gate: no test code, test frameworks or extra URL schemes in a built
# release app (owner ruling: no test hooks in any public release build).
# Usage: bash tools/check-release-bundle.sh <PushArmor.app | .xcarchive | .ipa> [PUBLIC_JSON]
# Checks the app and every .appex inside it:
#   - no XCTest*.framework, XCUIAutomation*, XCTAutomationSupport*, libXCTest*.dylib,
#     Testing.framework or *.xctest anywhere in the bundle
#   - each main executable: otool -L lists no XCTest / XCUI / Testing library (skipped
#     without otool); its strings hold no XCTest, XCUIApplication or UITest
#   - CFBundleURLTypes schemes: the app has exactly the Google callback scheme, derived
#     from google_ios_client_id in release/public.json as tools/public-xcconfig.sh does;
#     an extension has none
#   - codesign entitlements carry no get-task-allow true (skipped without codesign)
# Plists are read with Apple plutil on macOS, else python3 plistlib.
here="$(cd "$(dirname "$0")" && pwd)"
in="$1"
public_json="${2:-$here/../../../release/public.json}"
[ -n "$in" ] && [ -e "$in" ] || { echo "usage: $0 <app|xcarchive|ipa> [public.json]" >&2; exit 2; }
[ -f "$public_json" ] || { echo "error: $public_json is missing" >&2; exit 2; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
case "$in" in
  *.ipa)
    unzip -q "$in" -d "$tmp/ipa" || { echo "error: cannot unzip $in" >&2; exit 2; }
    app="$(ls -d "$tmp"/ipa/Payload/*.app 2>/dev/null | head -n 1)" ;;
  *.xcarchive) app="$(ls -d "$in"/Products/Applications/*.app 2>/dev/null | head -n 1)" ;;
  *) app="$in" ;;
esac
[ -n "$app" ] && [ -d "$app" ] || { echo "error: no .app found in $in" >&2; exit 2; }

if [ "$(uname -s)" = "Darwin" ] && command -v plutil >/dev/null 2>&1; then
  reader=plutil
else
  reader=python3
  echo "note: Apple plutil not available: reading plists with python3 plistlib"
fi

# pl_get <plist> <key>: print a top-level string value.
pl_get() {
  if [ "$reader" = plutil ]; then
    plutil -extract "$2" raw -o - "$1" 2>/dev/null
  else
    python3 -I -c 'import plistlib,sys; v=plistlib.load(open(sys.argv[1],"rb")).get(sys.argv[2]); print(v if isinstance(v,str) else "")' "$1" "$2" 2>/dev/null
  fi
}
# pl_schemes <plist>: print every CFBundleURLSchemes entry, one per line.
pl_schemes() {
  if [ "$reader" = plutil ]; then
    i=0
    while plutil -extract "CFBundleURLTypes.$i" xml1 -o /dev/null "$1" 2>/dev/null; do
      j=0
      while s="$(plutil -extract "CFBundleURLTypes.$i.CFBundleURLSchemes.$j" raw -o - "$1" 2>/dev/null)"; do
        echo "$s"; j=$((j + 1))
      done
      i=$((i + 1))
    done
  else
    python3 -I -c '
import plistlib, sys
for t in plistlib.load(open(sys.argv[1], "rb")).get("CFBundleURLTypes") or []:
    for s in t.get("CFBundleURLSchemes") or []:
        print(s)' "$1"
  fi
}

want_scheme="$(python3 -I -c '
import json, sys
cid = str(json.load(open(sys.argv[1])).get("google_ios_client_id") or "")
suffix = ".apps.googleusercontent.com"
print("com.googleusercontent.apps." + (cid[:-len(suffix)] if cid.endswith(suffix) else cid))' "$public_json")" \
  || { echo "error: cannot read google_ios_client_id from $public_json" >&2; exit 2; }

bad=""
add() { bad="$bad
  - $1"; }

# 1. Test frameworks and bundles anywhere inside the app.
while IFS= read -r f; do
  [ -n "$f" ] && add "test artifact in bundle: ${f#"$app"/}"
done <<EOF
$(find "$app" \( -name 'XCTest*.framework' -o -name 'XCUIAutomation*' -o -name 'XCTAutomationSupport*' \
  -o -name 'libXCTest*.dylib' -o -name 'Testing.framework' -o -name '*.xctest' \) -prune -print)
EOF

have_otool=0; command -v otool >/dev/null 2>&1 && have_otool=1
have_codesign=0; command -v codesign >/dev/null 2>&1 && have_codesign=1
[ $have_otool = 1 ] || echo "note: otool not found: linked-library check skipped"
[ $have_codesign = 1 ] || echo "note: codesign not found: get-task-allow check skipped"

# 2-4. Per bundle: the app, then every app extension.
bundles="$app
$(find "$app" -name '*.appex' -type d)"
while IFS= read -r b; do
  [ -n "$b" ] || continue
  name="${b#"$(dirname "$app")"/}"
  plist="$b/Info.plist"
  if [ ! -f "$plist" ]; then add "$name: no Info.plist"; continue; fi
  exe_name="$(pl_get "$plist" CFBundleExecutable)"
  exe="$b/$exe_name"
  if [ -z "$exe_name" ] || [ ! -f "$exe" ]; then
    add "$name: main executable not found"
  else
    if [ $have_otool = 1 ]; then
      libs="$(otool -L "$exe" | grep -E 'XCTest|XCUI|Testing\.framework')"
      [ -z "$libs" ] || add "$name: links a test library: $(echo "$libs" | tr -s ' \t\n' ' ')"
    fi
    if command -v strings >/dev/null 2>&1; then
      hits="$(strings -a "$exe" | grep -oE 'XCTest|XCUIApplication|UITest' | sort -u | tr '\n' ' ')"
    else
      hits="$(grep -aoE 'XCTest|XCUIApplication|UITest' "$exe" | sort -u | tr '\n' ' ')"
    fi
    [ -z "$hits" ] || add "$name: executable contains test strings: $hits"
  fi
  schemes="$(pl_schemes "$plist" | sort | tr '\n' ' ')"
  if [ "$b" = "$app" ]; then
    [ "$schemes" = "$want_scheme " ] || add "$name: URL schemes are [${schemes% }], want [$want_scheme]"
  else
    [ -z "$schemes" ] || add "$name: an extension declares URL schemes [${schemes% }]"
  fi
  if [ $have_codesign = 1 ]; then
    ent="$(codesign -d --entitlements - --xml "$b" 2>/dev/null)"
    if echo "$ent" | tr -d ' \t\n\r' | grep -q '<key>get-task-allow</key><true/>'; then
      add "$name: entitlements have get-task-allow true (a debug signature)"
    fi
  fi
done <<EOF
$bundles
EOF

if [ -n "$bad" ]; then
  echo "error: release bundle check failed:$bad" >&2
  exit 1
fi
echo "ok: release bundle check passed: $app"
