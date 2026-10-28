-- Vendor auth alert counters per UTC hour, shared by every isolate. No user data.
CREATE TABLE vendor_health (
  vendor TEXT NOT NULL,
  hour   INTEGER NOT NULL,
  auth   INTEGER NOT NULL DEFAULT 0,
  ok     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (vendor, hour)
) WITHOUT ROWID;
