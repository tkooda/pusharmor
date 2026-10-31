#!/bin/bash
# Checks the App Group and the team-prefixed keychain group in a release archive:
# aps-environment (app only), Info.plist PAKeychainGroup and the signed keychain-access-groups and
# application-groups of the app, the NSE and the Share extension.
# AppIdentifierPrefix normally comes from a provisioning profile; the ad-hoc
# archive has none, so the archive line must set it to "TEAM.".
# Usage: bash tools/check-archive-groups.sh ARCHIVE_OR_APP TEAM [BUNDLE_ID]
set -u
[ $# -ge 2 ] && [ -n "$1" ] && [ -n "$2" ] || { echo "usage: $0 ARCHIVE_OR_APP TEAM [BUNDLE_ID]" >&2; exit 2; }
app="$1"; team="$2"; bid="${3:-com.pusharmor.app}"
[ -d "$app/Products/Applications/PushArmor.app" ] && app="$app/Products/Applications/PushArmor.app"
[ -d "$app" ] || { echo "error: $app is not a directory" >&2; exit 1; }
d="$(mktemp -d)"; trap 'rm -rf "$d"' EXIT
fail=0
for b in "$app" "$app/PlugIns/PushArmorNSE.appex" "$app/PlugIns/PushArmorShare.appex"; do
  aps=""; [ "$b" = "$app" ] && aps=production
  codesign -d --entitlements - --xml "$b" > "$d/ent.plist" 2>/dev/null || { echo "error: no entitlements on $b"; fail=1; continue; }
  python3 -I - "$b/Info.plist" "$d/ent.plist" "$b" "$team" "$bid" "$aps" <<'PY' || fail=1
import plistlib, sys
info, ent, name, team, bid, aps = sys.argv[1:7]
want = team + "." + bid + ".shared"
bad = []
try:
    i = plistlib.load(open(info, "rb"))
except Exception as e:
    i = {}
    bad.append("Info.plist unreadable: %s" % e)
try:
    e = plistlib.load(open(ent, "rb"))
except Exception as x:
    e = {}
    bad.append("entitlements unreadable: %s" % x)
if i.get("PAKeychainGroup") != want:
    bad.append("Info.plist PAKeychainGroup is %r, want %r" % (i.get("PAKeychainGroup"), want))
if e.get("keychain-access-groups") != [want]:
    bad.append("keychain-access-groups is %r, want %r" % (e.get("keychain-access-groups"), [want]))
if e.get("com.apple.security.application-groups") != ["group." + bid]:
    bad.append("application-groups is %r" % e.get("com.apple.security.application-groups"))
if aps and e.get("aps-environment") != aps:
    bad.append("aps-environment is %r, want %r" % (e.get("aps-environment"), aps))
elif not aps and "aps-environment" in e:
    bad.append("aps-environment must be absent")
if bad:
    sys.exit("error: " + name + ":\n  - " + "\n  - ".join(bad))
print("ok: " + name)
PY
done
exit "$fail"
