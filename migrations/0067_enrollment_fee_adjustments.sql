-- A staff discount is an enrollment-scoped reduction of an active agreement.
-- It is deliberately separate from 0066's immutable debt-waiver record: it
-- neither creates a receipt nor any transferable/refundable credit.
CREATE TABLE enrollment_fee_adjustment (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  payment_request_id TEXT NOT NULL REFERENCES payment_request(id) ON DELETE RESTRICT,
  registration_draft_child_id TEXT NOT NULL REFERENCES registration_draft_child(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  review_fingerprint TEXT NOT NULL,
  adjusted_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  adjusted_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE TABLE enrollment_fee_adjustment_installment (
  enrollment_fee_adjustment_id TEXT NOT NULL REFERENCES enrollment_fee_adjustment(id) ON DELETE RESTRICT,
  payment_installment_id TEXT NOT NULL REFERENCES payment_installment(id) ON DELETE RESTRICT,
  adjusted_amount_mnt INTEGER NOT NULL CHECK (adjusted_amount_mnt > 0),
  expected_applied_amount_mnt INTEGER NOT NULL CHECK (expected_applied_amount_mnt >= 0),
  expected_effective_amount_mnt INTEGER NOT NULL CHECK (expected_effective_amount_mnt >= 0),
  expected_prior_adjustment_mnt INTEGER NOT NULL CHECK (expected_prior_adjustment_mnt >= 0),
  PRIMARY KEY (enrollment_fee_adjustment_id, payment_installment_id)
);

CREATE INDEX idx_enrollment_fee_adjustment_child
  ON enrollment_fee_adjustment(registration_draft_child_id, adjusted_at);
CREATE INDEX idx_enrollment_fee_adjustment_installment
  ON enrollment_fee_adjustment_installment(payment_installment_id, enrollment_fee_adjustment_id);

-- Reject a payment/credit race and make the reviewed amount a hard upper bound
-- without trying to duplicate the discount projection inside a trigger.
CREATE TRIGGER enrollment_fee_adjustment_installment_available_insert
BEFORE INSERT ON enrollment_fee_adjustment_installment
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
OR NEW.adjusted_amount_mnt > NEW.expected_effective_amount_mnt - NEW.expected_applied_amount_mnt - NEW.expected_prior_adjustment_mnt
BEGIN
  SELECT RAISE(ABORT, 'enrollment fee adjustment exceeds the remaining installment');
END;

CREATE TRIGGER enqueue_payment_milestone_reconciliation_for_enrollment_fee_adjustment
AFTER INSERT ON enrollment_fee_adjustment
BEGIN
  INSERT INTO payment_milestone_reconciliation_queue (payment_request_id, status, priority, revision, updated_at)
  VALUES (NEW.payment_request_id, 'pending', 0, 1, NEW.adjusted_at)
  ON CONFLICT(payment_request_id) DO UPDATE SET
    status = 'pending', priority = 0, revision = payment_milestone_reconciliation_queue.revision + 1,
    lease_expires_at = NULL, completed_at = NULL, last_error_code = NULL, updated_at = excluded.updated_at;
END;
