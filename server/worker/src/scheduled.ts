// scheduled(): monthly purge and pending expiry.
import type { Env } from "./env";
import { CRON_MONTHLY } from "./crons";
import * as SQL from "./db/sql";
import { Log } from "./log";

export const PURGE_IDLE_S = 94608000; // 3 years
export const PURGE_MAX_CHUNKS = 500;

// Returns the number of purged accounts.
export async function purge(env: Env, nowS: number, log: Log): Promise<number> {
  const cutoff = nowS - PURGE_IDLE_S;
  let purged = 0;
  let chunks = 0;
  let last = "";
  while (chunks < PURGE_MAX_CHUNKS) {
    const rs = await env.DB.batch([
      env.DB.prepare(SQL.W_PURGE_PEERS).bind(cutoff, last),
      env.DB.prepare(SQL.W_PURGE_ACCOUNTS).bind(cutoff, last),
    ]);
    chunks++;
    const ids = (rs[1].results as { id: string }[]).map((r) => r.id);
    purged += ids.length;
    if (ids.length < SQL.PURGE_CHUNK) break;
    last = ids.reduce((a, b) => (a > b ? a : b));
  }
  log.extra.purged = purged;
  log.extra.chunks = chunks;
  return purged;
}

export const PENDING_CHUNK = 500;
export const PENDING_MAX_CHUNKS = 400;

// Drops pending entries older than PENDING_TTL_S, one keyset chunk per batch (no rescans).
// Returns the number of rows changed.
export async function expirePending(env: Env, nowS: number, log: Log, chunk = PENDING_CHUNK): Promise<number> {
  const cutoff = nowS - SQL.PENDING_TTL_S;
  let last = "";
  let changed = 0;
  let chunks = 0;
  while (chunks < PENDING_MAX_CHUNKS) {
    const rs = await env.DB.batch([
      env.DB.prepare(SQL.Q_PENDING_CHUNK).bind(last, chunk),
      env.DB.prepare(SQL.W_PENDING_EXPIRE).bind(last, chunk, cutoff, nowS),
    ]);
    chunks++;
    changed += rs[1].meta.changes;
    const head = rs[0].results[0] as { n: number; last: string | null } | undefined;
    if (!head || head.n < chunk || head.last === null) break;
    last = head.last;
  }
  log.extra.pending_expired = changed;
  log.extra.pending_chunks = chunks;
  return changed;
}

export async function scheduled(controller: ScheduledController, env: Env): Promise<void> {
  const log = new Log();
  log.route = "cron";
  try {
    if (controller.cron === CRON_MONTHLY) {
      log.route = "cron monthly";
      const now = Math.floor(Date.now() / 1000);
      try {
        await purge(env, now, log);
      } finally {
        await expirePending(env, now, log);
      }
    } else {
      log.error = "cron-unknown";
    }
  } catch (e) {
    log.setException(e);
  } finally {
    log.emit();
  }
}
