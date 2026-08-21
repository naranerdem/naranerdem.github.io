-- Durable payment-notification timing is separate from payment state. The
-- milestone row is channel-neutral so a later SMS delivery can accompany the
-- same operational milestone without changing registration identity or money.

CREATE TABLE payment_reminder_setting (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  initial_reminder_lead_minutes INTEGER NOT NULL CHECK (initial_reminder_lead_minutes BETWEEN 1 AND 10080),
  later_reminder_lead_minutes INTEGER NOT NULL CHECK (later_reminder_lead_minutes BETWEEN 1 AND 43200),
  updated_at TEXT NOT NULL
);

INSERT INTO payment_reminder_setting (
  singleton, initial_reminder_lead_minutes, later_reminder_lead_minutes, updated_at
) VALUES (1, 360, 4320, '2026-08-21T00:00:00.000Z');

ALTER TABLE registration_draft_child ADD COLUMN facebook_name TEXT;

ALTER TABLE payment_installment ADD COLUMN reminder_lead_minutes INTEGER;
ALTER TABLE payment_installment ADD COLUMN reminder_at TEXT;
ALTER TABLE payment_confirmation ADD COLUMN remaining_reminder_lead_minutes INTEGER;
ALTER TABLE payment_confirmation ADD COLUMN remaining_reminder_at TEXT;

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

CREATE INDEX idx_payment_notification_due
  ON payment_notification_milestone(status, scheduled_at);
CREATE INDEX idx_payment_notification_installment
  ON payment_notification_milestone(payment_installment_id, milestone_type);
