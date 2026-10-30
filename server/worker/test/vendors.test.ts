import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { b64urlDecode } from "../src/codec/b64url";
import { utf8 } from "../src/crypto/hash";
import { BUDGET_MS, fanout, SUBREQUEST_WORST_CASE, type Target } from "../src/push/fanout";
import { apnsPayload } from "../src/push/apns";
import { deps } from "../src/push/deps";
import { mintFcmToken } from "../src/push/fcm";
import { getToken, MAX_TOKENS, peekToken } from "../src/push/tokencache";
import { Log } from "../src/log";
import { authAlerts, HEALTH_FLUSH_MS, isAuthFailure, recordHealth } from "../src/push/results";
import { healthCheck } from "../src/scheduled";
import { call, decodeJwt, initP256, message, mock, newPeer, onVendor, pushFor, randomEmail, row, setAllow, testEnv, vendorKeys, vendorRequests, type Peer } from "./helpers";
import { VENDOR_ROWS } from "./vendor-fixtures";

beforeAll(initP256);

const platformOf = { fcm: "android", apns: "iphone", wp: "chrome", up: "unifiedpush" } as const;

async function target(v: "fcm" | "apns" | "wp" | "up", cls: Target["cls"] = "send", m = message(512)): Promise<Target> {
  const push = pushFor(platformOf[v] === "unifiedpush" ? "android" : platformOf[v], v === "up" ? "unifiedpush" : undefined);
  if (v === "up") (push as Record<string, unknown>).verified_at = 1;
  const pushType = v === "fcm" ? 1 : v === "apns" ? 2 : v === "up" ? 6 : 3;
  return { id: "id-" + v, pushType, push: JSON.stringify(push), m, cls };
}

const isSend = (v: string) => (r: { url: string }) =>
  v === "fcm" ? r.url.includes("/messages:send") : v === "apns" ? r.url.includes("/3/device/") : v === "wp" ? r.url.startsWith("https://fcm.googleapis.com/fcm/send/") : r.url.startsWith("https://up.example.org/");

describe("result mapping, row by row (vendor-wrap 6)", () => {
  for (const row of VENDOR_ROWS) {
    it(row.name, async () => {
      const e = await testEnv();
      onVendor(isSend(row.vendor), () => new Response(row.body ?? null, { status: row.status, headers: row.headers }), 99);
      const t = await target(row.vendor);
      const log = new Log();
      const out = await fanout(e, [t], log);
      expect(out.results[t.id]).toBe(row.result);
      expect(mock.requests.filter(isSend(row.vendor))).toHaveLength(row.attempts);
      expect(out.gone.length).toBe(row.result === "gone" ? 1 : 0);
      for (const r of mock.requests) expect(r.redirect).toBe("manual");
    });
  }

  it("apns 403 InvalidProviderToken with a JWT >= 20 min old: one remint and retry", async () => {
    const e = await testEnv();
    onVendor(isSend("apns"), () => new Response('{"reason":"InvalidProviderToken"}', { status: 403 }), 1);
    const t = await target("apns");
    await fanout(e, [t], new Log()); // mints at clock 0, gets 403 (fresh: no remint) -- consumes the script
    mock.clock += 21 * 60 * 1000;
    onVendor(isSend("apns"), () => new Response('{"reason":"InvalidProviderToken"}', { status: 403 }), 1);
    const before = mock.requests.filter(isSend("apns")).length;
    const out = await fanout(e, [t], new Log());
    expect(out.results[t.id]).toBe("sent");
    const sends = mock.requests.filter(isSend("apns")).slice(before);
    expect(sends).toHaveLength(2);
    expect(sends[0].headers.authorization).not.toBe(sends[1].headers.authorization);
  });

  it("fcm 401 within 60 s of a mint: retry once with no second OAuth exchange (I304)", async () => {
    const e = await testEnv();
    const t = await target("fcm");
    onVendor(isSend("fcm"), () => new Response(null, { status: 401 }), 1);
    expect((await fanout(e, [t], new Log())).results[t.id]).toBe("sent");
    expect(vendorRequests("oauth2.googleapis.com")).toHaveLength(1);
    mock.clock += 61 * 1000;
    onVendor(isSend("fcm"), () => new Response(null, { status: 401 }), 1);
    expect((await fanout(e, [t], new Log())).results[t.id]).toBe("sent");
    expect(vendorRequests("oauth2.googleapis.com")).toHaveLength(2);
  });

  it("token cache is bounded; build failures are not labeled auth (I304)", async () => {
    for (let i = 0; i < 300; i++) await getToken("vapid:https://h" + i + ".example", async () => ({ value: "v", mintedAt: 0, useUntil: deps.now() + 3600000 }), deps.now());
    expect(peekToken("vapid:https://h0.example")).toBeUndefined();
    expect(peekToken("vapid:https://h299.example")).toBeDefined();
    const e = await testEnv();
    const t = await target("wp");
    t.push = JSON.stringify({ ...JSON.parse(t.push), p256dh: "!" });
    expect((await fanout(e, [t], new Log())).results[t.id]).toBe("failed:wp-build");
    const f = await target("fcm");
    onVendor((r) => r.url === "https://oauth2.googleapis.com/token", () => new Response(null, { status: 500 }), 1);
    expect((await fanout(e, [f], new Log())).results[f.id]).toBe("failed:fcm-auth");
  });

  it("network error -> failed:net after 3 retries; backoff 0.5, 1.5, 3 s", async () => {
    const e = await testEnv();
    onVendor(isSend("fcm"), () => {
      throw new TypeError("network");
    }, 99);
    const out = await fanout(e, [await target("fcm")], new Log());
    expect(out.results["id-fcm"]).toBe("failed:net");
    expect(mock.sleeps).toEqual([500, 1500, 3000]);
  });

  it("Retry-After honored when it fits the budget", async () => {
    const e = await testEnv();
    onVendor(isSend("wp"), () => new Response(null, { status: 429, headers: { "Retry-After": "2" } }), 1);
    const out = await fanout(e, [await target("wp")], new Log());
    expect(out.results["id-wp"]).toBe("sent");
    expect(mock.sleeps).toEqual([2000]);
  });

  it("8 s budget per recipient", async () => {
    const e = await testEnv();
    onVendor(isSend("wp"), () => {
      mock.clock += 2600;
      return new Response(null, { status: 503 });
    }, 99);
    const out = await fanout(e, [await target("wp")], new Log());
    expect(out.results["id-wp"]).toBe("failed:wp-503");
    expect(mock.clock).toBeLessThanOrEqual(BUDGET_MS + 2600);
  });

  it("9 recipients with 6 slow calls: recipients 7-9 still get their full attempt (I274)", async () => {
    const e = await testEnv();
    let open = 0;
    let maxOpen = 0;
    const gates: (() => void)[] = [];
    onVendor(isSend("wp"), async () => {
      open++;
      maxOpen = Math.max(maxOpen, open);
      await new Promise<void>((r) => gates.push(r));
      open--;
      return new Response(null, { status: 201 });
    }, 99);
    const targets = await Promise.all(Array.from({ length: 9 }, async (_, i) => ({ ...(await target("wp")), id: "r" + i })));
    const p = fanout(e, targets, new Log());
    for (let i = 0; i < 50 && gates.length < 6; i++) await new Promise((r) => setTimeout(r, 1));
    expect(gates.length).toBe(6);
    mock.clock += 7000; // slow first six: queued ones must not count this as their own time
    while (gates.length) {
      gates.shift()!();
      await new Promise((r) => setTimeout(r, 1));
    }
    for (let i = 0; i < 50 && gates.length < 3; i++) await new Promise((r) => setTimeout(r, 1));
    while (gates.length) gates.shift()!();
    const out = await p;
    expect(maxOpen).toBe(6);
    expect(Object.values(out.results).every((x) => x === "sent")).toBe(true);
  });

  it("subrequest worst case is 47", () => {
    expect(SUBREQUEST_WORST_CASE).toBe(47);
  });
});

describe("request shapes: TTL, priority, sizes, no ids in headers", () => {
  it("FCM: data {m}, ttl 604800s, HIGH; deny/pause NORMAL; size 3801 at M = 3800", async () => {
    const e = await testEnv();
    for (const cls of ["send", "approve", "peerchg", "deny", "pause"] as const) {
      const m = message(3800);
      await fanout(e, [await target("fcm", cls, m)], new Log());
      const req = mock.requests.filter(isSend("fcm")).pop()!;
      expect(req.url).toBe("https://fcm.googleapis.com/v1/projects/test-project/messages:send");
      const body = JSON.parse(new TextDecoder().decode(req.body));
      expect(body.message.data).toEqual({ m });
      expect(body.message.android.ttl).toBe("604800s");
      expect(body.message.android.priority).toBe(cls === "deny" || cls === "pause" ? "NORMAL" : "HIGH");
      expect(Object.keys(body.message).sort()).toEqual(["android", "data", "token"]);
      expect("m".length + m.length).toBe(3801);
      expect(req.headers.authorization).toBe("Bearer ya29.test-access-token");
    }
  });

  it("FCM OAuth JWT claims; single-flight mint", async () => {
    const e = await testEnv();
    await Promise.all([mintFcmToken(e), mintFcmToken(e), mintFcmToken(e)]);
    const mints = vendorRequests("oauth2.googleapis.com");
    expect(mints).toHaveLength(1);
    const form = new URLSearchParams(new TextDecoder().decode(mints[0].body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const jwt = decodeJwt(form.get("assertion")!);
    expect(jwt.header).toEqual({ alg: "RS256", typ: "JWT", kid: "test-fcm-kid" });
    expect(jwt.claims.scope).toBe("https://www.googleapis.com/auth/firebase.messaging");
    expect(jwt.claims.aud).toBe("https://oauth2.googleapis.com/token");
    expect((jwt.claims.exp as number) - (jwt.claims.iat as number)).toBe(3600);
  });

  it("APNs: headers, expiration now + 604800, payload 3897 bytes at M = 3800, JWT verifies; sandbox host", async () => {
    const e = await testEnv();
    const k = await vendorKeys();
    const m = message(3800);
    const t = await target("apns", "send", m);
    await fanout(e, [t], new Log());
    const req = mock.requests.filter(isSend("apns")).pop()!;
    expect(req.url).toBe("https://api.push.apple.com/3/device/" + JSON.parse(t.push).token);
    expect(req.headers["apns-push-type"]).toBe("alert");
    expect(req.headers["apns-topic"]).toBe("com.example.pusharmor");
    expect(req.headers["apns-priority"]).toBe("10");
    expect(req.headers["apns-collapse-id"]).toBeUndefined();
    const ttl = Number(req.headers["apns-expiration"]) - Math.floor(Date.now() / 1000);
    expect(ttl).toBeGreaterThan(604800 - 3);
    expect(ttl).toBeLessThanOrEqual(604800);
    expect(req.body.length).toBe(3897);
    expect(new TextDecoder().decode(req.body)).toBe(apnsPayload(m));
    const jwt = req.headers.authorization.slice("bearer ".length);
    const [h, c, s] = jwt.split(".");
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k.apnsPublic, b64urlDecode(s)!, utf8(h + "." + c))).toBe(true);
    expect(decodeJwt(jwt).header).toEqual({ alg: "ES256", kid: "TESTAPNSKID" });
    expect(decodeJwt(jwt).claims.iss).toBe("TESTTEAMID");
    await fanout(e, [{ ...t, pushType: 5 }], new Log());
    expect(mock.requests.filter(isSend("apns")).pop()!.url.startsWith("https://api.sandbox.push.apple.com/3/device/")).toBe(true);
  });

  it("Web Push: VAPID verifies, TTL 604800, urgency, body 3903 bytes at M = 3800; pair TTL 2419200", async () => {
    const e = await testEnv();
    const k = await vendorKeys();
    for (const cls of ["send", "deny", "pause", "pair"] as const) {
      await fanout(e, [await target("wp", cls, message(3800))], new Log());
      const req = mock.requests.filter(isSend("wp")).pop()!;
      expect(req.headers.ttl).toBe(cls === "pair" ? "2419200" : "604800");
      expect(req.headers.urgency).toBe(cls === "deny" || cls === "pause" ? "normal" : "high");
      expect(req.headers["content-encoding"]).toBe("aes128gcm");
      expect(req.headers.topic).toBeUndefined();
      expect(req.body.length).toBe(3903);
      const auth = req.headers.authorization;
      const mm = /^vapid t=([^,]+), k=(.+)$/.exec(auth)!;
      expect(mm[2]).toBe(k.vapidPublicRaw);
      const [h, c, s] = mm[1].split(".");
      expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k.vapidPublic, b64urlDecode(s)!, utf8(h + "." + c))).toBe(true);
      const claims = decodeJwt(mm[1]).claims;
      expect(claims.aud).toBe("https://fcm.googleapis.com");
      expect(claims.sub).toBe("mailto:ops@example.com");
    }
  });

  it("TTL on all three vendors for class pair is 2419200", async () => {
    const e = await testEnv();
    await fanout(e, [await target("fcm", "pair"), await target("apns", "pair")], new Log());
    const f = JSON.parse(new TextDecoder().decode(mock.requests.filter(isSend("fcm")).pop()!.body));
    expect(f.message.android.ttl).toBe("2419200s");
    const a = mock.requests.filter(isSend("apns")).pop()!;
    const ttl = Number(a.headers["apns-expiration"]) - Math.floor(Date.now() / 1000);
    expect(ttl).toBeGreaterThan(2419200 - 3);
  });

  it("no sender or recipient id in any vendor header (all routes)", async () => {
    const email = randomEmail();
    const me = await newPeer(email);
    const peers: Peer[] = [];
    for (const pl of ["android", "iphone", "chrome", "firefox"]) peers.push(await newPeer(email, pl));
    for (const p of peers) await setAllow(p, [me.id]);
    const m: Record<string, string> = {};
    for (const p of peers) m[p.id] = message(512);
    const r = await call("POST", "/v1/send", { v: 1, m }, { peer: me });
    expect(Object.values(r.body.r as object).every((x) => x === "sent")).toBe(true);
    const ids = [me.id, ...peers.map((p) => p.id)];
    for (const req of mock.requests) {
      const hv = JSON.stringify(req.headers);
      for (const id of ids) {
        expect(hv).not.toContain(id);
        expect(req.url).not.toContain(id);
      }
    }
    expect(await row(me.id)).not.toBeNull();
  });
});

describe("vendor auth alert (I274)", () => {
  it("only APNs 403 InvalidProviderToken for an hour -> the ops mail is built", async () => {
    const e = await testEnv();
    const hour = Math.floor(deps.now() / 3600000) - 1;
    const t = hour * 3600000 + 1000;
    await recordHealth(env, "apns", false, true, t);
    await recordHealth(env, "apns", false, true, t);
    await recordHealth(env, "fcm", true, false, t);
    expect(await authAlerts(env, hour)).toEqual(["apns"]);
    const log = new Log();
    await healthCheck(e, log);
    const mails = vendorRequests("email.us-east-1.amazonaws.com");
    const texts = mails.map((x) => JSON.parse(new TextDecoder().decode(x.body)).Content.Simple.Subject.Data);
    expect(texts).toContain("PushArmor vendor auth alert");
    expect(log.extra.auth_alert).toBe("apns");
    expect(env.DB).toBeTruthy();
  });
});

describe("health ok cache (I374)", () => {
  it("a failed ok write does not suppress the next ok write in the hour", async () => {
    const hour = Math.floor(deps.now() / 3600000) - 1;
    const t = hour * 3600000 + 1000;
    const broken = { DB: { prepare: () => { throw new Error("d1 down"); } } } as unknown as typeof env;
    await recordHealth(broken, "fcm", true, false, t);
    await recordHealth(env, "fcm", true, false, t);
    await recordHealth(env, "fcm", false, true, t);
    expect(await authAlerts(env, hour)).toEqual([]);
  });
});

describe("vendor health: only our credential failures, throttled writes (I448)", () => {
  const fcmBody = (status: string, errorCode?: string) =>
    JSON.stringify({ error: { status, details: errorCode ? [{ errorCode }] : [] } });

  it("per-token errors are not auth failures; credential errors are", () => {
    expect(isAuthFailure("fcm", 403, "fcm-403-SENDER_ID_MISMATCH")).toBe(false);
    expect(isAuthFailure("fcm", 404, "fcm-404-UNREGISTERED")).toBe(false);
    expect(isAuthFailure("fcm", 400, "fcm-400-INVALID_ARGUMENT")).toBe(false);
    expect(isAuthFailure("apns", 400, "apns-400-BadDeviceToken")).toBe(false);
    expect(isAuthFailure("apns", 410, "apns-410-Unregistered")).toBe(false);
    expect(isAuthFailure("fcm", 401, "fcm-401")).toBe(true);
    expect(isAuthFailure("fcm", 401, "fcm-401-THIRD_PARTY_AUTH_ERROR")).toBe(true);
    expect(isAuthFailure("fcm", 403, "fcm-403")).toBe(true);
    expect(isAuthFailure("apns", 403, "apns-403-InvalidProviderToken")).toBe(true);
  });

  it("attacker: 9 peers with FCM tokens from a foreign project write no health row", async () => {
    const e = await testEnv();
    onVendor(isSend("fcm"), () => new Response(fcmBody("PERMISSION_DENIED", "SENDER_ID_MISMATCH"), { status: 403 }), 999);
    const base = await target("fcm");
    const ts: Target[] = [];
    for (let i = 0; i < 9; i++) ts.push({ ...base, id: "id-fcm-" + i });
    for (let k = 0; k < 5; k++) {
      const out = await fanout(e, ts, new Log());
      expect(Object.values(out.results).every((r) => r === "failed:fcm-403-SENDER_ID_MISMATCH")).toBe(true);
    }
    const rows = await env.DB.prepare("SELECT vendor, auth, ok FROM vendor_health").all();
    expect(rows.results).toEqual([]);
  });

  it("a burst of credential failures writes at most once per vendor per flush window per isolate", async () => {
    let writes = 0;
    const counting = { DB: { prepare: (sql: string) => { writes++; return env.DB.prepare(sql); }, batch: (s: D1PreparedStatement[]) => { writes++; return env.DB.batch(s); } } } as unknown as typeof env;
    const hour = Math.floor(deps.now() / 3600000) - 1;
    const t = hour * 3600000 + 1000;
    for (let i = 0; i < 50; i++) await recordHealth(counting, "fcm", false, true, t + i);
    expect(writes).toBe(1);
    expect(await authAlerts(env, hour)).toEqual(["fcm"]);
    // The first success of the hour goes out at once (no false alert after a good retry).
    for (let i = 0; i < 50; i++) await recordHealth(counting, "fcm", true, false, t + i);
    expect(writes).toBe(2);
    expect(await authAlerts(env, hour)).toEqual([]);
    await recordHealth(counting, "fcm", false, true, t + HEALTH_FLUSH_MS);
    expect(writes).toBe(3);
    const r = await env.DB.prepare("SELECT auth, ok FROM vendor_health WHERE vendor = 'fcm' AND hour = ?1").bind(hour).first();
    expect(r).toEqual({ auth: 51, ok: 1 });
    expect(await authAlerts(env, hour)).toEqual([]);
  });

  it("counts left from the previous hour are written when the hour changes", async () => {
    const hour = Math.floor(deps.now() / 3600000) - 2;
    const t = hour * 3600000 + 1000;
    await recordHealth(env, "apns", false, true, t);
    await recordHealth(env, "apns", false, true, t + 1);
    await recordHealth(env, "apns", false, true, t + 2);
    await recordHealth(env, "apns", true, false, (hour + 1) * 3600000 + 5);
    const old = await env.DB.prepare("SELECT auth, ok FROM vendor_health WHERE vendor = 'apns' AND hour = ?1").bind(hour).first();
    expect(old).toEqual({ auth: 3, ok: 0 });
    const cur = await env.DB.prepare("SELECT auth, ok FROM vendor_health WHERE vendor = 'apns' AND hour = ?1").bind(hour + 1).first();
    expect(cur).toEqual({ auth: 0, ok: 1 });
  });
});

describe("token cache bound (I316)", () => {
  it("evicts only vapid keys; apns and fcm stay", async () => {
    const mint = async () => ({ value: "t", mintedAt: 0, useUntil: 1e12 });
    await getToken("apns", mint, 1);
    await getToken("fcm", mint, 1);
    const apns = peekToken("apns");
    const fcm = peekToken("fcm");
    for (let i = 0; i < 300; i++) await getToken("vapid:https://h" + i + ".example", mint, 1);
    expect(peekToken("apns")).toBe(apns);
    expect(peekToken("fcm")).toBe(fcm);
    let vapid = 0;
    for (let i = 0; i < 300; i++) if (peekToken("vapid:https://h" + i + ".example")) vapid++;
    expect(vapid).toBeLessThanOrEqual(MAX_TOKENS);
    expect(vapid).toBeGreaterThan(0);
    expect(peekToken("vapid:https://h299.example")).toBeDefined();
  });
});
