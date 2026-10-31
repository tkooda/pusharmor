#!/bin/bash
# Release archive without secrets: an unsigned Release archive, then an ad-hoc
# signature with the expanded entitlements on every bundle, so
# xcodebuild -exportArchive (ios-release.yml sign-ios) re-signs it with them.
# xcodebuild refuses ad-hoc signing for the iOS device SDK, so codesign does it.
# AppIdentifierPrefix normally comes from a provisioning profile; it is set to
# "TEAM." here. Run after xcodegen generate and package resolution.
# Usage: bash tools/release-archive.sh ARCHIVE_PATH TEAM VERSION BUILD
set -euo pipefail
[ $# -eq 4 ] || { echo "usage: $0 ARCHIVE_PATH TEAM VERSION BUILD" >&2; exit 2; }
archive="$1"; team="$2"; version="$3"; build="$4"
bid=com.pusharmor.app
[[ "$team" =~ ^[A-Z0-9]{10}$ ]] || { echo "error: TEAM must be 10 uppercase letters or digits" >&2; exit 2; }
cd "$(dirname "$0")/.."
xcodebuild archive -project PushArmor.xcodeproj -scheme PushArmor -configuration Release \
  -destination "generic/platform=iOS" -archivePath "$archive" \
  -disableAutomaticPackageResolution \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= PROVISIONING_PROFILE_SPECIFIER= \
  MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$build" AppIdentifierPrefix="$team."
app="$archive/Products/Applications/PushArmor.app"
[ -d "$app" ] || { echo "error: no $app" >&2; exit 1; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
# expand SRC OUT: the Release values of the entitlements' build settings.
expand() {
  python3 -I - "$1" "$2" "$team" "$bid" <<'PY'
import plistlib, sys
src, out, team, bid = sys.argv[1:5]
vals = {"AppIdentifierPrefix": team + ".", "APP_BUNDLE_ID": bid, "APS_ENVIRONMENT": "production"}
def x(v):
    if isinstance(v, str):
        for k, r in vals.items():
            v = v.replace("$(" + k + ")", r)
        if "$(" in v:
            sys.exit("error: unexpanded build setting in %s: %s" % (src, v))
        return v
    if isinstance(v, list):
        return [x(i) for i in v]
    if isinstance(v, dict):
        return {k: x(i) for k, i in v.items()}
    return v
plistlib.dump(x(plistlib.load(open(src, "rb"))), open(out, "wb"))
PY
}
sign() { codesign --force --sign - --timestamp=none --generate-entitlement-der "$@"; }
# Inside out: nested code first, then each extension, then the app.
find "$app" -depth \( -name '*.framework' -o -name '*.dylib' \) -print0 | while IFS= read -r -d '' f; do sign "$f"; done
expand NSE/PushArmorNSE.entitlements "$tmp/nse.plist"
expand Share/PushArmorShare.entitlements "$tmp/share.plist"
expand App/PushArmor.entitlements "$tmp/app.plist"
sign --entitlements "$tmp/nse.plist" "$app/PlugIns/PushArmorNSE.appex"
sign --entitlements "$tmp/share.plist" "$app/PlugIns/PushArmorShare.appex"
sign --entitlements "$tmp/app.plist" "$app"
codesign --verify --strict --deep "$app"
bash tools/check-archive-groups.sh "$archive" "$team" "$bid"
