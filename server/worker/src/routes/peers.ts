// POST /peers, GET /peers, PATCH/DELETE /peers/$id, POST logout, login, confirm.
import type { Ctx } from "../context";
import { dayStart, monthStart, nowS } from "../context";
import {
  bad,
  checkMessageMap,
  checkNameMap,
  checkPlatform,
  checkPush,
  checkPushPlatform,
  isId,
  keysExactly,
  requireAccount,
  type PushValue,
} from "../codec/validate";
import { parseJsonObject } from "../pipeline/body";
import { importEcdhPub, importVerifyKey, rawPoint } from "../crypto/ecdsa";
import { peerId } from "../crypto/ids";
import { ctEqualStr } from "../crypto/hash";
import { makeTicket, TICKET_LIFE_PEER_LIMIT_S, TICKET_LIFE_S, TICKET_RENEW_MAX_S } from "../crypto/tokens";
import { ApiError } from "../errors";
import { checkSig, checkTime } from "../pipeline/signed";
import { enforceAccount } from "../pipeline/limits";
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
  push_verified_at: number | null;
  push_missing: number;
  logged_out: number;
  allow: string;
  push_failed: number | null;
}

function pushOrNull(c: Ctx, v: unknown): Promise<PushValue | null> {
  if (v === null) return Promise.resolve(null);
  return checkPush(v, c.env.PA_ALLOWED_PUSH_ENDPOINT_PREFIXES, c.env.PA_ALLOWED_UP_HOSTS, (r) => (c.log.endpoint_reject = r));
}

// PATCH skip rule: stored push confirmed (push_verified_at set) and equal to the incoming push.
// confirmed is the stored push, or null while push_verified_at is NULL.
function skipPushWrite(confirmed: string | null, incoming: PushValue | null): boolean {
  return confirmed !== null && incoming !== null && confirmed === incoming.stored;
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
  if (push) checkPushPlatform(platform, push);
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
  const id = await peerId(c.env.PA_ID_SECRET, acct, signRaw, encRaw);
  c.log.account = acct;
  c.log.peer = id;
  requireAccount(evict, acct);
  if (evict.includes(id)) throw bad();
  await enforceAccount(c.env, acct, c.log);

  const reg = (
    await all<{ status: string | null; old_sign: string | null; old_enc: string | null; old_platform: string | null; old_confirmed_push: string | null; evict_found: number }>(c.env.DB.prepare(SQL.Q_REG).bind(acct, id, JSON.stringify(evict)),
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
    if (skipPushWrite(reg.old_confirmed_push, push)) {
      rows = await all<ListRow>(listStmt);
    } else {
      const rs = await batch(c.env.DB, [
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
      c.env.DB.prepare(SQL.W_ACCT).bind(acct, dayStart(now), monthStart(now)),
      c.env.DB.prepare(SQL.W_REG).bind(id, acct, signPub, encPub, push ? push.pushType : null, push ? push.stored : null, now, platform),
      listStmt,
    );
    const rs = await batch(c.env.DB, stmts);
    const regRes = rs[rs.length - 2];
    rows = rs[rs.length - 1].results as ListRow[];
    // No change: a concurrent duplicate already inserted this peer (its row is in the list), or the limit is hit.
    if (regRes.meta.changes === 0 && !rows.some((r) => r.id === id)) {
      // Renewal keeps the first issue time, so the email or OAuth proof cannot be kept alive forever.
      const i = typeof ticket.i === "number" ? ticket.i : ticket.x - TICKET_LIFE_S;
      const x = Math.min(now + TICKET_LIFE_PEER_LIMIT_S, i + TICKET_RENEW_MAX_S);
      const fresh = await makeTicket(c.env.PA_TOKEN_SECRET, { a: acct, k: ticket.k, p: "register", x, i });
      throw new ApiError(409, "peer limit", { ticket: fresh, peers: limitPeers(rows) });
    }
    pushWritten = push !== null;
  }
  if (pushWritten && push && push.pushType === 6) scheduleProbe(c, acct, id, push.fields);
  const body = await listBody(rows, id);
  body.id = id;
  const self = rows.find((r) => r.id === id);
  return json(200, withPushMissing(body, !self || self.my_push === null));
}

// ---------- GET /peers ----------
export async function list(c: Ctx): Promise<Response> {
  if (c.body.length !== 0) throw bad();
  const s = await signedStart(c);
  const rows = await all<ListRow>(c.env.DB.prepare(SQL.Q_LIST).bind(s.me, s.acct));
  const self = rows.find((r) => r.id === s.me);
  await callerCheck(c, s, self);
  return json(200, withPushMissing(await listBody(rows, s.me), self!.my_push === null));
}

function selfPath(c: Ctx, s: { me: string }): void {
  if (c.params[0] !== s.me) throw bad();
}

async function readSelf(c: Ctx, me: string, acct: string): Promise<SelfRow | undefined> {
  return (await all<SelfRow>(c.env.DB.prepare(SQL.Q_SELF).bind(me, acct)))[0];
}

async function readCtx(c: Ctx, me: string, acct: string, ids: string[]): Promise<{ caller?: CtxRow; byId: Map<string, CtxRow> }> {
  const rows = await all<CtxRow>(c.env.DB.prepare(SQL.Q_CTX(ids.length)).bind(me, acct, ...ids));
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
    if (push) checkPushPlatform(self!.platform as never, push);
    if (!skipPushWrite(self!.push_verified_at === null ? null : self!.push, push)) {
      await batch(c.env.DB, [c.env.DB.prepare(SQL.W_PUSH).bind(s.me, s.acct, push ? push.stored : null, push ? push.pushType : null)]);
      if (push && push.pushType === 6) scheduleProbe(c, s.acct, s.me, push.fields);
    }
    return json(200, withPushMissing({}, push === null));
  }
  if ("listening" in b) {
    // cli listen report: clears push_failed when set (no write otherwise).
    keysExactly(b, ["listening"]);
    if (b.listening !== true) throw bad();
    const s = await signedStart(c);
    selfPath(c, s);
    const self = await readSelf(c, s.me, s.acct);
    await callerCheck(c, s, self);
    if (self!.platform !== "cli") throw bad();
    if (self!.push_failed !== null) await batch(c.env.DB, [c.env.DB.prepare(SQL.W_LISTEN).bind(s.me, s.acct)]);
    return json(200, withPushMissing({}, self!.push === null));
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
    const rs = await batch(c.env.DB, [c.env.DB.prepare(SQL.W_NAME(kept.length)).bind(...args)]);
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
    await batch(c.env.DB, [c.env.DB.prepare(SQL.W_DEL).bind(target, s.acct), c.env.DB.prepare(SQL.W_PRUNE).bind(target, s.acct)]);
  }
  const r = await relayMap(c, s.acct, m, (id) => ctxRelayRow(byId.get(id)), "peerchg");
  return json(200, withPushMissing({ r }, caller!.push === null));
}

// ---------- POST /peers/$id/logout and /login ----------
async function logoutCommon(c: Ctx, loggedOut: 0 | 1): Promise<Response> {
  const b = parseJsonObject(c.body);
  if (loggedOut === 1) keysExactly(b, ["m"]);
  else keysExactly(b, ["ticket", "m"]);
  const m = checkMessageMap(b.m);
  const s = await signedStart(c);
  selfPath(c, s);
  requireAccount(Object.keys(m), s.acct);
  const { caller, byId } = await readCtx(c, s.me, s.acct, Object.keys(m));
  await callerCheck(c, s, caller, loggedOut === 0);
  const missing = myAllowKeys(caller!.my_allow).filter((id) => !(id in m));
  if (missing.length) throw new ApiError(400, "messages missing", { ids: missing });
  if (loggedOut === 0) await checkTicket(c, b.ticket, "login", caller!.sign_pub, s.acct);
  await batch(c.env.DB, [c.env.DB.prepare(SQL.W_LOGOUT).bind(s.me, s.acct, loggedOut)]);
  const r = await relayMap(c, s.acct, m, (id) => ctxRelayRow(byId.get(id)), "logout");
  return json(200, withPushMissing({ r }, caller!.push === null));
}

export function logout(c: Ctx): Promise<Response> {
  return logoutCommon(c, 1);
}

export function login(c: Ctx): Promise<Response> {
  return logoutCommon(c, 0);
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
  const now = nowS();
  const w = Math.floor(now / 300);
  const ok =
    ctEqualStr(b.code, await probeCode(c.env.PA_CONFIRM_SECRET, s.me, fields, w)) ||
    ctEqualStr(b.code, await probeCode(c.env.PA_CONFIRM_SECRET, s.me, fields, w - 1));
  if (!ok) throw new ApiError(401, "wrong code");
  await batch(c.env.DB, [c.env.DB.prepare(SQL.W_CONFIRM).bind(s.me, s.acct, now, self!.push)]);
  return json(200, {});
}

