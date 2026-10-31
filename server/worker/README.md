# PushArmor Worker

The Cloudflare Worker behind https://api.pusharmor.com/v1. It is a blind relay: it never
sees plaintext, stores no messages, and keeps its state in one D1 database.

## Layout

    wrangler.jsonc            bindings, vars, cron triggers (no secrets)
    migrations/0001_init.sql  D1 schema
    src/index.ts              fetch() pipeline and scheduled() entry
    src/router.ts             route table
    src/pipeline/             rate limits, capped body read, PA-ID / PA-Time / PA-Sig
    src/codec/                strict b64url, request validators
    src/crypto/               ids, ECDSA, tokens, email code
    src/auth/                 email code, Turnstile, SES (SigV4), Google and Apple sign-in
    src/db/                   SQL statements and row mapping
    src/routes/               peers, account, approve/deny, pair, send, health
    src/push/                 fan-out, FCM, APNs, Web Push (RFC 8291 + VAPID)
    test/                     vitest suite (workerd + local D1)

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
Workers Logs bills every line. `head_sampling_rate` stays 1: head sampling is decided before
the request runs and would drop errors as well. Sampling is done in code with the var
`PA_LOG_SAMPLE` (wrangler.jsonc):

- always logged, whatever the rate: 5xx and exceptions, 4xx other than 429, rate-limit
  binding errors, failed gone write-backs, rejected push endpoints, any recipient not
  delivered on the first try, and every cron run;
- logged at the rate: plain successes and 429s; when the rate is below 1 such a line has
  `"sample": N` (N = 1 / rate), so multiply counts by N.

Now `PA_LOG_SAMPLE` is `"1"` (every line), for launch and the first users.

When to lower it: when Workers Logs events approach this Worker's share of the plan's
included 20M events per month (about 650k per day for the whole Cloudflare account), or when
the monthly Workers Logs overage passes a few dollars. How: set `"PA_LOG_SAMPLE": "0.1"` in
`wrangler.jsonc` and release a new Worker tag (`RELEASING.md`, Worker). Errors stay complete.

## Client versions

Clients send `PA-Client: <platform>/<x.y.z>` (android, ios, chrome, firefox, web, cli). The
log line carries it as `client` (`"invalid"` when malformed). When the var `PA_MIN_CLIENT`
(`x.y.z`) is set, a request whose PA-Client version is lower gets 426
`{"error":"update required"}`. Unset (now): never 426. A missing or malformed header is
always allowed.

## Deploy

Only with `server/deploy/deploy.sh worker/vX.Y.Z` from a clean checkout of that
tag on main (see `server/deploy/README.md` and `RELEASING.md`).
Deployment ids (FCM, APNs, VAPID, SES, OAuth audiences) are Cloudflare
dashboard variables, not repo values; `wrangler.jsonc` sets `keep_vars: true`.
The owner steps are in `server/deploy/README.md`.
