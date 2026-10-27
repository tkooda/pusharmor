// Shared route steps: signed prologue (5a-5c), caller checks (5d-5f), ticket check,
// relay of an "m" map, UnifiedPush probe.
import type { Ctx } from "../context";
import { nowS } from "../context";
import { b64urlEncode } from "../codec/b64url";
import { pushSha256 } from "../codec/validate";
import { rawPoint } from "../crypto/ecdsa";
import { hmac, utf8 } from "../crypto/hash";
import { keyRef, LABEL_TICKET, openToken, type Purpose, type Ticket } from "../crypto/tokens";
import { ApiError } from "../errors";
import { allow, enforce } from "../pipeline/limits";
import { checkKeyhash, checkPaId, checkSig, checkTime } from "../pipeline/signed";
import { relayFilter, type RelayRow } from "../db/rows";
import { fanout, sendProbe, writeBack, type Target } from "../push/fanout";
import type { Cls } from "../push/deps";

export interface Signed {
  me: string;
  acct: string;
  paTime: string;
}

// Steps a, b, c.
export async function signedStart(c: Ctx): Promise<Signed> {
  const paTime = checkTime(c.req.headers, Date.now());
  const me = await checkPaId(c.env.PA_ID_SECRET, c.req.headers);
  c.log.peer = me;
  c.log.account = me.slice(0, 12);
  await enforce(c.env, "RL_PEER", "id:" + me, c.log);
  return { me, acct: me.slice(0, 12), paTime };
}

export interface CallerRow {
  sign_pub: string;
  enc_pub: string;
  paused: number;
}

// Steps d, e, f.
export async function callerCheck(c: Ctx, s: Signed, row: CallerRow | undefined | null, allowPaused = false): Promise<void> {
  if (!row) throw new ApiError(401, "unknown peer");
  await checkSig(row.sign_pub, c.req.headers, c.method, c.path, s.paTime, c.body);
  await checkKeyhash(s.me, row.sign_pub, row.enc_pub);
  if (row.paused === 1 && !allowPaused) throw new ApiError(401, "paused");
}

// Ticket check: MAC, purpose, k, expiry (and account when given).
export async function checkTicket(c: Ctx, ticket: unknown, purpose: Purpose, signPub: string, acct?: string): Promise<Ticket> {
  const t = await openToken(c.env.PA_TOKEN_SECRET, LABEL_TICKET, ticket);
  const raw = rawPoint(signPub);
  if (!t || !raw) throw new ApiError(401, "invalid ticket");
  if (t.p !== purpose || t.k !== (await keyRef(raw)) || typeof t.a !== "string" || !/^[A-Za-z0-9_-]{12}$/.test(t.a)) {
    throw new ApiError(401, "invalid ticket");
  }
  if (acct !== undefined && t.a !== acct) throw new ApiError(401, "invalid ticket");
  if (typeof t.x !== "number" || t.x < nowS()) throw new ApiError(401, "ticket expired");
  return t as unknown as Ticket;
}

// Relays an "m" map: filter each id, fan out the rest, best-effort gone write-back.
export async function relayMap(
  c: Ctx,
  acct: string,
  m: Record<string, string>,
  rowOf: (id: string) => RelayRow | undefined,
  cls: Cls,
  extraWrites: D1PreparedStatement[] = [],
): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  const targets: Target[] = [];
  for (const [id, msg] of Object.entries(m)) {
    const row = rowOf(id);
    const f = relayFilter(row);
    if (f !== null) results[id] = f;
    else targets.push({ id, pushType: row!.push_type!, push: row!.push!, m: msg, cls });
  }
  const out = await fanout(c.env, targets, c.log);
  Object.assign(results, out.results);
  await writeBack(c.env, acct, out.gone, extraWrites, c.log);
  return results;
}

// Probe code for one 300 s window.
export async function probeCode(secret: string, id: string, fields: Record<string, unknown>, windowIdx: number): Promise<string> {
  const ps = await pushSha256(fields);
  const mac = await hmac(secret, utf8("PA-CONF1\n" + id + "\n" + ps + "\n" + windowIdx));
  return b64urlEncode(mac.slice(0, 16));
}

// Sends the UnifiedPush probe after the reply (ctx.waitUntil); never fails the call.
export function scheduleProbe(c: Ctx, id: string, fields: Record<string, string>): void {
  const env = c.env;
  const log = c.log;
  c.exec.waitUntil(
    (async () => {
      try {
        if (!(await allow(env, "RL_PROBE", "probe:" + id, log))) return;
        const code = await probeCode(env.PA_CONFIRM_SECRET, id, fields, Math.floor(nowS() / 300));
        await sendProbe(env, { endpoint: fields.endpoint, p256dh: fields.p256dh, auth: fields.auth }, code);
      } catch {
        // best effort
      }
    })(),
  );
}

export function withPushMissing(body: Record<string, unknown>, pushIsNull: boolean): Record<string, unknown> {
  if (pushIsNull) body.push_missing = true;
  return body;
}
