// GET /v1/health: no auth, one trivial D1 read, 200 "ok" or an empty 503.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handle } from "../src/index";
import { testEnv } from "./helpers";
import type { Env } from "../src/env";

let n = 0;
async function health(env: Env, method = "GET"): Promise<Response> {
  const req = new Request("https://api.pusharmor.com/v1/health", { method, headers: { "CF-Connecting-IP": `192.0.2.${(++n % 250) + 1}` } });
  const ctx = createExecutionContext();
  const res = await handle(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("GET /v1/health", () => {
  it("returns 200 ok with no-store and no auth", async () => {
    const res = await health(await testEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("PA-Epoch")).toMatch(/^[0-9]{10}$/);
  });

  it("returns an empty 503 when the database read throws", async () => {
    const db = { prepare: () => { throw new Error("d1 down secret-detail"); } } as unknown as D1Database;
    const res = await health(await testEnv({ DB: db }));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("other methods get 405", async () => {
    expect((await health(await testEnv(), "POST")).status).toBe(405);
  });
});
