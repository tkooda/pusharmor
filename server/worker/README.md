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
    src/routes/               peers, account, approve/deny, pair, send
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
`rows_read` / `rows_written` per endpoint; the D1 cost test fails when they change. The
golden test reads `../../tests/vectors/golden-v1.json`.

## Secrets

Secrets are set with `wrangler secret put`; their names are listed in `.dev.vars.example`.
The test suite uses fixed test-only values (`test/secrets.ts`).

No test hooks in release builds: `src/` exports nothing that only tests call, and
`server/deploy/check-bundle.mjs` (deploy step 0) fails a bundle holding test code or a
test route.

## Logs

One JSON line per request (`src/log.ts`), allow-listed fields only. Workers Logs bills every
line, so the Worker samples in code with `PA_LOG_SAMPLE` (wrangler.jsonc, 0.01):

- always logged: 5xx and exceptions, 4xx other than 429, rate-limit binding errors, failed
  gone write-backs, rejected push endpoints, any recipient not delivered on the first try,
  and every cron run;
- sampled at 1 in 100: plain successes and 429s; such a line has `"sample": 100`, so
  multiply counts and `rows_read` / `rows_written` by it.

`head_sampling_rate` stays 1: head sampling is decided before the request runs and would
drop errors as well. For a debugging session set `PA_LOG_SAMPLE` to 1 and deploy.

## Deploy

Only with `server/deploy/deploy.sh worker/vX.Y.Z` from a clean checkout of that
tag on main (see `server/deploy/README.md` and `RELEASING.md`).
Deployment ids (FCM, APNs, VAPID, SES, OAuth audiences) are Cloudflare
dashboard variables, not repo values; `wrangler.jsonc` sets `keep_vars: true`.
The owner steps are in `server/deploy/README.md`.
