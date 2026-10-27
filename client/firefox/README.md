# PushArmor for Firefox

Manifest V2 add-on with a persistent background page. On desktop it runs its
own Mozilla autopush WebSocket client (`src/autopush/`) and decrypts RFC 8291
itself. On Firefox for Android, and on desktop when autopush is unreachable,
the pusharmor.com site service worker receives the push and forwards the
ciphertext, which the add-on catches (`src/sitefwd/`).

Build and test from `client/webext-common`:

    cd ../webext-common && npm ci && npm test && npm run build && npm run lint:firefox

The zip is `dist/pusharmor-firefox.zip`; load `dist/unpacked` from
about:debugging for a local test. AMO receives the source with each version
because the output is bundled: check out the release tag and run the
commands above to reproduce it.
