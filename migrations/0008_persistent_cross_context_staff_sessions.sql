PRAGMA foreign_keys = ON;

CREATE TABLE staff_session_policy (
  role_code TEXT PRIMARY KEY REFERENCES staff_role(code) ON DELETE CASCADE,
  inactivity_seconds INTEGER NOT NULL CHECK (inactivity_seconds BETWEEN 86400 AND 15552000),
  absolute_seconds INTEGER NOT NULL CHECK (absolute_seconds BETWEEN 86400 AND 31536000),
  updated_at TEXT NOT NULL,
  updated_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  CHECK (inactivity_seconds % 86400 = 0),
  CHECK (absolute_seconds % 86400 = 0),
  CHECK (inactivity_seconds <= absolute_seconds)
);

INSERT INTO staff_session_policy (
  role_code, inactivity_seconds, absolute_seconds, updated_at
) VALUES
  ('admin', 604800, 2592000, CURRENT_TIMESTAMP),
  ('teacher', 2592000, 7776000, CURRENT_TIMESTAMP),
  ('accountant', 1209600, 5184000, CURRENT_TIMESTAMP);

CREATE TABLE staff_login_attempt (
  id TEXT PRIMARY KEY,
  staff_account_id TEXT REFERENCES staff_account(id) ON DELETE CASCADE,
  claim_secret_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'claimed', 'expired', 'cancelled')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  claimed_at TEXT,
  cancelled_at TEXT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  updated_at TEXT NOT NULL,
  CHECK (length(claim_secret_hash) = 64),
  CHECK (expires_at > created_at),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

ALTER TABLE staff_login_challenge
  ADD COLUMN login_attempt_id TEXT REFERENCES staff_login_attempt(id) ON DELETE CASCADE;

UPDATE staff_login_challenge
SET status = 'invalidated', invalidated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
WHERE login_attempt_id IS NULL AND status = 'pending';

ALTER TABLE staff_session ADD COLUMN last_seen_at TEXT;
ALTER TABLE staff_session ADD COLUMN expired_at TEXT;
ALTER TABLE staff_session ADD COLUMN client_label TEXT;

UPDATE staff_session SET last_seen_at = created_at WHERE last_seen_at IS NULL;

CREATE INDEX idx_staff_session_policy_updated ON staff_session_policy(updated_at);
CREATE INDEX idx_staff_login_attempt_account_status_expiry
  ON staff_login_attempt(staff_account_id, status, expires_at);
CREATE INDEX idx_staff_login_attempt_status_expiry
  ON staff_login_attempt(status, expires_at);
CREATE INDEX idx_staff_challenge_attempt_status
  ON staff_login_challenge(login_attempt_id, status, expires_at);
CREATE INDEX idx_staff_session_activity
  ON staff_session(staff_account_id, revoked_at, expired_at, last_seen_at);
