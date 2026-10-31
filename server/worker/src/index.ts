// PushArmor Worker entry: fetch() pipeline + router + top-level catch; scheduled().
import type { Env } from "./env";
import type { Ctx } from "./context";
import { ApiError } from "./errors";
import { errorResponse, finish, json, preflight } from "./http";
import { Log, sampleRate } from "./log";
import { readBody } from "./pipeline/body";
import { checkMinClient, parseClient } from "./pipeline/client";
import { enforce, ipKey } from "./pipeline/limits";
import { route } from "./router";
import { scheduled } from "./scheduled";

export async function handle(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const log = new Log();
  let path = "";
  let res: Response;
  try {
    const url = new URL(req.url);
    path = url.pathname;
    const colo = (req as { cf?: { colo?: unknown } }).cf?.colo;
    if (typeof colo === "string") log.colo = colo;
    const ch = req.headers.get("PA-Client");
    const client = parseClient(ch);
    if (ch !== null) log.client = client ? ch : "invalid";
    // 1. RL_IP (the IP is only a key, never logged).
    await enforce(env, "RL_IP", ipKey(req.headers.get("CF-Connecting-IP") ?? ""), log);
    // 2. Route match.
    const m = route(req.method, path);
    log.route = m.template;
    if (m.handler === "preflight") {
      res = preflight();
    } else {
      // 3. Client version floor (PA_MIN_CLIENT).
      checkMinClient(client, env.PA_MIN_CLIENT);
      // 4. Capped body read; raw bytes kept for PA-Sig.
      const body = await readBody(req);
      log.body_bytes = body.length;
      const c: Ctx = { env, exec, req, method: req.method, path, params: m.params, body, log };
      res = await m.handler(c);
    }
  } catch (e) {
    if (e instanceof ApiError) {
      res = errorResponse(e);
      log.error = e.word;
      const b = e.extra?._binding;
      if (typeof b === "string") log.rl = b;
    } else {
      log.setException(e);
      log.error = "unavailable";
      res = json(503, { error: "unavailable" });
    }
  }
  res = finish(res, path, req.headers.get("Origin"), env.PA_WEB_ORIGINS);
  log.status = res.status;
  log.emit(sampleRate(env.PA_LOG_SAMPLE));
  return res;
}

export default {
  fetch: handle,
  scheduled: (controller: ScheduledController, env: Env, exec: ExecutionContext) => {
    exec.waitUntil(scheduled(controller, env));
  },
} satisfies ExportedHandler<Env>;
