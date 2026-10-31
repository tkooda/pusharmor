-- Pending approve entries carry their store time as [time, c], so the monthly cron can drop
-- them 30 days later. Legacy string entries get the migration time; entries whose peer row is
-- gone are dropped.
UPDATE peers SET pending = (
  SELECT COALESCE(json_group_object(j.key, CASE WHEN j.type = 'text'
           THEN json_array(CAST(strftime('%s', 'now') AS INTEGER), j.value) ELSE json(j.value) END), '{}')
  FROM json_each(peers.pending) j
  WHERE EXISTS (SELECT 1 FROM peers o WHERE o.account = peers.account AND o.id = j.key))
WHERE pending <> '{}';
-- Stored JSON caps per row (src/db/sql.ts NAME_JSON_MAX, PENDING_JSON_MAX): rows over the cap
-- are emptied, and a write that grows a row past the cap fails (the Worker answers 413).
UPDATE peers SET pending = '{}' WHERE length(pending) > 16000;
UPDATE peers SET name = '{}' WHERE length(name) > 6000;
CREATE TRIGGER peers_json_cap BEFORE UPDATE OF name, pending ON peers
WHEN (length(NEW.name) > 6000 AND length(NEW.name) > length(OLD.name))
  OR (length(NEW.pending) > 16000 AND length(NEW.pending) > length(OLD.pending))
BEGIN
  SELECT RAISE(ABORT, 'pa-json-cap');
END;
