-- PushArmor D1 schema. Ids, keys and ciphertexts are b64url TEXT.
CREATE TABLE accounts (
  id      TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 12),
  created INTEGER NOT NULL,
  status  TEXT CHECK (status IS NULL OR status = 'banned'),
  last_seen_month INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE peers (
  id        TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 40),
  account   TEXT NOT NULL CHECK (account = substr(id, 1, 12)),
  sign_pub  TEXT NOT NULL CHECK (length(sign_pub) = 87),
  enc_pub   TEXT NOT NULL CHECK (length(enc_pub) = 87),
  platform  TEXT NOT NULL
            CHECK (platform IN ('android', 'iphone', 'chrome', 'firefox')),
  push_type INTEGER CHECK (push_type IS NULL OR push_type IN (1, 2, 3, 4, 5, 6)),
  push      TEXT CHECK (push IS NULL OR json_valid(push)),
  paused    INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  allow     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(allow)),
  deny      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(deny)),
  name      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(name)),
  pending   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(pending)),
  created   INTEGER NOT NULL,
  CHECK ((push IS NULL) = (push_type IS NULL))
);
CREATE INDEX peers_account ON peers (account);
