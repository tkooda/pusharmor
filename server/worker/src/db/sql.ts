// Every SQL statement of the Worker (component design section 6). P(n) is the JSON path
// for one id: '$."' || ?n || '"'. Ids are validated b64url, so they cannot leave the path.
// Note: "+account" (unary plus) stops SQLite from choosing the peers_account index (a scan
// of the whole account) where a primary-key lookup by id is cheaper. If the schema switches
// to WITHOUT ROWID PRIMARY KEY (account, id), drop the "+" again.
const P = (n: number) => `'$."' || ?${n} || '"'`;

// GET /peers; tail of POST /peers. ?1 me, ?2 acct
export const Q_LIST = `SELECT id, sign_pub, enc_pub, platform, push_type, created, allow,
  json_type(allow, ${P(1)}) IS NOT NULL AS approves_me,
  json_type(deny, ${P(1)}) IS NOT NULL AS denies_me,
  push IS NOT NULL AS reachable, paused,
  CASE WHEN id = ?1 THEN push END AS my_push,
  json_extract(name, ${P(1)}) AS name_for_me
FROM peers WHERE account = ?2`;

// Caller + named peers. ?1 me, ?2 acct, ?3 JSON array of ids
const Q_CTX_COLS = `id, sign_pub, enc_pub, push_type, push, paused,
  json_type(allow, ${P(1)}) IS NOT NULL AS approves_me,
  json_type(deny, ${P(1)}) IS NOT NULL AS denies_me,
  CASE WHEN id = ?1 THEN allow END AS my_allow`;
export const Q_CTX = `SELECT ${Q_CTX_COLS}
FROM peers
WHERE +account = ?2 AND (id = ?1 OR id IN (SELECT value FROM json_each(?3)))`;

// POST /send: Q_CTX plus the account's last_seen_month.
export const Q_CTX_SEND = `SELECT ${Q_CTX_COLS},
  (SELECT last_seen_month FROM accounts WHERE id = ?2) AS seen
FROM peers
WHERE +account = ?2 AND (id = ?1 OR id IN (SELECT value FROM json_each(?3)))`;

// POST /peers read. ?1 acct, ?2 id, ?3 JSON array of evict ids
export const Q_REG = `SELECT (SELECT status FROM accounts WHERE id = ?1) AS status,
  (SELECT sign_pub FROM peers WHERE account = ?1 AND id = ?2) AS old_sign,
  (SELECT enc_pub FROM peers WHERE account = ?1 AND id = ?2) AS old_enc,
  (SELECT platform FROM peers WHERE account = ?1 AND id = ?2) AS old_platform,
  (SELECT push FROM peers WHERE account = ?1 AND id = ?2) AS old_push,
  (SELECT count(*) FROM peers WHERE account = ?1
     AND id IN (SELECT value FROM json_each(?3))) AS evict_found`;

// ?1 acct, ?2 now
export const W_ACCT = `INSERT INTO accounts (id, created, status, last_seen_month) VALUES (?1, ?2, NULL, ?2)
ON CONFLICT (id) DO UPDATE SET last_seen_month = excluded.last_seen_month
WHERE accounts.last_seen_month < excluded.last_seen_month - 2592000`;

// ?1 id, ?2 acct, ?3 sign_pub, ?4 enc_pub, ?5 push_type, ?6 push, ?7 now, ?8 platform
export const W_REG = `INSERT INTO peers (id, account, sign_pub, enc_pub, platform, push_type, push,
  allow, deny, name, pending, created)
SELECT ?1, ?2, ?3, ?4, ?8, ?5, ?6, '{}', '{}', '{}', '{}', ?7
WHERE (SELECT count(*) FROM peers WHERE account = ?2) < 10
  AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = ?2 AND status = 'banned')`;

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
    guards.push(`AND EXISTS (SELECT 1 FROM peers g WHERE +g.account = ?2 AND g.id = ?${idp})`);
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

// Lazy cleanup of pending entries whose peer row is gone. ?2 acct
const PRUNED = `(SELECT COALESCE(json_group_object(j.key, j.value), '{}') FROM json_each(peers.pending) j
  WHERE EXISTS (SELECT 1 FROM peers o WHERE +o.account = ?2 AND o.id = j.key))`;

// ?1 me, ?2 acct, ?3 X, ?4 name entry, ?5 c
export const W_APPROVE = `UPDATE peers
SET allow = json_set(allow, ${P(3)}, 1), deny = json_remove(deny, ${P(3)}),
    name = json_set(name, ${P(3)}, ?4),
    pending = json_set(${PRUNED}, ${P(3)}, ?5)
WHERE account = ?2 AND id = ?1
  AND EXISTS (SELECT 1 FROM peers g WHERE +g.account = ?2 AND g.id = ?3)
RETURNING NOT EXISTS (SELECT 1 FROM peers x
                      WHERE +x.account = ?2 AND x.id = ?3
                        AND json_type(x.allow, ${P(1)}) IS NOT NULL) AS stored,
          (SELECT json_extract(x.pending, ${P(1)}) FROM peers x
           WHERE +x.account = ?2 AND x.id = ?3) AS c_x`;

// ?1 me, ?2 acct, ?3 X
export const W_DENY = `UPDATE peers
SET deny = json_set(deny, ${P(3)}, 1), allow = json_remove(allow, ${P(3)}),
    name = json_remove(name, ${P(3)}), pending = json_remove(${PRUNED}, ${P(3)})
WHERE account = ?2 AND id = ?1
  AND EXISTS (SELECT 1 FROM peers g WHERE +g.account = ?2 AND g.id = ?3)
RETURNING 1`;

// ?1 me, ?2 acct, ?3 X
export const W_WITHDRAW = `UPDATE peers
SET allow = json_remove(allow, ${P(3)}), name = json_remove(name, ${P(3)}),
    pending = json_remove(pending, ${P(3)})
WHERE account = ?2 AND id = ?1
RETURNING 1`;

// ?1 acct, ?2 now
export const W_SEEN = `UPDATE accounts SET last_seen_month = ?2
WHERE id = ?1 AND last_seen_month < ?2 - 2592000`;

// ?1 id, ?2 acct, ?3 push as read
export const W_GONE = `UPDATE peers SET push = NULL, push_type = NULL
WHERE account = ?2 AND id = ?1 AND push = ?3`;

// ?1 me, ?2 acct, ?3 paused (1 or 0)
export const W_PAUSE = `UPDATE peers SET paused = ?3 WHERE account = ?2 AND id = ?1`;

// ?1 me, ?2 acct, ?3 now, ?4 push as read
export const W_CONFIRM = `UPDATE peers SET push = json_set(push, '$.verified_at', ?3)
WHERE account = ?2 AND id = ?1 AND push = ?4`;

// Purge (monthly). ?1 = now - 94608000
export const W_PURGE_PEERS = `DELETE FROM peers WHERE account IN (SELECT id FROM accounts
  WHERE status IS NULL AND last_seen_month < ?1 ORDER BY id LIMIT 100)`;
export const W_PURGE_ACCOUNTS = `DELETE FROM accounts WHERE id IN (SELECT id FROM accounts
  WHERE status IS NULL AND last_seen_month < ?1 ORDER BY id LIMIT 100)`;

export const Q_HEALTH = `SELECT 1 AS ok`;
