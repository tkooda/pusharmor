import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { call, captured, countingLimit, initP256, message, newPeer, randomEmail, testEnv, keys, ticketFor } from "./helpers";
import { ipKey } from "../src/pipeline/limits";
import type { Env, RateLimit } from "../src/env";
import { CRON_HOURLY, CRON_MONTHLY } from "../src/crons";
import wranglerText from "../wrangler.jsonc?raw";
import limitsSrc from "../src/pipeline/limits.ts?raw";

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

  it("RL_IP: 100 per 60 s per IP", async () => {
    let last = 0;
    const e = await testEnv({ RL_IP: countingLimit(100) });
    for (let i = 0; i < 101; i++) last = (await call("GET", "/v1/nope", undefined, { ip: "198.51.100.7", env: e })).status;
    expect(last).toBe(429);
  });

  it("RL_PEER (I227 06): 60 signed calls pass, the 61st -> 429", async () => {
    const p = await newPeer(randomEmail());
    const e = await testEnv({ RL_PEER: countingLimit(60), RL_ACCT: countingLimit(1000) });
    for (let i = 0; i < 60; i++) expect((await call("GET", "/v1/peers", undefined, { peer: p, env: e })).status).toBe(200);
    const r = await call("GET", "/v1/peers", undefined, { peer: p, env: e });
    expect(r.status).toBe(429);
    expect(r.res.headers.get("Retry-After")).toBe("60");
  });

  it("RL_ACCT (I448): one counter per account across its peers, sends and register churn", async () => {
    const email = randomEmail();
    const a = await newPeer(email);
    const b = await newPeer(email);
    const rl = countingLimit(3);
    const e = await testEnv({ RL_ACCT: rl } as Partial<Env>);
    expect((await call("GET", "/v1/peers", undefined, { peer: a, env: e })).status).toBe(200);
    expect((await call("POST", "/v1/send", { v: 1, m: { [b.id]: message() } }, { peer: a, env: e })).status).toBe(200);
    expect((await call("POST", "/v1/peers/" + b.id + "/pause", { m: {} }, { peer: b, env: e })).status).toBe(200);
    const r = await call("GET", "/v1/peers", undefined, { peer: a, env: e });
    expect(r.status).toBe(429);
    expect(r.res.headers.get("Retry-After")).toBe("60");
    // Register (new peer or re-register) counts against the same account key.
    const k = await keys();
    const reg = await call("POST", "/v1/peers", { ticket: await ticketFor(email, k.signPub, "register"), sign_pub: k.signPub, enc_pub: k.encPub, platform: "android", push: null }, { sign: k.sign, env: e });
    expect(reg.status).toBe(429);
    expect(new Set(rl.seen)).toEqual(new Set(["acct:" + a.acct]));
    // Another account is not affected.
    const c = await newPeer(randomEmail());
    expect((await call("GET", "/v1/peers", undefined, { peer: c, env: e })).status).toBe(200);
  });

  it("RL_ACCT (M1): unsigned or badly signed calls with a valid PA-ID do not charge the account", async () => {
    const email = randomEmail();
    const a = await newPeer(email);
    const b = await newPeer(email);
    const rl = countingLimit(3);
    const e = await testEnv({ RL_ACCT: rl } as Partial<Env>);
    const other = await keys();
    for (let i = 0; i < 10; i++) {
      expect((await call("GET", "/v1/peers", undefined, { peer: a, env: e, noSig: true })).status).toBe(401);
      expect((await call("GET", "/v1/peers", undefined, { peer: a, sign: other.sign, env: e })).status).toBe(401);
    }
    expect(rl.seen.length).toBe(0);
    expect((await call("GET", "/v1/peers", undefined, { peer: b, env: e })).status).toBe(200);
    const k = await keys();
    const reg = await call("POST", "/v1/peers", { ticket: await ticketFor(email, k.signPub, "register"), sign_pub: k.signPub, enc_pub: k.encPub, platform: "android", push: null }, { sign: k.sign, env: e });
    expect(reg.status).toBe(200);
  });

  it("limit() throwing: open for RL_IP, RL_PEER and RL_ACCT, closed for RL_MAIL / RL_MAIL_ALL / RL_CODE", async () => {
    const p = await newPeer(randomEmail());
    const e = { ...(await testEnv()), RL_IP: throwing, RL_PEER: throwing, RL_ACCT: throwing } as Env;
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
    expect(cfg.vars.PA_PUSH_TTL_SECONDS).toBe("604800");
    expect(cfg.vars.PA_PUSH_PAIR_TTL_SECONDS).toBe("2419200");
  });
  it("rate limit bindings match the expected table and the Binding union", () => {
    const cfg = JSON.parse(wranglerText.replace(/^\s*\/\/.*$/gm, ""));
    const got = Object.fromEntries(cfg.ratelimits.map((r: { name: string; simple: { limit: number; period: number } }) => [r.name, [r.simple.limit, r.simple.period]]));
    expect(got).toEqual({
      RL_IP: [100, 60], RL_PEER: [60, 60], RL_MAIL: [2, 60], RL_MAIL_ALL: [100, 60],
      RL_CODE: [5, 60], RL_PAIR: [1, 60], RL_PROBE: [2, 60], RL_CODE_ALL: [30, 60], RL_ACCT: [120, 60],
    });
    const union = /export type Binding = ([^;]+);/.exec(limitsSrc)![1].match(/RL_[A-Z_]+/g)!;
    expect([...union].sort()).toEqual(Object.keys(got).sort());
    for (const b of union) expect(typeof (env as unknown as Record<string, RateLimit>)[b]?.limit, b).toBe("function");
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
    expect(Object.keys(o).every((x) => ["ts", "route", "status", "ms", "error", "colo", "account", "peer", "body_bytes", "recipients", "rows_read", "rows_written", "rl", "rl-error", "gone_write", "endpoint_reject", "exception", "sample"].includes(x))).toBe(true);
    expect(lines[0]).not.toContain(email);
    expect(lines[0]).not.toContain(k.signPub);
  });

  it("log sampling (I448): plain successes and 429s sampled, other errors always logged", async () => {
    const off = await testEnv({ PA_LOG_SAMPLE: "0" } as Partial<Env>);
    const k = await keys();
    let before = captured.length;
    const ok = await call("POST", "/v1/peers", { ticket: await ticketFor(randomEmail(), k.signPub, "register"), sign_pub: k.signPub, enc_pub: k.encPub, platform: "android", push: null }, { sign: k.sign, env: off });
    expect(ok.status).toBe(200);
    expect(captured.slice(before)).toHaveLength(0);
    before = captured.length;
    expect((await call("POST", "/v1/peers", { x: 1 }, { env: off })).status).toBe(400);
    expect(captured.slice(before)).toHaveLength(1);
    before = captured.length;
    const limited = await call("GET", "/v1/peers", undefined, { env: { ...off, RL_IP: countingLimit(0) } });
    expect(limited.status).toBe(429);
    expect(captured.slice(before)).toHaveLength(0);
    // Sampled lines carry the scale factor; a bad rate logs everything.
    const all = await testEnv({ PA_LOG_SAMPLE: "junk" } as Partial<Env>);
    before = captured.length;
    expect((await call("GET", "/v1/peers", undefined, { env: { ...all, RL_IP: countingLimit(0) } })).status).toBe(429);
    expect(captured.slice(before)).toHaveLength(1);
    const half = await testEnv({ PA_LOG_SAMPLE: "0.5" } as Partial<Env>);
    before = captured.length;
    for (let i = 0; i < 40; i++) await call("GET", "/v1/peers", undefined, { env: { ...half, RL_IP: countingLimit(0) } });
    const lines = captured.slice(before).map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(40);
    for (const o of lines) expect(o.sample).toBe(2);
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
