// scheduled(): monthly purge and pending expiry; 15-minute health ping; 5-minute file cleanup.
import type { Env } from "./env";
import { CRON_FILES, CRON_HEALTH, CRON_MONTHLY } from "./crons";
import { storeDeps } from "./file/store";
import { SWEEP_OBJECT } from "./file/quota";
import { minuteStart, storageError } from "./routes/file";
import { dbSelfCheck } from "./routes/health";
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
      env.DB.prepare(SQL.W_PENDING_EXPIRE).bind(last, chunk, cutoff),
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

// File cleanup. A file is deleted 5 min after it expires. Its folder v1/<minute>/ is named by
// the expiry minute, and expires is a whole second, so the folder is due once its latest
// possible expires (minute start + 59 s) plus 5 min is reached; then every version of every
// object under it is deleted. Every run handles every due folder,
// oldest first, up to SWEEP_MAX_CALLS storage calls; folders left over stay due and the next
// run takes them. Runs keep no state, so two runs at once only repeat deletes. Only failures to
// delete are logged as errors; the time of the last run that left nothing due and had no failure
// is kept for /v1/health.
export const FILE_GRACE_S = 300;
export const SWEEP_MAX_CALLS = 1000;
const PAGE = 1000;
const DIR = /^v1\/([0-9]{12})\/$/;

const pages = (n: number) => Math.max(1, Math.ceil(n / PAGE));

// Unix second at which folder v1/<minute>/ is due, or null for a name that is not a minute folder.
export function dueAt(prefix: string): number | null {
  const m = DIR.exec(prefix);
  const start = m ? minuteStart(m[1]) : null;
  return start === null ? null : start + 59 + FILE_GRACE_S;
}

export async function sweepFiles(env: Env, nowS: number, log: Log, maxCalls = SWEEP_MAX_CALLS): Promise<void> {
  const store = storeDeps.store(env);
  if (!store) return;
  let calls = 0;
  let deleted = 0;
  let failed = 0;
  let due: string[];
  const fail = (why: string) => {
    failed++;
    log.error = "file-delete-failed";
    log.extra.storage ??= why;
  };
  try {
    const all = await store.listPrefixes("v1/");
    if (all === "cap") {
      fail("cap");
      return;
    }
    calls += pages(all.length);
    due = all.filter((p) => {
      const t = dueAt(p);
      return t !== null && t <= nowS;
    });
    due.sort();
  } catch (e) {
    fail(storageError(e));
    return;
  }
  for (let i = 0; i < due.length && calls < maxCalls; i++) {
    try {
      const vs = await store.listVersions(due[i]);
      calls++;
      if (vs === "cap") {
        fail("cap");
        break;
      }
      calls += pages(vs.length) - 1;
      if (vs.length) {
        const r = await store.deleteVersions(vs);
        calls += pages(vs.length);
        if (r === "cap") {
          fail("cap");
          break;
        }
      }
      deleted++;
    } catch (e) {
      fail(storageError(e));
    }
  }
  const left = due.length - deleted - failed;
  log.extra.files_calls = calls;
  log.extra.files_dirs = deleted;
  if (left > 0 || failed > 0) log.extra.files_left = left + failed;
  if (failed === 0 && left === 0) {
    const q = env.FILE_QUOTA.get(env.FILE_QUOTA.idFromName(SWEEP_OBJECT));
    await q.markSweep(nowS);
  }
}

// Self-check, then GET the monitor URL. Never throws; logs no URL.
async function healthPing(env: Env, log: Log): Promise<void> {
  if (!(await dbSelfCheck(env, log))) {
    log.error = "health-check-failed";
    return;
  }
  if (!env.PA_HEALTHCHECK_URL) return;
  try {
    const res = await fetch(env.PA_HEALTHCHECK_URL, { method: "GET", signal: AbortSignal.timeout(10000) });
    await res.body?.cancel();
  } catch {
    log.error = "health-ping-failed";
  }
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
    } else if (controller.cron === CRON_FILES) {
      log.route = "cron files";
      await sweepFiles(env, Math.floor(Date.now() / 1000), log);
    } else if (controller.cron === CRON_HEALTH) {
      log.route = "cron health";
      await healthPing(env, log);
    } else {
      log.error = "cron-unknown";
    }
  } catch (e) {
    log.setException(e);
  } finally {
    // A file cleanup run is logged only when it failed.
    if (log.route !== "cron files" || log.error || log.exception) log.emit();
  }
}
