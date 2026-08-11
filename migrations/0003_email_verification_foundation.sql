-- One-time email verification and short-lived verified-email sessions.
-- Raw challenge and session tokens are never stored.

ALTER TABLE outbound_email ADD COLUMN idempotency_key TEXT;
ALTER TABLE outbound_email ADD COLUMN failure_code TEXT;

CREATE UNIQUE INDEX idx_outbound_email_idempotency_key
  ON outbound_email(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE email_verification_challenge (
  id TEXT PRIMARY KEY,
  normalized_email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose IN ('registration_email')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'used', 'expired', 'invalidated')),
  outbound_email_id TEXT NOT NULL UNIQUE REFERENCES outbound_email(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  invalidated_at TEXT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  updated_at TEXT NOT NULL,
  CHECK (length(trim(normalized_email)) > 3),
  CHECK (length(token_hash) = 64),
  CHECK (expires_at > created_at),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE TABLE verified_email_session (
  id TEXT PRIMARY KEY,
  normalized_email TEXT NOT NULL,
  session_token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  CHECK (length(trim(normalized_email)) > 3),
  CHECK (length(session_token_hash) = 64),
  CHECK (expires_at > created_at),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE INDEX idx_email_verification_email_status_expiry
  ON email_verification_challenge(normalized_email, status, expires_at);
CREATE INDEX idx_email_verification_status_expiry
  ON email_verification_challenge(status, expires_at);
CREATE INDEX idx_verified_email_session_email_expiry
  ON verified_email_session(normalized_email, expires_at);
CREATE INDEX idx_verified_email_session_expiry
  ON verified_email_session(expires_at, revoked_at);
