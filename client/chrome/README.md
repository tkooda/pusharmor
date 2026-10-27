# PushArmor for Chrome

Manifest V3 extension. Push messages arrive through the Push API in the
extension service worker (`src/sw.ts`). All shared code lives in
`client/webext-common`; build and test from there:

    cd ../webext-common && npm ci && npm test && npm run build

The zip is `dist/pusharmor-chrome.zip`. Load `dist/unpacked` with
"Load unpacked" on chrome://extensions for a local test (use
`npm run build -- --dev` so the unpacked id matches the store id).

Chrome on Windows and macOS refuses CRX installs from outside the Chrome Web
Store for normal users; a CRX from GitHub is mainly for verification and Linux.
