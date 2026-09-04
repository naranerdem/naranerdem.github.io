-- A confirmed seat can use either the ordinary later-installment schedule or
-- a staff-set deadline for an exceptionally incomplete first installment.
-- The latter is optional at the schema level; payment reconciliation remains
-- responsible for requiring it in that exceptional case.
-- D1 does not permit dropping a parent table while a dependent foreign key is
-- present, even in a deferred migration transaction. Preserve the milestone
-- rows in a structurally equivalent temporary table, then restore their
-- original foreign-key contract after the parent rebuild.
CREATE TABLE payment_notification_milestone_rebuilt (
  id TEXT PRIMARY KEY,
  milestone_key TEXT NOT NULL UNIQUE,
  registration_draft_id TEXT NOT NULL REFERENCES registration_draft(id) ON DELETE RESTRICT,
  registration_draft_child_id TEXT NOT NULL REFERENCES registration_draft_child(id) ON DELETE RESTRICT,
  payment_installment_id TEXT REFERENCES payment_installment(id) ON DELETE RESTRICT,
  payment_confirmation_id TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  milestone_type TEXT NOT NULL CHECK (milestone_type IN ('initial_reminder', 'initial_overdue', 'later_reminder', 'partial_balance_reminder')),
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  outbound_email_id TEXT REFERENCES outbound_email(id) ON DELETE SET NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT,
  processing_started_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  CHECK (test_run_id IS NULL OR is_test = 1),
  CHECK ((payment_installment_id IS NOT NULL) OR (payment_confirmation_id IS NOT NULL))
);

INSERT INTO payment_notification_milestone_rebuilt (
  id, milestone_key, registration_draft_id, registration_draft_child_id,
  payment_installment_id, payment_confirmation_id, channel, milestone_type,
  scheduled_at, status, outbound_email_id, attempt_count, last_error_code,
  processing_started_at, sent_at, created_at, updated_at, is_test, test_run_id
)
SELECT
  id, milestone_key, registration_draft_id, registration_draft_child_id,
  payment_installment_id, payment_confirmation_id, channel, milestone_type,
  scheduled_at, status, outbound_email_id, attempt_count, last_error_code,
  processing_started_at, sent_at, created_at, updated_at, is_test, test_run_id
FROM payment_notification_milestone;

DROP TABLE payment_notification_milestone;

CREATE TABLE payment_confirmation_rebuilt (
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
  remaining_reminder_lead_minutes INTEGER,
  remaining_reminder_at TEXT,
  CHECK (test_run_id IS NULL OR is_test = 1),
  CHECK (seat_confirmation_approved IN (0, 1))
);

INSERT INTO payment_confirmation_rebuilt (
  id, received_payment_id, payment_request_id, status, finalize_after,
  seat_confirmation_approved, remaining_payment_due_at, finalized_at, undone_at,
  undone_by_staff_account_id, created_at, updated_at, is_test, test_run_id,
  remaining_reminder_lead_minutes, remaining_reminder_at
)
SELECT
  id, received_payment_id, payment_request_id, status, finalize_after,
  seat_confirmation_approved, remaining_payment_due_at, finalized_at, undone_at,
  undone_by_staff_account_id, created_at, updated_at, is_test, test_run_id,
  remaining_reminder_lead_minutes, remaining_reminder_at
FROM payment_confirmation;

DROP TABLE payment_confirmation;
ALTER TABLE payment_confirmation_rebuilt RENAME TO payment_confirmation;

CREATE INDEX idx_payment_confirmation_due
  ON payment_confirmation(status, finalize_after);
CREATE INDEX idx_payment_confirmation_request
  ON payment_confirmation(payment_request_id, status);

CREATE TABLE payment_notification_milestone (
  id TEXT PRIMARY KEY,
  milestone_key TEXT NOT NULL UNIQUE,
  registration_draft_id TEXT NOT NULL REFERENCES registration_draft(id) ON DELETE RESTRICT,
  registration_draft_child_id TEXT NOT NULL REFERENCES registration_draft_child(id) ON DELETE RESTRICT,
  payment_installment_id TEXT REFERENCES payment_installment(id) ON DELETE RESTRICT,
  payment_confirmation_id TEXT REFERENCES payment_confirmation(id) ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  milestone_type TEXT NOT NULL CHECK (milestone_type IN ('initial_reminder', 'initial_overdue', 'later_reminder', 'partial_balance_reminder')),
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  outbound_email_id TEXT REFERENCES outbound_email(id) ON DELETE SET NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT,
  processing_started_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  CHECK (test_run_id IS NULL OR is_test = 1),
  CHECK ((payment_installment_id IS NOT NULL) OR (payment_confirmation_id IS NOT NULL))
);

INSERT INTO payment_notification_milestone (
  id, milestone_key, registration_draft_id, registration_draft_child_id,
  payment_installment_id, payment_confirmation_id, channel, milestone_type,
  scheduled_at, status, outbound_email_id, attempt_count, last_error_code,
  processing_started_at, sent_at, created_at, updated_at, is_test, test_run_id
)
SELECT
  id, milestone_key, registration_draft_id, registration_draft_child_id,
  payment_installment_id, payment_confirmation_id, channel, milestone_type,
  scheduled_at, status, outbound_email_id, attempt_count, last_error_code,
  processing_started_at, sent_at, created_at, updated_at, is_test, test_run_id
FROM payment_notification_milestone_rebuilt;

DROP TABLE payment_notification_milestone_rebuilt;

CREATE INDEX idx_payment_notification_due
  ON payment_notification_milestone(status, scheduled_at);
CREATE INDEX idx_payment_notification_installment
  ON payment_notification_milestone(payment_installment_id, milestone_type);
