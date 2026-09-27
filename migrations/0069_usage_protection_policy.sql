-- Durable staff policy and a bounded cache for account usage diagnostics.
-- Metrics are collected out of band from ordinary HTTP requests; no learner or
-- financial rows are inspected by this feature.
CREATE TABLE usage_protection_policy (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  enforcement_mode TEXT NOT NULL CHECK (enforcement_mode IN ('observation')) DEFAULT 'observation',
  warning_cpu_error_count INTEGER NOT NULL CHECK (warning_cpu_error_count BETWEEN 0 AND 100000) DEFAULT 1,
  pause_reminders INTEGER NOT NULL CHECK (pause_reminders IN (0, 1)) DEFAULT 0,
  pause_waitlist INTEGER NOT NULL CHECK (pause_waitlist IN (0, 1)) DEFAULT 0,
  pause_internal_notices INTEGER NOT NULL CHECK (pause_internal_notices IN (0, 1)) DEFAULT 0,
  pause_recovery INTEGER NOT NULL CHECK (pause_recovery IN (0, 1)) DEFAULT 0,
  updated_at TEXT NOT NULL
);

INSERT INTO usage_protection_policy (
  singleton, enforcement_mode, warning_cpu_error_count, pause_reminders,
  pause_waitlist, pause_internal_notices, pause_recovery, updated_at
) VALUES (1, 'observation', 1, 0, 0, 0, 0, CURRENT_TIMESTAMP);

CREATE TABLE usage_protection_cache (
  environment TEXT PRIMARY KEY CHECK (environment IN ('production', 'staging')),
  collector_status TEXT NOT NULL CHECK (collector_status IN ('unknown', 'available', 'unavailable', 'failed')) DEFAULT 'unknown',
  source TEXT NOT NULL DEFAULT 'unavailable',
  observed_at TEXT,
  attempted_at TEXT,
  period_starts_at TEXT,
  period_ends_at TEXT,
  worker_invocations INTEGER,
  worker_errors INTEGER,
  cpu_limit_errors INTEGER,
  worker_versions_json TEXT,
  d1_rows_read INTEGER,
  d1_rows_written INTEGER,
  sampled INTEGER NOT NULL CHECK (sampled IN (0, 1)) DEFAULT 0,
  detail_code TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_usage_protection_cache_observed
  ON usage_protection_cache(observed_at);
