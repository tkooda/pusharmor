// GET /health: one trivial database read. 200 "ok", or an empty 503 when the read fails.
import type { Ctx } from "../context";
import type { Env } from "../env";
import type { Log } from "../log";

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
  return new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } });
}
