#!/bin/bash
# Store screenshots on an iOS simulator (workflow screenshots.yml).
# Usage: bash tools/screenshots.sh <out-dir> [device name] [review-dir]   (run from client/ios after
# xcodegen generate). Boots the device (default iPhone 17 Pro Max, 1320x2868), sets the
# status bar to 9:41, runs PushArmorUITests/ScreenshotTests with PA_SHOTS=1 and exports
# its screenshot attachments as <out-dir>/NN-name.png. Attachments named 9N-* are review
# images: written to [review-dir] when given, else dropped. With PA_SHOTS_ALL=1 it runs only
# ScreenshotTests/testCaptureAllScreens (every screen, light and dark, NN-screen-<theme>,
# none named 9N-*) into <out-dir>.
set -euo pipefail
out="${1:?usage: $0 <out-dir> [device name]}"
name="${2:-iPhone 17 Pro Max}"
review="${3:-}"
udid="$(xcrun simctl list devices available -j | python3 -I -c '
import json, sys
want = sys.argv[1]
for rt, devs in sorted(json.load(sys.stdin)["devices"].items(), reverse=True):
    if "iOS" not in rt:
        continue
    for d in devs:
        if d["name"] == want:
            print(d["udid"]); sys.exit(0)
' "$name")"
[ -n "$udid" ] || { echo "error: no available simulator named $name" >&2; xcrun simctl list devices available; exit 1; }
xcrun simctl boot "$udid" 2>/dev/null || true
xcrun simctl bootstatus "$udid" -b
xcrun simctl status_bar "$udid" override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 \
  --cellularMode active --cellularBars 4 --batteryState discharging --batteryLevel 100
tmp="$(mktemp -d)"
rb="$tmp/shots.xcresult"
all="${PA_SHOTS_ALL:-}"
only=PushArmorUITests/ScreenshotTests
[ "$all" != 1 ] || only=PushArmorUITests/ScreenshotTests/testCaptureAllScreens
TEST_RUNNER_PA_SHOTS=1 TEST_RUNNER_PA_SHOTS_ALL="$all" xcodebuild test -project PushArmor.xcodeproj -scheme PushArmor \
  -destination "platform=iOS Simulator,id=$udid" -disableAutomaticPackageResolution \
  -only-testing:"$only" -resultBundlePath "$rb"
xcrun xcresulttool export attachments --path "$rb" --output-path "$tmp/att"
mkdir -p "$out"
[ -z "$review" ] || mkdir -p "$review"
python3 -I - "$tmp/att" "$out" "$review" <<'PY'
import json, os, re, shutil, sys
src, dst, rev = sys.argv[1], sys.argv[2], sys.argv[3]
n = 0
for t in json.load(open(os.path.join(src, "manifest.json"))):
    for a in t.get("attachments", []):
        m = re.match(r"(\d\d-[a-z0-9-]+)", a.get("suggestedHumanReadableName", ""))
        if m:
            if m.group(1).startswith("9"):
                if rev:
                    shutil.copy(os.path.join(src, a["exportedFileName"]), os.path.join(rev, m.group(1) + ".png"))
                continue
            shutil.copy(os.path.join(src, a["exportedFileName"]), os.path.join(dst, m.group(1) + ".png"))
            n += 1
print("exported %d screenshots" % n)
if n == 0:
    sys.exit(1)
PY
ls -l "$out" ${review:+"$review"}
