# Releasing

A tag builds ONE platform and publishes it to a GitHub release only. A tag
uploads nothing to any store (no TestFlight, no Play internal track, no Chrome
Web Store or AMO upload), except `cli/vX.Y.Z`: it publishes to PyPI at once (a
PyPI version can never be uploaded again). The owner later sends the build of
the GitHub release to the stores with the promote workflow (below). Nothing is
rebuilt for the promotion. The
site has no tag and a push to main does NOT deploy it: deploy it by hand with
`npx wrangler deploy` in `site/` (`wrangler.jsonc` runs the build into the
gitignored `site/dist` first, so the tree stays clean; `site/README.md`).

Cadence (owner policy, no schedule in CI): release to GitHub at any time.
Promote to the stores in a batch at most once a week, and never while that
store has a version in review, unless the owner says otherwise. The store
jobs refuse a store that has an earlier version in review.

| Tag              | CI publishes to                                       | Owner promotes (promote workflow)                |
|------------------|-------------------------------------------------------|--------------------------------------------------|
| `android/vX.Y.Z` | GitHub release (Obtainium), F-Droid repo              | AAB of the release to Play production            |
| `ios/vX.Y.Z`     | GitHub release                                        | IPA of the release to App Store (see NOTE)       |
| `chrome/vX.Y.Z`  | GitHub release                                        | public zip of the release to the public item     |
| `firefox/vX.Y.Z` | GitHub release                                        | public zip of the release to the listed add-on   |
| `worker/vX.Y.Z`  | nothing (build and tests only)                        | `server/deploy/deploy.sh worker/vX.Y.Z`          |
| `cli/vX.Y.Z`     | PyPI (public at once), GitHub release                 | nothing (already public)                         |

NOTE: the App Store version is released automatically after approval
(`IOS_RELEASE_TYPE` = `AFTER_APPROVAL` in `release/promote.mjs`), like the other
three stores; it is not a manual release.

## Versions

All platforms share ONE version counter X.Y.Z. A release tags only the platforms
that changed (for example `chrome/v0.0.22` alone); the others skip that number.
Versions are tags only: nothing is committed for a release. A release tags one
commit of main, and all the tags of X.Y.Z are on that commit. A commit carries
one version; the tags of X.Y.Z are on one line of history and versions grow
along it; a new version is greater than every existing tag. `release/tag.mjs`
creates the tags and enforces the rules (header comment there; tests in
`release/tag.test.mjs`); every release workflow checks them again in its first job, including the
platform's release gate on the tag commit (it waits up to 40 minutes for a
running CI): in one push run of the ci workflow, every job of the platform and
of the shared checks (`repo`, `vectors`) ran and succeeded (`GATE` in
`release/tag.mjs`; android also needs `android-emulator` and `site`, firefox
and cli `site`). A skipped component is not a pass, and the jobs of other
platforms do not count. The release workflow then does not run those tests
again.

Build numbers: Android versionCode and the iOS build number grow with the
version (0.0.1 -> 1; `buildNumber` in `release/tag.mjs`).

Each build reads X.Y.Z from its tag; the repo holds only the dev version 0.0.0
(build number 1), which every build without a tag gets:

- Android: Gradle (`client/android/app/build.gradle.kts`) takes env `PA_VERSION`
  (android-release and rebuild set it from the tag), else the tag `android/vX.Y.Z`
  at HEAD (F-Droid builds a checkout of the tag), else 0.0.0. Both flavors.
- iOS: ios-release passes the version and build number of the tag to
  `client/ios/tools/release-archive.sh` (`MARKETING_VERSION`,
  `CURRENT_PROJECT_VERSION`).
- Chrome and Firefox: `client/webext-common/build.mjs` writes the manifest
  version from env `PA_VERSION` (webext-release sets it), else
  `release/source-tag.txt` (only in the Firefox source archive), else the tag
  `chrome/vX.Y.Z` or `firefox/vX.Y.Z` at HEAD (`buildVersion` in `release/tag.mjs`).
- CLI: cli-release writes X.Y.Z into `pusharmor.py` (`VERSION` and the line-2
  comment) before it builds; PyPI and the GitHub release get that file.
- Site: the site build reads the newest tags at deploy time (`site/README.md`).

## Making a tag

Order: deploy the Worker first when the clients need it. Every release build
talks to the production Worker, and the public clients must keep working with it.

1. Pick a commit of main whose CI passed, check it out with a clean tree and run
   `node release/tag.mjs X.Y.Z <platform>...` (`all` = android ios chrome
   firefox; list `cli` or `worker` too when they ship). It fetches the tags and
   main of origin, checks the rules (the commit is on origin/main, and each
   platform's gate, with your `gh` login) and creates the annotated tags
   `<platform>/vX.Y.Z`, all on that commit. Nothing is committed.
2. `git push origin <platform>/vX.Y.Z`, one tag per push (it prints the
   commands). A platform that failed: fix it on main and tag the new commit
   (same X.Y.Z while no higher version is tagged; its tag may join later).
3. After the releases are published, deploy the site (`site/README.md`): it
   picks up the new versions at build time.

`PA_MIN_CLIENT` (Worker) takes a per-platform list (`android=0.0.22,ios=0.0.20`)
because platform versions differ; set a floor only for platforms that have it.

Each tag workflow creates the GitHub release as a draft, uploads every
asset, then publishes it as a release. A rerun replaces the assets of a
draft; it never changes a published release.

## Promote workflow (all stores)

Actions > promote > Run workflow (also in the GitHub phone app), on `main`,
with the version X.Y.Z and `platforms`, a comma list of `android`, `ios`,
`chrome` and `firefox` (required, no default; for example `firefox` sends
only the Firefox add-on). A platform not in the list is skipped (a SKIP line)
and its job does not run. The first job checks, per platform, the tag
`<platform>/vX.Y.Z` and its published GitHub release with the needed assets; a
platform without them is skipped (a SKIP line in the summary). It lists the
client platforms that have no tag of X.Y.Z as a NOTE line. A selected platform
whose tag commit has no `.github/workflows/store.yml` is skipped too (tags
made before store.yml existed cannot be promoted by the workflow). It also checks the
listing files. Then the run waits for the owner's approval (Environment
`promote`, the owner is the required reviewer): one tap on "Review
deployments" > Approve. The `dispatch` job (only `actions: write`, no
Environment, no secret) then starts the `store` workflow
(`.github/workflows/store.yml`) once per ready platform, by workflow_dispatch
on the tag `<platform>/vX.Y.Z`, so each store job runs on a tag ref that the
tag-only release Environment allows. In each store run, the `gate` job checks
the tag and that an approved promote run on `main` for this version and
platform started it, then the store job checks out that promote run's commit
and runs with the store's release Environment. Each job takes its file from
the GitHub release X.Y.Z (hash in the release hashes file and the build
attestation of the tag workflow checked) and uploads it to the store as the
step right before the review submission:

| Job        | What it does (`release/promote.mjs`)                                        |
|------------|-----------------------------------------------------------------------------|
| `play`     | `pusharmor-X.Y.Z-play.aab` of the release uploaded (skipped when Play has the versionCode) and sent to production, status completed, in one edit; listing text and phone screenshots |
| `appstore` | (macOS) `pusharmor-X.Y.Z.ipa` of the release uploaded with `xcrun altool` (skipped when App Store Connect has the build), waits up to 40 minutes for processing; the build on the version page X.Y.Z (an unsubmitted version page of an older version is renamed to X.Y.Z, not duplicated), version page text, app name, subtitle, privacy URL, 6.9-inch screenshots; submits for App Review, release after approval |
| `chrome`   | `pusharmor-chrome-X.Y.Z-store.zip` of the release (hash and build attestation checked) to the public item, then publish (live after review) |
| `firefox`  | `pusharmor-firefox-X.Y.Z.zip` and the source archive of the release (hash and build attestation checked) to the listed add-on as a new listed version, with the reviewer notes of `store/listing/amo/review_notes.txt`; then replaces the listing previews with `store/screenshots/amo/en-US/` (uploads them, then deletes the old ones) |

Hard gate: nothing goes to Play until BOTH repository variables
`PLAY_CONTACT_OK` and `PLAY_PUBLIC_OK` are `yes` (Settings > Secrets and
variables > Actions > Variables). The owner sets `PLAY_CONTACT_OK` only after
the public developer contact details in Play Console are fixed, and
`PLAY_PUBLIC_OK` only when Play may leave internal testing (no production, closed or open track before that). The first job tests both
before the approval: Play shows BLOCKED and its job is skipped; the other
stores still go. The `play` job tests them again.

Every job skips a version that is already live or in review, and a version
older than the one the store has, so a rerun is safe. Before it uploads or
submits, each job checks that the store has no other version in review and
fails with the store and that version when it has one (App Store: a version in
WAITING_FOR_REVIEW or IN_REVIEW; Chrome Web Store: a submitted revision in
PENDING_REVIEW; AMO: a listed version whose file is `unreviewed` or
`nominated`). Play shows no review state through its API: the Play job commits
its edit with ERROR_IF_IN_REVIEW and reports a refused commit as changes
already in review, naming the newest production release; a refused commit
changes nothing on Play. When one store fails,
rerun only its `store` run ("Re-run failed jobs"); the others are not redone.
Each job ends with one summary line per store.

Listings: `store/listing/play/en-US/*.txt`,
`store/listing/appstore/en-US/*.txt` and the screenshots in
`store/screenshots/{play,appstore}/en-US/` are the source for those stores;
promote sends them (Play: only when they differ). The AMO screenshots in
`store/screenshots/amo/en-US/` (800x1120, the popup at 2x) are sent by the `firefox` job on each
run. The Chrome Web Store screenshots in `store/screenshots/cws/en-US/`
(1280x800, the full tab view at 2x, at most 5) are uploaded by hand. Change them in a normal commit. `release/promote.test.mjs` checks the store limits, plain ASCII, and
that no listing or release file holds a phone number or an address at the
project or company domains. Promote never sets or overwrites a contact field
(email, phone, website, support or marketing URL, address) through any store
API (the test checks the payloads). Contact details, the App Review contact
and demo account, tester lists, the age rating, App Privacy and Data safety stay in the
store consoles. Chrome Web Store and AMO listing text stays in their
dashboards. The AMO reviewer notes (`store/listing/amo/review_notes.txt`)
name no credentials; enter the demo account for the AMO reviewers in the
Developer Hub.

Tag workflows publish full GitHub releases (not pre-releases); only Android
takes the Latest badge. Older releases were made as pre-releases: each store
job clears "Set as a pre-release" on its own GitHub release once its store
accepts the build, or when X.Y.Z is already live or in review there.

## Worker (`worker/vX.Y.Z`)

1. Tag and push; wait for the green worker-release run (tag rule and the
   worker gate: the Worker tests, bundle check and migrations with the
   previous Worker tag passed in ci on the tagged commit).
2. From a clean checkout of the tag on main:
   `CLOUDFLARE_ACCOUNT_ID=... server/deploy/deploy.sh worker/vX.Y.Z`
   (`server/deploy/README.md`: preflight, restore bookmark, migrations, deploy, smoke test).

Rollback: `server/deploy/README.md`, step 7.

Log volume: `PA_LOG_SAMPLE` is a Cloudflare dashboard variable (`1` logs every request). When
log volume grows, set it in the Cloudflare dashboard (for example `0.1`); no release is needed.
Errors are always logged (`server/worker/README.md`, Logs).

## Android (`android/vX.Y.Z`)

CI: signed play and foss APKs, mapping files, the play AAB (upload key
signature, for Play) and hashes in the GitHub release. Nothing goes to Play.

CI also updates the F-Droid repo https://fdroid.pusharmor.com/repo (job
`android-rel-fdroid`, `release/fdroid/publish.sh`, fdroidserver 2.4.5): the
foss APKs of the newest three Android releases and an index signed with the
repo key, uploaded to the R2 bucket `pusharmor-fdroid` (never `repo/status/`);
older APKs are deleted from the bucket. It reads the secrets
`FDROID_REPO_KEYSTORE_B64`, `FDROID_REPO_STORE_PASSWORD`,
`FDROID_REPO_KEY_PASSWORD`, `CLOUDFLARE_R2_API_TOKEN` (R2 edit) and
`CLOUDFLARE_ACCOUNT_ID` of the Environment `fdroid-release`; while one is
missing the job skips with a notice. Rerun only that job after a failure.

Test: Obtainium installs from the GitHub release.

Promote:

1. The promote workflow (job `play`): uploads the AAB of the release and sends
   it to production (a personal developer account created after 2023-11-13 must run
   a closed test with 12 testers for 14 days first).
2. Optional: run the rebuild workflow (Actions > rebuild, "Use workflow
   from" and the tag input both `android/vX.Y.Z`, so the toolchain pins are
   those of the release) to prove the APKs are reproducible.
3. F-Droid: the site build writes `/fdroid/android.txt` (versionName, then
   versionCode) from the newest `android/vX.Y.Z` tag; deploy the site after the
   release. F-Droid builds a checkout of the tag, and Gradle takes the version
   from the tag at HEAD. The
   first time, add the app metadata to fdroiddata by hand (UpdateCheckMode HTTP on that file,
   tag pattern `android/v%v`, Binaries
   `https://github.com/tkooda/pusharmor/releases/download/android/v%v/pusharmor-%v-foss.apk`,
   AllowedAPKSigningKeys the release certificate). F-Droid builds only after
   the GitHub release resolves.

## iOS (`ios/vX.Y.Z`)

CI: the IPA (cloud-managed signing) in the GitHub release. Nothing is
uploaded to App Store Connect (no TestFlight build). Before the archive, ios-release
runs the iOS UI tests and the iOS 17 job: they are not in the per-change gate
(the nightly workflow runs them on main when main changed).

The app is iPhone only (`TARGETED_DEVICE_FAMILY: "1"` in
`client/ios/project.yml`), so promote sends only the 6.9-inch iPhone
screenshots. App Store Connect can list the 13-inch iPad screenshot slot as
required while no build is attached to the version; the slot clears once the
iPhone-only build is attached (promote attaches it before it submits).

The app declares ITSAppUsesNonExemptEncryption = false: it uses only Apple OS
encryption (CryptoKit), so no export compliance answer is needed.

Promote:

1. The promote workflow (job `appstore`, release after approval): uploads the
   IPA of the release, waits for processing, submits for review.
2. By hand with "Manually release this version" only: after approval,
   Release this version.

## Chrome (`chrome/vX.Y.Z`)

CI: the store zip `pusharmor-chrome-X.Y.Z-store.zip` (no "key"), the
same zip with the public item's "key" `pusharmor-chrome-X.Y.Z.zip` (for
"Load unpacked": it gets the store id, so Google login works; never uploaded to
the store) and the Beta zip ("PushArmor Beta") in the GitHub release. Nothing
goes to the Chrome Web Store.

Test: "Load unpacked" from `pusharmor-chrome-X.Y.Z.zip` of the release.

Promote:

1. The promote workflow (job `chrome`): uploads
   `pusharmor-chrome-X.Y.Z-store.zip` of the release to the public item and
   publishes it (live after review).
2. The collect workflow (on each chrome/v or firefox/v tag push, or run by hand
   once the store serves the new version) publishes the store CRX as the release
   `store/chrome/vX.Y.Z` after it checks it against the release file hashes. It
   takes the tag of the version the public item serves, so promoting an older
   test tag works.

## Firefox (`firefox/vX.Y.Z`)

CI: the public zip `pusharmor-firefox-X.Y.Z.zip` and the source archive in
the GitHub release. Nothing goes to AMO (no signed Beta XPI).

Test: load `pusharmor-firefox-X.Y.Z.zip` of the release as a temporary add-on
(about:debugging).

Promote:

1. The promote workflow (job `firefox`): uploads `pusharmor-firefox-X.Y.Z.zip`
   of the release as a new listed version with the source archive; it goes
   public after review. The listed add-on is
   created by hand once (the first listed version, with the public gecko id
   of `release/public.json`); the workflow fails until it exists.
2. The collect workflow publishes the AMO XPI of the current public version
   as the release `store/firefox/vX.Y.Z` after it checks it.

## One-time owner setup

Store items and ids:

- Chrome: create a second item in the Chrome Web Store dashboard named
  "PushArmor Beta" (the first upload by hand, e.g. the Beta zip of a local
  release build or a dev zip), description stating it is a test build,
  visibility Private (trusted testers). Put its id in `release/public.json`
  `google_chrome_beta_extension_id`. The release build fails when this id
  equals the public id or is not 32 letters a-p. No workflow uploads to it.
- Firefox: both gecko ids are random lowercase GUIDs in braces
  (`{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}`, from `uuidgen`); the release build
  refuses any other form. Pick the Beta gecko id (not the public id) for
  `mozilla_firefox_beta_addon_id`. No workflow signs or uploads the Beta
  add-on.
- Worker variable `PA_OAUTH_REDIRECT_CHROME` (Cloudflare dashboard): a JSON
  list of both redirects,
  `["https://<public id>.chromiumapp.org/","https://<Beta id>.chromiumapp.org/"]`.
  The Chrome extension names its own redirect; the Worker accepts only an exact
  entry of this list.
- The site CSP allows both Chrome ids (the site build fills them from
  `release/public.json`); a change deploys with the next site build.

## Release protection (owner setup in GitHub and Google Cloud)

The release workflows trust the workflow file and `release/public.json` of the
tag commit, so only reviewed commits may be tagged:

1. Branch ruleset on `main`: block force pushes, restrict deletions, and
   require the status check `ci-ok`. No pull request: a commit reaches `main`
   by a fast-forward push once `ci-ok` passed on it (CONTRIBUTING.md).
   `release/tag.mjs` and the first job of every release
   workflow refuse a commit whose platform gate did not pass (Versions).
2. Tag ruleset, target pattern `*/v*` (all release tags): restrict creation,
   update and deletion to the owner (bypass list: repository admin and the
   push deploy key); block force pushes. A release tag can then not be
   created by anyone else, moved or deleted.
3. Environments `android-sign`, `android-release`, `ios-release`,
   `chrome-release`, `firefox-release`, `pypi`: "Deployment branches and tags"
   = selected tags only, `android/v*` for both Android environments, `ios/v*`,
   `chrome/v*`, `firefox/v*`, `cli/v*`. Required reviewers are optional
   because the store promotion is the human gate. In the tag workflows only
   the jobs that need a secret name an Environment (`android-sign`,
   `fdroid-release`, `ios-release` for the export signing, `pypi`); the
   publish jobs name none, so a tag run can get no store credential.
   `android-release`, `chrome-release` and `firefox-release` are named only
   by store.yml.
4. Secrets only as environment secrets, never repository or organization
   secrets (names and environments: `release/names.json` "github_secrets"):
   `ANDROID_*` in `android-sign`, `ASC_*` in `ios-release`, `MOZILLA_AMO_*` in
   `firefox-release`. `android-release` and `chrome-release` hold none (WIF).
5. Workload Identity Federation: one pool per store (Play, CWS), each with a
   provider (`google_play_wif_provider`, `google_cws_wif_provider`) with an
   attribute condition scoped to this repository, its tags and its environment:
   Play: `assertion.repository == 'tkooda/pusharmor' &&
   assertion.ref.startsWith('refs/tags/android/v') &&
   assertion.environment == 'android-release'`;
   Chrome Web Store: the same with `refs/tags/chrome/v` and `chrome-release`.
   Promote needs no extra clause: its store jobs (store.yml) run on the
   platform tag in the same Environment (item 7).
   Grant each service account to the principalSet of its own store's pool only.
6. GitHub immutable releases are on and supported: the release workflows add
   every asset to a draft and publish it last. A published release cannot get
   new assets, so a failed publish after that point is fixed with a new patch
   version.
7. Promote (`.github/workflows/promote.yml`, dispatched on `main`):
   Environment `promote`, required reviewer the owner, "Prevent self-review"
   off, deployment branch `main` only. promote.yml names no store
   Environment and gets no store secret; its `dispatch` job has only
   `actions: write`. The store jobs are in `.github/workflows/store.yml`,
   started by promote on each platform tag, so `android-release`,
   `ios-release`, `chrome-release` and `firefox-release` stay tags only (item
   3). No secret is copied.