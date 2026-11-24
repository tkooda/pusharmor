// GET /v1/health: one trivial database read, then 200 with JSON {status: "ok", files: "on" or
// "paused", last_sweep: unix seconds of the last complete file cleanup, or null}; an empty 503
// when the database read fails. files is "paused" when a quota var is 0 or not set, storage or
// FILE_ACCT_SECRET is not set, or this isolate saw a storage cap that is still in force.
import type { Ctx } from "../context";
import type { Env } from "../env";
import type { Log } from "../log";
import { json } from "../http";
import { SWEEP_OBJECT } from "../file/quota";
import { storeDeps } from "../file/store";
import { capLeft, quotaLimits } from "./file";

// The self-check shared with the 15-minute cron. Returns false (and records the exception) on failure.
export async function dbSelfCheck(env: Env, log: Log): Promise<boolean> {
  try {
    await env.DB.prepare("SELECT 1").first();
    return true;
  } catch (e) {
    log.setException(e);
    return false;
  }
}

export async function health(c: Ctx): Promise<Response> {
  if (!(await dbSelfCheck(c.env, c.log))) return new Response(null, { status: 503 });
  const env = c.env;
  const now = Math.floor(Date.now() / 1000);
  const on = typeof quotaLimits(env) !== "string" && !!env.FILE_ACCT_SECRET && storeDeps.store(env) !== null && capLeft(now) === 0;
  let last: number | null = null;
  try {
    last = await env.FILE_QUOTA.get(env.FILE_QUOTA.idFromName(SWEEP_OBJECT)).lastSweep();
  } catch (e) {
    c.log.setException(e);
  }
  return json(200, { status: "ok", files: on ? "on" : "paused", last_sweep: last });
}
