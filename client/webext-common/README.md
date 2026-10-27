# PushArmor WebExtension shared code

Shared TypeScript for the Chrome extension (`client/chrome`) and the Firefox
add-on (`client/firefox`): crypto (WebCrypto, HPKE through `@hpke/core`),
the inner message and pairing protocol, IndexedDB storage, the background
engine, and the popup and tab UI. This directory holds the one npm package
for both extensions.

No code here reads `chrome.*` or `browser.*`; the shells pass their
namespace object in (`src/shellkit.ts`, `src/platform.ts`).

## Commands

Node 24 runs the TypeScript tests directly (type stripping).

    npm ci
    npm run typecheck      # tsc --noEmit (shared code and both shells)
    npm test               # unit, state machine, manifest and golden vector tests
    npm run build          # both zips in client/chrome/dist and client/firefox/dist
    npm run build -- --dev # dev build: Chrome manifest gets "key"
    npm run lint:firefox   # web-ext lint on the Firefox build

The build is reproducible: unminified ES modules, zip entries sorted, fixed
timestamps. Build ids (VAPID public key, Firefox add-on id, Chrome dev key)
come from the tracked `release/public.json` (edit it in a normal commit). A
release build fails while a needed value is a placeholder (or a CI dummy
without `PA_CI_DUMMY=1`); `--dev` builds work with the placeholders.

A release build then checks both zips with `check-release.mjs` (also runnable
on its own: `node check-release.mjs <zip>...`): no Chrome "key", no source map
or test entry, no public.json placeholder, no CI dummy without `PA_CI_DUMMY=1`,
no `://localhost` or `127.0.0.1`, no `globalThis.__*` in shipped JS. It also
checks against the pinned allow-list `release-allow.json`: each zip entry must
be in its browser's `entries`, and each runtime message op the shipped JS
dispatches on must be in `ops` (a test pins `ops` to the source handlers; add
a new op or output file there). No test hooks ship in a release.

The golden test reads `tests/vectors/golden-v1.json` at the repo root.

`amo-sign/` pins web-ext alone (exact version, own lockfile) for the AMO
submission in `.github/workflows/webext-release.yml`: the publish job installs
only it (`npm ci --ignore-scripts`), never this package's dependencies.
