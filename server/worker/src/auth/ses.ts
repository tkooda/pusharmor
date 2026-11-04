import { ApiError } from "../errors";
import type { Log } from "../log";
import { cleanMsg } from "../push/results";
import { signV4 } from "./sigv4";

export interface SesEnv {
  AWS_SES_REGION: string;
  AWS_SES_MAIL_FROM: string;
  AWS_SES_CONFIG_SET: string;
  AWS_SES_ACCESS_KEY_ID: string;
  AWS_SES_SECRET_ACCESS_KEY: string;
}

// Sends a plain-text email through SESv2. On a failure it logs only the SES status, an error
// code, and a cleaned message (log.extra ses_status, ses_code, ses_msg); never the recipient,
// credentials, or the code.
export async function sendEmail(
  env: SesEnv,
  to: string,
  subject: string,
  text: string,
  fetchFn: typeof fetch = fetch,
  log?: Log,
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
  } catch (e) {
    if (log) log.extra.ses_exception = e instanceof Error && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : typeof e;
    throw new ApiError(502, "email send failed");
  }
  if (res.status < 200 || res.status > 299) {
    if (log) await logSesFailure(res, log);
    try {
      await res.body?.cancel();
    } catch {
      // ignore
    }
    throw new ApiError(502, "email send failed");
  }
  await res.body?.cancel();
}

const SES_BODY_MAX = 2048;
const SES_CODE = /^[A-Za-z][A-Za-z0-9_.:]{0,63}$/;

// Reads at most SES_BODY_MAX bytes of a failed response and logs its status, error code, and
// cleaned message. Email addresses in the message are redacted.
async function logSesFailure(res: Response, log: Log): Promise<void> {
  log.extra.ses_status = res.status;
  let code = res.headers.get("x-amzn-ErrorType")?.split(":")[0];
  let msg: unknown;
  try {
    const reader = res.body?.getReader();
    let text = "";
    if (reader) {
      const dec = new TextDecoder();
      while (text.length < SES_BODY_MAX) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
      }
      await reader.cancel().catch(() => undefined);
    }
    const j = JSON.parse(text.slice(0, SES_BODY_MAX));
    if (typeof j?.__type === "string") code = code ?? j.__type.split("#").pop();
    msg = j?.message ?? j?.Message;
  } catch {
    // body missing, cut, or not JSON
  }
  if (code && SES_CODE.test(code)) log.extra.ses_code = code;
  const m = cleanMsg(typeof msg === "string" ? msg.replace(/[^\s@<>"']+@[^\s@<>"']+/g, "[email]") : undefined);
  if (m) log.extra.ses_msg = m;
}
