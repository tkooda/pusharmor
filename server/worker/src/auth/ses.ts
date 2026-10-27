import { ApiError } from "../errors";
import { signV4 } from "./sigv4";

export interface SesEnv {
  AWS_SES_REGION: string;
  AWS_SES_MAIL_FROM: string;
  AWS_SES_CONFIG_SET: string;
  AWS_SES_ACCESS_KEY_ID: string;
  AWS_SES_SECRET_ACCESS_KEY: string;
}

// Sends a plain-text email through SESv2. Nothing is logged here on purpose.
export async function sendEmail(
  env: SesEnv,
  to: string,
  subject: string,
  text: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const url = `https://email.${env.AWS_SES_REGION}.amazonaws.com/v2/email/outbound-emails`;
  const body = new TextEncoder().encode(
    JSON.stringify({
      FromEmailAddress: env.AWS_SES_MAIL_FROM,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: { Text: { Data: text, Charset: "UTF-8" } },
        },
      },
      ConfigurationSetName: env.AWS_SES_CONFIG_SET,
    }),
  );
  let res: Response;
  try {
    const headers = await signV4({
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      body,
      accessKeyId: env.AWS_SES_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SES_SECRET_ACCESS_KEY,
      region: env.AWS_SES_REGION,
      service: "ses",
      now: new Date(),
    });
    res = await fetchFn(url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new ApiError(502, "email send failed");
  }
  if (res.status < 200 || res.status > 299) {
    try {
      await res.body?.cancel();
    } catch {
      // ignore
    }
    throw new ApiError(502, "email send failed");
  }
  await res.body?.cancel();
}
