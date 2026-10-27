import { describe, expect, it } from "vitest";
import { deriveSigningKey, signV4 } from "../src/auth/sigv4";
import { sendEmail, type SesEnv } from "../src/auth/ses";
import { ApiError } from "../src/errors";

const AK = "AKIDEXAMPLE";
const SK = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const NOW = new Date("2015-08-30T12:36:00Z");
const enc = new TextEncoder();

function base(over: Record<string, unknown>) {
  return {
    method: "GET",
    url: "https://example.amazonaws.com/",
    headers: { host: "example.amazonaws.com" },
    body: new Uint8Array(0),
    accessKeyId: AK,
    secretAccessKey: SK,
    region: "us-east-1",
    service: "service",
    now: NOW,
    ...over,
  } as Parameters<typeof signV4>[0];
}
const auth = (sig: string, signed: string) =>
  `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=${signed}, Signature=${sig}`;

describe("sigv4", () => {
  it("get-vanilla", async () => {
    const h = await signV4(base({}));
    expect(h["x-amz-date"]).toBe("20150830T123600Z");
    expect(h["authorization"]).toBe(
      auth("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31", "host;x-amz-date"),
    );
  });
  it("get-vanilla-query-order-key-case", async () => {
    const h = await signV4(base({ url: "https://example.amazonaws.com/?Param2=value2&Param1=value1" }));
    expect(h["authorization"]).toBe(
      auth("b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500", "host;x-amz-date"),
    );
  });
  it("post-x-www-form-urlencoded", async () => {
    const h = await signV4(
      base({
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", host: "example.amazonaws.com" },
        body: enc.encode("Param1=value1"),
      }),
    );
    expect(h["authorization"]).toBe(
      auth("ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a", "content-type;host;x-amz-date"),
    );
  });
  it("adds host when absent", async () => {
    const h = await signV4(base({ headers: {} }));
    expect(h["host"]).toBe("example.amazonaws.com");
    expect(h["authorization"]).toBe(
      auth("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31", "host;x-amz-date"),
    );
  });
  it("derives the documented signing key", async () => {
    const k = await deriveSigningKey(SK, "20120215", "us-east-1", "iam");
    const hex = [...k].map((x) => x.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe("f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d");
  });
});

describe("ses sendEmail", () => {
  const env: SesEnv = {
    AWS_SES_REGION: "eu-west-1",
    AWS_SES_MAIL_FROM: "noreply@example.com",
    AWS_SES_CONFIG_SET: "cfg",
    AWS_SES_ACCESS_KEY_ID: "AKIDTEST",
    AWS_SES_SECRET_ACCESS_KEY: "secret",
  };
  it("sends the expected signed request", async () => {
    let req: Request | undefined;
    const f = (async (u: string, init: RequestInit) => {
      req = new Request(u, init);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await sendEmail(env, "a@b.com", "Subj", "Body", f);
    expect(req!.url).toBe("https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails");
    expect(req!.method).toBe("POST");
    expect(req!.headers.get("content-type")).toBe("application/json");
    const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    expect(req!.headers.get("authorization")!.startsWith(
      `AWS4-HMAC-SHA256 Credential=AKIDTEST/${ymd}/eu-west-1/ses/aws4_request`,
    )).toBe(true);
    expect(JSON.parse(await req!.text())).toEqual({
      FromEmailAddress: "noreply@example.com",
      Destination: { ToAddresses: ["a@b.com"] },
      Content: {
        Simple: {
          Subject: { Data: "Subj", Charset: "UTF-8" },
          Body: { Text: { Data: "Body", Charset: "UTF-8" } },
        },
      },
      ConfigurationSetName: "cfg",
    });
  });
  it("maps a 400 to ApiError 502", async () => {
    const f = (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;
    const e = await sendEmail(env, "a@b.com", "s", "t", f).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(502);
    expect(e.word).toBe("email send failed");
  });
  it("maps a thrown fetch to ApiError 502", async () => {
    const f = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const e = await sendEmail(env, "a@b.com", "s", "t", f).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(502);
  });
});
