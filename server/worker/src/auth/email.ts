// POST /auth/email and POST /auth/email/verify.
import type { Ctx } from "../context";
import { nowS } from "../context";
import { b64urlDecode, b64urlEncode } from "../codec/b64url";
import { bad, keysExactly } from "../codec/validate";
import { checkCode, deriveCode } from "../crypto/code";
import { importVerifyKey, rawPoint } from "../crypto/ecdsa";
import { accountId, emailHash } from "../crypto/ids";
import {
  CLI_WINDOW_S,
  keyRef,
  makeCliCode,
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
import { enforce, ipKey } from "../pipeline/limits";
import { deps } from "../push/deps";
import { mailboxKey, normalizeEmail } from "./normalize";
import { sendEmail } from "./ses";
import { verifyTurnstile } from "./turnstile";

const ENDING = "Nothing happens unless this code is entered within 15 minutes. If you did not request it, ignore this email.";

export function mailText(purpose: Purpose, code: string): { subject: string; text: string } {
  const what =
    purpose === "register"
      ? "Your PushArmor login code is"
      : purpose === "login"
        ? "Your PushArmor code to log in again is"
        : "Your PushArmor code to delete your account is";
  const subject =
    purpose === "register"
      ? "your PushArmor login code"
      : purpose === "login"
        ? "your PushArmor code to log in again"
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

// cli_k: k16 of the CLI's sign_pub (22 chars), from the /auth/cli link.
export function checkCliK(v: unknown): string {
  if (typeof v !== "string" || v.length !== 22 || b64urlDecode(v)?.length !== 16) throw bad();
  return v;
}

export async function start(c: Ctx): Promise<Response> {
  const b = parseJsonObject(c.body);
  // The /auth/cli page sends cli_k instead of sign_pub; verify then returns a cli code.
  const cli = "cli_k" in b;
  keysExactly(b, ["email", cli ? "cli_k" : "sign_pub", "purpose", "turnstile"]);
  const k = cli ? checkCliK(b.cli_k) : await keyRef(await checkSignPub(b.sign_pub));
  const purpose = checkPurpose(b.purpose);
  if (typeof b.email !== "string" || typeof b.turnstile !== "string" || b.turnstile.length === 0 || b.turnstile.length > 4096) throw bad();
  await verifyTurnstile(c.env, b.turnstile, c.req.headers.get("CF-Connecting-IP"));
  const email = normalizeEmail(b.email);
  const eh = b64urlEncode(await emailHash(email));
  // Per mailbox (+tag and Gmail dot variants share it); a limiter key only, never stored.
  await enforce(c.env, "RL_MAIL", "mail:" + b64urlEncode(await emailHash(mailboxKey(email))), c.log);
  // Per IP (a limiter key only, never stored): address variants from one IP share this cap.
  // IPv6 by its /64 like RL_IP, so one /64 cannot rotate source addresses (I446).
  await enforce(c.env, "RL_MAIL", "mail" + ipKey(c.req.headers.get("CF-Connecting-IP") ?? ""), c.log);
  await enforce(c.env, "RL_MAIL_ALL", "mail:all", c.log);
  const token = await makeToken(c.env.PA_TOKEN_SECRET, LABEL_REQUEST_TOKEN, { t: nowS(), e: eh, m: email, k, p: purpose, ...(cli ? { c: 1 } : {}) });
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
  // this also charges the one correct guess of a register code. Keyed per purpose, so guesses on register
  // tokens cannot lock out a login or delete code for the same email (I408).
  await enforce(c.env, "RL_CODE", "code:" + rt.e + ":" + b.request_token.slice(b.request_token.lastIndexOf(".") + 1), c.log);
  await enforce(c.env, "RL_CODE_ALL", "codeall:" + purpose + ":" + rt.e, c.log);
  if (!(await checkCode(c.env.PA_CODE_SECRET, b.request_token, b.code))) throw new ApiError(401, "wrong code");
  const eh = b64urlDecode(rt.e);
  if (!eh || eh.length !== 32) throw new ApiError(401, "wrong code");
  const a = await accountId(c.env.PA_ID_SECRET, eh);
  if (rt.c === 1) return json(200, { cli_code: await makeCliCode(c.env.PA_TOKEN_SECRET, a, rt.k, purpose, Math.floor(nowS() / CLI_WINDOW_S)), email: rt.m });
  const ticket = await makeTicket(c.env.PA_TOKEN_SECRET, { a, k: rt.k, p: purpose, x: nowS() + TICKET_LIFE_S });
  return json(200, { ticket, email: rt.m });
}
