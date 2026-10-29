#!/bin/bash
# Test for check-archive-groups.sh. Run: bash client/ios/tools/check-archive-groups.test.sh (VERBOSE=1 prints each output)
# Fake bundle trees; a fake codesign on PATH prints the entitlements in $1/ent.xml.
here="$(cd "$(dirname "$0")" && pwd)"
s="$here/check-archive-groups.sh"
d="$(mktemp -d)"; trap 'rm -rf "$d"' EXIT
fail=0
T=ABCDE12345
mkdir "$d/fakebin"
cat > "$d/fakebin/codesign" <<'X'
#!/bin/sh
for a; do last="$a"; done
[ -f "$last/ent.xml" ] || exit 1
cat "$last/ent.xml"
X
chmod +x "$d/fakebin/codesign"

# bundle <dir> <keychain group> [app group]: Info.plist and entitlements.
bundle() {
  mkdir -p "$1"
  printf '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>PAKeychainGroup</key><string>%s</string></dict></plist>\n' "$2" > "$1/Info.plist"
  printf '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>keychain-access-groups</key><array><string>%s</string></array><key>com.apple.security.application-groups</key><array><string>%s</string></array></dict></plist>\n' "$2" "${3:-group.com.pusharmor.app}" > "$1/ent.xml"
}
# archive <dir> <app group> <nse group> <share group>
archive() {
  rm -rf "$1"; a="$1/Products/Applications/PushArmor.app"
  bundle "$a" "$2"; bundle "$a/PlugIns/PushArmorNSE.appex" "$3"; bundle "$a/PlugIns/PushArmorShare.appex" "$4"
}
expect() { # name want-status args...
  name="$1"; want="$2"; shift 2
  env PATH="$d/fakebin:$PATH" bash "$s" "$@" >"$d/out" 2>&1; got=$?
  if [ "$got" != "$want" ]; then echo "FAIL $name: status $got, want $want"; cat "$d/out"; fail=1; else echo "ok $name"; fi
  [ -n "$VERBOSE" ] && sed "s/^/    /" "$d/out"
}
A="$d/PushArmor.xcarchive"
G="$T.com.pusharmor.app.shared"
archive "$A" "$G" "$G" "$G"; expect pass 0 "$A" "$T"
expect pass-app-dir 0 "$A/Products/Applications/PushArmor.app" "$T"
expect no-args 2
expect no-team 2 "$A"
# The failure before the fix: no AppIdentifierPrefix in an ad-hoc archive.
archive "$A" com.pusharmor.app.shared com.pusharmor.app.shared com.pusharmor.app.shared; expect no-prefix 1 "$A" "$T"
archive "$A" "$G" com.pusharmor.app.shared "$G"; expect no-prefix-nse 1 "$A" "$T"
archive "$A" "$G" "$G" "OTHER99999.com.pusharmor.app.shared"; expect wrong-team-share 1 "$A" "$T"
archive "$A" "$G" "$G" "$G"; bundle "$A/Products/Applications/PushArmor.app" "$G" group.other; expect wrong-app-group 1 "$A" "$T"
archive "$A" "$G" "$G" "$G"; rm "$A/Products/Applications/PushArmor.app/PlugIns/PushArmorNSE.appex/ent.xml"; expect unsigned-nse 1 "$A" "$T"
archive "$A" "$G" "$G" "$G"; rm -rf "$A/Products/Applications/PushArmor.app/PlugIns/PushArmorShare.appex"; expect missing-share 1 "$A" "$T"
exit "$fail"
