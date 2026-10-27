# Worker deploy

Operator scripts for the `pusharmor-api` Worker (api.pusharmor.com).

## Usage

`deploy.sh` is the only supported release path for the Worker. Do not run
`wrangler deploy` directly for a release: it skips the preflight, the backup
and the migration steps. `wrangler dev` stays fine for local work.

    CLOUDFLARE_ACCOUNT_ID=... server/deploy/deploy.sh X.Y.Z
    CLOUDFLARE_ACCOUNT_ID=... server/deploy/deploy.sh maintenance
    server/deploy/deploy.sh --help

## Environment

- CLOUDFLARE_ACCOUNT_ID: required.
- DB_EXPORT_MAX_BYTES: abort before the export if the remote DB is larger.
  Default 209715200 (200 MB). Set it from the measured export time; the DB
  is blocked while the export runs.
- WRANGLER: wrangler path. Default server/worker/node_modules/.bin/wrangler.
- API_BASE: smoke test base URL. Default https://api.pusharmor.com/v1.

## Release steps

1. Refuse to run on a dirty tree (uncommitted or untracked files).
2. Check HEAD is an ancestor of origin/main, X.Y.Z is valid, and tag
   worker-vX.Y.Z does not exist.
3. Check the DB size, print the D1 time-travel bookmark (the restore path),
   export the DB to a temp dir (deleted on exit).
4. Apply D1 migrations. On failure the script prints the restore command
   `wrangler d1 time-travel restore pusharmor --bookmark=<bookmark>` and stops.
5. Deploy with --outdir and print the sha256 of that uploaded bundle.
6. Smoke test: an unsigned GET /v1/peers must return 400 with body
   {"error":"bad request"}, a 13-digit PA-Epoch-Ms header, and
   Access-Control-Expose-Headers containing PA-Epoch-Ms. Then send one message
   between peers of your own accounts and type `ok`.
7. If step 5 or 6 fails, run `(cd server/worker && npx wrangler rollback)`.
   The previous version must work with the current migrations (N-1 rule).
8. Tag worker-vX.Y.Z at the deployed commit (annotated, with the bundle
   sha256) and push the tag. If the push fails, rerun
   `git push origin worker-vX.Y.Z`.

## Maintenance mode

`deploy.sh maintenance` deploys `maintenance/`: the same Worker name with a
static 503 response `{"error":"unavailable"}` and the same cron triggers.
Return to service with `(cd server/worker && npx wrangler rollback)` or a
normal release deploy.
