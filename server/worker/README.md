# PushArmor Worker

The Cloudflare Worker behind https://api.pusharmor.com/v1. It is a blind relay: it never
sees plaintext, stores no messages, and keeps its state in one D1 database.

## Layout

Code in `src/` (entry `src/index.ts`, route table `src/router.ts`), the vitest suite in
`test/`, the D1 schema in `migrations/`, and bindings in `wrangler.jsonc` (no secrets).

No runtime npm dependencies: everything uses WebCrypto.

## Build and test

Node 24. From this directory:

    npm ci
    npm run typecheck
    npm test

`.npmrc` sets `ignore-scripts=true`; the workerd and esbuild binaries come from their
platform packages, so no install script is needed.

Tests run in the workerd pool with a local D1 (migrations applied from empty), the local
rate-limit binding simulation, and a local vendor mock that replays recorded FCM, APNs and
Web Push replies. No test calls a real vendor. `test/d1-cost.json` holds the measured
D1 `rows_read` / `rows_written` per endpoint (summed from the D1 result meta in the test, not
logged); the D1 cost test fails when they change. The
golden test reads `../../tests/vectors/golden-v1.json`.

## Secrets

Secrets are set with `wrangler secret put`; their names are listed in `.dev.vars.example`.
The test suite uses fixed test-only values (`test/secrets.ts`).

No test hooks in release builds: `src/` exports nothing that only tests call, and
`server/deploy/check-bundle.mjs` (deploy step 0) fails a bundle holding test code or a
test route.

## Logs

One compact JSON line per request (`src/log.ts`): allow-listed fields only, no bodies,
tokens or messages; the largest field is the per-recipient list (at most 9 short entries).
Every logged line adds to the log volume. `head_sampling_rate` stays 1: head sampling is decided before
the request runs and would drop errors as well. Sampling is done in code with the var
`PA_LOG_SAMPLE`, a Cloudflare dashboard variable (not in wrangler.jsonc):

- always logged, whatever the rate: 5xx and exceptions, rate-limit binding errors, failed gone write-backs, rejected push endpoints, any recipient not
  delivered on the first try, and every cron run;
- logged at the rate: plain successes and all 4xx; when the rate is below 1 such a line has
  `"sample": N` (N = 1 / rate), so multiply counts by N.

When to lower it: when log volume grows. How: set `PA_LOG_SAMPLE` in the Cloudflare
dashboard (for example `0.1`); a deploy keeps it (`keep_vars`). 5xx lines stay complete;
4xx counts become estimates.

## Client versions

Clients send `PA-Client: <platform>/<x.y.z>` (android, ios, chrome, firefox, web, cli). The
log line carries it as `client` (`"invalid"` when malformed). When the var `PA_MIN_CLIENT`
(a per-platform list `ios/0.0.47 cli/0.0.42 android/0.0.28`, entries separated by spaces
and/or commas, where an unlisted platform has no floor) is set, a request whose PA-Client
version is lower than the floor of its platform gets 426 `{"error":"update required"}`. A
platform listed twice takes its highest floor. A malformed entry (also a bare `x.y.z` or the
old `ios=0.0.47` form) is skipped with a warning in the log and never blocks. Unset: never 426. With a floor set, a signed request
(PA-ID or PA-Sig) with a missing or malformed header also gets 426; an unsigned one passes.

The website sends `PA-Client: delete-account` on the /delete-account page and
`PA-Client: cli-login` on the /auth/cli page. These two values are never held to a floor.
Each is accepted only for its own action (the email code steps of that action, plus
`DELETE /v1/account` for delete-account); any other request with either value gets 426.

## Deploy

Only with `server/deploy/deploy.sh worker/vX.Y.Z` from a clean checkout of that
tag on main (see `server/deploy/README.md` and `RELEASING.md`).
Deployment ids (FCM, APNs, VAPID, SES, OAuth audiences) are Cloudflare
dashboard variables, not repo values; `wrangler.jsonc` sets `keep_vars: true`.
The owner steps are in `server/deploy/README.md`.
