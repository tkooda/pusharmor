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
import type { Env } from "../env";
import { Log } from "../log";
import { dayOf } from "../file/quota";
import { storeDeps, type Version } from "../file/store";
import { acctHash, storageError } from "./file";

const LIST_PARALLEL = 6;
export const ACCOUNT_FILES_MAX_CALLS = 1000;

// Deletes the stored files of a deleted account. No storage call when the account never
// uploaded or its last upload day (UTC) is older than yesterday: no file of it can still exist
// past its deletion time. Else, page by page over the minute folders: list
// v1/<minute>/<acct-hash>/ under each folder of the page, then delete every version found
// there, then the next page; at most maxCalls storage calls. Runs after the reply; only a
// failure is logged. Files left over expire and the 5-minute cleanup removes them.
export async function deleteAccountFiles(env: Env, acct: string, nowS: number, maxCalls = ACCOUNT_FILES_MAX_CALLS): Promise<void> {
  const log = new Log();
  log.route = "account files";
  log.account = acct;
  let calls = 0;
  try {
    const q = env.FILE_QUOTA.get(env.FILE_QUOTA.idFromName(acct));
    const day = await q.lastDay();
    if (day === null || day < dayOf(nowS) - 86400) return;
    const store = storeDeps.store(env);
    if (!store || !env.FILE_ACCT_SECRET) return;
    const hash = await acctHash(env.FILE_ACCT_SECRET, acct);
    let token: string | undefined;
    // Each listing call keeps 2 calls back: one for the next page and one for the delete.
    while (calls + 3 <= maxCalls) {
      const page = await store.listPrefixesPage("v1/", token);
      calls++;
      if (page === "cap") throw new Error("cap");
      const dirs = page.prefixes;
      const found: Version[] = [];
      let next = 0;
      const lane = async () => {
        while (next < dirs.length && calls + 2 < maxCalls) {
          const dir = dirs[next++];
          calls++;
          const vs = await store.listVersionsPage(dir + hash + "/");
          if (vs === "cap") throw new Error("cap");
          found.push(...vs.versions);
        }
      };
      await Promise.all(Array.from({ length: LIST_PARALLEL }, lane));
      for (let k = 0; k < found.length && calls < maxCalls; k += 1000) {
        calls++;
        if ((await store.deleteVersions(found.slice(k, k + 1000))) === "cap") throw new Error("cap");
      }
      token = page.next;
      if (token === undefined) break;
    }
  } catch (e) {
    log.error = "file-delete-failed";
    log.extra.storage = e instanceof Error && e.message === "cap" ? "cap" : storageError(e);
  } finally {
    log.extra.files_calls = calls;
    if (log.error) log.emit();
  }
}

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
  c.exec.waitUntil(deleteAccountFiles(c.env, acct, Math.floor(Date.now() / 1000)));

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
