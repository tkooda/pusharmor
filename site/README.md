# PushArmor website (pusharmor.com)

Static site served by Cloudflare Workers static assets (assets only, no Worker script).
Hand-written HTML, one CSS file and small plain scripts. No framework and no build step
beyond filling the build ids (below); no third-party scripts except Cloudflare Turnstile
on /turnstile.

Layout:

    site/
      public/              served as is (assets directory)
        _headers           security headers per path
        css/site.css       the one stylesheet
        js/                page scripts (SRI-pinned, hashed in the page CSP)
        fx/                Firefox fallback service worker and its pages
        auth/              OAuth landing pages (/auth/done, /auth/android)
        .well-known/       security.txt, assetlinks.json
      wrangler.jsonc       assets-only config (the site checks allow no other keys)
      tools/hashes.mjs     rewrites SRI integrity attributes and CSP script hashes
      tools/build.mjs      fills the build ids from release/public.json (release deploy)
      tools/test/          site checks (node --test)

## Install

    cd site && npm ci

## Update hashes after editing a page, script or stylesheet

    node site/tools/hashes.mjs           # rewrite
    node site/tools/hashes.mjs --check   # report only, exit 1 if stale

## Checks

    node --test 'site/tools/test/*.test.mjs'

The header snapshot test starts the project-local `wrangler dev`; it is skipped with a note if
wrangler cannot start. Checks that need files from other components (release constants,
Firefox manifest, golden vectors, Worker wrangler version) are skipped until those files exist.

## Build ids (release/public.json)

The site files hold placeholders, not ids. `site/tools/build.mjs` fills them from the
tracked `release/public.json` (edit it in a normal commit) in place and rewrites the
hashes:

- `cloudflare_turnstile_sitekey` -> `data-sitekey` in `public/turnstile.html`.
- `webpush_vapid_public_key` -> `VAPID_PUBLIC_KEY` in `public/js/fx-setup.js`.
- `google_chrome_extension_id` -> `chrome-extension://CHROME_EXTENSION_ID` in `public/_headers`.
- `android_release_cert_sha256` (list) -> `public/.well-known/assetlinks.json`.

It fails when a value is missing, empty, malformed or a PLACEHOLDER, or a CI dummy
(`release/ci-dummy.mjs`) without `PA_CI_DUMMY=1`. Store
links and APK hashes (`public/download.html`) and the F-Droid version
(`public/fdroid/android.txt`) are edited by hand in the release PR.

Try a build without touching the tree:

    cp -r site/public /tmp/site && node site/tools/build.mjs --dir /tmp/site

Deploy is done by Cloudflare Workers Builds from the main branch. `wrangler.jsonc` sets the build
command `node tools/build.mjs` (run in `site/`), so `wrangler deploy` fails while a placeholder is
left, with no dashboard setting needed. `wrangler dev` skips the build (`WRANGLER_COMMAND=dev`) and
keeps the placeholders. Keep the Workers Builds build command empty or equal to that value.

The site has no deploy script. Before a release deploy, run the checks with the release gate on:

    PA_RELEASE=1 node --test 'site/tools/test/*.test.mjs'

Do not deploy a release if any check fails or is skipped. `wrangler dev` stays fine for local work. `npx wrangler deploy --dry-run` in `site/` must fail while a placeholder is left.
