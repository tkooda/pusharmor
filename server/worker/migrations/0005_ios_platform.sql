-- Platform value 'iphone' becomes 'ios'. SQLite cannot change a CHECK in place, so the peers
-- table is rebuilt with the same columns, keys and CHECKs; the 0004 trigger is recreated.
-- No foreign key references peers.
CREATE TABLE peers_new (
  id        TEXT NOT NULL CHECK (length(id) = 40),
  account   TEXT NOT NULL CHECK (account = substr(id, 1, 12)),
  sign_pub  TEXT NOT NULL CHECK (length(sign_pub) = 87),
  enc_pub   TEXT NOT NULL CHECK (length(enc_pub) = 87),
  platform  TEXT NOT NULL
            CHECK (platform IN ('android', 'ios', 'chrome', 'firefox')),
  push_type INTEGER CHECK (push_type IS NULL OR push_type IN (1, 2, 3, 4, 5, 6)),
  push      TEXT CHECK (push IS NULL OR json_valid(push)),
  paused    INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  allow     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(allow)),
  deny      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(deny)),
  name      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(name)),
  pending   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(pending)),
  created   INTEGER NOT NULL,
  CHECK ((push IS NULL) = (push_type IS NULL)),
  PRIMARY KEY (account, id)
) WITHOUT ROWID;
INSERT INTO peers_new (id, account, sign_pub, enc_pub, platform, push_type, push, paused, allow, deny, name, pending, created)
SELECT id, account, sign_pub, enc_pub, CASE platform WHEN 'iphone' THEN 'ios' ELSE platform END,
       push_type, push, paused, allow, deny, name, pending, created
FROM peers;
DROP TABLE peers;
ALTER TABLE peers_new RENAME TO peers;
CREATE TRIGGER peers_json_cap BEFORE UPDATE OF name, pending ON peers
WHEN (length(NEW.name) > 6000 AND length(NEW.name) > length(OLD.name))
  OR (length(NEW.pending) > 16000 AND length(NEW.pending) > length(OLD.pending))
BEGIN
  SELECT RAISE(ABORT, 'pa-json-cap');
END;
