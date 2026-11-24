-- peers.version is no longer written or read: clear every stored value. The column stays, so a
-- rollback to a Worker that still reads it keeps working.
UPDATE peers SET version = NULL WHERE version IS NOT NULL;
