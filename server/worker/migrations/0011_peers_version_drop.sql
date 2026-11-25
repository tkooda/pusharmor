-- Drops peers.version (no Worker since 0.0.55 reads or writes it; 0010 cleared it). Its only
-- CHECK is on the column itself and no index, trigger, or foreign key uses it, so a plain
-- DROP COLUMN works and no rebuild is needed. Workers below 0.0.55 write this column: never
-- roll back below 0.0.55 after this migration.
ALTER TABLE peers DROP COLUMN version;
