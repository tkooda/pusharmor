// POST /auth/email and POST /auth/email/verify.
import type { Ctx } from "../context";
import { nowS } from "../context";
import { b64urlDecode, b64urlEncode } from "../codec/b64url";
import { bad, keysExactly } from "../codec/validate";
import { checkCode, deriveCode } from "../crypto/code";
import { importVerifyKey, rawPoint } from "../crypto/ecdsa";
import { accountId, emailHash } from "../crypto/ids";
import {
  keyRef,
  LABEL_REQUEST_TOKEN,
  makeTicket,
  makeToken,
  openToken,
  PURPOSES,
  REQUEST_TOKEN_LIFE_S,
  TICKET_LIFE_S,
  type Purpose,
} from "../crypto/tokens";
import { ApiError } from "../errors";
import { json } from "../http";
import { parseJsonObject } from "../pipeline/body";
import { enforce } from "../pipeline/limits";
import { deps } from "../push/deps";
import { normalizeEmail } from "./normalize";
import { sendEmail } from "./ses";
import { verifyTurnstile } from "./turnstile";

const ENDING = "Nothing happens unless this code is entered within 15 minutes. If you did not request it, ignore this email.";

export function mailText(purpose: Purpose, code: string): { subject: string; text: string } {
  const what =
    purpose === "register"
      ? "Your PushArmor sign-in code is"
      : purpose === "unpause"
        ? "Your PushArmor code to resume receiving is"
        : "Your PushArmor code to delete your account is";
  const subject =
    purpose === "register"
      ? "your PushArmor sign-in code"
      : purpose === "unpause"
        ? "your PushArmor resume code"
        : "your PushArmor account deletion code";
  return { subject, text: `${what}:\n\n${code}\n\n${ENDING}\n` };
}

export function checkPurpose(v: unknown): Purpose {
  if (typeof v !== "string" || !(PURPOSES as readonly string[]).includes(v)) throw bad();
  return v as Purpose;
}

export async function checkSignPub(v: unknown): Promise<Uint8Array> {
  const raw = rawPoint(v);
  if (!raw || !(await importVerifyKey(raw))) throw bad();
  return raw;
}

export async function start(c: Ctx): Promise<Response> {
  const b = parseJsonObject(c.body);
  keysExactly(b, ["email", "sign_pub", "purpose", "turnstile"]);
  const raw = await checkSignPub(b.sign_pub);
  const purpose = checkPurpose(b.purpose);
  if (typeof b.email !== "string" || typeof b.turnstile !== "string" || b.turnstile.length === 0 || b.turnstile.length > 4096) throw bad();
  await verifyTurnstile(c.env, b.turnstile, c.req.headers.get("CF-Connecting-IP"));
  const email = normalizeEmail(b.email);
  const eh = b64urlEncode(await emailHash(email));
  await enforce(c.env, "RL_MAIL", "mail:" + eh, c.log);
  // Per IP (a limiter key only, never stored): address variants from one IP share this cap.
  await enforce(c.env, "RL_MAIL", "mailip:" + (c.req.headers.get("CF-Connecting-IP") ?? ""), c.log);
  await enforce(c.env, "RL_MAIL_ALL", "mail:all", c.log);
  const token = await makeToken(c.env.PA_TOKEN_SECRET, LABEL_REQUEST_TOKEN, { t: nowS(), e: eh, m: email, k: await keyRef(raw), p: purpose });
  const code = await deriveCode(c.env.PA_CODE_SECRET, token);
  const mail = mailText(purpose, code);
  await sendEmail(c.env, email, mail.subject, mail.text, ((u: string, i: RequestInit) => deps.fetch(u, i)) as unknown as typeof fetch);
  return json(200, { request_token: token });
}

export async function verify(c: Ctx): Promise<Response> {
  const b = parseJsonObject(c.body);
  keysExactly(b, ["request_token", "code"]);
  if (typeof b.request_token !== "string" || typeof b.code !== "string" || !/^[0-9A-Za-z]{6}$/.test(b.code)) throw bad();
  const rt = await openToken(c.env.PA_TOKEN_SECRET, LABEL_REQUEST_TOKEN, b.request_token);
  if (!rt || typeof rt.t !== "number" || typeof rt.e !== "string" || typeof rt.m !== "string" || typeof rt.k !== "string") {
    throw new ApiError(401, "wrong code");
  }
  const purpose = checkPurpose(rt.p);
  if (nowS() - rt.t > REQUEST_TOKEN_LIFE_S) throw new ApiError(401, "code expired");
  // Per request token, so wrong guesses on one token cannot lock out a later token for the same email;
  // codeall: is the looser cap over every token of one email. It is checked before the code, so a
  // correct guess cannot pass once the cap is spent; the limit binding has no read-only check, so
  // this also charges the one correct guess of a sign-in.
  await enforce(c.env, "RL_CODE", "code:" + rt.e + ":" + b.request_token.slice(b.request_token.lastIndexOf(".") + 1), c.log);
  await enforce(c.env, "RL_CODE_ALL", "codeall:" + rt.e, c.log);
  if (!(await checkCode(c.env.PA_CODE_SECRET, b.request_token, b.code))) throw new ApiError(401, "wrong code");
  const eh = b64urlDecode(rt.e);
  if (!eh || eh.length !== 32) throw new ApiError(401, "wrong code");
  const a = await accountId(c.env.PA_ID_SECRET, eh);
  const ticket = await makeTicket(c.env.PA_TOKEN_SECRET, { a, k: rt.k, p: purpose, x: nowS() + TICKET_LIFE_S });
  return json(200, { ticket, email: rt.m });
}
