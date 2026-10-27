// Turnstile siteverify. Fail closed: any error -> 403 "turnstile failed".
import type { Env } from "../env";
import { ApiError } from "../errors";
import { deps } from "../push/deps";

export async function verifyTurnstile(env: Env, response: string, ip: string | null): Promise<void> {
  const fail = new ApiError(403, "turnstile failed");
  const form = new URLSearchParams({ secret: env.CLOUDFLARE_TURNSTILE_SECRET, response });
  if (ip) form.set("remoteip", ip);
  let j: { success?: unknown; hostname?: unknown; action?: unknown };
  try {
    const res = await deps.fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      throw fail;
    }
    j = await res.json();
  } catch {
    throw fail;
  }
  if (j.success !== true || j.hostname !== env.CLOUDFLARE_TURNSTILE_HOSTNAME || j.action !== env.CLOUDFLARE_TURNSTILE_ACTION) throw fail;
}
