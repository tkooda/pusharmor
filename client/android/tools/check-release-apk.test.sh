#!/bin/bash
# Test for check-release-apk.sh with fake aapt2 and dexdump on PATH (no SDK needed).
# Run: bash client/android/tools/check-release-apk.test.sh (VERBOSE=1 prints each output)
here="$(cd "$(dirname "$0")" && pwd)"
s="$here/check-release-apk.sh"
d="$(mktemp -d)"; trap 'rm -rf "$d"' EXIT
fail=0
mkdir "$d/bin"
printf '#!/bin/sh\ncat "$FAKE_MANIFEST"\n' > "$d/bin/aapt2"
printf '#!/bin/sh\ncat "$FAKE_CLASSES"\n' > "$d/bin/dexdump"
chmod +x "$d/bin/aapt2" "$d/bin/dexdump"
echo x > "$d/classes.dex"
(cd "$d" && zip -q app-foss-release.apk classes.dex && cp app-foss-release.apk app-play-release.apk \
  && cp app-foss-release.apk app.apk)

NS=http://schemas.android.com/apk/res/android
# comp <element> <name> <exported|-> <permission|-> [filter]: one component in aapt2 form.
comp() {
  echo "      E: $1 (line=1)"
  echo "        A: $NS:name(0x01010003)=\"$2\" (Raw: \"$2\")"
  [ "$4" = - ] || echo "        A: $NS:permission(0x01010006)=\"$4\" (Raw: \"$4\")"
  [ "$3" = - ] || echo "        A: $NS:exported(0x01010010)=$3"
  if [ -n "$5" ]; then
    echo "        E: intent-filter (line=2)"
    echo "          E: action (line=3)"
    echo "            A: $NS:name(0x01010003)=\"$5\" (Raw: \"$5\")"
  fi
}
# manifest <flavor> [application attr line...] then extra components on stdin.
manifest() {
  f="$1"; shift
  {
    echo "N: android=$NS (line=2)"
    echo "  E: manifest (line=2)"
    echo "    A: $NS:versionCode(0x0101021b)=1"
    echo "    E: application (line=8)"
    for a in "$@"; do echo "      A: $NS:$a"; done
    comp activity com.pusharmor.app.ui.MainActivity true - android.intent.action.MAIN
    comp activity-alias com.pusharmor.app.ui.AuthTicket false -
    comp activity com.pusharmor.app.ui.ShareActivity true - android.intent.action.SEND
    comp activity com.pusharmor.app.ui.AuthLinkActivity true - android.intent.action.VIEW
    comp service com.pusharmor.app.push.UpService false - org.unifiedpush.android.connector.PUSH_EVENT
    comp receiver androidx.profileinstaller.ProfileInstallReceiver true android.permission.DUMP x
    comp service androidx.work.impl.background.systemjob.SystemJobService true android.permission.BIND_JOB_SERVICE
    comp receiver androidx.work.impl.diagnostics.DiagnosticsReceiver true android.permission.DUMP x
    comp receiver org.unifiedpush.android.connector.internal.MessagingReceiverImpl true - x
    comp service org.unifiedpush.android.connector.internal.RaiseToForegroundService true - x
    if [ "$f" = play ]; then
      comp service com.google.android.gms.auth.api.signin.RevocationBoundService true \
        com.google.android.gms.auth.api.signin.permission.REVOCATION_NOTIFICATION
      comp receiver com.google.firebase.iid.FirebaseInstanceIdReceiver true com.google.android.c2dm.permission.SEND x
      comp service com.pusharmor.app.push.FcmService false - com.google.firebase.MESSAGING_EVENT
    fi
    cat
  } > "$d/manifest.txt"
}
# classes [name...]: a dexdump listing of a few app classes plus the given ones.
classes() {
  for c in com/pusharmor/app/ui/MainActivity com/pusharmor/crypto/Hpke "$@"; do
    echo "  Class descriptor  : 'L$c;'"
    echo "  Access flags      : 0x0011 (PUBLIC FINAL)"
  done > "$d/classes.txt"
}
expect() { # name want-status apk [flavor]
  name="$1"; want="$2"; shift 2
  env -u ANDROID_HOME PATH="$d/bin:$PATH" FAKE_MANIFEST="$d/manifest.txt" FAKE_CLASSES="$d/classes.txt" \
    bash "$s" "$@" >"$d/out" 2>&1; got=$?
  if [ "$got" != "$want" ]; then echo "FAIL $name: status $got, want $want"; cat "$d/out"; fail=1; else echo "ok $name"; fi
  [ -n "$VERBOSE" ] && sed 's/^/    /' "$d/out"
}
F="$d/app-foss-release.apk"; P="$d/app-play-release.apk"

manifest foss </dev/null; classes; expect foss-pass 0 "$F"
manifest play </dev/null; classes; expect play-pass 0 "$P"
expect play-flag-on-generic-name 0 "$d/app.apk" play
expect no-flavor 2 "$d/app.apk"
expect bad-flavor 2 "$F" beta
manifest foss "debuggable(0x0101000f)=true" </dev/null; expect debuggable 1 "$F"
manifest foss "testOnly(0x01010272)=true" </dev/null; expect test-only 1 "$F"
manifest foss "usesCleartextTraffic(0x010104ec)=true" </dev/null; expect cleartext 1 "$F"
manifest foss "usesCleartextTraffic(0x010104ec)=false" </dev/null; expect cleartext-false 0 "$F"
comp activity com.pusharmor.app.ui.DebugActivity true - | manifest foss; expect extra-exported 1 "$F"
comp receiver com.pusharmor.app.TestReceiver - - com.pusharmor.TEST | manifest foss; expect filter-no-exported 1 "$F"
comp receiver com.pusharmor.app.TestReceiver false - com.pusharmor.TEST | manifest foss; expect filter-not-exported 0 "$F"
manifest foss </dev/null; sed -i.bak '/AuthLinkActivity/{n;s/=true/=false/;}' "$d/manifest.txt"; expect allowed-missing 1 "$F"
manifest foss </dev/null; sed -i.bak '/BIND_JOB_SERVICE/d' "$d/manifest.txt"; expect lib-permission-dropped 1 "$F"
manifest play </dev/null; expect play-manifest-as-foss 1 "$F"
comp provider com.google.firebase.provider.FirebaseInitProvider false - | manifest foss; expect foss-google-component 1 "$F"
comp provider com.google.firebase.provider.FirebaseInitProvider false - | manifest play; expect play-google-component 0 "$P"
manifest foss </dev/null
classes org/junit/Assert; expect dex-junit 1 "$F"
classes junit/framework/TestCase; expect dex-junit3 1 "$F"
classes androidx/test/runner/AndroidJUnitRunner; expect dex-androidx-test 1 "$F"
classes org/mockito/Mockito; expect dex-mockito 1 "$F"
classes org/robolectric/Robolectric; expect dex-robolectric 1 "$F"
classes kotlinx/coroutines/test/TestDispatcher; expect dex-coroutines-test 1 "$F"
classes com/pusharmor/crypto/SoftwareKeyOps; expect dex-software-key-ops 1 "$F"
classes 'com/pusharmor/crypto/Golden$Vector'; expect dex-golden-inner 1 "$F"
classes com/pusharmor/crypto/GoldenRatio; expect dex-golden-prefix-only 0 "$F"
classes com/google/firebase/messaging/FirebaseMessaging; expect foss-dex-firebase 1 "$F"
classes com/google/android/gms/common/GoogleApiAvailability; expect foss-dex-gms 1 "$F"
classes androidx/credentials/playservices/HiddenActivity; expect foss-dex-credentials-play 1 "$F"
manifest play </dev/null; classes com/google/firebase/messaging/FirebaseMessaging; expect play-dex-firebase 0 "$P"
classes; : > "$d/classes.txt"; expect no-classes 2 "$P"
exit $fail
