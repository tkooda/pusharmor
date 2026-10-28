#!/bin/bash
# Release APK gate, independent of Gradle: no test hooks or test code in a release APK
# (owner ruling: no test hooks in any public release build).
# Usage: bash tools/check-release-apk.sh <apk> [play|foss]
# The flavor defaults to the one named in the APK file name; foss adds the no-Google checks.
# Checks:
#   - manifest (aapt2 dump xmltree): no android:debuggable, no android:testOnly, no
#     android:usesCleartextTraffic true
#   - exported components (exported=true, or an intent-filter without exported): the app's
#     own equal the allow-list MainActivity, ShareActivity, AuthLinkActivity; library
#     components merged in equal a pinned list of name and guarding permission per flavor,
#     so a new exported library component or a dropped permission fails
#   - dex classes (dexdump, else apkanalyzer): no androidx.test, org.junit, junit.,
#     org.mockito, org.robolectric, kotlinx.coroutines.test, and no crypto testFixtures
#     class (SoftwareKeyOps, Golden, EcMath), no screenshot mode (ScreenshotMode, app.shots); foss: no com.google.firebase,
#     com.google.android.gms or androidx.credentials.playservices, in dex or manifest
# Tools: aapt2 and dexdump from $ANDROID_HOME/build-tools (newest), or on PATH; apkanalyzer
# from $ANDROID_HOME/cmdline-tools/latest/bin.
apk="$1"
flavor="$2"
[ -n "$apk" ] && [ -f "$apk" ] || { echo "usage: $0 <apk> [play|foss]" >&2; exit 2; }
if [ -z "$flavor" ]; then
  case "$(basename "$apk")" in
    *foss*) flavor=foss ;;
    *play*) flavor=play ;;
    *) echo "error: cannot tell the flavor from the file name; pass play or foss" >&2; exit 2 ;;
  esac
fi
case "$flavor" in play|foss) ;; *) echo "error: flavor must be play or foss" >&2; exit 2 ;; esac

ALLOWED="com.pusharmor.app.ui.AuthLinkActivity -
com.pusharmor.app.ui.MainActivity -
com.pusharmor.app.ui.ShareActivity -"
# Library components the manifest merger adds, with the permission that guards each
# ("-": none; UnifiedPush distributors deliver by plain broadcast).
LIB_ALLOWED="androidx.profileinstaller.ProfileInstallReceiver android.permission.DUMP
androidx.work.impl.background.systemjob.SystemJobService android.permission.BIND_JOB_SERVICE
androidx.work.impl.diagnostics.DiagnosticsReceiver android.permission.DUMP
org.unifiedpush.android.connector.internal.MessagingReceiverImpl -
org.unifiedpush.android.connector.internal.RaiseToForegroundService -"
[ "$flavor" = play ] && LIB_ALLOWED="$LIB_ALLOWED
com.google.android.gms.auth.api.signin.RevocationBoundService com.google.android.gms.auth.api.signin.permission.REVOCATION_NOTIFICATION
com.google.firebase.iid.FirebaseInstanceIdReceiver com.google.android.c2dm.permission.SEND"
ALLOWED="$ALLOWED
$LIB_ALLOWED"
ALLOWED="$(echo "$ALLOWED" | sort)"
TEST_PKGS='androidx\.test\.|org\.junit\.|junit\.|org\.mockito\.|org\.robolectric\.|kotlinx\.coroutines\.test\.|com\.pusharmor\.crypto\.(SoftwareKeyOps|Golden|EcMath)([.$]|$)|com\.pusharmor\.app\.ScreenshotMode([.$]|$)|com\.pusharmor\.app\.shots\.'
FOSS_PKGS='com\.google\.firebase\.|com\.google\.android\.gms\.|androidx\.credentials\.playservices\.'

# tool <name>: print the path of an SDK tool.
tool() {
  if [ -n "$ANDROID_HOME" ]; then
    for p in $(ls -d "$ANDROID_HOME"/build-tools/*/ 2>/dev/null | sort -V -r) "$ANDROID_HOME/cmdline-tools/latest/bin/"; do
      [ -x "$p$1" ] && { echo "$p$1"; return 0; }
    done
  fi
  command -v "$1"
}
aapt2="$(tool aapt2)" || { echo "error: aapt2 not found (set ANDROID_HOME)" >&2; exit 2; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
bad=""
add() { bad="$bad
  - $1"; }

# 1. Manifest.
"$aapt2" dump xmltree --file AndroidManifest.xml "$apk" > "$tmp/manifest.txt" \
  || { echo "error: aapt2 cannot read the manifest of $apk" >&2; exit 2; }
python3 -I - "$tmp/manifest.txt" > "$tmp/manifest.out" <<'PY' || { echo "error: cannot parse the manifest dump" >&2; exit 2; }
import re, sys
TRUE = ("true", "(type 0x12)0xffffffff", "-1")
attr_re = re.compile(r'^A: (?:http://schemas.android.com/apk/res/android:)?([A-Za-z]+)(?:\(0x[0-9a-f]+\))?=(.*)$')
stack = []   # [indent, element, attrs, has intent-filter]
comps = []
app = {}
def close(upto):
    while stack and stack[-1][0] >= upto:
        e = stack.pop()
        if e[1] in ("activity", "activity-alias", "service", "receiver", "provider"):
            comps.append(e)
        if e[1] == "application":
            app.update(e[2])
for line in open(sys.argv[1]):
    body = line.lstrip(" ")
    ind = len(line) - len(body)
    body = body.rstrip("\n")
    if body.startswith("E: "):
        close(ind)
        name = body[3:].split(" ")[0]
        if name == "intent-filter" and stack:
            stack[-1][3] = True
        stack.append([ind, name, {}, False])
    elif body.startswith("A: ") and stack:
        m = attr_re.match(body)
        if m:
            v = m.group(2)
            q = re.match(r'^"([^"]*)"', v)
            stack[-1][2][m.group(1)] = q.group(1) if q else v.split(" ")[0]
close(-1)
for k in ("debuggable", "testOnly"):
    if k in app:
        print("bad\tandroid:%s is set (%s)" % (k, app[k]))
if app.get("usesCleartextTraffic") in TRUE:
    print("bad\tandroid:usesCleartextTraffic is true")
for ind, el, attrs, has_filter in comps:
    exp = attrs.get("exported")
    if exp in TRUE or (exp is None and has_filter):
        print("exported\t%s %s" % (attrs.get("name", "?"), attrs.get("permission", "-")))
    print("component\t" + attrs.get("name", "?"))
PY
while IFS="$(printf '\t')" read -r kind val; do
  [ "$kind" = bad ] && add "manifest: $val"
done < "$tmp/manifest.out"
got="$(grep '^exported' "$tmp/manifest.out" | cut -f2 | sort)"
if [ "$got" != "$ALLOWED" ]; then
  extra="$(comm -13 <(echo "$ALLOWED") <(echo "$got") | paste -sd ';' -)"
  missing="$(comm -23 <(echo "$ALLOWED") <(echo "$got") | paste -sd ';' -)"
  add "manifest: exported components differ from the allow-list (extra: ${extra:-none}; missing: ${missing:-none})"
fi
if [ "$flavor" = foss ]; then
  hits="$(grep '^component' "$tmp/manifest.out" | cut -f2 | grep -E "$FOSS_PKGS" | tr '\n' ' ')"
  [ -z "$hits" ] || add "manifest: foss declares Google components: $hits"
fi

# 2. Dex classes, as dotted names.
if dexdump="$(tool dexdump)"; then
  mkdir "$tmp/dex"
  unzip -q -o "$apk" 'classes*.dex' -d "$tmp/dex" || { echo "error: no classes*.dex in $apk" >&2; exit 2; }
  for f in "$tmp"/dex/classes*.dex; do "$dexdump" "$f"; done \
    | sed -n "s/^ *Class descriptor *: 'L\(.*\);'$/\1/p" | tr '/' '.' > "$tmp/classes.txt"
elif apkanalyzer="$(tool apkanalyzer)"; then
  "$apkanalyzer" dex packages --defined-only "$apk" | awk '$1 == "C" { print $NF }' > "$tmp/classes.txt"
else
  echo "error: neither dexdump nor apkanalyzer found (set ANDROID_HOME)" >&2; exit 2
fi
[ -s "$tmp/classes.txt" ] || { echo "error: no dex classes read from $apk" >&2; exit 2; }
hits="$(grep -E "^($TEST_PKGS)" "$tmp/classes.txt" | head -n 5 | tr '\n' ' ')"
[ -z "$hits" ] || add "dex: test classes present (first: $hits)"
if [ "$flavor" = foss ]; then
  hits="$(grep -E "^($FOSS_PKGS)" "$tmp/classes.txt" | head -n 5 | tr '\n' ' ')"
  [ -z "$hits" ] || add "dex: foss holds Google classes (first: $hits)"
fi

if [ -n "$bad" ]; then
  echo "error: release APK check failed ($flavor): $apk$bad" >&2
  exit 1
fi
echo "ok: release APK check passed ($flavor, $(wc -l < "$tmp/classes.txt") classes): $apk"
