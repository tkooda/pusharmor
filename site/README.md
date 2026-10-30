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
      wrangler.jsonc       assets-only config (the site checks allow no other keys)
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

## Build ids (release/public.json)

The site files hold placeholders, not ids. `site/tools/build.mjs` copies `site/public` to
`site/dist` (gitignored, replaced on each run), fills the ids there from the tracked
`release/public.json` (edit it in a normal commit) and rewrites the hashes there. The
tracked files keep their placeholders, so a build or deploy leaves `git status` clean:

- `cloudflare_turnstile_sitekey` -> `data-sitekey` in `public/turnstile.html`.
- `webpush_vapid_public_key` -> `VAPID_PUBLIC_KEY` in `public/js/fx-setup.js`.
- `google_chrome_extension_id` -> `chrome-extension://CHROME_EXTENSION_ID` in `public/_headers`.
- `google_chrome_beta_extension_id` -> `chrome-extension://CHROME_BETA_EXTENSION_ID` in `public/_headers`
  (the private "PushArmor Beta" item).
- `android_release_cert_sha256` (list) -> `public/.well-known/assetlinks.json`.

It fails when a value is missing, empty, malformed or a PLACEHOLDER, or a CI dummy
(`release/ci-dummy.mjs`) without `PA_CI_DUMMY=1`. Store
links and APK hashes (`public/download.html`) and the F-Droid version
(`public/fdroid/android.txt`) are edited by hand in the release PR.

Try a build (the tree stays clean; `--out DIR` writes elsewhere):

    node site/tools/build.mjs

Deploy is done by Cloudflare Workers Builds from the main branch, or by hand with
`npx wrangler deploy` in `site/`. `wrangler.jsonc` sets the build command `node tools/build.mjs`
(run in `site/`) and the assets directory `./dist`, so `wrangler deploy` builds `dist/` first and
fails while a placeholder is left, with no dashboard setting needed. `wrangler dev` copies
`public/` to `dist/` without filling the ids (`WRANGLER_COMMAND=dev`), so it serves the
placeholders. Keep the Workers Builds build command EMPTY: `wrangler deploy` already runs the build.

`node site/tools/hashes.mjs --check` and the site checks read the tracked `site/public` (with the
placeholders). The build rewrites the hashes in `dist/` for the filled values, then checks that
they settled and that no placeholder is left.

The site has no deploy script. Before a release deploy, run the checks with the release gate on:

    PA_RELEASE=1 node --test 'site/tools/test/*.test.mjs'

Do not deploy a release if any check fails or is skipped. `wrangler dev` stays fine for local work. `npx wrangler deploy --dry-run` in `site/` must fail while a placeholder is left.

## About page screenshots

`public/about.html` shows the app screenshots from `public/img/about/<platform>/` (android,
iphone, chrome, firefox). Each shot is a 1x webp, a 2x webp (`-2x`) and a reduced png fallback.
To swap them:

1. Put the new store PNGs in a folder per platform, e.g. `SRC/android/03-send.png`. Files whose
   name contains `BLANK` are skipped.
2. From the repo root, replace the old files and convert (ImageMagick with webp support):

        SRC=/path/to/screenshots
        rm -rf site/public/img/about
        for p in android iphone chrome firefox; do
          case $p in android|iphone) w=280;; *) w=720;; esac
          mkdir -p site/public/img/about/$p
          for f in "$SRC"/$p/*.png; do
            case "$f" in *BLANK*) continue;; esac
            n=site/public/img/about/$p/$(basename "$f" .png)
            convert "$f" -strip -resize ${w}x -quality 85 -define webp:method=6 $n.webp
            convert "$f" -strip -resize "$((w*2))x>" -quality 80 -define webp:method=6 $n-2x.webp
            convert "$f" -strip -resize ${w}x -dither None -colors 128 -define png:compression-level=9 PNG8:$n.png
          done
        done

3. Edit the `<figure>` list in `public/about.html` to match the file names, with the image
   `width` and `height` (`identify site/public/img/about/*/*.png`) and an alt text that
   describes the screen. Only the first tab loads at once; keep `loading="lazy"` on the others.
4. Run `node site/tools/hashes.mjs` and the checks.

`/about#shots-iphone` (or `-chrome`, `-firefox`) opens that tab.
