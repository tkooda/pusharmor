-- peers.version: the device's last app version "x.y.z" from its PA-Client header, NULL until
-- the device's first signed GET /v1/peers or POST /v1/send after this migration. Written only
-- when it changes. Additive: existing rows keep NULL; no backfill.
ALTER TABLE peers ADD COLUMN version TEXT CHECK (version IS NULL OR length(version) BETWEEN 5 AND 20);
