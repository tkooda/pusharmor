# PushArmor

PushArmor sends links and short notes between your own devices. All of your
data is always end-to-end encrypted, and can never be read by the server or
anyone else.

Platforms: Android, iPhone, Chrome, and Firefox.

- Website: https://pusharmor.com
- Security model: https://pusharmor.com/security
- Privacy policy: https://pusharmor.com/privacy

## Build from source

Each part builds on its own. The CI workflows in `.github/workflows/` run the
exact commands.

- Chrome and Firefox extensions (`client/webext-common`, shared by
  `client/chrome` and `client/firefox`):
  `npm ci --ignore-scripts && npm run typecheck && npm test && npm run build -- --dev`
- Android (`client/android`):
  `./gradlew :app:assemblePlayDebug :app:assembleFossDebug`
- iPhone (`client/ios`, needs Xcode on macOS):
  `swift test --package-path client/ios/PushArmorCore`, then
  `xcodebuild build -project PushArmor.xcodeproj -scheme PushArmor -configuration Debug -destination "generic/platform=iOS Simulator" CODE_SIGNING_ALLOWED=NO`
- Worker (`server/worker`): `npm ci --ignore-scripts && npm run typecheck && npm test`
- Site (`site`): `npm ci --ignore-scripts && node --test 'site/tools/test/*.test.mjs'`

See the README in each directory for details.

## Support and security

- Questions, bugs, and ideas: open a GitHub issue. There is no email support.
- Security reports: open a public GitHub issue or use GitHub private
  vulnerability reporting, see [SECURITY.md](SECURITY.md).
- Contributing: see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, see [LICENSE](LICENSE).

## Releasing

Per-platform tags `<platform>/vX.Y.Z` on one version line, test channels,
manual promotion and the release protection setup: `RELEASING.md`.

## Deployment ids

Every name is listed once, with its meaning, in `release/names.json`.

- Worker: Cloudflare dashboard variables and secrets; see
  `server/deploy/README.md`.
- Site, extensions, Android, iOS: the public build ids live in the tracked
  `release/public.json`; edit it in a normal commit. Builds read it directly;
  see each part's README. Release builds fail while a needed value is empty or
  a PLACEHOLDER (a CI dummy from `release/ci-dummy.mjs` passes only with
  `PA_CI_DUMMY=1`).

## No test hooks in release builds

No release build holds a test-only endpoint, launch argument, environment
switch, URL scheme, debug menu or method. Tests reach the code only from test
sources. Each part has a release check:

- iOS: `client/ios/tools/check-release-bundle.sh` (app, archive or ipa).
- Android: `client/android/tools/check-release-apk.sh` (release APK).
- Worker: `server/deploy/check-bundle.mjs` (run by `deploy.sh` step 0).
- Extensions: `client/webext-common/check-release.mjs` (run by a release build).
