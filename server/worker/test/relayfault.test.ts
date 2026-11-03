import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { classify } from "../src/push/results";
import { PUSH_FAILED_COL, W_RELAY_FAULT } from "../src/db/sql";
import { call, countingLimit, initP256, meterD1, message, newPeer, onVendor, pushFor, randomEmail, row, setAllow, testEnv, vendorRequests, type Peer } from "./helpers";

beforeAll(initP256);

const fcmErr = (status: string, code?: string) =>
  JSON.stringify({ error: { code: 403, message: "denied", status, details: code ? [{ errorCode: code }] : [] } });
const isFcmSend = (r: { url: string }) => r.url.includes("/messages:send");
const mark = async (p: Peer) => (await row(p.id))![PUSH_FAILED_COL];
const myFault = async (p: Peer) => (await call("GET", "/v1/peers", undefined, { peer: p })).body.my_relay_fault;

describe("relay-side fault classification", () => {
  it("credential faults are relay-side; device-side and other faults are not", () => {
    const relay = (v: "fcm" | "apns" | "wp" | "up", s: number, b = "") => classify(v, s, b, null).relay === true;
    expect(relay("fcm", 401, fcmErr("UNAUTHENTICATED"))).toBe(true);
    expect(relay("fcm", 403, fcmErr("PERMISSION_DENIED"))).toBe(true);
    expect(relay("fcm", 403, fcmErr("PERMISSION_DENIED", "SENDER_ID_MISMATCH"))).toBe(false);
    expect(relay("fcm", 404, fcmErr("NOT_FOUND", "UNREGISTERED"))).toBe(false);
    expect(relay("fcm", 500)).toBe(false);
    expect(relay("fcm", 429)).toBe(false);
    for (const r of ["InvalidProviderToken", "ExpiredProviderToken", "MissingProviderToken"]) {
      expect(relay("apns", 403, JSON.stringify({ reason: r }))).toBe(true);
    }
    expect(relay("apns", 403, JSON.stringify({ reason: "BadCertificateEnvironment" }))).toBe(false);
    expect(relay("apns", 410, JSON.stringify({ reason: "Unregistered" }))).toBe(false);
    expect(relay("wp", 401)).toBe(true);
    expect(relay("wp", 403)).toBe(true);
    expect(relay("wp", 410)).toBe(false);
    expect(relay("up", 401)).toBe(false);
    expect(relay("up", 403)).toBe(false);
    expect(classify("apns", 403, JSON.stringify({ reason: "MissingProviderToken" }), null).kind).toBe("failed");
  });
});

describe("relay fault mark (push_failed_since on non-cli rows)", () => {
  it("set on a relay-side fault, cleared on the next accepted push, written only on a change", async () => {
    const email = randomEmail();
    const me = await newPeer(email);
    const x = await newPeer(email, "android");
    await setAllow(x, [me.id]);
    const send = () => call("POST", "/v1/send", { v: 1, m: { [x.id]: message(512) } }, { peer: me });
    // First send also writes W_SEEN; later sends in the month do not.
    await send();
    expect(await mark(x)).toBeNull();
    expect(await myFault(x)).toBe(false);

    onVendor(isFcmSend, () => new Response(fcmErr("PERMISSION_DENIED"), { status: 403 }));
    let m = await meterD1(send);
    expect(m.result.body.r).toEqual({ [x.id]: "failed:fcm-403" });
    expect(m.rows_written).toBeGreaterThan(0);
    const since = (await mark(x)) as number;
    expect(Math.abs(since - Math.floor(Date.now() / 1000))).toBeLessThan(5);
    expect((await row(x.id))!.push).not.toBeNull();
    expect(await myFault(x)).toBe(true);
    expect(await myFault(me)).toBe(false);

    // Fault again while set: no write.
    onVendor(isFcmSend, () => new Response(fcmErr("PERMISSION_DENIED"), { status: 403 }));
    m = await meterD1(send);
    expect(m.rows_written).toBe(0);
    expect(await mark(x)).toBe(since);

    // A device-side fault neither sets nor clears it.
    onVendor(isFcmSend, () => new Response(fcmErr("PERMISSION_DENIED", "SENDER_ID_MISMATCH"), { status: 403 }));
    m = await meterD1(send);
    expect(m.rows_written).toBe(0);
    expect(await mark(x)).toBe(since);

    // Accepted push clears it once; the next accepted push writes nothing.
    m = await meterD1(send);
    expect(m.result.body.r).toEqual({ [x.id]: "sent" });
    expect(m.rows_written).toBeGreaterThan(0);
    expect(await mark(x)).toBeNull();
    expect(await myFault(x)).toBe(false);
    m = await meterD1(send);
    expect(m.rows_written).toBe(0);
  });

  it("a failed OAuth token mint is relay-side", async () => {
    const email = randomEmail();
    const me = await newPeer(email);
    const x = await newPeer(email, "android");
    await setAllow(x, [me.id]);
    onVendor((r) => r.url.startsWith("https://oauth2.googleapis.com/token"), () => new Response("{}", { status: 400 }));
    const r = await call("POST", "/v1/send", { v: 1, m: { [x.id]: message(512) } }, { peer: me });
    expect(r.body.r).toEqual({ [x.id]: "failed:fcm-auth" });
    expect(await mark(x)).not.toBeNull();
    expect(await myFault(x)).toBe(true);
  });

  it("pair relay to an iPhone: APNs InvalidProviderToken sets it; Web Push 401 sets it", async () => {
    const email = randomEmail();
    const n = await newPeer(email);
    const x = await newPeer(email, "ios");
    onVendor((r) => r.url.includes("/3/device/"), () => Response.json({ reason: "InvalidProviderToken" }, { status: 403 }));
    const r = await call("POST", "/v1/pair/" + x.id, { k: "commit", c: message(364) + "AA" }, { peer: n });
    expect(r.body.r).toBe("failed:apns-403-InvalidProviderToken");
    expect(await mark(x)).not.toBeNull();

    const w = await newPeer(email, "chrome");
    await setAllow(w, [n.id]);
    onVendor((q) => q.url.startsWith("https://fcm.googleapis.com/fcm/send/"), () => new Response(null, { status: 401 }), 2);
    await call("POST", "/v1/send", { v: 1, m: { [w.id]: message(512) } }, { peer: n });
    expect(await mark(w)).not.toBeNull();
  });

  it("the SQL never touches a cli row (ntfy 507 semantics stay)", async () => {
    const email = randomEmail();
    const c = await newPeer(email, "cli", pushFor("cli"));
    const r = await env.DB.prepare(W_RELAY_FAULT).bind(c.id, c.acct, 1).run();
    expect(r.meta.changes).toBe(0);
    expect(await mark(c)).toBeNull();
    expect(await myFault(c)).toBe(false);
  });
});

describe("POST /v1/peers/$id/check", () => {
  const check = (p: Peer, o: { env?: Env; body?: unknown; id?: string } = {}) =>
    call("POST", `/v1/peers/${o.id ?? p.id}/check`, o.body, { peer: p, env: o.env });

  it("sent: FCM data-only check push at normal priority; clears the mark", async () => {
    const x = await newPeer(randomEmail(), "android");
    await env.DB.prepare(`UPDATE peers SET ${PUSH_FAILED_COL} = 5 WHERE id = ?1`).bind(x.id).run();
    expect(await myFault(x)).toBe(true);
    const r = await check(x);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ result: "sent" });
    const q = vendorRequests("fcm.googleapis.com").filter(isFcmSend);
    expect(q).toHaveLength(1);
    const msg = JSON.parse(new TextDecoder().decode(q[0].body)).message;
    expect(msg.data).toEqual({ check: "1" });
    expect(msg.notification).toBeUndefined();
    expect(msg.android.priority).toBe("NORMAL");
    expect(await mark(x)).toBeNull();
    // An empty JSON object body is accepted too; anything else is not.
    expect((await check(x, { body: {} })).body).toEqual({ result: "sent" });
    expect((await check(x, { body: { a: 1 } })).status).toBe(400);
  });

  it("relay: sets the mark; a second relay fault writes nothing", async () => {
    const x = await newPeer(randomEmail(), "android");
    onVendor(isFcmSend, () => new Response(fcmErr("PERMISSION_DENIED"), { status: 403 }), 2);
    expect((await check(x)).body).toEqual({ result: "relay" });
    const since = await mark(x);
    expect(since).not.toBeNull();
    expect(await myFault(x)).toBe(true);
    const m = await meterD1(() => check(x));
    expect(m.result.body).toEqual({ result: "relay" });
    expect(m.rows_written).toBe(0);
  });

  it("gone: Web Push 410 clears the stored push address; the check push is encrypted at normal urgency", async () => {
    const x = await newPeer(randomEmail(), "chrome");
    onVendor((q) => q.url.startsWith("https://fcm.googleapis.com/fcm/send/"), () => new Response(null, { status: 410 }));
    expect((await check(x)).body).toEqual({ result: "gone" });
    const q = vendorRequests("fcm.googleapis.com")[0];
    expect(q.headers["content-encoding"]).toBe("aes128gcm");
    expect(q.headers.urgency).toBe("normal");
    expect((await row(x.id))!.push).toBeNull();
    // none: no push address stored.
    expect((await check(x)).body).toEqual({ result: "none" });
  });

  it("APNs: background push, priority 5, check body; other failures -> failed", async () => {
    const x = await newPeer(randomEmail(), "ios");
    onVendor((r) => r.url.includes("/3/device/"), () => Response.json({ reason: "BadDeviceToken" }, { status: 400 }));
    expect((await check(x)).body).toEqual({ result: "failed" });
    const q = vendorRequests("api.push.apple.com")[0];
    expect(q.headers["apns-push-type"]).toBe("background");
    expect(q.headers["apns-priority"]).toBe("5");
    expect(q.headers["apns-collapse-id"]).toBeUndefined();
    expect(JSON.parse(new TextDecoder().decode(q.body))).toEqual({ aps: { "content-available": 1 }, check: 1 });
    expect(await mark(x)).toBeNull();
    expect((await row(x.id))!.push).not.toBeNull();
  });

  it("caller only, not cli, rate limited per peer", async () => {
    const email = randomEmail();
    const x = await newPeer(email, "android");
    const y = await newPeer(email, "android");
    expect((await check(x, { id: y.id })).status).toBe(400);
    const c = await newPeer(email, "cli", pushFor("cli"));
    expect((await check(c)).status).toBe(400);
    const rl = countingLimit(2);
    const e = await testEnv({ RL_PROBE: rl });
    expect((await check(x, { env: e })).status).toBe(200);
    expect((await check(x, { env: e })).status).toBe(200);
    expect((await check(x, { env: e })).status).toBe(429);
    expect(rl.seen).toContain("check:" + x.id);
    expect((await call("POST", `/v1/peers/${x.id}/check`, undefined, { peer: x, noSig: true })).status).toBe(401);
  });
});
