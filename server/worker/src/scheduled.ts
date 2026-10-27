// scheduled(): hourly health check + vendor auth alert, monthly purge.
import type { Env } from "./env";
import { CRON_HOURLY, CRON_MONTHLY } from "./crons";
import * as SQL from "./db/sql";
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
  // Ops contact = VAPID_SUB without "mailto:".
  const to = env.VAPID_SUB.replace(/^mailto:/, "");
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
  while (chunks < PURGE_MAX_CHUNKS) {
    const rs = await env.DB.batch([env.DB.prepare(SQL.W_PURGE_PEERS).bind(cutoff), env.DB.prepare(SQL.W_PURGE_ACCOUNTS).bind(cutoff)]);
    chunks++;
    for (const r of rs) log.addMeta(r.meta);
    const changed = rs[0].meta.changes + rs[1].meta.changes;
    purged += rs[1].meta.changes;
    if (changed === 0) break;
  }
  log.extra.purged = purged;
  log.extra.chunks = chunks;
  return purged;
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
  await check("d1", () => env.DB.prepare(SQL.Q_HEALTH).first());
  // Vendor auth alert: the previous full hour of this isolate's counts.
  const hour = Math.floor(deps.now() / 3600000) - 1;
  const alerts = authAlerts(hour);
  const snap = healthSnapshot(hour);
  for (const [v, h] of Object.entries(snap)) {
    log.extra[`auth_${v}`] = h.auth;
    log.extra[`ok_${v}`] = h.ok;
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
      await purge(env, Math.floor(Date.now() / 1000), log);
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
