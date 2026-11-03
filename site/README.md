# PushArmor website (pusharmor.com)

Static site served by Cloudflare Workers static assets (assets only, no Worker script).
Hand-written HTML, one CSS file and small plain scripts. No framework and no build step
beyond filling the build ids (below); no third-party scripts except Cloudflare Turnstile
on /turnstile.

Layout:

    site/
      public/              tracked source, with placeholders for the build ids
      dist/                build output served by wrangler (assets directory, gitignored)
        _headers           security headers per path
        css/site.css       the one stylesheet
        js/                page scripts (SRI-pinned, hashed in the page CSP)
        fx/                Firefox fallback service worker and its pages
        auth/              OAuth landing pages (/auth/done, /auth/android)
        .well-known/       security.txt, assetlinks.json
      wrangler.jsonc       assets-only config
      tools/hashes.mjs     rewrites SRI integrity attributes and CSP script hashes
      tools/build.mjs      copies public/ to dist/ and fills the build ids there (deploy)
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

## Build ids and deploy

The tracked files hold placeholders, not ids. `site/tools/build.mjs` copies `site/public` to
the gitignored `site/dist`, fills the ids there from `release/public.json` and rewrites the
hashes there (see its header comment), so `git status` stays clean. Try it with
`node site/tools/build.mjs` (`--out DIR` writes elsewhere).

Deploy is manual: `npx wrangler deploy` in `site/` (a push to main does not deploy). It runs
the build first (`wrangler.jsonc`) and fails while a placeholder is left. Before a release
deploy, run the checks with the release gate on, and do not deploy if any check fails or is
skipped:

    PA_RELEASE=1 node --test 'site/tools/test/*.test.mjs'

## About page screenshots

`public/about.html` shows PNGs from `public/img/about/<platform>/` (android, iphone, chrome,
firefox), at most twice the shown width (280 for phones, 720 for browsers), e.g.
`convert IN.png -strip -resize "560x>" -define png:compression-level=9 OUT.png`. Update the
`<figure>` list (width, height, alt; `loading="lazy"` past the first tab), then run
`node site/tools/hashes.mjs` and the checks. `/about#shots-iphone` (or `-chrome`, `-firefox`) opens that tab.
