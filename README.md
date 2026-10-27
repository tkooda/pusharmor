# pusharmor
Push URLs and text between devices securely.

## Deployment ids

The repo holds no deployment ids. Every name is listed once, with its meaning,
in `release/names.json`.

- Worker: Cloudflare dashboard variables and secrets; see
  `server/deploy/README.md`.
- Site, extensions, Android, iOS: copy `release/local.example.json` to
  `release/local.json` (git-ignored) and fill it; see each part's README.
  Release builds fail while it is missing or holds a placeholder.
