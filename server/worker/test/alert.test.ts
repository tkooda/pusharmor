import { beforeAll, describe, expect, it } from "vitest";
import { createScheduledController } from "cloudflare:test";
import type { Env } from "../src/env";
import { Log } from "../src/log";
import { scheduled } from "../src/scheduled";
import { call, captured, initP256, keys, message, newPeer, onVendor, randomEmail, setAllow, testEnv } from "./helpers";

beforeAll(initP256);

// Lines logged while f runs, parsed.
async function lines(f: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  const before = captured.length;
  await f();
  return captured.slice(before).map((l) => JSON.parse(l));
}
const unsampled = () => testEnv({ PA_LOG_SAMPLE: "0" } as Partial<Env>);
const throwing = { limit: async () => { throw new Error("rl down"); } } as unknown as RateLimit;

describe("log alert field", () => {
  it("one kind per line in priority order; none for 4xx or device-side failures", () => {
    const l = () => {
      const x = new Log();
      x.route = "GET /v1/peers";
      x.status = 200;
      return x;
    };
    let x = l();
    expect(x.alert()).toBeUndefined();
    expect(JSON.parse(x.line()).alert).toBeUndefined();
    x.status = 401;
    x.error = "unknown peer";
    expect(x.alert()).toBeUndefined();
    x = l();
    x.recipients.push({ id: "a", class: "send", bytes: 1, result: "gone", vendor: "fcm-404", retry: false });
    expect(x.alert()).toBeUndefined();
    x = l();
    x.rl_error.push("RL_PEER");
    expect(x.alert()).toBe("ratelimit");
    x.pushAuth = true;
    expect(x.alert()).toBe("push-auth");
    x.gone_write = "failed";
    expect(x.alert()).toBe("db");
    x.status = 502;
    x.error = "email send failed";
    expect(x.alert()).toBe("mail");
    expect(JSON.parse(x.line()).alert).toBe("mail");
    expect(x.notable()).toBe(true);
    x = l();
    x.route = "cron monthly";
    x.status = 0;
    expect(x.alert()).toBeUndefined();
    x.setException(new Error("d1"));
    expect(x.alert()).toBe("cron");
  });

  it("mail: SES failure", async () => {
    onVendor((r) => r.url.includes("amazonaws.com"), () => new Response("{}", { status: 400 }));
    const k = await keys();
    const e = await unsampled();
    const ls = await lines(() => call("POST", "/v1/auth/email", { email: randomEmail(), sign_pub: k.signPub, purpose: "register", turnstile: "t" }, { env: e }));
    expect(ls).toHaveLength(1);
    expect(ls[0].alert).toBe("mail");
  });

  it("db: D1 error -> 503", async () => {
    const p = await newPeer(randomEmail());
    const broken = { prepare: () => ({ bind: () => ({ all: async () => { throw new Error("down"); } }) }) } as unknown as D1Database;
    const e = await unsampled();
    const ls = await lines(() => call("GET", "/v1/peers", undefined, { peer: p, env: { ...e, DB: broken } }));
    expect(ls).toHaveLength(1);
    expect(ls[0].alert).toBe("db");
  });

  it("push-auth: vendor refuses our credentials; a device-side failure has no alert", async () => {
    const email = randomEmail();
    const me = await newPeer(email);
    const x = await newPeer(email, "android");
    await setAllow(x, [me.id]);
    const e = await unsampled();
    const send = () => call("POST", "/v1/send", { v: 1, m: { [x.id]: message(512) } }, { peer: me, env: e });
    onVendor((r) => r.url.includes("/messages:send"), () => Response.json({ error: { status: "PERMISSION_DENIED" } }, { status: 403 }));
    let ls = await lines(send);
    expect(ls).toHaveLength(1);
    expect(ls[0].alert).toBe("push-auth");
    onVendor((r) => r.url.includes("/messages:send"), () => Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 }));
    ls = await lines(send);
    expect(ls).toHaveLength(1);
    expect(ls[0].alert).toBeUndefined();
  });

  it("ratelimit: a throwing binding is logged even at sample rate 0", async () => {
    const p = await newPeer(randomEmail());
    const e = await unsampled();
    const ls = await lines(() => call("GET", "/v1/peers", undefined, { peer: p, env: { ...e, RL_PEER: throwing } }));
    expect(ls).toHaveLength(1);
    expect(ls[0].status).toBe(200);
    expect(ls[0].alert).toBe("ratelimit");
  });

  it("cron: a failed scheduled job", async () => {
    const ls = await lines(async () => scheduled(createScheduledController({ cron: "5 5 5 5 5" }), await testEnv()));
    expect(ls.some((o) => o.alert === "cron")).toBe(true);
  });

  it("4xx: no alert", async () => {
    const ls = await lines(() => call("POST", "/v1/peers", { x: 1 }));
    expect(ls).toHaveLength(1);
    expect(ls[0].status).toBe(400);
    expect(ls[0].alert).toBeUndefined();
  });
});
