-- peers.push_failed_since: unix s of the first ntfy 507 (no subscriber) on a cli peer's push
-- endpoint; NULL while it listens. The name is used once in src/db/sql.ts (PUSH_FAILED_COL).
ALTER TABLE peers ADD COLUMN push_failed_since INTEGER;
