import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { utf8 } from "../src/crypto/hash";
import { LABEL_REQUEST_TOKEN, openToken } from "../src/crypto/tokens";
import { base32Decode, checkTotp, TOTP_LOGINS, totp, totpKeyFor } from "../src/auth/totp";
import { call, countingLimit, keys, randomEmail, secretString, testEnv, vendorRequests } from "./helpers";
import { TEST_SECRETS as S, TEST_TOTP } from "./secrets";

const { RFC: RFC_KEY_B32, A: KEY_A, B: KEY_B } = TEST_TOTP;
const SES = "email.us-east-1.amazonaws.com";

async function hex(s: string): Promise<string> {
  let h = "";
  for (const x of new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(s)))) h += x.toString(16).padStart(2, "0");
  return h;
}

// Stand-in addresses mapped like the two real ones (the real addresses are not in this file).
const ADDR_A = secretString("totp-a@example.com");
const ADDR_B = secretString("totp-b@example.com");
beforeAll(async () => {
  TOTP_LOGINS.set(await hex(ADDR_A), "PA_TOTP_KEY_REVIEWER");
  TOTP_LOGINS.set(await hex(ADDR_B), "PA_TOTP_KEY_RELEASE_TEST");
});
afterAll(async () => {
  TOTP_LOGINS.delete(await hex(ADDR_A));
  TOTP_LOGINS.delete(await hex(ADDR_B));
});
afterEach(() => vi.restoreAllMocks());

async function start(email: string, e: Env, ip?: string) {
  const k = await keys();
  return call("POST", "/v1/auth/email", { email, sign_pub: k.signPub, purpose: "register", turnstile: "t" }, { env: e, ip });
}

describe("TOTP (RFC 6238)", () => {
  it("Appendix B SHA-1 vectors", async () => {
    const key = base32Decode(RFC_KEY_B32)!;
    expect(new TextDecoder().decode(key)).toBe("12345678901234567890");
    const vectors: [number, string][] = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [t, code] of vectors) expect(await totp(key, Math.floor(t / 30), 8)).toBe(code);
    expect(await totp(key, 1, 6)).toBe("287082");
  });

  it("accepts one step either side, not two; digits only", async () => {
    const key = base32Decode(RFC_KEY_B32)!;
    const t = 1111111111;
    const c = Math.floor(t / 30);
    for (const d of [-1, 0, 1]) expect(await checkTotp(key, await totp(key, c + d), t)).toBe(true);
    for (const d of [-2, 2]) expect(await checkTotp(key, await totp(key, c + d), t)).toBe(false);
    expect(await checkTotp(key, "ABCDEF", t)).toBe(false);
    expect(base32Decode("not base32!")).toBeNull();
  });

  it("the two login hashes name their own secrets", async () => {
    expect(TOTP_LOGINS.get("0cb0ee6c640e13641d605d3fd417c1e412e707676424a34a92bef701c855c7c4")).toBe("PA_TOTP_KEY_REVIEWER");
    expect(TOTP_LOGINS.get("34a7fa4e54529533ee628eb78cee8b7322eda149625c442bf1b33f13e55f3120")).toBe("PA_TOTP_KEY_RELEASE_TEST");
    const e = { PA_TOTP_KEY_REVIEWER: KEY_A, PA_TOTP_KEY_RELEASE_TEST: KEY_B };
    expect(await totpKeyFor(e, ADDR_A)).toEqual(base32Decode(KEY_A));
    expect(await totpKeyFor(e, ADDR_B)).toEqual(base32Decode(KEY_B));
    expect(await totpKeyFor({}, ADDR_A)).toBeNull();
    expect(await totpKeyFor(e, randomEmail())).toBeNull();
  });
});

describe("POST /auth/email with a TOTP address", () => {
  it("sends no mail; verify takes the TOTP code, not a wrong one", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const e = await testEnv({ PA_TOTP_KEY_REVIEWER: KEY_A, PA_TOTP_KEY_RELEASE_TEST: KEY_B });
    const r = await start(" " + ADDR_A.toUpperCase() + " ", e);
    expect(r.status).toBe(200);
    expect(vendorRequests(SES)).toHaveLength(0);
    const token = secretString(r.body.request_token as string);
    expect(await openToken(S.PA_TOKEN_SECRET, LABEL_REQUEST_TOKEN, token)).toMatchObject({ o: 1, m: ADDR_A });
    const c = Math.floor(now / 1000 / 30);
    const wrongKey = await totp(base32Decode(KEY_B)!, c);
    let v = await call("POST", "/v1/auth/email/verify", { request_token: token, code: wrongKey }, { env: e });
    expect(v.body.error).toBe("wrong code");
    v = await call("POST", "/v1/auth/email/verify", { request_token: token, code: await totp(base32Decode(KEY_A)!, c - 2) }, { env: e });
    expect(v.body.error).toBe("wrong code");
    v = await call("POST", "/v1/auth/email/verify", { request_token: token, code: await totp(base32Decode(KEY_A)!, c + 1) }, { env: e });
    expect(v.status).toBe(200);
    expect(v.body.email).toBe(ADDR_A);
    // The second address uses its own key.
    const r2 = await start(ADDR_B, e);
    expect(vendorRequests(SES)).toHaveLength(0);
    const t2 = secretString(r2.body.request_token as string);
    v = await call("POST", "/v1/auth/email/verify", { request_token: t2, code: await totp(base32Decode(KEY_A)!, c) }, { env: e });
    expect(v.body.error).toBe("wrong code");
    v = await call("POST", "/v1/auth/email/verify", { request_token: t2, code: await totp(base32Decode(KEY_B)!, c - 1) }, { env: e });
    expect(v.status).toBe(200);
    expect(v.body.email).toBe(ADDR_B);
  });

  it("RL_MAIL_EMAIL and RL_CODE still apply", async () => {
    const e = await testEnv({ PA_TOTP_KEY_REVIEWER: KEY_A, RL_MAIL_EMAIL: countingLimit(1), RL_CODE: countingLimit(1) });
    const r = await start(ADDR_A, e);
    expect(r.status).toBe(200);
    expect((await start(ADDR_A, e)).status).toBe(429);
    const token = r.body.request_token as string;
    const code = await totp(base32Decode(KEY_A)!, Math.floor(Date.now() / 1000 / 30));
    expect((await call("POST", "/v1/auth/email/verify", { request_token: token, code: "000000" }, { env: e })).status).toBe(401);
    expect((await call("POST", "/v1/auth/email/verify", { request_token: token, code }, { env: e })).status).toBe(429);
  });

  it("a missing secret falls back to the mailed code; other addresses unchanged", async () => {
    const e = await testEnv({ PA_TOTP_KEY_RELEASE_TEST: KEY_B });
    const r = await start(ADDR_A, e);
    expect(r.status).toBe(200);
    expect(vendorRequests(SES)).toHaveLength(1);
    expect((await openToken(S.PA_TOKEN_SECRET, LABEL_REQUEST_TOKEN, r.body.request_token))!.o).toBeUndefined();
    const other = randomEmail();
    const r2 = await start(other, e);
    expect(r2.status).toBe(200);
    expect(vendorRequests(SES)).toHaveLength(2);
    const { deriveCode } = await import("../src/crypto/code");
    const v = await call("POST", "/v1/auth/email/verify", { request_token: r2.body.request_token, code: await deriveCode(S.PA_CODE_SECRET, r2.body.request_token as string) }, { env: e });
    expect(v.status).toBe(200);
  });
});
