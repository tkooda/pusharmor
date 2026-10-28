# Releasing

A tag builds ONE platform and uploads it to that platform's test channel and to
a GitHub prerelease. CI never publishes to a public channel. After testing on
devices, the owner promotes the same build by hand in each store console.
Nothing is rebuilt for the promotion. The site deploys from main on its own
(Cloudflare Workers Builds, build command EMPTY: `wrangler deploy` runs the
build from `wrangler.jsonc`, and a second run fails); it has no tag.

| Tag              | CI uploads to (test channel)                          | Owner promotes by hand                          |
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
   it fetches the tags of origin, checks the rules and creates the annotated tag.
4. `git push origin <platform>/vX.Y.Z`. More platforms at the same version: run
   step 3 for each one at the SAME commit.

A failed upload after the store accepted the file is fixed with a new patch
version. A rerun of the tag workflow replaces the assets of a prerelease; it
never changes a promoted release.

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
prereleases" for the app. While `PLAY_INTERNAL_STATUS` in
`.github/workflows/android-release.yml` is `draft` (until the app's first manual
publish), roll the internal release out by hand in Play Console.

Promote:

1. Play Console > Test and release > Internal testing > Promote release >
   Production (a personal developer account created after 2023-11-13 must run
   a closed test with 12 testers for 14 days first: promote to a closed track).
2. GitHub: edit the release, clear "Set as a pre-release", set it as latest.
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

Promote:

1. App Store Connect: create the version X.Y.Z, choose the uploaded build,
   select "Manually release this version", submit for review.
2. After approval: Release this version.
3. GitHub: clear "Set as a pre-release" on the release.

## Chrome (`chrome/vX.Y.Z`)

CI: the public zip `pusharmor-chrome-X.Y.Z.zip` (no dev key) and the Beta zip in
the GitHub prerelease; the Beta zip ("PushArmor Beta") uploaded to the PRIVATE
Beta item and published there to trusted testers after store review.

Test: testers install "PushArmor Beta" from the store; it auto-updates.

Promote:

1. Chrome Web Store dashboard, the public item: upload
   `pusharmor-chrome-X.Y.Z.zip` from the prerelease, submit for review, publish.
2. GitHub: clear "Set as a pre-release".
3. The collect workflow (daily) attaches the store CRX after it checks it
   against the release file hashes. It takes the tag of the version the public
   item serves, so promoting an older test tag works.

## Firefox (`firefox/vX.Y.Z`)

CI: the public zip `pusharmor-firefox-X.Y.Z.zip`, the source archive, the
signed Beta XPI `pusharmor-firefox-beta-X.Y.Z.xpi` and its update manifest
`pusharmor-firefox-beta-X.Y.Z-updates.json` in the GitHub prerelease. The Beta
add-on ("PushArmor Beta", own gecko id) is signed UNLISTED on AMO; AMO never
lists it.

Test: install the Beta XPI from the prerelease link once. Auto-update: copy the
updates.json asset to `site/public/fx/beta/updates.json` in a site commit (the
Beta manifest's update_url is `https://pusharmor.com/fx/beta/updates.json`,
`release/constants.json`). Do not install the public add-on and the Beta add-on
in the same Firefox profile: both handle the sign-in page.

Promote:

1. AMO Developer Hub, the listed add-on: upload `pusharmor-firefox-X.Y.Z.zip`
   as a new version with the source archive; it goes public after review.
2. GitHub: clear "Set as a pre-release".
3. The collect workflow attaches the AMO XPI of the current public version
   after it checks it.

## One-time owner setup

Store items and ids:

- Chrome: create a second item in the Chrome Web Store dashboard named
  "PushArmor Beta" (the first upload by hand, e.g. the Beta zip of a local
  release build or a dev zip), description stating it is a test build,
  visibility Private (trusted testers). Put its id in `release/public.json`
  `google_chrome_beta_extension_id`. The CWS service account must have access
  to that item. The release build and the `chrome/v` job fail when this id
  equals the public id or is not 32 letters a-p.
- Firefox: pick the Beta gecko id (e.g. `beta@pusharmor.com`, not the public
  id) for `mozilla_firefox_beta_addon_id`. The first `firefox/v` tag creates the
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
   you tag a commit. No script or workflow in the repo checks this for you.
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
   Grant each service account to the principalSet of its own store's pool only.
6. Leave GitHub immutable releases off: with it on, a rerun cannot replace the
   assets of a prerelease and the collect workflow cannot attach the store
   files.
