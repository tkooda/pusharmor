-- peers.push_failed_since: unix s of the first ntfy 507 (no subscriber) on a cli peer's push
-- endpoint; NULL while it listens. The name is used once in src/db/sql.ts (PUSH_FAILED_COL).
ALTER TABLE peers ADD COLUMN push_failed_since INTEGER;
-- peers.push_verified_at: unix s of the type 6 (UnifiedPush) probe confirmation, NULL while
-- unconfirmed. It was the verified_at key of the push JSON, so the key is moved to the column.
ALTER TABLE peers ADD COLUMN push_verified_at INTEGER;
UPDATE peers SET push_verified_at = json_extract(push, '$.verified_at'), push = json_remove(push, '$.verified_at')
WHERE json_type(push, '$.verified_at') IS NOT NULL;
