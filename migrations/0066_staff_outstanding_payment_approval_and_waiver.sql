-- A teacher may confirm a real enrollment before any money is received.  This
-- record is deliberately separate from payment_confirmation: that table is
-- receipt-backed and must never be used to manufacture a zero-value receipt.
CREATE TABLE staff_outstanding_payment_approval (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  payment_request_id TEXT NOT NULL REFERENCES payment_request(id) ON DELETE RESTRICT,
  registration_draft_child_id TEXT NOT NULL UNIQUE REFERENCES registration_draft_child(id) ON DELETE RESTRICT,
  initial_payment_installment_id TEXT NOT NULL UNIQUE REFERENCES payment_installment(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active', 'settled', 'waived')),
  remaining_payment_due_at TEXT NOT NULL,
  remaining_reminder_lead_minutes INTEGER NOT NULL CHECK (remaining_reminder_lead_minutes >= 0),
  remaining_reminder_at TEXT NOT NULL,
  approved_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  approved_at TEXT NOT NULL,
  settled_at TEXT,
  waived_at TEXT,
  updated_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE INDEX idx_staff_outstanding_payment_approval_request
  ON staff_outstanding_payment_approval(payment_request_id, status);
CREATE INDEX idx_staff_outstanding_payment_approval_due
  ON staff_outstanding_payment_approval(status, remaining_payment_due_at);

CREATE TABLE staff_outstanding_payment_deadline_change (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  staff_outstanding_payment_approval_id TEXT NOT NULL REFERENCES staff_outstanding_payment_approval(id) ON DELETE RESTRICT,
  previous_due_at TEXT NOT NULL,
  next_due_at TEXT NOT NULL,
  changed_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  changed_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

-- A waiver is an immutable staff decision against the still-unpaid portion of
-- one or more installments.  It does not affect receipts, allocations, or
-- child-credit/payment-credit lineage.
CREATE TABLE payment_fee_waiver (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  payment_request_id TEXT NOT NULL REFERENCES payment_request(id) ON DELETE RESTRICT,
  registration_draft_child_id TEXT NOT NULL REFERENCES registration_draft_child(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  review_fingerprint TEXT NOT NULL,
  waived_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  waived_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  CHECK (test_run_id IS NULL OR is_test = 1),
  UNIQUE(registration_draft_child_id)
);

CREATE TABLE payment_fee_waiver_installment (
  payment_fee_waiver_id TEXT NOT NULL REFERENCES payment_fee_waiver(id) ON DELETE RESTRICT,
  payment_installment_id TEXT NOT NULL REFERENCES payment_installment(id) ON DELETE RESTRICT,
  waived_amount_mnt INTEGER NOT NULL CHECK (waived_amount_mnt > 0),
  expected_applied_amount_mnt INTEGER NOT NULL CHECK (expected_applied_amount_mnt >= 0),
  PRIMARY KEY (payment_fee_waiver_id, payment_installment_id)
);

CREATE INDEX idx_payment_fee_waiver_child
  ON payment_fee_waiver(registration_draft_child_id, waived_at);
CREATE INDEX idx_payment_fee_waiver_installment
  ON payment_fee_waiver_installment(payment_installment_id, payment_fee_waiver_id);

-- A concurrent payment can only reduce the still-unpaid cash obligation.  A
-- waiver insert therefore has a database-level floor as well as the reviewed
-- service fingerprint, so it can never drive the underlying installment below
-- zero while a payment/refund operation races it.
CREATE TRIGGER payment_fee_waiver_installment_available_insert
BEFORE INSERT ON payment_fee_waiver_installment
WHEN NEW.expected_applied_amount_mnt != (
  SELECT COALESCE((SELECT SUM(CASE WHEN confirmation.status = 'undone' THEN 0 ELSE allocation.allocated_amount_mnt END)
    FROM payment_allocation AS allocation
    LEFT JOIN payment_confirmation AS confirmation ON confirmation.received_payment_id = allocation.received_payment_id
    WHERE allocation.payment_installment_id = payment_installment.id), 0)
    + COALESCE((SELECT SUM(-credit_entry.amount_mnt) FROM child_credit_entry AS credit_entry
      WHERE credit_entry.payment_installment_id = payment_installment.id
        AND credit_entry.entry_kind = 'credit_application'), 0)
  FROM payment_installment WHERE payment_installment.id = NEW.payment_installment_id
)
OR NEW.waived_amount_mnt > (
  SELECT payment_installment.amount_mnt
    - COALESCE((SELECT SUM(CASE WHEN confirmation.status = 'undone' THEN 0 ELSE allocation.allocated_amount_mnt END)
      FROM payment_allocation AS allocation
      LEFT JOIN payment_confirmation AS confirmation ON confirmation.received_payment_id = allocation.received_payment_id
      WHERE allocation.payment_installment_id = payment_installment.id), 0)
    - COALESCE((SELECT SUM(-credit_entry.amount_mnt) FROM child_credit_entry AS credit_entry
      WHERE credit_entry.payment_installment_id = payment_installment.id
        AND credit_entry.entry_kind = 'credit_application'), 0)
    - COALESCE((SELECT SUM(existing.waived_amount_mnt) FROM payment_fee_waiver_installment AS existing
      WHERE existing.payment_installment_id = payment_installment.id), 0)
  FROM payment_installment WHERE payment_installment.id = NEW.payment_installment_id
)
BEGIN
  SELECT RAISE(ABORT, 'payment fee waiver exceeds the remaining installment');
END;

-- 0064's queue is the authoritative reminder catch-up mechanism.  Both
-- records affect a request's due balance, so enqueue it rather than relying
-- on a historical scan.
CREATE TRIGGER enqueue_payment_milestone_reconciliation_for_outstanding_approval_insert
AFTER INSERT ON staff_outstanding_payment_approval
BEGIN
  INSERT INTO payment_milestone_reconciliation_queue (payment_request_id, status, priority, revision, updated_at)
  VALUES (NEW.payment_request_id, 'pending', 0, 1, NEW.updated_at)
  ON CONFLICT(payment_request_id) DO UPDATE SET
    status = 'pending', priority = 0, revision = payment_milestone_reconciliation_queue.revision + 1,
    lease_expires_at = NULL, completed_at = NULL, last_error_code = NULL, updated_at = excluded.updated_at;
END;

CREATE TRIGGER enqueue_payment_milestone_reconciliation_for_outstanding_approval_update
AFTER UPDATE OF status, remaining_payment_due_at, remaining_reminder_at ON staff_outstanding_payment_approval
BEGIN
  INSERT INTO payment_milestone_reconciliation_queue (payment_request_id, status, priority, revision, updated_at)
  VALUES (NEW.payment_request_id, 'pending', 0, 1, NEW.updated_at)
  ON CONFLICT(payment_request_id) DO UPDATE SET
    status = 'pending', priority = 0, revision = payment_milestone_reconciliation_queue.revision + 1,
    lease_expires_at = NULL, completed_at = NULL, last_error_code = NULL, updated_at = excluded.updated_at;
END;

CREATE TRIGGER enqueue_payment_milestone_reconciliation_for_fee_waiver
AFTER INSERT ON payment_fee_waiver
BEGIN
  INSERT INTO payment_milestone_reconciliation_queue (payment_request_id, status, priority, revision, updated_at)
  VALUES (NEW.payment_request_id, 'pending', 0, 1, NEW.waived_at)
  ON CONFLICT(payment_request_id) DO UPDATE SET
    status = 'pending', priority = 0, revision = payment_milestone_reconciliation_queue.revision + 1,
    lease_expires_at = NULL, completed_at = NULL, last_error_code = NULL, updated_at = excluded.updated_at;
END;
