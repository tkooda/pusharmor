import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Log, ipPrefix, logLevel, testing } from "../src/log";

let out: Record<string, unknown>[];
let t: number;
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

beforeEach(() => {
  out = [];
  t = T0;
  testing.reset();
  testing.setClock(() => t);
  vi.spyOn(console, "log").mockImplementation((s: string) => { out.push(JSON.parse(s)); });
});
afterEach(() => {
  vi.restoreAllMocks();
  testing.reset();
});

function send(status: number, o: { route?: string; ip?: string; account?: string; rate?: number; level?: "error" | "warn" | "info" | "debug" } = {}): void {
  const l = new Log();
  l.route = o.route ?? "GET /v1/peers";
  l.status = status;
  if (o.ip) l.setIp(o.ip);
  if (o.account) l.account = o.account;
  l.emit(o.rate ?? 0, o.level);
}

describe("refusal logging", () => {
  it("401, 403, 429 are logged with sampling off; other 4xx and 2xx are not", () => {
    for (const s of [401, 403, 429]) send(s);
    send(400);
    send(404);
    send(200);
    expect(out.map((o) => o.status)).toEqual([401, 403, 429]);
  });

  it("the normal line never carries an IP", () => {
    const l = new Log();
    l.route = "x";
    l.status = 401;
    l.setIp("203.0.113.9");
    expect(l.line()).not.toContain("203.0.113");
  });

  it("the 11th refusal in a window is suppressed", () => {
    for (let i = 0; i < 12; i++) send(401);
    expect(out).toHaveLength(10);
  });

  it("the suppressed line comes on the next call after rollover", () => {
    for (let i = 0; i < 10; i++) send(401);
    send(401, { route: "A", ip: "203.0.113.5", account: "a1" });
    send(403, { route: "A", ip: "203.0.113.77", account: "a1" });
    send(429, { route: "B", ip: "2001:db8:1:2:3::9", account: "a2" });
    send(429, { route: "B", ip: "2001:db8:1::1", account: "a3" });
    send(401, { route: "B", ip: "198.51.100.1", account: "a4" });
    send(401, { route: "B", ip: "192.0.2.1" });
    expect(out).toHaveLength(10);
    t = T0 + 59_999;
    send(200);
    expect(out).toHaveLength(10);
    t = T0 + 60_000;
    send(200);
    expect(out).toHaveLength(11);
    const s = out[10];
    expect(s.route).toBe("suppressed");
    expect(s.suppressed).toBe(6);
    expect(s.window_start).toBe("2026-01-01T00:00:00.000Z");
    expect(s.window_end).toBe("2026-01-01T00:01:00.000Z");
    expect(s.by_status).toEqual({ 401: 3, 403: 1, 429: 2 });
    expect(s.by_route).toEqual({ A: 2, B: 4 });
    expect(Object.keys(s.ip_prefixes as object)).toHaveLength(3);
    expect((s.ip_prefixes as Record<string, number>)["203.0.113.0/24"]).toBe(2);
    expect((s.ip_prefixes as Record<string, number>)["2001:db8:1::/48"]).toBe(2);
    expect(s.accounts).toEqual({ a1: 2, a2: 1, a3: 1 });
    // A new window starts: refusals are logged again, no second summary.
    send(401);
    expect(out).toHaveLength(12);
    t += 60_000;
    send(200);
    expect(out).toHaveLength(12);
  });

  it("the accounts field is omitted when no refusal had an account", () => {
    for (let i = 0; i < 11; i++) send(401, { ip: "203.0.113.5" });
    t += 60_000;
    send(200);
    const s = out[out.length - 1];
    expect(s.suppressed).toBe(1);
    expect("accounts" in s).toBe(false);
    expect(s.ip_prefixes).toEqual({ "203.0.113.0/24": 1 });
  });

  it("ip prefix and account counts keep at most 1000 keys each; the rest count as other", () => {
    for (let i = 0; i < 10; i++) send(401);
    for (let i = 0; i < 1000; i++) send(401, { ip: `10.${i >> 8}.${i & 255}.1`, account: `acct${i}` });
    for (let i = 0; i < 5; i++) send(401, { ip: `10.200.${i}.1`, account: `new${i}` });
    send(401, { ip: "10.0.0.9", account: "acct0" });
    t += 60_000;
    send(200);
    const s = out[out.length - 1];
    expect(s.suppressed).toBe(1006);
    expect(s.ip_prefixes).toEqual({ other: 5, "10.0.0.0/24": 2, "10.0.1.0/24": 1 });
    expect(s.accounts).toEqual({ other: 5, acct0: 2, acct1: 1 });
  });

  it("ip prefixes", () => {
    expect(ipPrefix("203.0.113.9")).toBe("203.0.113.0/24");
    expect(ipPrefix("2001:0db8:0001:ffff::1")).toBe("2001:db8:1::/48");
    expect(ipPrefix("::1")).toBe("0:0:0::/48");
    expect(ipPrefix("junk")).toBeUndefined();
  });
});

describe("LOG_LEVEL", () => {
  const fault = (level: "error" | "warn" | "info" | "debug") => send(500, { level });
  it("unknown values mean info", () => {
    expect(logLevel(undefined)).toBe("info");
    expect(logLevel("loud")).toBe("info");
    expect(logLevel("debug")).toBe("debug");
  });
  it("error: faults only", () => {
    fault("error");
    send(401, { level: "error" });
    send(200, { level: "error", rate: 1 });
    expect(out.map((o) => o.status)).toEqual([500]);
  });
  it("warn: faults and refusals, no sampling", () => {
    fault("warn");
    send(401, { level: "warn" });
    send(200, { level: "warn", rate: 1 });
    send(404, { level: "warn", rate: 1 });
    expect(out.map((o) => o.status)).toEqual([500, 401]);
  });
  it("info: sampled by rate", () => {
    send(200, { level: "info", rate: 0 });
    expect(out).toHaveLength(0);
    send(200, { level: "info", rate: 1 });
    expect(out).toHaveLength(1);
    send(401, { level: "info", rate: 0 });
    expect(out).toHaveLength(2);
  });
  it("debug: every line, no refusal limit", () => {
    for (let i = 0; i < 15; i++) send(401, { level: "debug" });
    send(200, { level: "debug", rate: 0 });
    expect(out).toHaveLength(16);
  });
});
