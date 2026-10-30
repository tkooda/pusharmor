// Every SQL statement of the Worker (component design section 6). Each user statement is
// scoped to one account (run on dbFor(env, acct), src/db/shard.ts); only the cron purge,
// pending expiry and the vendor_health counters span accounts. Keep it that way. P(n) is the JSON path
// for one id: '$."' || ?n || '"'. Ids are validated b64url, so they cannot leave the path.
const P = (n: number) => `'$."' || ?${n} || '"'`;

// GET /peers; tail of POST /peers. ?1 me, ?2 acct
export const Q_LIST = `SELECT id, sign_pub, enc_pub, platform, push_type, created, allow,
  json_type(allow, ${P(1)}) IS NOT NULL AS approves_me,
  json_type(deny, ${P(1)}) IS NOT NULL AS denies_me,
  push IS NOT NULL AS reachable, paused,
  CASE WHEN id = ?1 THEN push END AS my_push,
  json_extract(name, ${P(1)}) AS name_for_me
FROM peers WHERE account = ?2`;

// Caller + named peers. ?1 me, ?2 acct, then one id per parameter ?3, ?4, ... A VALUES
// list joined to the primary key reads one row per id; json_each and IN lists add rows
// read on D1. A repeated id returns a repeated row.
const Q_CTX_COLS = `id, sign_pub, enc_pub, push_type, push, paused,
  json_type(allow, ${P(1)}) IS NOT NULL AS approves_me,
  json_type(deny, ${P(1)}) IS NOT NULL AS denies_me,
  CASE WHEN id = ?1 THEN allow END AS my_allow`;
const ctxCache = new Map<string, string>();
function ctxSql(ids: number, send: boolean): string {
  if (!Number.isInteger(ids) || ids < 0 || ids > 10) throw new Error("Q_CTX ids");
  const key = `${ids}${send}`;
  let s = ctxCache.get(key);
  if (s) return s;
  const list = ["(?1)"];
  for (let i = 0; i < ids; i++) list.push(`(?${3 + i})`);
  s = `SELECT ${Q_CTX_COLS}${send ? `,
  (SELECT last_seen_month FROM accounts WHERE id = ?2) AS seen` : ""}
FROM (VALUES ${list.join(", ")}) v CROSS JOIN peers
WHERE peers.account = ?2 AND peers.id = v.column1`;
  ctxCache.set(key, s);
  return s;
}
export const Q_CTX = (ids: number): string => ctxSql(ids, false);

// POST /send: Q_CTX plus the account's last_seen_month.
export const Q_CTX_SEND = (ids: number): string => ctxSql(ids, true);

// POST /peers read. ?1 acct, ?2 id, ?3 JSON array of evict ids
export const Q_REG = `SELECT (SELECT status FROM accounts WHERE id = ?1) AS status,
  (SELECT sign_pub FROM peers WHERE account = ?1 AND id = ?2) AS old_sign,
  (SELECT enc_pub FROM peers WHERE account = ?1 AND id = ?2) AS old_enc,
  (SELECT platform FROM peers WHERE account = ?1 AND id = ?2) AS old_platform,
  (SELECT push FROM peers WHERE account = ?1 AND id = ?2) AS old_push,
  (SELECT count(*) FROM peers WHERE account = ?1
     AND id IN (SELECT value FROM json_each(?3))) AS evict_found`;

// ?1 acct, ?2 dayStart(now), ?3 monthStart(now)
export const W_ACCT = `INSERT INTO accounts (id, created, status, last_seen_month) VALUES (?1, ?2, NULL, ?3)
ON CONFLICT (id) DO UPDATE SET last_seen_month = excluded.last_seen_month
WHERE accounts.last_seen_month < excluded.last_seen_month`;

// ?1 id, ?2 acct, ?3 sign_pub, ?4 enc_pub, ?5 push_type, ?6 push, ?7 now, ?8 platform
export const W_REG = `INSERT INTO peers (id, account, sign_pub, enc_pub, platform, push_type, push,
  allow, deny, name, pending, created)
SELECT ?1, ?2, ?3, ?4, ?8, ?5, ?6, '{}', '{}', '{}', '{}', ?7
WHERE (SELECT count(*) FROM peers WHERE account = ?2) < 10
  AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = ?2 AND status = 'banned')
ON CONFLICT (account, id) DO NOTHING`;

// ?1 me, ?2 acct
export const Q_SELF = `SELECT sign_pub, enc_pub, platform, push_type, push, push IS NULL AS push_missing, paused, allow
FROM peers WHERE account = ?2 AND id = ?1`;

// ?1 me, ?2 acct, ?3 push JSON, ?4 push_type
export const W_PUSH = `UPDATE peers SET push = ?3, push_type = ?4 WHERE account = ?2 AND id = ?1`;

// W_NAME for 1..9 pairs: ?1 me, ?2 acct, then (?3 id, ?4 entry), (?5, ?6), ...
const wNameCache = new Map<number, string>();
export function W_NAME(pairs: number): string {
  if (!Number.isInteger(pairs) || pairs < 1 || pairs > 9) throw new Error("W_NAME pairs");
  let s = wNameCache.get(pairs);
  if (s) return s;
  const sets: string[] = [];
  const guards: string[] = [];
  for (let i = 0; i < pairs; i++) {
    const idp = 3 + 2 * i;
    sets.push(`${P(idp)}, ?${idp + 1}`);
    guards.push(`AND EXISTS (SELECT 1 FROM peers g WHERE g.account = ?2 AND g.id = ?${idp})`);
  }
  s = `UPDATE peers SET name = json_set(name, ${sets.join(", ")})
WHERE account = ?2 AND id = ?1
  ${guards.join("\n  ")}
RETURNING 1`;
  wNameCache.set(pairs, s);
  return s;
}

// ?1 id, ?2 acct
export const W_DEL = `DELETE FROM peers WHERE account = ?2 AND id = ?1`;

// ?1 id, ?2 acct
export const W_PRUNE = `UPDATE peers
SET allow = json_remove(allow, ${P(1)}), deny = json_remove(deny, ${P(1)}),
    name = json_remove(name, ${P(1)}), pending = json_remove(pending, ${P(1)})
WHERE account = ?2
  AND (json_type(allow, ${P(1)}) IS NOT NULL OR json_type(deny, ${P(1)}) IS NOT NULL
       OR json_type(name, ${P(1)}) IS NOT NULL OR json_type(pending, ${P(1)}) IS NOT NULL)`;

// ?1 acct
export const Q_ACCT = `SELECT id, sign_pub, push_type, push, paused, allow, deny
FROM peers WHERE account = ?1`;
export const W_DELALL = `DELETE FROM peers WHERE account = ?1`;
export const W_DELACCT = `DELETE FROM accounts WHERE id = ?1 AND status IS NULL`;

// Stored JSON caps per row, in chars. The trigger peers_json_cap (migrations/0004) refuses an
// UPDATE that grows name or pending past them; d1.ts maps that to 413 "too large".
export const NAME_JSON_MAX = 6000;
export const PENDING_JSON_MAX = 16000;
export const JSON_CAP_ERROR = "pa-json-cap";
// A pending entry is [store time, c]; the monthly cron drops it this long after the store.
// Longer than the 14-day pairing timeout, so a waiting re-fetch still finds it.
export const PENDING_TTL_S = 2592000;

// Lazy cleanup of pending entries whose peer row is gone. ?2 acct. json() keeps an array
// entry an array (legacy entries are plain strings).
const PRUNED = `(SELECT COALESCE(json_group_object(j.key, CASE WHEN j.type = 'array' THEN json(j.value) ELSE j.value END), '{}')
  FROM json_each(peers.pending) j
  WHERE EXISTS (SELECT 1 FROM peers o WHERE o.account = ?2 AND o.id = j.key))`;

// c of one pending entry: [time, c], or a legacy string. ?n id
const PENDING_C = (col: string, n: number) =>
  `CASE json_type(${col}, ${P(n)}) WHEN 'array' THEN json_extract(${col}, '$."' || ?${n} || '"[1]')
   ELSE json_extract(${col}, ${P(n)}) END`;

// ?1 me, ?2 acct, ?3 X, ?4 name entry, ?5 c, ?6 now
export const W_APPROVE = `UPDATE peers
SET allow = json_set(allow, ${P(3)}, 1), deny = json_remove(deny, ${P(3)}),
    name = json_set(name, ${P(3)}, ?4),
    pending = json_set(${PRUNED}, ${P(3)}, json_array(?6, ?5))
WHERE account = ?2 AND id = ?1
  AND EXISTS (SELECT 1 FROM peers g WHERE g.account = ?2 AND g.id = ?3)
RETURNING NOT EXISTS (SELECT 1 FROM peers x
                      WHERE x.account = ?2 AND x.id = ?3
                        AND json_type(x.allow, ${P(1)}) IS NOT NULL) AS stored,
          (SELECT ${PENDING_C("x.pending", 1)} FROM peers x
           WHERE x.account = ?2 AND x.id = ?3) AS c_x`;

// ?1 me, ?2 acct, ?3 X
export const W_DENY = `UPDATE peers
SET deny = json_set(deny, ${P(3)}, 1), allow = json_remove(allow, ${P(3)}),
    name = json_remove(name, ${P(3)}), pending = json_remove(${PRUNED}, ${P(3)})
WHERE account = ?2 AND id = ?1
  AND EXISTS (SELECT 1 FROM peers g WHERE g.account = ?2 AND g.id = ?3)
RETURNING 1`;

// ?1 me, ?2 acct, ?3 X
export const W_WITHDRAW = `UPDATE peers
SET allow = json_remove(allow, ${P(3)}), name = json_remove(name, ${P(3)}),
    pending = json_remove(pending, ${P(3)})
WHERE account = ?2 AND id = ?1
RETURNING 1`;

// ?1 acct, ?2 monthStart(now)
export const W_SEEN = `UPDATE accounts SET last_seen_month = ?2
WHERE id = ?1 AND last_seen_month < ?2`;

// ?1 id, ?2 acct, ?3 push as read
export const W_GONE = `UPDATE peers SET push = NULL, push_type = NULL
WHERE account = ?2 AND id = ?1 AND push = ?3`;

// ?1 me, ?2 acct, ?3 paused (1 or 0)
export const W_PAUSE = `UPDATE peers SET paused = ?3 WHERE account = ?2 AND id = ?1`;

// ?1 me, ?2 acct, ?3 now, ?4 push as read
export const W_CONFIRM = `UPDATE peers SET push = json_set(push, '$.verified_at', ?3)
WHERE account = ?2 AND id = ?1 AND push = ?4`;

// Purge (monthly). ?1 = now - 94608000, ?2 = last purged id of this run ('' to start). The
// keyset cursor walks the accounts primary key once per run: a chunk never rescans the ids
// before ?2. W_PURGE_ACCOUNTS returns the purged ids (the next ?2 is the largest).
const PURGE_IDS = `SELECT id FROM accounts
  WHERE id > ?2 AND status IS NULL AND last_seen_month < ?1 ORDER BY id LIMIT 100`;
export const PURGE_CHUNK = 100;
export const W_PURGE_PEERS = `DELETE FROM peers WHERE account IN (${PURGE_IDS})`;
export const W_PURGE_ACCOUNTS = `DELETE FROM accounts WHERE id IN (${PURGE_IDS}) RETURNING id`;

// Pending expiry (monthly), one keyset chunk of rows with pending entries. ?1 last id done
// ('' to start), ?2 chunk size, ?3 cutoff (now - PENDING_TTL_S), ?4 now. Ids start with the
// account, so id order is (account, id) order and the row value walks the primary key.
const PENDING_CHUNK_ROWS = `SELECT account, id FROM peers
  WHERE (account, id) > (substr(?1, 1, 12), ?1) AND pending <> '{}' ORDER BY account, id LIMIT ?2`;
export const Q_PENDING_CHUNK = `SELECT count(*) AS n, max(id) AS last FROM (${PENDING_CHUNK_ROWS})`;
// Drops entries stored before ?3 and stamps legacy string entries with ?4.
export const W_PENDING_EXPIRE = `UPDATE peers SET pending = (
  SELECT COALESCE(json_group_object(j.key, CASE WHEN j.type = 'array' THEN json(j.value) ELSE json_array(?4, j.value) END), '{}')
  FROM json_each(peers.pending) j
  WHERE j.type <> 'array' OR json_extract(j.value, '$[0]') >= ?3)
WHERE (account, id) IN (${PENDING_CHUNK_ROWS})
  AND EXISTS (SELECT 1 FROM json_each(peers.pending) j WHERE j.type <> 'array' OR json_extract(j.value, '$[0]') < ?3)`;

export const Q_HEALTH = `SELECT 1 AS ok`;

// Vendor auth counters, added in one write per isolate flush. ?1 vendor, ?2 hour, ?3 auth, ?4 ok.
// The hour rows older than 48 h are dropped by the cron.
export const W_HEALTH_ADD = `INSERT INTO vendor_health (vendor, hour, auth, ok) VALUES (?1, ?2, ?3, ?4)
  ON CONFLICT (vendor, hour) DO UPDATE SET auth = auth + excluded.auth, ok = ok + excluded.ok`;
export const Q_HEALTH_HOUR = `SELECT vendor, auth, ok FROM vendor_health WHERE hour = ?1 ORDER BY vendor`;
export const W_HEALTH_PURGE = `DELETE FROM vendor_health WHERE hour < ?1`;
