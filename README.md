# pusharmor
Push URLs and text between devices securely.

## Deployment ids

Every name is listed once, with its meaning, in `release/names.json`.

- Worker: Cloudflare dashboard variables and secrets; see
  `server/deploy/README.md`.
- Site, extensions, Android, iOS: the public build ids live in the tracked
  `release/public.json`; edit it in a normal commit. Builds read it directly;
  see each part's README. Release builds fail while a needed value is empty or
  a PLACEHOLDER (a CI dummy from `release/ci-dummy.mjs` passes only with
  `PA_CI_DUMMY=1`).
