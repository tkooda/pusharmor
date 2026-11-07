# PushArmor WebExtension shared code

Shared TypeScript for the Chrome extension (`client/chrome`) and the Firefox
add-on (`client/firefox`): crypto (WebCrypto, HPKE through `@hpke/core`),
the inner message and pairing protocol, IndexedDB storage, the background
engine, and the popup and tab UI. This directory holds the one npm package
for both extensions.

No code here reads `chrome.*` or `browser.*`; the shells pass their
namespace object in (`src/shellkit.ts`, `src/platform.ts`).

## Commands

Node 24 runs the TypeScript tests directly (type stripping). The scripts are
in `package.json` (`npm run check` runs them all, after `npm ci`).
`npm run build -- --dev` is the dev build: the Chrome manifest gets "key" when
`release/public.json` sets one.

The build is reproducible: unminified ES modules, zip entries sorted, fixed
timestamps. Build ids (VAPID public key, Firefox add-on id, Chrome dev key)
come from the tracked `release/public.json` (edit it in a normal commit). A
release build fails while a needed value is a placeholder (or a CI dummy
without `PA_CI_DUMMY=1`); `--dev` builds work with the placeholders.

A release build also writes the Beta zips `pusharmor-<browser>-beta.zip`
(a separate Beta listing): the same files with the name "PushArmor Beta"; the
Firefox one has the Beta gecko id `mozilla_firefox_beta_addon_id` and the
update_url `firefox_beta_update_url` of `release/constants.json`. Release tags
upload them to the test channels (`RELEASING.md`). It also writes
`pusharmor-chrome-unpacked.zip` for the GitHub release: the Chrome release
files with the public item's "key" (`google_chrome_dev_key`), so a copy loaded
with "Load unpacked" gets the store id. The store gets only the key-free zip.

A release build then checks all five zips with `check-release.mjs` (also runnable
on its own: `node check-release.mjs <zip>...`): no Chrome "key" (the
`-unpacked.zip`: exactly `google_chrome_dev_key`, and no other difference from
the store zip beside it), no source map
or test entry, no public.json placeholder, no CI dummy without `PA_CI_DUMMY=1`,
no `://localhost` or `127.0.0.1`, no `globalThis.__*` in shipped JS, the
name "PushArmor" ("PushArmor Beta" in a Beta zip), and a Firefox update_url
only in the Beta zip. It also
checks against the pinned allow-list `release-allow.json`: each zip entry must
be in its browser's `entries`, and each runtime message op the shipped JS
dispatches on must be in `ops` (a test pins `ops` to the source handlers; add
a new op or output file there). No test hooks ship in a release.

The golden test reads `tests/vectors/golden-v1.json` at the repo root.
