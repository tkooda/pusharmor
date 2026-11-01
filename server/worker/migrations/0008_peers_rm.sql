-- peers.rm: sealed remove messages stored for this peer, {"<removed id>":[stored_at_s,"<m string>"]}.
-- DELETE /v1/peers/<B> writes m[C] into C's row; C's next GET /v1/peers returns it once and clears it.
-- At most 8 entries (about 3900 chars each), so the cap leaves room: a DELETE never hits it.
ALTER TABLE peers ADD COLUMN rm TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(rm));
DROP TRIGGER peers_json_cap;
CREATE TRIGGER peers_json_cap BEFORE UPDATE OF name, pending, rm ON peers
WHEN (length(NEW.name) > 6000 AND length(NEW.name) > length(OLD.name))
  OR (length(NEW.pending) > 16000 AND length(NEW.pending) > length(OLD.pending))
  OR (length(NEW.rm) > 32000 AND length(NEW.rm) > length(OLD.rm))
BEGIN
  SELECT RAISE(ABORT, 'pa-json-cap');
END;
