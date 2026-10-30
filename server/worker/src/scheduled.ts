// scheduled(): hourly health check + vendor auth alert, monthly purge.
import type { Env } from "./env";
import { CRON_HOURLY, CRON_MONTHLY } from "./crons";
import * as SQL from "./db/sql";
import { allDbs, globalDb } from "./db/shard";
import { Log } from "./log";
import { sendEmail } from "./auth/ses";
import { deps } from "./push/deps";
import { mintFcmToken } from "./push/fcm";
import { apnsMayRemint, mintApnsJwt } from "./push/apns";
import { mintVapid } from "./push/webpush";
import { authAlerts, healthSnapshot } from "./push/results";

export const PURGE_IDLE_S = 94608000; // 3 years
export const PURGE_MAX_CHUNKS = 500;

const fetchFn = ((u: string, i: RequestInit) => deps.fetch(u, i)) as unknown as typeof fetch;

export async function mailOps(env: Env, subject: string, text: string): Promise<void> {
  // Ops contact = WEBPUSH_VAPID_SUB without "mailto:".
  const to = env.WEBPUSH_VAPID_SUB.replace(/^mailto:/, "");
  if (!to) return;
  try {
    await sendEmail(env, to, subject, text, fetchFn);
  } catch {
    // logged by the caller's line only
  }
}

// Returns the number of purged accounts.
export async function purge(env: Env, nowS: number, log: Log): Promise<number> {
  const cutoff = nowS - PURGE_IDLE_S;
  let purged = 0;
  let chunks = 0;
  for (const db of allDbs(env)) {
    let last = "";
    while (chunks < PURGE_MAX_CHUNKS) {
      const rs = await db.batch([db.prepare(SQL.W_PURGE_PEERS).bind(cutoff, last), db.prepare(SQL.W_PURGE_ACCOUNTS).bind(cutoff, last)]);
      chunks++;
      for (const r of rs) log.addMeta(r.meta);
      const ids = (rs[1].results as { id: string }[]).map((r) => r.id);
      purged += ids.length;
      if (ids.length < SQL.PURGE_CHUNK) break;
      last = ids.reduce((a, b) => (a > b ? a : b));
    }
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
  let changed = 0;
  let chunks = 0;
  for (const db of allDbs(env)) {
    let last = "";
    while (chunks < PENDING_MAX_CHUNKS) {
      const rs = await db.batch([db.prepare(SQL.Q_PENDING_CHUNK).bind(last, chunk), db.prepare(SQL.W_PENDING_EXPIRE).bind(last, chunk, cutoff, nowS)]);
      chunks++;
      for (const r of rs) log.addMeta(r.meta);
      changed += rs[1].meta.changes;
      const head = rs[0].results[0] as { n: number; last: string | null } | undefined;
      if (!head || head.n < chunk || head.last === null) break;
      last = head.last;
    }
  }
  log.extra.pending_expired = changed;
  log.extra.pending_chunks = chunks;
  return changed;
}

export async function healthCheck(env: Env, log: Log): Promise<string[]> {
  const failed: string[] = [];
  const check = async (name: string, f: () => Promise<unknown>) => {
    try {
      await f();
    } catch {
      failed.push(name);
    }
  };
  await check("fcm", () => mintFcmToken(env));
  // APNs and VAPID are local signing: mint fresh so a broken key shows up (APNs only when
  // the cached JWT is >= 20 min old, Apple's minimum refresh interval).
  await check("apns", () => mintApnsJwt(env, apnsMayRemint()));
  await check("vapid", () => mintVapid(env, "https://fcm.googleapis.com", true));
  await check("d1", async () => {
    for (const db of allDbs(env)) await db.prepare(SQL.Q_HEALTH).first();
  });
  // Vendor auth alert: the previous full hour of the shared counts.
  const hour = Math.floor(deps.now() / 3600000) - 1;
  // A D1 outage must not stop the health check failed mail below; it shows up there as "d1".
  let alerts: string[] = [];
  let snap: Awaited<ReturnType<typeof healthSnapshot>> = {};
  try {
    alerts = await authAlerts(env, hour);
    snap = await healthSnapshot(env, hour);
  } catch {
    // No alerts this hour; the d1 check reports the outage.
  }
  for (const [v, h] of Object.entries(snap)) {
    log.extra[`auth_${v}`] = h.auth;
    log.extra[`ok_${v}`] = h.ok;
  }
  try {
    await globalDb(env).prepare(SQL.W_HEALTH_PURGE).bind(hour - 48).run();
  } catch {
    // Old counter rows are harmless; the next hour retries.
  }
  if (failed.length) await mailOps(env, "PushArmor health check failed", "Failed checks: " + failed.join(", ") + "\n");
  if (alerts.length) await mailOps(env, "PushArmor vendor auth alert", "Only auth failures, no success, in the last hour: " + alerts.join(", ") + "\n");
  if (failed.length) log.extra.health_failed = failed.join(",");
  if (alerts.length) log.extra.auth_alert = alerts.join(",");
  return alerts;
}

export async function scheduled(controller: ScheduledController, env: Env): Promise<void> {
  const log = new Log();
  log.route = "cron";
  try {
    if (controller.cron === CRON_HOURLY) {
      log.route = "cron hourly";
      await healthCheck(env, log);
    } else if (controller.cron === CRON_MONTHLY) {
      log.route = "cron monthly";
      const now = Math.floor(Date.now() / 1000);
      try {
        await purge(env, now, log);
      } finally {
        await expirePending(env, now, log);
      }
    } else {
      log.error = "cron-unknown";
      await mailOps(env, "PushArmor cron-unknown", "scheduled() got an unknown cron string.\n");
    }
  } catch (e) {
    log.setException(e);
  } finally {
    log.emit();
  }
}
