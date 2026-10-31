// GET /health: one trivial database read. 200 "ok", or an empty 503 when the read fails.
import type { Ctx } from "../context";

export async function health(c: Ctx): Promise<Response> {
  try {
    await c.env.DB.prepare("SELECT 1").first();
  } catch (e) {
    c.log.setException(e);
    return new Response(null, { status: 503 });
  }
  return new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } });
}
