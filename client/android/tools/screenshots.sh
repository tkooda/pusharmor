#!/bin/bash
# Store screenshots on a running emulator or device (workflow screenshots.yml).
# Usage: bash tools/screenshots.sh <out-dir>   (run from client/android)
# Installs the play debug app and its test APK (not connectedAndroidTest: that uninstalls
# the app at the end), turns off the network, puts the status bar in demo mode (full Wi-Fi and
# signal with no "no internet" mark: "fully true"), runs
# shots.ScreenshotCapture with "-e shots 1" and pulls the PNGs into <out-dir>.
set -euo pipefail
out="${1:?usage: $0 <out-dir>}"
pkg=com.pusharmor
# A freshly booted emulator often shows "Pixel Launcher isn't responding" over every shot: hide
# error dialogs, and stop the home app so a dialog that is already up goes away.
adb shell settings put global hide_error_dialogs 1
./gradlew --no-daemon --stacktrace :app:installPlayDebug :app:installPlayDebugAndroidTest
home="$(adb shell cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME | tail -n 1 | cut -d/ -f1 | tr -d '\r')"
[ -n "$home" ] && adb shell am force-stop "$home" || true
adb shell svc wifi disable || true
adb shell svc data disable || true
adb shell settings put global sysui_demo_allowed 1
demo() { adb shell am broadcast -a com.android.systemui.demo -e command "$@" > /dev/null; }
demo enter
demo clock -e hhmm 0941
demo battery -e level 100 -e plugged false
demo network -e wifi show -e level 4 -e fully true
demo network -e mobile show -e datatype none -e level 4 -e fully true
demo notifications -e visible false
adb shell rm -rf "/sdcard/Android/data/$pkg/files/shots"
log="$(adb shell am instrument -w -e shots 1 -e class "$pkg.app.shots.ScreenshotCapture" \
  "$pkg.test/androidx.test.runner.AndroidJUnitRunner")"
echo "$log"
demo exit
echo "$log" | grep -q '^OK (1 test)' || { echo "error: screenshot run failed" >&2; exit 1; }
mkdir -p "$out"
adb pull "/sdcard/Android/data/$pkg/files/shots/." "$out/"
ls -l "$out"
