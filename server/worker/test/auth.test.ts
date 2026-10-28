import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { b64urlDecode, b64urlEncode } from "../src/codec/b64url";
import { deriveCode } from "../src/crypto/code";
import { utf8 } from "../src/crypto/hash";
import { keyRef, LABEL_REQUEST_TOKEN, LABEL_TICKET, oauthNonce, openToken } from "../src/crypto/tokens";
import { signJwt } from "../src/push/jwt";
import { normalizeEmail } from "../src/auth/normalize";
import { acctOf, call, countingLimit, initP256, keys, message, mock, newPeer, onVendor, randomEmail, secretString, setAllow, testEnv, vendorRequests } from "./helpers";
import { TEST_SECRETS as S } from "./secrets";

beforeAll(initP256);

describe("email normalization", () => {
  it("same hash for ' A@B.Com ' and 'a@b.com'; non-ASCII -> 400 bad email", () => {
    expect(normalizeEmail(" A@B.Com ")).toBe("a@b.com");
    expect(() => normalizeEmail("\u00c9@b.com")).toThrow("bad email");
    expect(() => normalizeEmail("a@b\u00fc.com")).toThrow("bad email");
    expect(() => normalizeEmail("\u0130nfo@b.com")).toThrow("bad email");
    expect(normalizeEmail("x@privaterelay.appleid.com")).toBe("x@privaterelay.appleid.com");
  });
});

async function startEmail(email: string, purpose = "register", extra: Record<string, unknown> = {}, e?: Env) {
  const k = await keys();
  const r = await call("POST", "/v1/auth/email", { email, sign_pub: k.signPub, purpose, turnstile: "turnstile-token", ...extra }, { env: e });
  return { k, r };
}

describe("POST /auth/email + verify", () => {
  it("sends the code by SES and verify returns ticket + email", async () => {
    const email = randomEmail();
    const { k, r } = await startEmail(" " + email.toUpperCase() + " ");
    expect(r.status).toBe(200);
    const token = secretString(r.body.request_token as string);
    const ses = vendorRequests("email.us-east-1.amazonaws.com");
    expect(ses).toHaveLength(1);
    const mail = JSON.parse(new TextDecoder().decode(ses[0].body));
    expect(mail.Destination.ToAddresses).toEqual([email]);
    expect(mail.ConfigurationSetName).toBe("test-config-set");
    const code = await deriveCode(S.PA_CODE_SECRET, token);
    expect(mail.Content.Simple.Body.Text.Data).toContain(code);
    expect(mail.Content.Simple.Body.Text.Data).toContain("Nothing happens unless this code is entered within 15 minutes. If you did not request it, ignore this email.");
    const ts = vendorRequests("challenges.cloudflare.com");
    expect(new URLSearchParams(new TextDecoder().decode(ts[0].body)).get("response")).toBe("turnstile-token");
    let v = await call("POST", "/v1/auth/email/verify", { request_token: token, code: "000000" });
    expect(v.body.error).toBe("wrong code");
    v = await call("POST", "/v1/auth/email/verify", { request_token: token, code: code.toLowerCase().replace(/0/g, "o") });
    expect(v.status).toBe(200);
    expect(v.body.email).toBe(email);
    const t = await openToken(S.PA_TOKEN_SECRET, LABEL_TICKET, secretString(v.body.ticket as string));
    expect(t).toMatchObject({ a: await acctOf(email), k: await keyRef(b64urlDecode(k.signPub)!), p: "register" });
  });

  it("non-ASCII email -> 400 bad email with no mail sent", async () => {
    const { r } = await startEmail("\u00c9@b.com");
    expect(r.body).toEqual({ error: "bad email" });
    expect(vendorRequests("email.us-east-1.amazonaws.com")).toHaveLength(0);
  });

  it("Turnstile failure and network error -> 403; hostname/action checked", async () => {
    onVendor((r) => r.url.includes("challenges.cloudflare.com"), () => Response.json({ success: false }));
    expect((await startEmail(randomEmail())).r.body).toEqual({ error: "turnstile failed" });
    onVendor((r) => r.url.includes("challenges.cloudflare.com"), () => { throw new TypeError("net"); });
    expect((await startEmail(randomEmail())).r.status).toBe(403);
    onVendor((r) => r.url.includes("challenges.cloudflare.com"), () => Response.json({ success: true, hostname: "evil.example", action: "email" }));
    expect((await startEmail(randomEmail())).r.status).toBe(403);
    onVendor((r) => r.url.includes("challenges.cloudflare.com"), () => Response.json({ success: true, hostname: "pusharmor.com", action: "other" }));
    expect((await startEmail(randomEmail())).r.status).toBe(403);
  });

  it("SES error -> 502 email send failed", async () => {
    onVendor((r) => r.url.includes("amazonaws.com"), () => new Response("{}", { status: 400 }));
    expect((await startEmail(randomEmail())).r).toMatchObject({ status: 502, body: { error: "email send failed" } });
  });

  it("RL_MAIL: 2 per 60 s per email_hash", async () => {
    const email = randomEmail();
    const e = await testEnv({ RL_MAIL: countingLimit(2) });
    expect((await startEmail(email, "register", {}, e)).r.status).toBe(200);
    expect((await startEmail(email, "register", {}, e)).r.status).toBe(200);
    expect((await startEmail(email, "register", {}, e)).r.status).toBe(429);
  });

  it("RL_MAIL per IP: address variants from one IP hit the limit (I306)", async () => {
    const k = await keys();
    const ip = "198.51.100.77";
    const st = [];
    const e = await testEnv({ RL_MAIL: countingLimit(2) });
    for (let i = 0; i < 3; i++) {
      st.push((await call("POST", "/v1/auth/email", { email: `v+${i}@example.com`, sign_pub: k.signPub, purpose: "register", turnstile: "t" }, { ip, env: e })).status);
    }
    expect(st).toEqual([200, 200, 429]);
  });

  it("request_token tamper and expiry; RL_CODE 5 per minute", async () => {
    const { r } = await startEmail(randomEmail());
    const token = r.body.request_token as string;
    const e = await testEnv({ RL_CODE: countingLimit(5) });
    const [b, mac] = token.split(".");
    const body = JSON.parse(new TextDecoder().decode(b64urlDecode(b)!));
    const forged = b64urlEncode(utf8(JSON.stringify({ ...body, p: "delete-account" }))) + "." + mac;
    expect((await call("POST", "/v1/auth/email/verify", { request_token: forged, code: "AAAAAA" })).status).toBe(401);
    const { makeToken } = await import("../src/crypto/tokens");
    const old = await makeToken(S.PA_TOKEN_SECRET, LABEL_REQUEST_TOKEN, { ...body, t: body.t - 901 });
    expect((await call("POST", "/v1/auth/email/verify", { request_token: old, code: "AAAAAA" })).body.error).toBe("code expired");
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await call("POST", "/v1/auth/email/verify", { request_token: token, code: "AAAAAA" }, { env: e })).status;
    expect(last).toBe(429);
  });

  it("RL_CODE is per request token: 5 wrong on token A, correct code on token B -> 200 (I293)", async () => {
    const email = randomEmail();
    const e = await testEnv({ RL_CODE: countingLimit(5) });
    const a = await startEmail(email);
    const tokA = secretString(a.r.body.request_token as string);
    for (let i = 0; i < 5; i++) expect((await call("POST", "/v1/auth/email/verify", { request_token: tokA, code: "AAAAAA" }, { env: e })).status).toBe(401);
    expect((await call("POST", "/v1/auth/email/verify", { request_token: tokA, code: "AAAAAA" }, { env: e })).status).toBe(429);
    const b = await startEmail(email);
    const tokB = secretString(b.r.body.request_token as string);
    const code = await deriveCode(S.PA_CODE_SECRET, tokB);
    const r = await call("POST", "/v1/auth/email/verify", { request_token: tokB, code }, { env: e });
    expect(r.status).toBe(200);
  });

  it("RL_CODE_ALL: the per-email cap over all tokens still bites (I293)", async () => {
    const email = randomEmail();
    const { r } = await startEmail(email);
    const tok = r.body.request_token as string;
    const e = { ...(await testEnv()), RL_CODE: { limit: async () => ({ success: true }) }, RL_CODE_ALL: { limit: async () => ({ success: false }) } } as Env;
    expect((await call("POST", "/v1/auth/email/verify", { request_token: tok, code: "AAAAAA" }, { env: e })).status).toBe(429);
  });
});

// ---------- OAuth ----------
interface Idp {
  priv: CryptoKey;
  jwk: JsonWebKey;
  alg: "RS256" | "ES256";
}

async function idp(alg: "RS256" | "ES256"): Promise<Idp> {
  const kp = (alg === "RS256"
    ? await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])
    : await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { priv: kp.privateKey, jwk: (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey, alg };
}

function serveJwks(host: string, i: Idp): void {
  onVendor((r) => new URL(r.url).hostname === host && /certs|keys/.test(r.url), () => Response.json({ keys: [{ ...i.jwk, kid: "kid1", alg: i.alg }] }, { headers: { "Cache-Control": "max-age=3600" } }), 99);
}

async function idToken(i: Idp, claims: Record<string, unknown>): Promise<string> {
  return secretString(await signJwt(i.alg, i.priv, { alg: i.alg, kid: "kid1" }, claims));
}

describe("Google", () => {
  it("native token: valid id_token -> ticket + email; bad iss/aud/nonce/exp/email_verified rejected", async () => {
    const g = await idp("RS256");
    serveJwks("www.googleapis.com", g);
    const k = await keys();
    const email = randomEmail();
    const nonce = await oauthNonce("register", await keyRef(b64urlDecode(k.signPub)!));
    const now = Math.floor(Date.now() / 1000);
    const good = { iss: "https://accounts.google.com", aud: "google-ios-client", exp: now + 600, nonce, email: email.toUpperCase(), email_verified: true };
    const r = await call("POST", "/v1/auth/google/token", { id_token: await idToken(g, good), sign_pub: k.signPub, purpose: "register" });
    expect(r.status).toBe(200);
    expect(r.body.email).toBe(email);
    secretString(r.body.ticket as string);
    const cases: [Record<string, unknown>, string][] = [
      [{ ...good, iss: "https://evil.example" }, "invalid id_token"],
      [{ ...good, aud: "other" }, "invalid id_token"],
      [{ ...good, nonce: "x" }, "invalid id_token"],
      [{ ...good, exp: now - 1 }, "invalid id_token"],
      [{ ...good, email_verified: false }, "email not verified"],
    ];
    for (const [claims, word] of cases) {
      const rr = await call("POST", "/v1/auth/google/token", { id_token: await idToken(g, claims), sign_pub: k.signPub, purpose: "register" });
      expect(rr.body.error).toBe(word);
    }
    const other = await idp("RS256");
    const forged = await signJwt("RS256", other.priv, { alg: "RS256", kid: "kid1" }, good);
    expect((await call("POST", "/v1/auth/google/token", { id_token: forged, sign_pub: k.signPub, purpose: "register" })).body.error).toBe("invalid id_token");
  });

  it("web flow: start 302 with PKCE + nonce; callback exchanges and redirects with fragment", async () => {
    const g = await idp("RS256");
    serveJwks("www.googleapis.com", g);
    const k = await keys();
    const kr = await keyRef(b64urlDecode(k.signPub)!);
    expect((await call("GET", `/v1/auth/google?k=${kr}&r=web&p=register`)).status).toBe(400);
    const s = await call("GET", `/v1/auth/google?k=${kr}&r=firefox&p=register`);
    expect(s.status).toBe(302);
    const loc = new URL(s.res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("nonce")).toBe(await oauthNonce("register", kr));
    expect(loc.searchParams.get("redirect_uri")).toBe("https://api.pusharmor.com/v1/auth/google/callback");
    const state = secretString(loc.searchParams.get("state")!);
    const email = randomEmail();
    onVendor((r) => r.url === "https://oauth2.googleapis.com/token" && new TextDecoder().decode(r.body).includes("authorization_code"), async () =>
      Response.json({ id_token: await idToken(g, { iss: "accounts.google.com", aud: "google-web-client", exp: Math.floor(Date.now() / 1000) + 60, nonce: await oauthNonce("register", kr), email, email_verified: "true" }) }),
    );
    const cb = await call("GET", `/v1/auth/google/callback?code=${secretString("authcode123")}&state=${state}`);
    expect(cb.status).toBe(302);
    const to = cb.res.headers.get("Location")!;
    expect(to.startsWith("https://pusharmor.com/auth/done#ticket=")).toBe(true);
    expect(to).toContain("&email=" + encodeURIComponent(email));
    const ex = vendorRequests("oauth2.googleapis.com").pop()!;
    const form = new URLSearchParams(new TextDecoder().decode(ex.body));
    const challenge = loc.searchParams.get("code_challenge");
    const v = form.get("code_verifier")!;
    expect(b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(v))))).toBe(challenge);
    // Tampered state -> 400.
    expect((await call("GET", `/v1/auth/google/callback?code=x&state=${state.slice(0, -2)}AA`)).status).toBe(400);
  });

  it("valid state: provider error, missing code, failed exchange -> 302 with #error; bad state stays 400 (I306)", async () => {
    const k = await keys();
    const kr = await keyRef(b64urlDecode(k.signPub)!);
    const s = await call("GET", `/v1/auth/google?k=${kr}&r=firefox&p=register`);
    const state = secretString(new URL(s.res.headers.get("Location")!).searchParams.get("state")!);
    const loc = async (q: string) => {
      const r = await call("GET", `/v1/auth/google/callback?${q}`);
      expect(r.status).toBe(302);
      return r.res.headers.get("Location");
    };
    expect(await loc(`error=access_denied&state=${state}`)).toBe("https://pusharmor.com/auth/done#error=cancelled");
    expect(await loc(`state=${state}`)).toBe("https://pusharmor.com/auth/done#error=failed");
    onVendor((r) => r.url === "https://oauth2.googleapis.com/token", () => new Response("{}", { status: 400 }));
    expect(await loc(`code=abc&state=${state}`)).toBe("https://pusharmor.com/auth/done#error=failed");
    expect((await call("GET", `/v1/auth/google/callback?error=access_denied&state=${state.slice(0, -2)}AA`)).status).toBe(400);
  });

  it("Chrome redirect list: u must equal an allow-listed entry; default is the first; u only for chrome", async () => {
    const k = await keys();
    const kr = await keyRef(b64urlDecode(k.signPub)!);
    const start = (q: string) => call("GET", `/v1/auth/google?k=${kr}&p=register&${q}`);
    const back = async (s: Awaited<ReturnType<typeof start>>, env?: Awaited<ReturnType<typeof testEnv>>) => {
      const state = secretString(new URL(s.res.headers.get("Location")!).searchParams.get("state")!);
      const r = await call("GET", `/v1/auth/google/callback?error=access_denied&state=${state}`, undefined, env ? { env } : undefined);
      return [r.status, r.res.headers.get("Location")];
    };
    const beta = encodeURIComponent("https://betaid.chromiumapp.org/");
    expect(await back(await start(`r=chrome&u=${beta}`))).toEqual([302, "https://betaid.chromiumapp.org/#error=cancelled"]);
    expect(await back(await start("r=chrome"))).toEqual([302, "https://extid.chromiumapp.org/#error=cancelled"]);
    for (const u of ["https://evil.chromiumapp.org/", "https://betaid.chromiumapp.org", "https://betaid.chromiumapp.org/x", "https://betaid.chromiumapp.org/#a", ""]) {
      expect((await start(`r=chrome&u=${encodeURIComponent(u)}`)).status, u).toBe(400);
    }
    expect((await start(`r=firefox&u=${beta}`)).status).toBe(400);
    // The callback checks u against the list again: an entry removed since the start -> 400.
    const s = await start(`r=chrome&u=${beta}`);
    const env = await testEnv({ PA_OAUTH_REDIRECT_CHROME: '["https://extid.chromiumapp.org/"]' });
    expect((await back(s, env))[0]).toBe(400);
    // A single URL (not a list) still works.
    const one = await testEnv({ PA_OAUTH_REDIRECT_CHROME: "https://extid.chromiumapp.org/" });
    const s1 = await call("GET", `/v1/auth/google?k=${kr}&p=register&r=chrome`, undefined, { env: one });
    expect(await back(s1, one)).toEqual([302, "https://extid.chromiumapp.org/#error=cancelled"]);
  });

  it("empty client redirect -> 503 at start and callback, never a relative Location (I296)", async () => {
    const g = await idp("RS256");
    serveJwks("www.googleapis.com", g);
    const k = await keys();
    const kr = await keyRef(b64urlDecode(k.signPub)!);
    const s = await call("GET", `/v1/auth/google?k=${kr}&r=chrome&p=register`);
    const state = secretString(new URL(s.res.headers.get("Location")!).searchParams.get("state")!);
    const env = await testEnv({ PA_OAUTH_REDIRECT_CHROME: "" });
    const s2 = await call("GET", `/v1/auth/google?k=${kr}&r=chrome&p=register`, undefined, { env });
    expect(s2.status).toBe(503);
    // An empty list never lets the client name the target.
    const s3 = await call("GET", `/v1/auth/google?k=${kr}&r=chrome&p=register&u=${encodeURIComponent("https://evil.example/")}`, undefined, { env });
    expect(s3.status).toBe(503);
    onVendor((r) => r.url === "https://oauth2.googleapis.com/token", async () =>
      Response.json({ id_token: await idToken(g, { iss: "accounts.google.com", aud: "google-web-client", exp: Math.floor(Date.now() / 1000) + 60, nonce: await oauthNonce("register", kr), email: randomEmail(), email_verified: true }) }),
    );
    const cb = await call("GET", `/v1/auth/google/callback?code=${secretString("authcode123")}&state=${state}`, undefined, { env });
    expect(cb.status).toBe(503);
    expect(cb.res.headers.get("Location")).toBeNull();
  });

  it("JWKS: unknown kid refetches at most once per 60 s; stale keys survive a failed refetch (I295)", async () => {
    const g = await idp("RS256");
    serveJwks("www.googleapis.com", g);
    const k = await keys();
    const nonce = await oauthNonce("register", await keyRef(b64urlDecode(k.signPub)!));
    const good = { iss: "https://accounts.google.com", aud: "google-ios-client", exp: Math.floor(Date.now() / 1000) + 3 * 86400, nonce, email: randomEmail(), email_verified: true };
    const post = (t: string) => call("POST", "/v1/auth/google/token", { id_token: t, sign_pub: k.signPub, purpose: "register" });
    expect((await post(await idToken(g, good))).status).toBe(200);
    const certs = () => vendorRequests("www.googleapis.com").length;
    expect(certs()).toBe(1);
    for (let i = 0; i < 10; i++) {
      const kid = b64urlEncode(crypto.getRandomValues(new Uint8Array(9)));
      const t = secretString(await signJwt("RS256", g.priv, { alg: "RS256", kid }, good));
      expect((await post(t)).body.error).toBe("invalid id_token");
    }
    expect(certs()).toBe(2);
    // Cache past max-age, refetch fails: the known kid still verifies.
    mock.clock += 2 * 86400 * 1000;
    onVendor((r) => new URL(r.url).hostname === "www.googleapis.com", () => new Response("down", { status: 503 }), 99);
    mock.scripts.unshift(mock.scripts.pop()!);
    expect((await post(await idToken(g, good))).status).toBe(200);
    expect(certs()).toBe(3);
  });
});

describe("Apple delete-account (6.5, 8.2)", () => {
  it("ticket issue makes no revoke call; DELETE /account revokes once; failed revoke still returns", async () => {
    const a = await idp("RS256");
    serveJwks("appleid.apple.com", a);
    const email = randomEmail();
    const p1 = await newPeer(email);
    const p2 = await newPeer(email);
    await setAllow(p2, [p1.id]);
    const nonce = await oauthNonce("delete-account", await keyRef(b64urlDecode(p1.signPub)!));
    const tok = await idToken(a, { iss: "https://appleid.apple.com", aud: "com.example.pusharmor", exp: Math.floor(Date.now() / 1000) + 60, nonce, email, email_verified: "true" });
    onVendor((r) => r.url === "https://appleid.apple.com/auth/token", () => Response.json({ id_token: "unused", refresh_token: secretString("apple-refresh-token-1") }));
    const r = await call("POST", "/v1/auth/apple/token", { id_token: tok, sign_pub: p1.signPub, purpose: "delete-account", code: secretString("apple-auth-code") });
    expect(r.status).toBe(200);
    secretString(r.body.ticket as string);
    expect(vendorRequests("appleid.apple.com").filter((x) => x.url.endsWith("/revoke"))).toHaveLength(0);
    const ex = vendorRequests("appleid.apple.com").find((x) => x.url.endsWith("/auth/token"))!;
    const form = new URLSearchParams(new TextDecoder().decode(ex.body));
    expect(form.get("client_id")).toBe("com.example.pusharmor");
    onVendor((x) => x.url.endsWith("/auth/revoke"), () => new Response(null, { status: 500 }));
    const d = await call("DELETE", "/v1/account", { ticket: r.body.ticket, sign_pub: p1.signPub, m: { [p2.id]: message(512) } }, { sign: p1.sign });
    expect(d.status).toBe(200);
    expect(d.body).toEqual({ r: { [p2.id]: "sent" }, deleted: 2 });
    const rev = vendorRequests("appleid.apple.com").filter((x) => x.url.endsWith("/revoke"));
    expect(rev).toHaveLength(1);
    const rf = new URLSearchParams(new TextDecoder().decode(rev[0].body));
    expect(rf.get("token")).toBe("apple-refresh-token-1");
    expect(rf.get("token_type_hint")).toBe("refresh_token");
    expect(mock.requests.length).toBeGreaterThan(0);
    expect(await testEnv()).toBeTruthy();
  });

  it("code only with purpose delete-account", async () => {
    const k = await keys();
    const r = await call("POST", "/v1/auth/apple/token", { id_token: "a.b.c", sign_pub: k.signPub, purpose: "register", code: "x" });
    expect(r.status).toBe(400);
  });
});
