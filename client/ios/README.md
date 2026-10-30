# PushArmor for iPhone (client/ios)

iOS 17+ app with a Notification Service Extension and a share extension. All
crypto, the wire codec, the API client, the SQLite store and the protocol rules
live in the local Swift package `PushArmorCore`, linked by all three targets.

    PushArmorCore/   Swift package (no UIKit): crypto, codec, rules, store, API
    App/             PushArmor app (SwiftUI)
    NSE/             PushArmorNSE (decrypts every push, sets the banner)
    Share/           PushArmorShare (send a shared URL, text or phone number)
    Shared/          App Group store, Keychain group and platform hooks (all targets)
    project.yml      XcodeGen spec for the Xcode project

Apple frameworks only in the shipped app: CryptoKit, Security, Compression,
UserNotifications, AuthenticationServices, WebKit, SQLite3.

## PushArmorCore

- HPKE: RFC 9180 base mode, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM
  (CryptoKit `HPKE`). Recipient keys in the Secure Enclave on a phone; software
  keys in the Simulator and in tests, through the same code paths.
- ECDSA P-256 raw r||s, strict b64url, peer id checks, pairing fingerprint,
  pairing id and key, PA-Sig request signing, name entries, inner message
  encode / pad / parse, replay window, phone detection, the pure `pair_decide`.
- Store: one SQLite file in the App Group (WAL, BEGIN IMMEDIATE, busy timeout
  2 s), shared by the app, the NSE and the share extension.

### Tests

On macOS (Xcode 15.3 or later):

    cd client/ios/PushArmorCore && swift test

On Linux the package builds against swift-crypto, the system zlib and the
system SQLite (test only; none of these is linked into the iOS targets). The
SQLite headers are not part of the Ubuntu runtime package, so point the script
at a directory holding `include/sqlite3.h` and `lib/libsqlite3.so`:

    SWIFT_BIN=/path/to/swift/usr/bin SQLITE_DIR=/path/to/sqlite ./PushArmorCore/test-linux.sh

The tests run every section of `tests/vectors/golden-v1.json`, the RFC 9180
P-256 suite vectors, RFC 6979 and RFC 7636 known answers, and the per-platform
state-machine tests (pairing, crossing, cap, allow reconcile, approve re-send,
replay window, counter reservation across connections, clock-skew retry,
countdown formatting, persistence across restart) against an in-memory Worker.

## App targets

    brew install xcodegen
    cd client/ios && xcodegen generate
    open PushArmor.xcodeproj

Build ids come from the tracked `release/public.json`: the owner fills
`apple_team_id` and `google_ios_client_id` there in a normal commit. Run
`sh tools/public-xcconfig.sh` before `xcodegen generate`. It writes the derived,
git-ignored `Config/Public.xcconfig` (DEVELOPMENT_TEAM, GOOGLE_IOS_CLIENT_ID,
GOOGLE_CALLBACK_SCHEME), which `Config/Base.xcconfig` includes. Debug builds work
without it; a Release build fails while a value is empty, a PLACEHOLDER or a CI
dummy without `PA_CI_DUMMY=1`. `APP_BUNDLE_ID` stays in `project.yml`. The App Group is `group.$APP_BUNDLE_ID`; the Keychain access group is
`$TEAM.$APP_BUNDLE_ID.shared`.

### App tests

The PushArmor scheme's test action (Debug) runs two targets:

- `PushArmorTests`: app-hosted unit tests (`@testable import PushArmor`) of
  app-target logic such as the notification categories and banner content.
- `PushArmorUITests`: one launch smoke test. It starts the app with no launch
  arguments and no environment and expects the first screen (login, or the
  notification explainer).

    xcodebuild test -scheme PushArmor -destination 'platform=iOS Simulator,name=iPhone 15'

### No test hooks in release builds

The app has no launch arguments, environment switches, URL schemes, debug
menus or methods that exist only for tests. Tests reach app code only through
`@testable import` in Debug; Release sets `ENABLE_TESTABILITY = NO`. The
Simulator alone keeps a software-key fallback when there is no Secure Enclave
(compiled only for the Simulator). Check a release build with:

    bash tools/check-release-bundle.sh build/PushArmor.xcarchive   # or a .app or .ipa

It fails on any XCTest, XCUIAutomation or Testing framework or `.xctest` in the
app or an extension, test strings or test libraries in a main executable
(`otool -L`, `strings`), a launch-argument hook in a main executable
(`launchArguments`, a `UITEST`-style key, `CommandLine.arguments`, or
`ProcessInfo` `arguments` / `environment`), URL schemes other than the Google callback scheme
derived from `release/public.json`, or `get-task-allow` in the signature
(`codesign`; skipped where the tool is missing). Its test:
`bash tools/check-release-bundle.test.sh`.

## Notes

- Deny on an unpinned peer row sends a deny message sealed to the listed key
  with an all-zero pairing id and n = 1 (as the browser extension and Android).
  The peer cannot verify it and drops it; the Worker still records the deny.
- Pair messages: an open is accepted in state replied, or in state prompted when
  the reply was authorized but its "sent" result was not recorded yet; the c_N
  check applies either way.
