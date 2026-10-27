# PushArmor for Android

Android client of PushArmor (package `com.pusharmor`, minSdk 31). Kotlin, Jetpack
Compose, Gradle Kotlin DSL with a version catalog.

## Modules

| Module      | Kind              | Content |
|-------------|-------------------|---------|
| `:crypto`   | pure Kotlin/JVM   | strict b64url, P-256 point checks, DER <-> raw r\|\|s, HKDF, HPKE (RFC 9180 base mode, DHKEM(P-256, HKDF-SHA256), AES-256-GCM), ids, keyhash, pairing fingerprint, pairing id, pairing key, OAuth nonce, PA-REQ1 bytes. Key use goes through `KeyOps`. |
| `:protocol` | pure Kotlin/JVM   | inner message build/parse, padding, deflate-raw, strict JSON, name entries, pair messages, replay window, acceptance table, `pair_decide`, phone and URL rules, size cap, and the client state machines (pairing, approve re-send, allow reconcile, clock-skew retry, send, peers merge). |
| `:net`      | pure Kotlin/JVM   | Worker API client (OkHttp): PA-Sig signing over the exact body bytes, Worker clock offset, retry policy, error words to UI text. |
| `:store`    | Android library   | Room database (`self`, `peers`, `pairing`, `pairing_cap`, `replay`, `allow_set`, `history`). |
| `:app`      | Android app       | Compose UI, Android Keystore keys (`pa.sign`, `pa.enc`), FCM (play) and UnifiedPush, notifications, share target, WorkManager jobs. |

## Flavors

- `play`: FCM and UnifiedPush, Google sign-in through Credential Manager.
- `foss`: no Firebase and no Google Play services code; UnifiedPush only.

Both use applicationId `com.pusharmor` and the same versionCode. The version comes from
`release/version.properties` (versionCode = major * 1000000 + minor * 1000 + patch).

`app/src/play/google-services.json` is a placeholder; replace it with the real Firebase
client config before a release build.

## Build and test

Requires JDK 17 and an Android SDK (platform 35, build-tools 34.0.0).

    export ANDROID_HOME=/path/to/android-sdk
    ./gradlew :crypto:test :protocol:test :net:test        # pure JVM tests
    ./gradlew :store:testDebugUnitTest                      # Room tests (Robolectric)
    ./gradlew :app:testFossDebugUnitTest :app:testPlayDebugUnitTest
    ./gradlew :app:assembleFossDebug :app:assemblePlayDebug
    ./gradlew :app:connectedFossDebugAndroidTest            # needs a device or emulator

The JVM tests of `:crypto` and `:protocol` run every section of the cross-platform vector
file `tests/vectors/golden-v1.json` (path relative to the repo root) and fail when it is
missing.
