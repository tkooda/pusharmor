# Releasing

A tag builds ONE platform and uploads it to that platform's test channel and to
a GitHub prerelease. A tag never publishes to a public channel. After testing
on devices, the owner promotes the same build with the promote workflow (below)
or by hand in each store console. Nothing is rebuilt for the promotion. The site deploys from main on its own
(Cloudflare Workers Builds, build command EMPTY: `wrangler deploy` runs the
build from `wrangler.jsonc`, and a second run fails); it has no tag.

| Tag              | CI uploads to (test channel)                          | Owner promotes (promote workflow or by hand)    |
|------------------|-------------------------------------------------------|-------------------------------------------------|
| `android/vX.Y.Z` | Play internal track, GitHub prerelease (Obtainium)    | Play production, GitHub release, F-Droid        |
| `ios/vX.Y.Z`     | TestFlight (no review submission), GitHub prerelease  | App Store (manual release), GitHub release      |
| `chrome/vX.Y.Z`  | private "PushArmor Beta" item, GitHub prerelease      | public zip to the public item, GitHub release   |
| `firefox/vX.Y.Z` | unlisted "PushArmor Beta" add-on, GitHub prerelease   | public zip to the listed add-on, GitHub release |
| `worker/vX.Y.Z`  | nothing (build and tests only)                        | `server/deploy/deploy.sh worker/vX.Y.Z`         |

## Versions

All platforms share ONE version line X.Y.Z, so the clients of one release show
the same number. Rules (`release/tag.mjs`, checked again by every release
workflow in its first job):

- A version is bound to one commit: every `<platform>/vX.Y.Z` tag of X.Y.Z points
  at the same commit, and a commit carries one version.
- A new version (no tag of it yet) is greater than every existing tag of any
  platform. A version that already has a tag stays open to other platforms at
  its commit, also after newer versions are tagged.
- Platforms may skip numbers (a Worker-only fix needs no Android tag).
- X.Y.Z has no leading zeros; Y and Z are at most 999; X is at most 2099.
- The version files at the tag commit hold X.Y.Z: `release/version.properties`
  (Android), `client/chrome/manifest.json`, `client/firefox/manifest.json`,
  `client/ios/project.yml`.
- `ci-ok` of the ci workflow succeeded on the tag commit (a push run; `gh api`
  with actions: read). The release workflow waits up to 40 minutes for it.

Build numbers: Android versionCode and the iOS build number
(CURRENT_PROJECT_VERSION, CFBundleVersion) are both
`X * 1000000 + Y * 1000 + Z` (0.0.1 -> 1, 1.2.3 -> 1002003, at most
2099999999 under Play's 2100000000 cap). They grow with the version, so
they always increase.

## Making a tag

Order: deploy the Worker first when the clients need it. Every test channel
talks to the production Worker, and the public clients must keep working with it.

1. On an up-to-date main with a clean tree:
   `node release/tag.mjs <platform> X.Y.Z`. When the version files do not hold
   X.Y.Z yet, it writes them and stops (nothing tagged).
2. Commit the version files ("release X.Y.Z") and push to main; wait for ci-ok.
3. Check out that commit and run `node release/tag.mjs <platform> X.Y.Z` again:
   it fetches the tags of origin, checks the rules (ci-ok too, with your `gh`
   login) and creates the annotated tag.
4. `git push origin <platform>/vX.Y.Z`. More platforms at the same version: run
   step 3 for each one at the SAME commit.

A failed upload after the store accepted the file is fixed with a new patch
version. Each tag workflow creates the GitHub release as a draft, uploads every
asset, then publishes it as a prerelease. A rerun replaces the assets of a
draft; it never changes a published release.

## Promote workflow (all stores)

Actions > promote > Run workflow (also in the GitHub phone app), on `main`,
with the version X.Y.Z. The first job checks, per platform, the tag
`<platform>/vX.Y.Z` and its published GitHub release with the needed assets; a
platform without them is skipped (a SKIP line in the summary). It also checks
the listing files. Then the run waits for the owner's approval (Environment
`promote`, the owner is the required reviewer): one tap on "Review
deployments" > Approve. The store jobs then run in parallel, each with the
store's release Environment:

| Job        | What it does (`release/promote.mjs`)                                        |
|------------|-----------------------------------------------------------------------------|
| `play`     | Play versionCode of X.Y.Z (already on the internal track) to production, status completed; listing text and phone screenshots |
| `appstore` | TestFlight build of X.Y.Z on the version page X.Y.Z, version page text, app name, subtitle, privacy URL, review notes, 6.9-inch screenshots; submits for App Review, release after approval |
| `chrome`   | `pusharmor-chrome-X.Y.Z.zip` of the prerelease (hash checked) to the public item, then publish (live after review) |
| `firefox`  | `pusharmor-firefox-X.Y.Z.zip` and the source archive of the prerelease to the listed add-on as a new listed version |

Hard gate (I414): the `play` job fails until the repository variable
`PLAY_CONTACT_OK` is `yes` (Settings > Secrets and variables > Actions >
Variables). The owner sets it only after the public developer contact details
in Play Console are fixed.

Every job skips a version that is already live or in review, and a version
older than the one the store has, so a rerun is safe. When one store fails,
rerun only that job ("Re-run failed jobs"); the others are not redone. Each
job ends with one summary line per store.

Listings (owner ruling Q242 A): `store/listing/play/en-US/*.txt`,
`store/listing/appstore/en-US/*.txt` and the screenshots in
`store/screenshots/{play,appstore}/en-US/` are the source for those stores;
promote sends them (Play: only when they differ). Change them in a normal
commit. `release/promote.test.mjs` checks the store limits, plain ASCII, and
that no listing or release file holds a phone number or an address at the
project or company domains. Promote never sets or overwrites a contact field
(email, phone, website, support or marketing URL, address) through any store
API (the test checks the payloads). Contact details, the App Review contact
and demo account, tester lists, the age rating, App Privacy and Data safety stay in the
store consoles. Chrome Web Store and AMO listing text stays in their
dashboards.

Each store job clears "Set as a pre-release" on its own GitHub release once
its store accepts the build. Do the F-Droid step for Android by hand, as below.

## Worker (`worker/vX.Y.Z`)

1. Tag and push; wait for the green worker-release run (tag rule, vectors,
   Worker tests, bundle check, migrations with the previous Worker tag).
2. From a clean checkout of the tag on main:
   `CLOUDFLARE_ACCOUNT_ID=... server/deploy/deploy.sh worker/vX.Y.Z`
   (`server/deploy/README.md`: preflight, backup, migrations, deploy, smoke test).

## Android (`android/vX.Y.Z`)

CI: signed play and foss APKs, mapping files and hashes in the GitHub
prerelease. The AAB is not attached there: it goes to the Play internal track
and stays in the `android-signed` run artifact.

Test: internal testers install from Play; Obtainium testers turn on "Include
prereleases" for the app. `PLAY_INTERNAL_STATUS` in
`.github/workflows/android-release.yml` is `completed`: each tag rolls out to
internal testers on its own. (Play accepts only `draft` until an app's first
release is published by hand in Play Console; that step is done.)

Promote:

1. The promote workflow (job `play`), or by hand: Play Console > Test and
   release > Internal testing > Promote release > Production (a personal developer account created after 2023-11-13 must run
   a closed test with 12 testers for 14 days first: promote to a closed track).
2. GitHub: the promote job clears "Set as a pre-release"; by hand, edit the release, clear it, set it as latest.
3. Optional: run the rebuild workflow (Actions > rebuild, tag
   `android/vX.Y.Z`) to prove the APKs are reproducible.
4. F-Droid, by hand after step 2: edit `site/public/fdroid/android.txt`
   (versionName, then versionCode) in a site commit. The first time, add the
   app metadata to fdroiddata by hand (UpdateCheckMode HTTP on that file,
   tag pattern `android/v%v`, Binaries
   `https://github.com/tkooda/pusharmor/releases/download/android/v%v/pusharmor-%v-foss.apk`,
   AllowedAPKSigningKeys the release certificate). F-Droid builds only after
   the GitHub release resolves.

## iOS (`ios/vX.Y.Z`)

CI: the IPA (cloud-managed signing) in the GitHub prerelease; the build uploaded
to App Store Connect. No review submission.

Test: internal TestFlight testers (no Beta App Review).

The app declares ITSAppUsesNonExemptEncryption = false: it uses only Apple OS
encryption (CryptoKit), so no export compliance answer is needed.

Promote:

1. The promote workflow (job `appstore`, release after approval), or by
   hand: App Store Connect: create the version X.Y.Z, choose the uploaded
   build, select the release option, submit for review.
2. By hand with "Manually release this version" only: after approval,
   Release this version.
3. GitHub: the promote job clears "Set as a pre-release"; by hand, clear it on the release.

## Chrome (`chrome/vX.Y.Z`)

CI: the public zip `pusharmor-chrome-X.Y.Z.zip` (no dev key) and the Beta zip in
the GitHub prerelease; the Beta zip ("PushArmor Beta") uploaded to the PRIVATE
Beta item and published there to trusted testers after store review.

Test: testers install "PushArmor Beta" from the store; it auto-updates.

Promote:

1. The promote workflow (job `chrome`), or by hand: Chrome Web Store
   dashboard, the public item: upload `pusharmor-chrome-X.Y.Z.zip` from the
   prerelease, submit for review, publish.
2. GitHub: the promote job clears "Set as a pre-release"; by hand, clear it.
3. The collect workflow (daily) publishes the store CRX as the release
   `store/chrome/vX.Y.Z` after it checks it against the release file hashes. It
   takes the tag of the version the public item serves, so promoting an older
   test tag works.

## Firefox (`firefox/vX.Y.Z`)

CI: the public zip `pusharmor-firefox-X.Y.Z.zip`, the source archive, the
signed Beta XPI `pusharmor-firefox-beta-X.Y.Z.xpi` and its update manifest
`pusharmor-firefox-beta-X.Y.Z-updates.json` in the GitHub prerelease. The Beta
add-on ("PushArmor Beta", own gecko id) is signed UNLISTED on AMO; AMO never
lists it.

Rerun: AMO accepts each version once. When `submit-firefox` passed and
`publish-firefox` failed, rerun only the failed `publish-firefox` job. A full
rerun signs the same version again and fails; fix a failure in
`submit-firefox` or before it with a new patch version.

Test: install the Beta XPI from the prerelease link once. Auto-update: copy the
updates.json asset to `site/public/fx/beta/updates.json` in a site commit (the
Beta manifest's update_url is `https://pusharmor.com/fx/beta/updates.json`,
`release/constants.json`). Do not install the public add-on and the Beta add-on
in the same Firefox profile: both handle the sign-in page.

Promote:

1. The promote workflow (job `firefox`), or by hand: AMO Developer Hub, the
   listed add-on: upload `pusharmor-firefox-X.Y.Z.zip` as a new version with
   the source archive; it goes public after review. The listed add-on is
   created by hand once (the first listed version, with the public gecko id
   of `release/public.json`); the workflow fails until it exists.
2. GitHub: the promote job clears "Set as a pre-release"; by hand, clear it.
3. The collect workflow publishes the AMO XPI of the current public version
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

1. Branch ruleset on `main`: block force pushes, restrict deletions. No pull
   request and no required status check, so the owner can push to `main`
   directly. `ci-ok` still runs on every push; wait for it to be green before
   you tag a commit. `release/tag.mjs` and the first job of every release
   workflow refuse a commit without a successful ci-ok.
2. Tag ruleset, target pattern `*/v*` (all release tags): restrict creation,
   update and deletion to the owner (bypass list: repository admin and the
   push deploy key); block force pushes. A release tag can then not be
   created by anyone else, moved or deleted.
3. Environments `android-sign`, `android-release`, `ios-release`,
   `chrome-release`, `firefox-release`: "Deployment branches and tags" =
   selected tags only, `android/v*` for both Android environments, `ios/v*`,
   `chrome/v*`, `firefox/v*`. Required reviewers are optional (owner ruling
   Q200: the store promotion is the human gate).
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
   Each condition also accepts the promote workflow on `main` (item 7):
   `(assertion.ref.startsWith('refs/tags/android/v') || assertion.workflow_ref
   == 'tkooda/pusharmor/.github/workflows/promote.yml@refs/heads/main')`, and
   the same with `chrome/v` for the Chrome Web Store.
   Grant each service account to the principalSet of its own store's pool only.
6. GitHub immutable releases are on and supported: the release workflows add
   every asset to a draft and publish it last. A published release cannot get
   new assets, so a failed publish after that point is fixed with a new patch
   version.
7. Promote (`.github/workflows/promote.yml`, dispatched on `main`):
   Environment `promote`, required reviewer the owner, "Prevent self-review"
   off, deployment branch `main` only. The store jobs use the existing store
   Environments for their secrets, so `android-release`, `ios-release`,
   `chrome-release` and `firefox-release` also allow the branch `main`; only
   promote.yml and the tag-triggered release workflows name them
   (`release/promote.test.mjs` checks this). No secret is copied.