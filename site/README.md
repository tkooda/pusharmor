# PushArmor website (pusharmor.com)

Static site served by Cloudflare Workers static assets (assets only, no Worker script).
Hand-written HTML, one CSS file and small plain scripts. No build step, no framework, no
third-party scripts except Cloudflare Turnstile on /turnstile.

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

## Values to fill before launch

- Turnstile sitekey: `data-sitekey` in `public/turnstile.html` (the only place).
- VAPID public key: `VAPID_PUBLIC_KEY` in `public/js/fx-setup.js`.
- Chrome extension id: `chrome-extension://CHROME_EXTENSION_ID` in the /turnstile rule of
  `public/_headers`.
- Release certificate SHA-256 values: `public/.well-known/assetlinks.json`.
- Store links and APK hashes: `public/download.html`; F-Droid version: `public/fdroid/android.txt`.

Deploy is done by Cloudflare Workers Builds from the main branch (`npx wrangler deploy`).
The site has no deploy script. Before a release deploy, run the checks with the release gate on:

    PA_RELEASE=1 node --test 'site/tools/test/*.test.mjs'

Do not deploy a release if any check fails or is skipped. `wrangler dev` stays fine for local work.
