# Ban tool

Bans an account by email. Run from any directory:

    PA_ID_SECRET="$(pass show pusharmor/PA_ID_SECRET)" node server/tools/ban/ban.mjs a@b.com

- PA_ID_SECRET: required, read from the environment only (the b64url string set as the
  Worker secret, at least 32 bytes decoded). Never printed.
- WRANGLER: optional wrangler path. Default server/worker/node_modules/.bin/wrangler.

The script normalizes the email (ASCII only), derives the account id, and
prints only the account id and the SQL. It never prints the secret, the email
hash or the email. You must type the account id to confirm. It then runs
`wrangler d1 execute pusharmor --remote --command "<sql>"` from server/worker.

A ban is per mailbox, the same account identity as the Worker: at the providers
in `PLUS_TAG` (`lib.mjs`) a "+tag" is dropped, and at Gmail dots are dropped
too, so "a+x@gmail.com", "a.b@gmail.com", and "ab@gmail.com" are one account, and
one ban covers them. At other domains each address is its own account.

The SQL is idempotent: it upserts the account with status 'banned', then
deletes its peers. Rerun after a failure to repair a half run.

Tests: `node --test server/tools/ban/lib.test.mjs`
