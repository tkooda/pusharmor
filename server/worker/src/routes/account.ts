// DELETE /account (ticket only, no PA-ID).
import type { Ctx } from "../context";
import { checkMessageMap, keysExactly, requireAccount, bad } from "../codec/validate";
import { rawPoint } from "../crypto/ecdsa";
import { parseJsonObject } from "../pipeline/body";
import { checkSig, checkTime } from "../pipeline/signed";
import * as SQL from "../db/sql";
import { all, batch } from "../db/d1";
import { isListening, type RelayRow } from "../db/rows";
import { checkTicket, relayMap } from "./common";
import { json } from "../http";
import { revokeAppleSealed } from "../auth/apple";

interface AcctRow {
  id: string;
  sign_pub: string;
  platform: string;
  push_failed: number | null;
  push_type: number | null;
  push: string | null;
  push_verified_at: number | null;
  logged_out: number;
  allow: string;
  deny: string;
}

function has(json: string, key: string): boolean {
  try {
    const o = JSON.parse(json);
    return !!o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, key);
  } catch {
    return false;
  }
}

export async function deleteAccount(c: Ctx): Promise<Response> {
  const b = parseJsonObject(c.body);
  keysExactly(b, ["ticket", "sign_pub", "m"]);
  if (!rawPoint(b.sign_pub)) throw bad();
  const m = checkMessageMap(b.m);
  const signPub = b.sign_pub as string;
  const ticket = await checkTicket(c, b.ticket, "delete-account", signPub);
  const paTime = checkTime(c.req.headers, Date.now());
  await checkSig(signPub, c.req.headers, c.method, c.path, paTime, c.body);
  const acct = ticket.a;
  c.log.account = acct;
  requireAccount(Object.keys(m), acct);

  const rows = await all<AcctRow>(c.env.DB.prepare(SQL.Q_ACCT).bind(acct));
  const me = rows.find((r) => r.sign_pub === signPub);
  await batch(c.env.DB, [c.env.DB.prepare(SQL.W_DELALL).bind(acct), c.env.DB.prepare(SQL.W_DELACCT).bind(acct)]);

  let r: Record<string, string>;
  if (!me) {
    r = {};
    for (const id of Object.keys(m)) r[id] = "unknown";
  } else {
    c.log.peer = me.id;
    const byId = new Map(rows.map((x) => [x.id, x]));
    const rowOf = (id: string): RelayRow | undefined => {
      const x = byId.get(id);
      return (
        x && {
          approves_me: has(x.allow, me.id),
          denies_me: has(x.deny, me.id),
          logged_out: x.logged_out === 1,
          listening: isListening(x.platform, x.push_failed),
          push_type: x.push_type,
          push: x.push,
          push_verified_at: x.push_verified_at,
        }
      );
    };
    // Rows are already deleted, so no gone write-back is needed (W_GONE would match nothing).
    r = await relayMap(c, acct, m, rowOf, "peerchg");
  }
  if (typeof ticket.s === "string") await revokeAppleSealed(c.env, ticket.s);
  return json(200, { r, deleted: rows.length });
}
