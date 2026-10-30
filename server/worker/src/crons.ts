// Cron trigger strings. wrangler.jsonc "triggers.crons" must equal these (a test checks it).
export const CRON_MONTHLY = "0 3 1 * *"; // purge of accounts idle 3 years
