-- Keep minute scheduler reconciliation proportional to changed work. The
-- released Worker does not read these additive tables, so it remains safe
-- during the brief migration/deployment interval.

CREATE TABLE child_credit_reconciliation_queue (
  canonical_student_id TEXT PRIMARY KEY REFERENCES student(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed')) DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  lease_expires_at TEXT,
  completed_at TEXT,
  last_error_code TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_child_credit_reconciliation_queue_pending
  ON child_credit_reconciliation_queue(status, priority, updated_at, canonical_student_id);
CREATE INDEX idx_child_credit_reconciliation_queue_lease
  ON child_credit_reconciliation_queue(status, lease_expires_at);
CREATE INDEX idx_registration_draft_child_canonical_student
  ON registration_draft_child(canonical_student_id, id)
  WHERE canonical_student_id IS NOT NULL;
CREATE INDEX idx_enrollment_student_for_credit_reconciliation
  ON enrollment(student_id, id);
CREATE INDEX idx_payment_credit_request_for_reconciliation
  ON payment_credit(payment_request_id, id);

CREATE TABLE payment_milestone_reconciliation_queue (
  payment_request_id TEXT PRIMARY KEY REFERENCES payment_request(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed')) DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  lease_expires_at TEXT,
  completed_at TEXT,
  last_error_code TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_payment_milestone_reconciliation_queue_pending
  ON payment_milestone_reconciliation_queue(status, priority, updated_at, payment_request_id);
CREATE INDEX idx_payment_milestone_reconciliation_queue_lease
  ON payment_milestone_reconciliation_queue(status, lease_expires_at);

-- Each sweep advances by stable primary-key cursor. It is a one-time,
-- resumable catch-up for records created before these queue triggers exist.
CREATE TABLE scheduler_reconciliation_sweep (
  kind TEXT PRIMARY KEY CHECK (kind IN ('legacy_payment_credit', 'legacy_transfer_credit', 'payment_milestone')),
  cursor_id TEXT NOT NULL DEFAULT '',
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO scheduler_reconciliation_sweep (kind, cursor_id, completed_at, updated_at) VALUES
  ('legacy_payment_credit', '', NULL, '2026-09-21T00:00:00.000Z'),
  ('legacy_transfer_credit', '', NULL, '2026-09-21T00:00:00.000Z'),
  ('payment_milestone', '', NULL, '2026-09-21T00:00:00.000Z');

CREATE TRIGGER enqueue_child_credit_reconciliation_for_payment_credit_insert
AFTER INSERT ON payment_credit
BEGIN
  INSERT INTO child_credit_reconciliation_queue (canonical_student_id, status, priority, revision, updated_at)
  SELECT child.canonical_student_id, 'pending', 0, 1, NEW.updated_at
  FROM payment_request
  INNER JOIN payment_installment ON payment_installment.payment_request_id = payment_request.id
    AND payment_installment.installment_kind = 'initial'
  INNER JOIN registration_draft_child AS child ON child.id = payment_installment.registration_draft_child_id
  WHERE payment_request.id = NEW.payment_request_id AND child.canonical_student_id IS NOT NULL
  ON CONFLICT(canonical_student_id) DO UPDATE SET
    status = 'pending', priority = 0, revision = child_credit_reconciliation_queue.revision + 1,
    lease_expires_at = NULL, completed_at = NULL, last_error_code = NULL, updated_at = excluded.updated_at;
END;

CREATE TRIGGER enqueue_child_credit_reconciliation_for_payment_credit_update
AFTER UPDATE OF payment_request_id, available_amount_mnt, status, refunded_at ON payment_credit
BEGIN
  INSERT INTO child_credit_reconciliation_queue (canonical_student_id, status, priority, revision, updated_at)
  SELECT child.canonical_student_id, 'pending', 0, 1, NEW.updated_at
  FROM payment_request
  INNER JOIN payment_installment ON payment_installment.payment_request_id = payment_request.id
    AND payment_installment.installment_kind = 'initial'
  INNER JOIN registration_draft_child AS child ON child.id = payment_installment.registration_draft_child_id
  WHERE payment_request.id = NEW.payment_request_id AND child.canonical_student_id IS NOT NULL
  ON CONFLICT(canonical_student_id) DO UPDATE SET
    status = 'pending', priority = 0, revision = child_credit_reconciliation_queue.revision + 1,
    lease_expires_at = NULL, completed_at = NULL, last_error_code = NULL, updated_at = excluded.updated_at;
END;

CREATE TRIGGER enqueue_child_credit_reconciliation_for_transfer_credit_insert
AFTER INSERT ON class_transfer_credit
BEGIN
  INSERT INTO child_credit_reconciliation_queue (canonical_student_id, status, priority, revision, updated_at)
  SELECT enrollment.student_id, 'pending', 0, 1, NEW.updated_at
  FROM class_transfer
  INNER JOIN enrollment ON enrollment.id = class_transfer.source_enrollment_id
  WHERE class_transfer.id = NEW.class_transfer_id
  ON CONFLICT(canonical_student_id) DO UPDATE SET
    status = 'pending', priority = 0, revision = child_credit_reconciliation_queue.revision + 1,
    lease_expires_at = NULL, completed_at = NULL, last_error_code = NULL, updated_at = excluded.updated_at;
END;

CREATE TRIGGER enqueue_child_credit_reconciliation_for_transfer_credit_update
AFTER UPDATE OF available_amount_mnt, status, refunded_at ON class_transfer_credit
BEGIN
  INSERT INTO child_credit_reconciliation_queue (canonical_student_id, status, priority, revision, updated_at)
  SELECT enrollment.student_id, 'pending', 0, 1, NEW.updated_at
  FROM class_transfer
  INNER JOIN enrollment ON enrollment.id = class_transfer.source_enrollment_id
  WHERE class_transfer.id = NEW.class_transfer_id
  ON CONFLICT(canonical_student_id) DO UPDATE SET
    status = 'pending', priority = 0, revision = child_credit_reconciliation_queue.revision + 1,
    lease_expires_at = NULL, completed_at = NULL, last_error_code = NULL, updated_at = excluded.updated_at;
END;

CREATE TRIGGER enqueue_child_credit_reconciliation_for_canonical_owner
AFTER UPDATE OF canonical_student_id ON registration_draft_child
WHEN NEW.canonical_student_id IS NOT NULL AND NEW.canonical_student_id IS NOT OLD.canonical_student_id
BEGIN
  INSERT INTO child_credit_reconciliation_queue (canonical_student_id, status, priority, revision, updated_at)
  VALUES (NEW.canonical_student_id, 'pending', 0, 1, NEW.updated_at)
  ON CONFLICT(canonical_student_id) DO UPDATE SET
    status = 'pending', priority = 0, revision = child_credit_reconciliation_queue.revision + 1,
    lease_expires_at = NULL, completed_at = NULL, last_error_code = NULL, updated_at = excluded.updated_at;
END;

CREATE TRIGGER enqueue_payment_milestone_reconciliation_for_installment_insert
AFTER INSERT ON payment_installment
BEGIN
  INSERT INTO payment_milestone_reconciliation_queue (payment_request_id, status, priority, revision, updated_at)
  VALUES (NEW.payment_request_id, 'pending', 0, 1, NEW.updated_at)
  ON CONFLICT(payment_request_id) DO UPDATE SET
    status = 'pending', priority = 0, revision = payment_milestone_reconciliation_queue.revision + 1,
    lease_expires_at = NULL, completed_at = NULL, last_error_code = NULL, updated_at = excluded.updated_at;
END;

CREATE TRIGGER enqueue_payment_milestone_reconciliation_for_installment_update
AFTER UPDATE OF payment_request_id, installment_kind, reminder_at, effective_due_at, status ON payment_installment
BEGIN
  INSERT INTO payment_milestone_reconciliation_queue (payment_request_id, status, priority, revision, updated_at)
  VALUES (NEW.payment_request_id, 'pending', 0, 1, NEW.updated_at)
  ON CONFLICT(payment_request_id) DO UPDATE SET
    status = 'pending', priority = 0, revision = payment_milestone_reconciliation_queue.revision + 1,
    lease_expires_at = NULL, completed_at = NULL, last_error_code = NULL, updated_at = excluded.updated_at;
END;

CREATE TRIGGER enqueue_payment_milestone_reconciliation_for_confirmation_insert
AFTER INSERT ON payment_confirmation
BEGIN
  INSERT INTO payment_milestone_reconciliation_queue (payment_request_id, status, priority, revision, updated_at)
  VALUES (NEW.payment_request_id, 'pending', 0, 1, NEW.updated_at)
  ON CONFLICT(payment_request_id) DO UPDATE SET
    status = 'pending', priority = 0, revision = payment_milestone_reconciliation_queue.revision + 1,
    lease_expires_at = NULL, completed_at = NULL, last_error_code = NULL, updated_at = excluded.updated_at;
END;

CREATE TRIGGER enqueue_payment_milestone_reconciliation_for_confirmation_update
AFTER UPDATE OF status, seat_confirmation_approved, remaining_payment_due_at, remaining_reminder_at ON payment_confirmation
BEGIN
  INSERT INTO payment_milestone_reconciliation_queue (payment_request_id, status, priority, revision, updated_at)
  VALUES (NEW.payment_request_id, 'pending', 0, 1, NEW.updated_at)
  ON CONFLICT(payment_request_id) DO UPDATE SET
    status = 'pending', priority = 0, revision = payment_milestone_reconciliation_queue.revision + 1,
    lease_expires_at = NULL, completed_at = NULL, last_error_code = NULL, updated_at = excluded.updated_at;
END;

CREATE TRIGGER enqueue_payment_milestone_reconciliation_for_draft_status
AFTER UPDATE OF status ON registration_draft
BEGIN
  INSERT INTO payment_milestone_reconciliation_queue (payment_request_id, status, priority, revision, updated_at)
  SELECT id, 'pending', 0, 1, NEW.updated_at FROM payment_request WHERE registration_draft_id = NEW.id
  ON CONFLICT(payment_request_id) DO UPDATE SET
    status = 'pending', priority = 0, revision = payment_milestone_reconciliation_queue.revision + 1,
    lease_expires_at = NULL, completed_at = NULL, last_error_code = NULL, updated_at = excluded.updated_at;
END;

CREATE TRIGGER enqueue_payment_milestone_reconciliation_for_child_status
AFTER UPDATE OF status ON registration_draft_child
BEGIN
  INSERT INTO payment_milestone_reconciliation_queue (payment_request_id, status, priority, revision, updated_at)
  SELECT payment_request.id, 'pending', 0, 1, NEW.updated_at
  FROM payment_request WHERE payment_request.registration_draft_id = NEW.registration_draft_id
  ON CONFLICT(payment_request_id) DO UPDATE SET
    status = 'pending', priority = 0, revision = payment_milestone_reconciliation_queue.revision + 1,
    lease_expires_at = NULL, completed_at = NULL, last_error_code = NULL, updated_at = excluded.updated_at;
END;
