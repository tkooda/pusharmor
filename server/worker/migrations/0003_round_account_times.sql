-- Account times as coarse as the privacy page says: created to the UTC day, last_seen_month to the 30-day period.
UPDATE accounts SET created = created - created % 86400, last_seen_month = last_seen_month - last_seen_month % 2592000;
