#!/bin/bash
# Test for check-release-bundle.sh. Run: bash client/ios/tools/check-release-bundle.test.sh (VERBOSE=1 prints each output)
# Fake bundle trees; fake otool and codesign on PATH cover those checks on any host.
here="$(cd "$(dirname "$0")" && pwd)"
s="$here/check-release-bundle.sh"
d="$(mktemp -d)"; trap 'rm -rf "$d"' EXIT
fail=0
printf '{"google_ios_client_id":"12-ab.apps.googleusercontent.com"}' > "$d/public.json"
SCHEME=com.googleusercontent.apps.12-ab

mkdir "$d/fakebin"
cat > "$d/fakebin/otool" <<'EOF'
#!/bin/sh
echo "$2:"
echo "	/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)"
[ -n "$FAKE_OTOOL_LIB" ] && echo "	$FAKE_OTOOL_LIB (compatibility version 1.0.0)"
exit 0
EOF
cat > "$d/fakebin/codesign" <<'EOF'
#!/bin/sh
echo '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>'
[ -n "$FAKE_GET_TASK_ALLOW" ] && printf '<key>get-task-allow</key>\n  <true/>\n'
echo '</dict></plist>'
EOF
chmod +x "$d/fakebin/otool" "$d/fakebin/codesign"

# info <dir> <exe> [scheme...]: write an XML Info.plist.
info() {
  dir="$1"; exe="$2"; shift 2
  {
    echo '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>'
    echo "<key>CFBundleExecutable</key><string>$exe</string>"
    if [ $# -gt 0 ]; then
      echo '<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array>'
      for x in "$@"; do echo "<string>$x</string>"; done
      echo '</array></dict></array>'
    fi
    echo '</dict></plist>'
  } > "$dir/Info.plist"
}
# good <app dir>: a clean app with two extensions.
good() {
  rm -rf "$1"; mkdir -p "$1/PlugIns/PushArmorNSE.appex" "$1/PlugIns/PushArmorShare.appex" "$1/Frameworks"
  info "$1" PushArmor "$SCHEME"; echo "app main code" > "$1/PushArmor"
  info "$1/PlugIns/PushArmorNSE.appex" PushArmorNSE; echo "nse code" > "$1/PlugIns/PushArmorNSE.appex/PushArmorNSE"
  info "$1/PlugIns/PushArmorShare.appex" PushArmorShare; echo "share code" > "$1/PlugIns/PushArmorShare.appex/PushArmorShare"
}
expect() { # name want-status path [env...]
  name="$1"; want="$2"; p="$3"; shift 3
  env PATH="$d/fakebin:$PATH" "$@" bash "$s" "$p" "$d/public.json" >"$d/out" 2>&1; got=$?
  if [ "$got" != "$want" ]; then echo "FAIL $name: status $got, want $want"; cat "$d/out"; fail=1; else echo "ok $name"; fi
  [ -n "$VERBOSE" ] && sed "s/^/    /" "$d/out"
}
A="$d/PushArmor.app"

good "$A"; expect pass 0 "$A"
expect no-args 2 ""
good "$A"; mkdir "$A/Frameworks/XCTest.framework"; expect xctest-framework 1 "$A"
good "$A"; mkdir "$A/Frameworks/XCTestCore.framework"; expect xctest-core-framework 1 "$A"
good "$A"; mkdir "$A/Frameworks/Testing.framework"; expect testing-framework 1 "$A"
good "$A"; mkdir "$A/Frameworks/XCUIAutomation.framework"; expect xcuiautomation 1 "$A"
good "$A"; mkdir "$A/Frameworks/XCTAutomationSupport.framework"; expect xctautomationsupport 1 "$A"
good "$A"; touch "$A/Frameworks/libXCTestSwiftSupport.dylib"; expect libxctest 1 "$A"
good "$A"; mkdir "$A/PlugIns/PushArmorTests.xctest"; expect xctest-bundle 1 "$A"
good "$A"; mkdir "$A/PlugIns/PushArmorShare.appex/Frameworks"; mkdir "$A/PlugIns/PushArmorShare.appex/Frameworks/XCTest.framework"
expect xctest-in-appex 1 "$A"
good "$A"; echo "XCTest" >> "$A/PushArmor"; expect strings-xctest 1 "$A"
good "$A"; echo "XCUIApplication" >> "$A/PlugIns/PushArmorNSE.appex/PushArmorNSE"; expect strings-xcui-appex 1 "$A"
good "$A"; echo "PushArmorUITests" >> "$A/PushArmor"; expect strings-uitest 1 "$A"
good "$A"; rm "$A/PushArmor"; expect missing-exe 1 "$A"
good "$A"; expect otool-xctest 1 "$A" FAKE_OTOOL_LIB=@rpath/XCTest.framework/XCTest
good "$A"; expect otool-testing 1 "$A" FAKE_OTOOL_LIB=@rpath/Testing.framework/Testing
good "$A"; expect get-task-allow 1 "$A" FAKE_GET_TASK_ALLOW=1
good "$A"; info "$A" PushArmor "$SCHEME" pusharmor-test; expect extra-scheme 1 "$A"
good "$A"; info "$A" PushArmor; expect no-scheme 1 "$A"
good "$A"; info "$A" PushArmor com.googleusercontent.apps.99-zz; expect wrong-scheme 1 "$A"
good "$A"; info "$A/PlugIns/PushArmorNSE.appex" PushArmorNSE x-nse; expect appex-scheme 1 "$A"

good "$A"; mkdir -p "$d/X.xcarchive/Products/Applications"; rm -rf "$d/X.xcarchive/Products/Applications/PushArmor.app"
cp -R "$A" "$d/X.xcarchive/Products/Applications/"; expect xcarchive-pass 0 "$d/X.xcarchive"
mkdir "$d/X.xcarchive/Products/Applications/PushArmor.app/Frameworks/XCTest.framework"; expect xcarchive-xctest 1 "$d/X.xcarchive"
good "$A"; rm -rf "$d/ipa"; mkdir -p "$d/ipa/Payload"; cp -R "$A" "$d/ipa/Payload/"
(cd "$d/ipa" && zip -qr "$d/X.ipa" Payload); expect ipa-pass 0 "$d/X.ipa"
mkdir "$d/ipa/Payload/PushArmor.app/PlugIns/PushArmorTests.xctest"; rm -f "$d/X.ipa"
(cd "$d/ipa" && zip -qr "$d/X.ipa" Payload); expect ipa-xctest 1 "$d/X.ipa"

# Without otool and codesign the other checks still run, and the output says what was skipped.
mkdir "$d/nobin"
for t in bash sh env python3 find grep sort tr dirname mktemp rm ls head uname unzip strings cat; do
  p="$(command -v "$t")" && ln -s "$p" "$d/nobin/$t"
done
good "$A"
PATH="$d/nobin" bash "$s" "$A" "$d/public.json" >"$d/out" 2>&1; got=$?
if [ "$got" = 0 ] && grep -q 'otool not found' "$d/out" && grep -q 'codesign not found' "$d/out"; then
  echo "ok no-tools-skip"
else
  echo "FAIL no-tools-skip: status $got"; cat "$d/out"; fail=1
fi
echo "XCTest" >> "$A/PushArmor"
PATH="$d/nobin" bash "$s" "$A" "$d/public.json" >"$d/out" 2>&1; got=$?
if [ "$got" = 1 ]; then echo "ok no-tools-strings"; else echo "FAIL no-tools-strings: status $got"; fail=1; fi
exit $fail
