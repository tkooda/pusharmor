// POST /approve/$X, POST /deny/$X (incl. withdraw).
import type { Ctx } from "../context";
import { nowS } from "../context";
import { bad, checkMessage, checkNameEntry, keysExactly, requireAccount } from "../codec/validate";
import { parseJsonObject } from "../pipeline/body";
import { enforce } from "../pipeline/limits";
import { ApiError } from "../errors";
import * as SQL from "../db/sql";
import { dbFor } from "../db/shard";
import { all, batch } from "../db/d1";
import { isUnconfirmedUp, type CtxRow } from "../db/rows";
import { fanout, writeBack } from "../push/fanout";
import type { Cls } from "../push/deps";
import { callerCheck, signedStart, withPushMissing, type Signed } from "./common";
import { json } from "../http";

export function targetX(c: Ctx, s: Signed): string {
  const x = c.params[0];
  if (x === s.me) throw bad();
  requireAccount([x], s.acct);
  return x;
}

export async function readCtxX(c: Ctx, s: Signed, x: string): Promise<{ caller?: CtxRow; xr?: CtxRow }> {
  const rows = await all<CtxRow>(c.log, dbFor(c.env, s.acct).prepare(SQL.Q_CTX(1)).bind(s.me, s.acct, x));
  return { caller: rows.find((r) => r.id === s.me), xr: rows.find((r) => r.id === x) };
}

// Relays one message to X (paused, gone and unconfirmed checks first). Returns the result word.
export async function relayOne(c: Ctx, s: Signed, xr: CtxRow, msg: string, cls: Cls, pk?: string): Promise<string> {
  if (xr.paused === 1) return "paused";
  if (xr.push === null || xr.push_type === null) return "gone";
  if (isUnconfirmedUp(xr.push_type, xr.push)) return "failed";
  const out = await fanout(c.env, [{ id: xr.id, pushType: xr.push_type, push: xr.push, m: msg, cls, pk }], c.log);
  await writeBack(c.env, s.acct, out.gone, [], c.log);
  return out.results[xr.id];
}

// Empty RETURNING: caller gone -> 401 "unknown peer", else X gone -> "unknown".
async function emptyReturning(c: Ctx, s: Signed): Promise<Response> {
  const self = await all(c.log, dbFor(c.env, s.acct).prepare(SQL.Q_SELF).bind(s.me, s.acct));
  if (!self.length) throw new ApiError(401, "unknown peer");
  return json(200, { r: "unknown" });
}

export async function approve(c: Ctx): Promise<Response> {
  const b = parseJsonObject(c.body);
  keysExactly(b, ["c", "name"]);
  const msg = checkMessage(b.c);
  const name = checkNameEntry(b.name);
  const s = await signedStart(c);
  const x = targetX(c, s);
  const { caller, xr } = await readCtxX(c, s, x);
  await callerCheck(c, s, caller);
  const pm = caller!.push === null;
  if (!xr) return json(200, withPushMissing({ r: "unknown" }, pm));
  await enforce(c.env, "RL_PAIR", "id:" + s.me + x, c.log);
  if (xr.denies_me === 1) return json(200, withPushMissing({ r: "denied" }, pm));
  const rs = await batch(c.log, dbFor(c.env, s.acct), [dbFor(c.env, s.acct).prepare(SQL.W_APPROVE).bind(s.me, s.acct, x, name, msg, nowS())]);
  const ret = rs[0].results[0] as { stored: number; c_x: string | null } | undefined;
  if (!ret) return emptyReturning(c, s);
  if (ret.stored === 1) return json(200, withPushMissing({ r: "stored" }, pm));
  const r = await relayOne(c, s, xr, msg, "approve");
  const body: Record<string, unknown> = { r };
  if (ret.c_x !== null) body.c = ret.c_x;
  return json(200, withPushMissing(body, pm));
}

export async function deny(c: Ctx): Promise<Response> {
  const b = parseJsonObject(c.body);
  if ("withdraw" in b) {
    keysExactly(b, ["withdraw"]);
    if (b.withdraw !== 1) throw bad();
    const s = await signedStart(c);
    const x = targetX(c, s);
    const self = (await all<{ sign_pub: string; enc_pub: string; paused: number; push: string | null }>(c.log, dbFor(c.env, s.acct).prepare(SQL.Q_SELF).bind(s.me, s.acct)))[0];
    await callerCheck(c, s, self, true);
    await enforce(c.env, "RL_PAIR", "deny:" + s.me + x, c.log);
    const rs = await batch(c.log, dbFor(c.env, s.acct), [dbFor(c.env, s.acct).prepare(SQL.W_WITHDRAW).bind(s.me, s.acct, x)]);
    if (rs[0].results.length === 0) throw new ApiError(401, "unknown peer");
    return json(200, withPushMissing({ r: "unapproved" }, self!.push === null));
  }
  keysExactly(b, ["c"]);
  const msg = checkMessage(b.c);
  const s = await signedStart(c);
  const x = targetX(c, s);
  const { caller, xr } = await readCtxX(c, s, x);
  await callerCheck(c, s, caller);
  const pm = caller!.push === null;
  if (!xr) return json(200, withPushMissing({ r: "unknown" }, pm));
  await enforce(c.env, "RL_PAIR", "deny:" + s.me + x, c.log);
  const rs = await batch(c.log, dbFor(c.env, s.acct), [dbFor(c.env, s.acct).prepare(SQL.W_DENY).bind(s.me, s.acct, x)]);
  if (rs[0].results.length === 0) return emptyReturning(c, s);
  let r: string;
  if (xr.denies_me === 1) r = "denied";
  else if (xr.approves_me !== 1) r = "unapproved";
  else r = await relayOne(c, s, xr, msg, "deny");
  return json(200, withPushMissing({ r }, pm));
}
