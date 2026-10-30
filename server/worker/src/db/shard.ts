// The one place that picks a D1 database (shard readiness). Every user query is scoped to one
// account, so it goes through dbFor(env, acct). An account's bucket is fixed by its id (first 8
// bits of the decoded 9-byte account id, 256 buckets); SHARD_MAP maps a bucket to a physical
// database. Today all buckets map to the one database (binding DB), so nothing changes.
// The "global" scope (vendor_health counters, the cron health probe) uses globalDb(env);
// the monthly purge and pending expiry run over allDbs(env), one database at a time.
// Rule: no new query may span accounts outside these cron and global paths.
import type { Env } from "../env";
import { b64urlDecode } from "../codec/b64url";

export const BUCKETS = 256;

// Bucket -> physical database binding name.
export const SHARD_MAP: readonly "DB"[] = Array.from({ length: BUCKETS }, () => "DB" as const);

export function bucketOf(acct: string): number {
  const raw = acct.length === 12 ? b64urlDecode(acct) : null;
  if (!raw || raw.length !== 9) throw new Error("bucketOf: bad account id");
  return raw[0];
}

export function dbFor(env: Env, acct: string): D1Database {
  return env[SHARD_MAP[bucketOf(acct)]];
}

export function globalDb(env: Env): D1Database {
  return env.DB;
}

export function allDbs(env: Env): D1Database[] {
  return [...new Set(SHARD_MAP)].map((b) => env[b]);
}
