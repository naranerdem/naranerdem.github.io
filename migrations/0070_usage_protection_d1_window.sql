-- D1 analytics are published in complete UTC-day buckets, unlike the
-- collector's rolling Worker window. Persist that separate measurement range.
ALTER TABLE usage_protection_cache ADD COLUMN d1_period_starts_at TEXT;
ALTER TABLE usage_protection_cache ADD COLUMN d1_period_ends_at TEXT;
