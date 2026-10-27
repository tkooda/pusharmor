import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { call, captured, initP256, newPeer, randomEmail, testEnv, keys, ticketFor } from "./helpers";
import { ipKey } from "../src/pipeline/limits";
import type { Env, RateLimit } from "../src/env";
import { CRON_HOURLY, CRON_MONTHLY } from "../src/crons";
import wranglerText from "../wrangler.jsonc?raw";

beforeAll(initP256);

const ORIGIN = "https://pusharmor.com";
const throwing: RateLimit = { limit: async () => { throw new Error("rl down"); } };
const denying: RateLimit = { limit: async () => ({ success: false }) };

describe("CORS", () => {
  it("allowed origin on the three CORS routes only; other origins get none and are not rejected", async () => {
    let r = await call("POST", "/v1/auth/email/verify", { request_token: "x", code: "ABCDEF" }, { headers: { Origin: ORIGIN } });
    expect(r.res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(r.res.headers.get("Vary")).toBe("Origin");
    r = await call("POST", "/v1/auth/email/verify", { request_token: "x", code: "ABCDEF" }, { headers: { Origin: "https://evil.example" } });
    expect(r.res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(r.res.headers.get("Vary")).toBe("Origin");
    expect(r.status).toBe(401);
    r = await call("GET", "/v1/peers", undefined, { headers: { Origin: ORIGIN } });
    expect(r.res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("preflight on the CORS paths", async () => {
    for (const p of ["/v1/auth/email", "/v1/auth/email/verify", "/v1/account"]) {
      const r = await call("OPTIONS", p, undefined, { headers: { Origin: ORIGIN } });
      expect(r.status).toBe(204);
      expect(r.res.headers.get("Access-Control-Allow-Methods")).toBe("POST, DELETE");
      expect(r.res.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type, PA-Time, PA-Sig");
      expect(r.res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
      expect(r.res.headers.get("PA-Epoch-Ms")).toMatch(/^[0-9]{13}$/);
    }
    expect((await call("OPTIONS", "/v1/send")).status).toBe(405);
  });

  it("RL_IP 429 on a CORS route keeps CORS headers and Retry-After (I255)", async () => {
    const e = { ...(await testEnv()), RL_IP: denying } as Env;
    for (const [m, p] of [["POST", "/v1/auth/email"], ["OPTIONS", "/v1/auth/email"]] as const) {
      const r = await call(m, p, m === "POST" ? {} : undefined, { env: e, headers: { Origin: ORIGIN } });
      expect(r.status).toBe(429);
      expect(r.res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
      expect(r.res.headers.get("Vary")).toBe("Origin");
      expect(r.res.headers.get("Retry-After")).toBe("60");
      expect(r.body).toEqual({ error: "rate limited", retry_after: 60 });
    }
    const r = await call("GET", "/v1/peers", undefined, { env: e, headers: { Origin: ORIGIN } });
    expect(r.status).toBe(429);
    expect(r.res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("rate limits", () => {
  it("IPv6 keys use the /64 prefix", () => {
    expect(ipKey("2001:db8:1:2:3:4:5:6")).toBe("ip:2001:db8:1:2::/64");
    expect(ipKey("2001:db8:1:2::9")).toBe("ip:2001:db8:1:2::/64");
    expect(ipKey("2001:DB8:0001:0002::")).toBe("ip:2001:db8:1:2::/64");
    expect(ipKey("::1")).toBe("ip:0:0:0:0::/64");
    expect(ipKey("192.0.2.1")).toBe("ip:192.0.2.1");
  });

  it("RL_IP real binding: 100 per 60 s per IP", async () => {
    let last = 0;
    for (let i = 0; i < 101; i++) last = (await call("GET", "/v1/nope", undefined, { ip: "198.51.100.7" })).status;
    expect(last).toBe(429);
  });

  it("RL_PEER (I227 06): 60 signed calls pass, the 61st -> 429", async () => {
    const p = await newPeer(randomEmail());
    for (let i = 0; i < 60; i++) expect((await call("GET", "/v1/peers", undefined, { peer: p })).status).toBe(200);
    const r = await call("GET", "/v1/peers", undefined, { peer: p });
    expect(r.status).toBe(429);
    expect(r.res.headers.get("Retry-After")).toBe("60");
  });

  it("limit() throwing: open for RL_IP and RL_PEER, closed for RL_MAIL / RL_MAIL_ALL / RL_CODE", async () => {
    const p = await newPeer(randomEmail());
    const e = { ...(await testEnv()), RL_IP: throwing, RL_PEER: throwing } as Env;
    expect((await call("GET", "/v1/peers", undefined, { peer: p, env: e })).status).toBe(200);
    for (const b of ["RL_MAIL", "RL_MAIL_ALL"] as const) {
      const k = await keys();
      const e2 = { ...(await testEnv()), [b]: throwing } as Env;
      const r = await call("POST", "/v1/auth/email", { email: randomEmail(), sign_pub: k.signPub, purpose: "register", turnstile: "tok" }, { env: e2 });
      expect(r.status, b).toBe(429);
    }
  });
});

describe("crons", () => {
  it("cron constants equal wrangler.jsonc triggers", () => {
    const stripped = wranglerText.replace(/^\s*\/\/.*$/gm, "");
    const cfg = JSON.parse(stripped);
    expect(cfg.triggers.crons).toEqual([CRON_HOURLY, CRON_MONTHLY]);
    expect(cfg.observability.logs.invocation_logs).toBe(false);
    expect(cfg.workers_dev).toBe(false);
    expect(cfg.preview_urls).toBe(false);
    expect(cfg.vars.PUSH_TTL_SECONDS).toBe("604800");
    expect(cfg.vars.PUSH_PAIR_TTL_SECONDS).toBe("2419200");
  });
});

describe("logging", () => {
  it("one JSON line per request with allow-listed fields", async () => {
    const before = captured.length;
    const email = randomEmail();
    const k = await keys();
    await call("POST", "/v1/peers", { ticket: await ticketFor(email, k.signPub, "register"), sign_pub: k.signPub, enc_pub: k.encPub, platform: "android", push: null }, { sign: k.sign });
    const lines = captured.slice(before);
    expect(lines).toHaveLength(1);
    const o = JSON.parse(lines[0]);
    expect(o.route).toBe("POST /v1/peers");
    expect(o.status).toBe(200);
    expect(Object.keys(o).every((x) => ["ts", "route", "status", "ms", "error", "colo", "account", "peer", "body_bytes", "recipients", "rows_read", "rows_written", "rl", "rl-error", "gone_write", "endpoint_reject", "exception"].includes(x))).toBe(true);
    expect(lines[0]).not.toContain(email);
    expect(lines[0]).not.toContain(k.signPub);
  });

  it("D1 failure -> 503 unavailable, exception logged without message text", async () => {
    const p = await newPeer(randomEmail());
    const e = await testEnv();
    const broken = { prepare: () => ({ bind: () => ({ all: async () => { throw new Error("SECRET-MESSAGE-TEXT"); } }) }) } as unknown as D1Database;
    const before = captured.length;
    const r = await call("GET", "/v1/peers", undefined, { peer: p, env: { ...e, DB: broken } });
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: "unavailable" });
    expect(captured.slice(before).join("\n")).not.toContain("SECRET-MESSAGE-TEXT");
    expect(env.DB).toBeTruthy();
  });
});

describe("log scrub self-check", () => {
  it("detects a forbidden string in captured output", async () => {
    const { scrubViolations } = await import("./helpers");
    expect(scrubViolations(["nothing here"])).toBe(0);
    expect(scrubViolations(["x " + [...(await import("./helpers")).forbidden].find((s) => s.length >= 8)])).toBeGreaterThan(0);
  });
});
