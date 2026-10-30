// POST /send.
import type { Ctx } from "../context";
import { monthStart, nowS } from "../context";
import { bad, checkMessageMap, keysExactly, requireAccount } from "../codec/validate";
import { parseJsonObject } from "../pipeline/body";
import * as SQL from "../db/sql";
import { dbFor } from "../db/shard";
import { all } from "../db/d1";
import { ctxRelayRow, type CtxRow } from "../db/rows";
import { callerCheck, relayMap, signedStart, withPushMissing } from "./common";
import { json } from "../http";

export async function send(c: Ctx): Promise<Response> {
  const b = parseJsonObject(c.body);
  keysExactly(b, ["v", "m"]);
  if (b.v !== 1) throw bad();
  const m = checkMessageMap(b.m);
  const paId = c.req.headers.get("PA-ID");
  if (paId !== null && paId in m) throw bad();
  const s = await signedStart(c);
  requireAccount(Object.keys(m), s.acct);
  const rows = await all<CtxRow>(c.log, dbFor(c.env, s.acct).prepare(SQL.Q_CTX_SEND(Object.keys(m).length)).bind(s.me, s.acct, ...Object.keys(m)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const caller = byId.get(s.me);
  await callerCheck(c, s, caller);
  const now = nowS();
  const extra: D1PreparedStatement[] = [];
  const seen = caller!.seen;
  if (typeof seen === "number" && seen < monthStart(now)) extra.push(dbFor(c.env, s.acct).prepare(SQL.W_SEEN).bind(s.acct, monthStart(now)));
  const r = await relayMap(c, s.acct, m, (id) => ctxRelayRow(byId.get(id)), "send", extra);
  return json(200, withPushMissing({ r }, caller!.push === null));
}
