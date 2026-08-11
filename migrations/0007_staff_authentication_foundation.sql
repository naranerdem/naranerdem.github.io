PRAGMA foreign_keys = ON;

CREATE TABLE staff_account (
  id TEXT PRIMARY KEY,
  email_normalized TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  disabled_at TEXT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(trim(email_normalized)) > 3),
  CHECK (length(trim(display_name)) > 0),
  CHECK ((status = 'disabled') = (disabled_at IS NOT NULL)),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE TABLE staff_role (
  code TEXT PRIMARY KEY CHECK (code IN ('admin', 'teacher', 'accountant')),
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO staff_role (code, display_name, created_at) VALUES
  ('admin', 'Administrator', CURRENT_TIMESTAMP),
  ('teacher', 'Teacher', CURRENT_TIMESTAMP),
  ('accountant', 'Accountant', CURRENT_TIMESTAMP);

CREATE TABLE staff_account_role (
  staff_account_id TEXT NOT NULL REFERENCES staff_account(id) ON DELETE CASCADE,
  role_code TEXT NOT NULL REFERENCES staff_role(code) ON DELETE RESTRICT,
  assigned_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (staff_account_id, role_code)
);

ALTER TABLE outbound_email
  ADD COLUMN staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL;

CREATE TABLE staff_login_challenge (
  id TEXT PRIMARY KEY,
  staff_account_id TEXT NOT NULL REFERENCES staff_account(id) ON DELETE CASCADE,
  normalized_email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'used', 'expired', 'invalidated', 'delivery_failed')),
  outbound_email_id TEXT NOT NULL UNIQUE REFERENCES outbound_email(id) ON DELETE RESTRICT,
  requested_ip_hash TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  invalidated_at TEXT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  updated_at TEXT NOT NULL,
  CHECK (length(trim(normalized_email)) > 3),
  CHECK (length(token_hash) = 64),
  CHECK (requested_ip_hash IS NULL OR length(requested_ip_hash) = 64),
  CHECK (expires_at > created_at),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE TABLE staff_session (
  id TEXT PRIMARY KEY,
  staff_account_id TEXT NOT NULL REFERENCES staff_account(id) ON DELETE CASCADE,
  session_token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  CHECK (length(session_token_hash) = 64),
  CHECK (expires_at > created_at),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE TABLE staff_auth_throttle (
  key_hash TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('email', 'ip')),
  window_started_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
  updated_at TEXT NOT NULL,
  CHECK (length(key_hash) = 64)
);

ALTER TABLE audit_event RENAME TO audit_event_legacy;

CREATE TABLE audit_event (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('guardian', 'teacher', 'admin', 'staff', 'system', 'developer', 'unknown')),
  actor_ref TEXT,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  metadata_json TEXT,
  environment TEXT NOT NULL CHECK (environment IN ('production', 'staging', 'local')),
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (length(trim(action)) > 0),
  CHECK (length(trim(subject_type)) > 0),
  CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

INSERT INTO audit_event (
  id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
  metadata_json, environment, is_test, test_run_id, created_at
)
SELECT
  id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
  metadata_json, environment, is_test, test_run_id, created_at
FROM audit_event_legacy;

DROP TABLE audit_event_legacy;

CREATE INDEX idx_staff_account_status ON staff_account(status, email_normalized);
CREATE INDEX idx_staff_account_role_role ON staff_account_role(role_code, staff_account_id);
CREATE INDEX idx_staff_challenge_account_status_expiry
  ON staff_login_challenge(staff_account_id, status, expires_at);
CREATE INDEX idx_staff_challenge_status_expiry ON staff_login_challenge(status, expires_at);
CREATE INDEX idx_staff_session_account_expiry ON staff_session(staff_account_id, expires_at, revoked_at);
CREATE INDEX idx_staff_session_expiry ON staff_session(expires_at, revoked_at);
CREATE INDEX idx_outbound_email_staff_account ON outbound_email(staff_account_id, status, queued_at);
CREATE INDEX idx_audit_event_subject_time ON audit_event(subject_type, subject_id, occurred_at);
CREATE INDEX idx_audit_event_action_time ON audit_event(action, occurred_at);
