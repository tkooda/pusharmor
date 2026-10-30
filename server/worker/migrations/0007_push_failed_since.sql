-- Rebuilds peers (SQLite cannot change a CHECK in place) with two new columns and shape-only
-- CHECKs on platform and push_type; the Worker validates the exact values. The 0004 trigger
-- is recreated. No foreign key references peers.
-- peers.push_failed_since: unix s of the first ntfy 507 (no subscriber) on a cli peer's push
-- endpoint, NULL while it listens. The name is used once in src/db/sql.ts (PUSH_FAILED_COL).
-- peers.push_verified_at: unix s of the type 6 (UnifiedPush) probe confirmation, NULL while
-- unconfirmed. It was the verified_at key of the push JSON, so the key is moved to the column.
CREATE TABLE peers_new (
  id        TEXT NOT NULL CHECK (length(id) = 40),
  account   TEXT NOT NULL CHECK (account = substr(id, 1, 12)),
  sign_pub  TEXT NOT NULL CHECK (length(sign_pub) = 87),
  enc_pub   TEXT NOT NULL CHECK (length(enc_pub) = 87),
  platform  TEXT NOT NULL CHECK (length(platform) BETWEEN 1 AND 16),
  push_type INTEGER CHECK (push_type IS NULL OR push_type BETWEEN 1 AND 63),
  push      TEXT CHECK (push IS NULL OR json_valid(push)),
  logged_out INTEGER NOT NULL DEFAULT 0 CHECK (logged_out IN (0, 1)),
  allow     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(allow)),
  deny      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(deny)),
  name      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(name)),
  pending   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(pending)),
  created   INTEGER NOT NULL,
  push_failed_since INTEGER,
  push_verified_at  INTEGER,
  CHECK ((push IS NULL) = (push_type IS NULL)),
  PRIMARY KEY (account, id)
) WITHOUT ROWID;
INSERT INTO peers_new (id, account, sign_pub, enc_pub, platform, push_type, push, logged_out, allow, deny, name, pending, created,
  push_failed_since, push_verified_at)
SELECT id, account, sign_pub, enc_pub, platform, push_type,
  CASE WHEN json_type(push, '$.verified_at') IS NOT NULL THEN json_remove(push, '$.verified_at') ELSE push END,
  logged_out, allow, deny, name, pending, created,
  NULL, json_extract(push, '$.verified_at')
FROM peers;
DROP TABLE peers;
ALTER TABLE peers_new RENAME TO peers;
CREATE TRIGGER peers_json_cap BEFORE UPDATE OF name, pending ON peers
WHEN (length(NEW.name) > 6000 AND length(NEW.name) > length(OLD.name))
  OR (length(NEW.pending) > 16000 AND length(NEW.pending) > length(OLD.pending))
BEGIN
  SELECT RAISE(ABORT, 'pa-json-cap');
END;
