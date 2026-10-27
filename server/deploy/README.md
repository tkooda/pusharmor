# Worker deploy

Operator scripts for the `pusharmor-api` Worker (api.pusharmor.com).

## Usage

`deploy.sh` is the only supported release path for the Worker. Do not run
`wrangler deploy` directly for a release: it skips the preflight, the backup
and the migration steps. `wrangler dev` stays fine for local work.

Never connect Workers Builds (Git integration) to the `pusharmor-api` Worker: it would skip
the preflight, check-bundle, the backup and the migrations. Deploy only with `deploy.sh`.

    CLOUDFLARE_ACCOUNT_ID=... server/deploy/deploy.sh worker/vX.Y.Z
    CLOUDFLARE_ACCOUNT_ID=... server/deploy/deploy.sh maintenance
    server/deploy/deploy.sh --help

## Environment

- CLOUDFLARE_ACCOUNT_ID: required.
- DB_EXPORT_MAX_BYTES: abort before the export if the remote DB is larger.
  Default 209715200 (200 MB). Set it from the measured export time; the DB
  is blocked while the export runs.
- WRANGLER: wrangler path. Default server/worker/node_modules/.bin/wrangler.
- API_BASE: smoke test base URL. Default https://api.pusharmor.com/v1.

## Worker variables (Cloudflare dashboard)

Deployment ids are not in the repo. `server/worker/wrangler.jsonc` holds only
fixed values and sets `keep_vars: true`, so a deploy keeps the dashboard
variables (the maintenance config sets it too). Owner steps, once and after
each change:

1. Create the Worker first: `wrangler secret put` for each secret (see the
   Worker README), or one plain `wrangler deploy` from `server/worker`.
2. Cloudflare dashboard > Workers & Pages > pusharmor-api > Settings >
   Variables and Secrets > Add, type Text, one variable per name in
   `release/names.json` "cloudflare_vars" (the one list, with a meaning per
   name; JSON lists such as GOOGLE_AUD_WEB go in as text, e.g.
   `["id1","id2"]`). Save and deploy. The secrets are in "cloudflare_secrets".
3. The D1 binding has no database_id; wrangler finds the database by its
   name `pusharmor`.

Preflight (step 0 of a release): `preflight.mjs` fails when the repo config
holds one of these ids, a database_id or a PLACEHOLDER, or lacks keep_vars;
`preflight.mjs --dashboard` then reads the deployed version with the
read-only `wrangler deployments status` and `wrangler versions view` and
fails when one of those variables is missing, empty or a PLACEHOLDER.
`check-bundle.mjs` then builds the bundle with `wrangler deploy --dry-run
--outdir <tmp>` (no upload) and fails when it holds test code or a test route:
resetHealth, clearTokens, clearJwks, TEST_MIGRATIONS, TEST_SECRETS, cloudflare:test,
vitest, miniflare, "/test", "/debug" or "/__". No test hooks ship in a release.
It also fails on any "/v1/..." string literal whose path is not in the pinned
allow-list `server/worker/routes.json`, and on any "x-pa-..." name (any case) not
in its `x_pa_headers` list. The Worker test `test/routes.test.ts` pins the router
table to that file, so a new route needs a reviewed edit to `routes.json`.

## Release steps

0. Preflight (above). Nothing is deployed when it fails.
1. Refuse to run on a dirty tree (uncommitted or untracked files).
2. Check HEAD is an ancestor of origin/main, `node release/tag.mjs --check
   worker/vX.Y.Z` passes (annotated tag at HEAD, version rules, version files),
   and the tag is on origin at HEAD. Make the tag first with
   `node release/tag.mjs worker X.Y.Z` and push it (RELEASING.md); its
   worker-release run must be green.
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
8. Done: the script prints the tag and the uploaded bundle sha256. It creates
   no tag (the worker/v tag came first).

## Maintenance mode

`deploy.sh maintenance` deploys `maintenance/`: the same Worker name with a
static 503 response `{"error":"unavailable"}` and the same cron triggers.
Return to service with `(cd server/worker && npx wrangler rollback)` or a
normal release deploy.
