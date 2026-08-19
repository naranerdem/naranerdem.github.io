-- A narrow, durable correction window for teacher-recorded initial payments.
-- This is intentionally typed rather than a generic settings store.
CREATE TABLE payment_confirmation_grace_setting (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  grace_minutes INTEGER NOT NULL CHECK (grace_minutes BETWEEN 1 AND 60),
  updated_at TEXT NOT NULL
);

INSERT INTO payment_confirmation_grace_setting (singleton, grace_minutes, updated_at)
VALUES (1, 5, '2026-08-18T00:00:00.000Z');

CREATE TABLE payment_confirmation (
  id TEXT PRIMARY KEY,
  received_payment_id TEXT NOT NULL UNIQUE REFERENCES received_payment(id) ON DELETE RESTRICT,
  payment_request_id TEXT NOT NULL REFERENCES payment_request(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('tentative', 'finalized', 'undone')),
  finalize_after TEXT NOT NULL,
  seat_confirmation_approved INTEGER NOT NULL DEFAULT 0 CHECK (seat_confirmation_approved IN (0, 1)),
  remaining_payment_due_at TEXT,
  finalized_at TEXT,
  undone_at TEXT,
  undone_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 1 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  CHECK (test_run_id IS NULL OR is_test = 1),
  CHECK ((seat_confirmation_approved = 0 AND remaining_payment_due_at IS NULL)
    OR (seat_confirmation_approved = 1 AND remaining_payment_due_at IS NOT NULL))
);

CREATE INDEX idx_payment_confirmation_due
  ON payment_confirmation(status, finalize_after);
CREATE INDEX idx_payment_confirmation_request
  ON payment_confirmation(payment_request_id, status);
