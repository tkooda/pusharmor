# Releasing

A tag builds ONE platform and uploads it to that platform's test channel and to
a GitHub release. A tag never publishes to a public channel, except `cli/vX.Y.Z`:
it publishes to PyPI at once (a PyPI version can never be uploaded again). After testing
on devices, the owner promotes the same build with the promote workflow (below)
or by hand in each store console. Nothing is rebuilt for the promotion. The
site has no tag and a push to main does NOT deploy it: deploy it by hand with
`npx wrangler deploy` in `site/` (`wrangler.jsonc` runs the build into the
gitignored `site/dist` first, so the tree stays clean; `site/README.md`).

| Tag              | CI uploads to (test channel)                          | Owner promotes (promote workflow or by hand)    |
|------------------|-------------------------------------------------------|-------------------------------------------------|
| `android/vX.Y.Z` | Play internal track, GitHub release (Obtainium)       | Play production, GitHub release, F-Droid        |
| `ios/vX.Y.Z`     | TestFlight (no review submission), GitHub release     | App Store (see NOTE), GitHub release            |
| `chrome/vX.Y.Z`  | private "PushArmor Beta" item, GitHub release         | public zip to the public item, GitHub release   |
| `firefox/vX.Y.Z` | unlisted "PushArmor Beta" add-on, GitHub release      | public zip to the listed add-on, GitHub release |
| `worker/vX.Y.Z`  | nothing (build and tests only)                        | `server/deploy/deploy.sh worker/vX.Y.Z`         |
| `cli/vX.Y.Z`     | PyPI (public at once), GitHub release                 | nothing (already public)                        |

NOTE: the App Store version is released automatically after approval
(`IOS_RELEASE_TYPE` = `AFTER_APPROVAL` in `release/promote.mjs`), like the other
three stores; it is not a manual release.

## Versions

All platforms share ONE version counter X.Y.Z. A release tags only the platforms
that changed (for example `chrome/v0.0.22` alone); the others skip that number.
Each platform of a release has its own stamp commit, so one slow platform never
holds up the others. A commit carries one version; the tags of X.Y.Z are on one
line of history and versions grow along it; a new version is greater than every
existing tag. `release/tag.mjs` stamps the version files of the named platform
(the Worker too: `server/worker/package.json` and its lockfile) and enforces the
rules (header comment and `FILES` list there; tests in `release/tag.test.mjs`);
every release workflow checks them again in its first job, including the
platform's release gate on the tag commit (it waits up to 40 minutes for a
running CI): in one push run of the ci workflow, every job of the platform and
of the shared checks (`repo`, `vectors`) ran and succeeded (`GATE` in
`release/tag.mjs`; android also needs `android-emulator` and `site`, firefox
and cli `site`). A skipped component is not a pass, and the jobs of other
platforms do not count. The release workflow then does not run those tests
again.

Build numbers: Android versionCode and the iOS build number grow with the
version (0.0.1 -> 1; `buildNumber` in `release/tag.mjs`).

## Making a tag

Order: deploy the Worker first when the clients need it. Every test channel
talks to the production Worker, and the public clients must keep working with it.

1. On an up-to-date main with a clean tree, one platform at a time, fastest
   first (worker, cli, chrome, firefox, android, ios):
   `node release/tag.mjs X.Y.Z <platform>`. It writes the version files of that
   platform and stops (nothing tagged). Commit them ("release X.Y.Z
   <platform>"), then do the next platform on top. Each stamp commit changes
   only its platform's files, so CI runs only that platform's jobs (and the
   shared checks) for it.
2. Push each stamp commit to its own `internal/<12-char sha>` branch, one push
   per branch (GitHub starts no workflow for a push of more than three refs).
3. As soon as a platform's gate passes on its stamp commit, fast-forward main
   to that commit (the stamp commits before it must have landed), check it out
   and run `node release/tag.mjs X.Y.Z <platform>` again: it fetches the tags and
   main of origin, checks the rules (the commit is on origin/main, and the
   platform's gate, with your `gh` login) and creates the annotated tag.
4. `git push origin <platform>/vX.Y.Z`, one tag per push. A platform that
   failed: fix it on top of main and stamp it again on a new commit (same
   X.Y.Z while no higher version is tagged).

`PA_MIN_CLIENT` (Worker) takes a per-platform list (`android=0.0.22,ios=0.0.20`)
because platform versions differ; set a floor only for platforms that have it.

A failed upload after the store accepted the file is fixed with a new patch
version. Each tag workflow creates the GitHub release as a draft, uploads every
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
and runs with the store's release Environment:

| Job        | What it does (`release/promote.mjs`)                                        |
|------------|-----------------------------------------------------------------------------|
| `play`     | Play versionCode of X.Y.Z (already on the internal track) to production, status completed; listing text and phone screenshots |
| `appstore` | TestFlight build of X.Y.Z on the version page X.Y.Z (an unsubmitted version page of an older version is renamed to X.Y.Z, not duplicated), version page text, app name, subtitle, privacy URL, review notes, 6.9-inch screenshots; submits for App Review, release after approval |
| `chrome`   | `pusharmor-chrome-X.Y.Z.zip` of the release (hash and build attestation checked) to the public item, then publish (live after review) |
| `firefox`  | `pusharmor-firefox-X.Y.Z.zip` and the source archive of the release (hash and build attestation checked) to the listed add-on as a new listed version, with the reviewer notes of `store/listing/amo/review_notes.txt`; then replaces the listing previews with `store/screenshots/amo/en-US/` (uploads them, then deletes the old ones) |

Hard gate: Play stays on internal testing until BOTH repository variables
`PLAY_CONTACT_OK` and `PLAY_PUBLIC_OK` are `yes` (Settings > Secrets and
variables > Actions > Variables). The owner sets `PLAY_CONTACT_OK` only after
the public developer contact details in Play Console are fixed, and
`PLAY_PUBLIC_OK` only when Play may leave internal testing (no production, closed or open track before that). The first job tests both
before the approval: Play shows BLOCKED and its job is skipped; the other
stores still go. The `play` job tests them again.

Every job skips a version that is already live or in review, and a version
older than the one the store has, so a rerun is safe. When one store fails,
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
   previous Worker tag passed in ci on the stamp commit).
2. From a clean checkout of the tag on main:
   `CLOUDFLARE_ACCOUNT_ID=... server/deploy/deploy.sh worker/vX.Y.Z`
   (`server/deploy/README.md`: preflight, restore bookmark, migrations, deploy, smoke test).

Rollback: `server/deploy/README.md`, step 7.

Log volume: `PA_LOG_SAMPLE` is a Cloudflare dashboard variable (`1` logs every request). When
log volume grows, set it in the Cloudflare dashboard (for example `0.1`); no release is needed.
Errors are always logged (`server/worker/README.md`, Logs).

## Android (`android/vX.Y.Z`)

CI: signed play and foss APKs, mapping files and hashes in the GitHub
release. The AAB is not attached there: it goes to the Play internal track
and stays in the `android-signed` run artifact.

CI also updates the F-Droid repo https://fdroid.pusharmor.com/repo (job
`android-rel-fdroid`, `release/fdroid/publish.sh`, fdroidserver 2.4.5): the
foss APKs of the newest three Android releases and an index signed with the
repo key, uploaded to the R2 bucket `pusharmor-fdroid` (never `repo/status/`);
older APKs are deleted from the bucket. It reads the secrets
`FDROID_REPO_KEYSTORE_B64`, `FDROID_REPO_STORE_PASSWORD`,
`FDROID_REPO_KEY_PASSWORD`, `CLOUDFLARE_R2_API_TOKEN` (R2 edit) and
`CLOUDFLARE_ACCOUNT_ID` of the Environment `fdroid-release`; while one is
missing the job skips with a notice. Rerun only that job after a failure.

Test: internal testers install from Play; Obtainium testers install from the
GitHub release. `PLAY_INTERNAL_STATUS` in
`.github/workflows/android-release.yml` is `completed`: each tag rolls out to
internal testers on its own. (Play accepts only `draft` until an app's first
release is published by hand in Play Console; that step is done.)

Promote:

1. The promote workflow (job `play`), or by hand: Play Console > Test and
   release > Internal testing > Promote release > Production (a personal developer account created after 2023-11-13 must run
   a closed test with 12 testers for 14 days first: promote to a closed track).
2. Optional: run the rebuild workflow (Actions > rebuild, "Use workflow
   from" and the tag input both `android/vX.Y.Z`, so the toolchain pins are
   those of the release) to prove the APKs are reproducible.
3. F-Droid: `release/tag.mjs` stamps `site/public/fdroid/android.txt`
   (versionName, then versionCode) with the other Android version files. The
   first time, add the app metadata to fdroiddata by hand (UpdateCheckMode HTTP on that file,
   tag pattern `android/v%v`, Binaries
   `https://github.com/tkooda/pusharmor/releases/download/android/v%v/pusharmor-%v-foss.apk`,
   AllowedAPKSigningKeys the release certificate). F-Droid builds only after
   the GitHub release resolves.

## iOS (`ios/vX.Y.Z`)

CI: the IPA (cloud-managed signing) in the GitHub release; the build uploaded
to App Store Connect. No review submission. Before the archive, ios-release
runs the iOS UI tests and the iOS 17 job: they are not in the per-change gate
(the nightly workflow runs them on main when main changed).

Test: internal TestFlight testers (no Beta App Review).

The app is iPhone only (`TARGETED_DEVICE_FAMILY: "1"` in
`client/ios/project.yml`), so promote sends only the 6.9-inch iPhone
screenshots. App Store Connect can list the 13-inch iPad screenshot slot as
required while no build is attached to the version; the slot clears once the
iPhone-only build is attached (promote attaches it before it submits).

The app declares ITSAppUsesNonExemptEncryption = false: it uses only Apple OS
encryption (CryptoKit), so no export compliance answer is needed.

Promote:

1. The promote workflow (job `appstore`, release after approval), or by
   hand: App Store Connect: create the version X.Y.Z, choose the uploaded
   build, select the release option, submit for review.
2. By hand with "Manually release this version" only: after approval,
   Release this version.

## Chrome (`chrome/vX.Y.Z`)

CI: the public zip `pusharmor-chrome-X.Y.Z.zip` (no "key": the store zip), the
same zip with the public item's "key" `pusharmor-chrome-X.Y.Z-unpacked.zip` (for
"Load unpacked": it gets the store id, so Google login works; never uploaded to
the store) and the Beta zip in the GitHub release; the Beta zip ("PushArmor Beta") uploaded to the PRIVATE
Beta item and published there to trusted testers after store review.

Test: testers install "PushArmor Beta" from the store; it auto-updates.

Promote:

1. The promote workflow (job `chrome`), or by hand: Chrome Web Store
   dashboard, the public item: upload `pusharmor-chrome-X.Y.Z.zip` from the
   release, submit for review, publish.
2. The collect workflow (on each chrome/v or firefox/v tag push, or run by hand
   once the store serves the new version) publishes the store CRX as the release
   `store/chrome/vX.Y.Z` after it checks it against the release file hashes. It
   takes the tag of the version the public item serves, so promoting an older
   test tag works.

## Firefox (`firefox/vX.Y.Z`)

CI: the public zip `pusharmor-firefox-X.Y.Z.zip`, the source archive, the
signed Beta XPI `pusharmor-firefox-beta-X.Y.Z.xpi` and its update manifest
`pusharmor-firefox-beta-X.Y.Z-updates.json` in the GitHub release. The Beta
add-on ("PushArmor Beta", own gecko id) is signed UNLISTED on AMO; AMO never
lists it.

Rerun: AMO accepts each version once. When `submit-firefox` passed and
`publish-firefox` failed, rerun only the failed `publish-firefox` job. A full
rerun signs the same version again and fails; fix a failure in
`submit-firefox` or before it with a new patch version.

Test: install the Beta XPI from the release link once. Auto-update:
`release/tag.mjs` stamps `site/public/fx/beta/updates.json` (version and XPI
URL) with the other Firefox version files; deploy the site after the
release is published (the Beta manifest's update_url is
`https://pusharmor.com/fx/beta/updates.json`, `release/constants.json`). Do not install the public add-on and the Beta add-on
in the same Firefox profile: both handle the login page.

Promote:

1. The promote workflow (job `firefox`), or by hand: AMO Developer Hub, the
   listed add-on: upload `pusharmor-firefox-X.Y.Z.zip` as a new version with
   the source archive; it goes public after review. The listed add-on is
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
  `google_chrome_beta_extension_id`. The CWS service account must have access
  to that item. The release build and the `chrome/v` job fail when this id
  equals the public id or is not 32 letters a-p.
- Firefox: both gecko ids are random lowercase GUIDs in braces
  (`{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}`, from `uuidgen`); the release build
  refuses any other form. Pick the Beta gecko id (not the public id) for
  `mozilla_firefox_beta_addon_id`. The first `firefox/v` tag creates the
  unlisted add-on on AMO.
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
   by a fast-forward push once `ci-ok` passed on it (CONTRIBUTING.md). A stamp
   commit changes only its platform's files, so its ci-ok covers that platform
   and the shared checks. `release/tag.mjs` and the first job of every release
   workflow refuse a commit whose platform gate did not pass (Versions).
2. Tag ruleset, target pattern `*/v*` (all release tags): restrict creation,
   update and deletion to the owner (bypass list: repository admin and the
   push deploy key); block force pushes. A release tag can then not be
   created by anyone else, moved or deleted.
3. Environments `android-sign`, `android-release`, `ios-release`,
   `chrome-release`, `firefox-release`, `pypi`: "Deployment branches and tags"
   = selected tags only, `android/v*` for both Android environments, `ios/v*`,
   `chrome/v*`, `firefox/v*`, `cli/v*`. Required reviewers are optional
   because the store promotion is the human gate.
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
   3); only store.yml and the tag-triggered release workflows name them. No
   secret is copied.