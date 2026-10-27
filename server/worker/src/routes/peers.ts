// POST /peers, GET /peers, PATCH/DELETE /peers/$id, POST pause, unpause, confirm.
import type { Ctx } from "../context";
import { nowS } from "../context";
import {
  bad,
  checkMessageMap,
  checkNameMap,
  checkPlatform,
  checkPush,
  fitsPlatform,
  isId,
  keysExactly,
  requireAccount,
  storedWithoutVerified,
  type PushValue,
} from "../codec/validate";
import { parseJsonObject } from "../pipeline/body";
import { importEcdhPub, importVerifyKey, rawPoint } from "../crypto/ecdsa";
import { peerId } from "../crypto/ids";
import { ctEqualStr } from "../crypto/hash";
import { makeTicket, TICKET_LIFE_PEER_LIMIT_S } from "../crypto/tokens";
import { ApiError } from "../errors";
import { checkSig, checkTime } from "../pipeline/signed";
import * as SQL from "../db/sql";
import { all, batch } from "../db/d1";
import { ctxRelayRow, limitPeers, listBody, myAllowKeys, type CtxRow, type ListRow } from "../db/rows";
import { callerCheck, checkTicket, probeCode, relayMap, scheduleProbe, signedStart, withPushMissing } from "./common";
import { json } from "../http";

interface SelfRow {
  sign_pub: string;
  enc_pub: string;
  platform: string;
  push_type: number | null;
  push: string | null;
  push_missing: number;
  paused: number;
  allow: string;
}

function pushOrNull(c: Ctx, v: unknown): Promise<PushValue | null> {
  if (v === null) return Promise.resolve(null);
  return checkPush(v, c.env.ALLOWED_PUSH_ENDPOINT_PREFIXES, (r) => (c.log.endpoint_reject = r));
}

// PATCH skip rule: stored push confirmed and equal to the incoming push without verified_at.
function skipPushWrite(stored: string | null, incoming: PushValue | null): boolean {
  if (stored === null || incoming === null) return false;
  const s = storedWithoutVerified(stored);
  return s.verified && s.base === incoming.stored;
}

// ---------- POST /peers ----------
export async function register(c: Ctx): Promise<Response> {
  const b = parseJsonObject(c.body);
  keysExactly(b, ["ticket", "sign_pub", "enc_pub", "platform", "push"], ["evict"]);
  const signRaw = rawPoint(b.sign_pub);
  const encRaw = rawPoint(b.enc_pub);
  if (!signRaw || !encRaw || !(await importVerifyKey(signRaw)) || !(await importEcdhPub(encRaw))) throw bad();
  const signPub = b.sign_pub as string;
  const encPub = b.enc_pub as string;
  if (signPub === encPub) throw bad();
  const platform = checkPlatform(b.platform);
  const push = await pushOrNull(c, b.push);
  if (push && !fitsPlatform(platform, push.pushType)) throw bad();
  let evict: string[] = [];
  if (b.evict !== undefined) {
    if (!Array.isArray(b.evict) || b.evict.length > 9 || !b.evict.every(isId)) throw bad();
    evict = b.evict as string[];
    if (new Set(evict).size !== evict.length) throw bad();
  }

  const ticket = await checkTicket(c, b.ticket, "register", signPub);
  const acct = ticket.a;
  const paTime = checkTime(c.req.headers, Date.now());
  await checkSig(signPub, c.req.headers, c.method, c.path, paTime, c.body);
  const id = await peerId(c.env.ID_SECRET, acct, signRaw, encRaw);
  c.log.account = acct;
  c.log.peer = id;
  requireAccount(evict, acct);
  if (evict.includes(id)) throw bad();

  const reg = (
    await all<{ status: string | null; old_sign: string | null; old_enc: string | null; old_platform: string | null; old_push: string | null; evict_found: number }>(
      c.log,
      c.env.DB.prepare(SQL.Q_REG).bind(acct, id, JSON.stringify(evict)),
    )
  )[0];
  if (reg.status === "banned") throw new ApiError(403, "banned");
  if (reg.evict_found !== evict.length) throw bad();
  if (reg.old_sign !== null && (reg.old_sign !== signPub || reg.old_enc !== encPub)) throw new ApiError(409, "id collision");

  const now = nowS();
  const listStmt = c.env.DB.prepare(SQL.Q_LIST).bind(id, acct);
  let rows: ListRow[];
  let pushWritten = false;
  if (reg.old_sign !== null) {
    // Re-register.
    if (reg.old_platform !== platform) throw bad();
    if (skipPushWrite(reg.old_push, push)) {
      rows = await all<ListRow>(c.log, listStmt);
    } else {
      const rs = await batch(c.log, c.env.DB, [
        c.env.DB.prepare(SQL.W_PUSH).bind(id, acct, push ? push.stored : null, push ? push.pushType : null),
        listStmt,
      ]);
      rows = rs[1].results as ListRow[];
      pushWritten = true;
    }
  } else {
    const stmts: D1PreparedStatement[] = [];
    for (const e of evict) stmts.push(c.env.DB.prepare(SQL.W_DEL).bind(e, acct), c.env.DB.prepare(SQL.W_PRUNE).bind(e, acct));
    stmts.push(
      c.env.DB.prepare(SQL.W_ACCT).bind(acct, now),
      c.env.DB.prepare(SQL.W_REG).bind(id, acct, signPub, encPub, push ? push.pushType : null, push ? push.stored : null, now, platform),
      listStmt,
    );
    const rs = await batch(c.log, c.env.DB, stmts);
    const regRes = rs[rs.length - 2];
    rows = rs[rs.length - 1].results as ListRow[];
    if (regRes.meta.changes === 0) {
      const fresh = await makeTicket(c.env.TOKEN_SECRET, { a: acct, k: ticket.k, p: "register", x: now + TICKET_LIFE_PEER_LIMIT_S });
      throw new ApiError(409, "peer limit", { ticket: fresh, peers: limitPeers(rows) });
    }
    pushWritten = push !== null;
  }
  if (pushWritten && push && push.pushType === 6) scheduleProbe(c, id, push.fields);
  const body = await listBody(rows, id);
  body.id = id;
  const self = rows.find((r) => r.id === id);
  return json(200, withPushMissing(body, !self || self.my_push === null));
}

// ---------- GET /peers ----------
export async function list(c: Ctx): Promise<Response> {
  if (c.body.length !== 0) throw bad();
  const s = await signedStart(c);
  const rows = await all<ListRow>(c.log, c.env.DB.prepare(SQL.Q_LIST).bind(s.me, s.acct));
  const self = rows.find((r) => r.id === s.me);
  await callerCheck(c, s, self);
  return json(200, withPushMissing(await listBody(rows, s.me), self!.my_push === null));
}

function selfPath(c: Ctx, s: { me: string }): void {
  if (c.params[0] !== s.me) throw bad();
}

async function readSelf(c: Ctx, me: string, acct: string): Promise<SelfRow | undefined> {
  return (await all<SelfRow>(c.log, c.env.DB.prepare(SQL.Q_SELF).bind(me, acct)))[0];
}

async function readCtx(c: Ctx, me: string, acct: string, ids: string[]): Promise<{ caller?: CtxRow; byId: Map<string, CtxRow> }> {
  const rows = await all<CtxRow>(c.log, c.env.DB.prepare(SQL.Q_CTX).bind(me, acct, JSON.stringify(ids)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { caller: byId.get(me), byId };
}

// ---------- PATCH /peers/$id ----------
export async function patch(c: Ctx): Promise<Response> {
  const b = parseJsonObject(c.body);
  if ("push" in b) {
    keysExactly(b, ["push"]);
    const push = await pushOrNull(c, b.push);
    const s = await signedStart(c);
    selfPath(c, s);
    const self = await readSelf(c, s.me, s.acct);
    await callerCheck(c, s, self);
    if (push && !fitsPlatform(self!.platform as never, push.pushType)) throw bad();
    if (!skipPushWrite(self!.push, push)) {
      await batch(c.log, c.env.DB, [c.env.DB.prepare(SQL.W_PUSH).bind(s.me, s.acct, push ? push.stored : null, push ? push.pushType : null)]);
      if (push && push.pushType === 6) scheduleProbe(c, s.me, push.fields);
    }
    return json(200, withPushMissing({}, push === null));
  }
  keysExactly(b, ["name", "m"]);
  const names = checkNameMap(b.name);
  const m = checkMessageMap(b.m);
  const s = await signedStart(c);
  selfPath(c, s);
  requireAccount([...Object.keys(names), ...Object.keys(m)], s.acct);
  const { caller, byId } = await readCtx(c, s.me, s.acct, Object.keys(m));
  await callerCheck(c, s, caller);
  const myAllow = new Set(myAllowKeys(caller!.my_allow));
  const kept = Object.entries(names).filter(([id]) => myAllow.has(id));
  if (kept.length) {
    const args: unknown[] = [s.me, s.acct];
    for (const [id, entry] of kept) args.push(id, entry);
    const rs = await batch(c.log, c.env.DB, [c.env.DB.prepare(SQL.W_NAME(kept.length)).bind(...args)]);
    if (rs[0].results.length === 0) {
      if (!(await readSelf(c, s.me, s.acct))) throw new ApiError(401, "unknown peer");
      throw bad();
    }
  }
  const r = await relayMap(c, s.acct, m, (id) => ctxRelayRow(byId.get(id)), "peerchg");
  return json(200, withPushMissing({ r }, caller!.push === null));
}

// ---------- DELETE /peers/$id ----------
export async function remove(c: Ctx): Promise<Response> {
  const b = parseJsonObject(c.body);
  keysExactly(b, ["m"]);
  const m = checkMessageMap(b.m);
  const target = c.params[0];
  const s = await signedStart(c);
  requireAccount([target, ...Object.keys(m)], s.acct);
  const { caller, byId } = await readCtx(c, s.me, s.acct, [target, ...Object.keys(m)]);
  await callerCheck(c, s, caller, target === s.me);
  if (byId.has(target)) {
    await batch(c.log, c.env.DB, [c.env.DB.prepare(SQL.W_DEL).bind(target, s.acct), c.env.DB.prepare(SQL.W_PRUNE).bind(target, s.acct)]);
  }
  const r = await relayMap(c, s.acct, m, (id) => ctxRelayRow(byId.get(id)), "peerchg");
  return json(200, withPushMissing({ r }, caller!.push === null));
}

// ---------- POST /peers/$id/pause and /unpause ----------
async function pauseCommon(c: Ctx, paused: 0 | 1): Promise<Response> {
  const b = parseJsonObject(c.body);
  if (paused === 1) keysExactly(b, ["m"]);
  else keysExactly(b, ["ticket", "m"]);
  const m = checkMessageMap(b.m);
  const s = await signedStart(c);
  selfPath(c, s);
  requireAccount(Object.keys(m), s.acct);
  const { caller, byId } = await readCtx(c, s.me, s.acct, Object.keys(m));
  await callerCheck(c, s, caller, paused === 0);
  const missing = myAllowKeys(caller!.my_allow).filter((id) => !(id in m));
  if (missing.length) throw new ApiError(400, "messages missing", { ids: missing });
  if (paused === 0) await checkTicket(c, b.ticket, "unpause", caller!.sign_pub, s.acct);
  await batch(c.log, c.env.DB, [c.env.DB.prepare(SQL.W_PAUSE).bind(s.me, s.acct, paused)]);
  const r = await relayMap(c, s.acct, m, (id) => ctxRelayRow(byId.get(id)), "pause");
  return json(200, withPushMissing({ r }, caller!.push === null));
}

export function pause(c: Ctx): Promise<Response> {
  return pauseCommon(c, 1);
}

export function unpause(c: Ctx): Promise<Response> {
  return pauseCommon(c, 0);
}

// ---------- POST /peers/$id/confirm ----------
export async function confirm(c: Ctx): Promise<Response> {
  const b = parseJsonObject(c.body);
  keysExactly(b, ["code"]);
  if (typeof b.code !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(b.code)) throw bad();
  const s = await signedStart(c);
  selfPath(c, s);
  const self = await readSelf(c, s.me, s.acct);
  await callerCheck(c, s, self);
  if (self!.push === null || self!.push_type !== 6) throw bad();
  const fields = JSON.parse(self!.push) as Record<string, unknown>;
  delete fields.verified_at;
  const now = nowS();
  const w = Math.floor(now / 300);
  const ok =
    ctEqualStr(b.code, await probeCode(c.env.CONFIRM_SECRET, s.me, fields, w)) ||
    ctEqualStr(b.code, await probeCode(c.env.CONFIRM_SECRET, s.me, fields, w - 1));
  if (!ok) throw new ApiError(401, "wrong code");
  await batch(c.log, c.env.DB, [c.env.DB.prepare(SQL.W_CONFIRM).bind(s.me, s.acct, now, self!.push)]);
  return json(200, {});
}

