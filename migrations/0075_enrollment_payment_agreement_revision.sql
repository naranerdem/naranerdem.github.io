-- A registration's original payment-plan choice remains historical evidence.
-- A reviewed agreement revision records a later negotiated fee/plan without
-- rewriting receipts, allocations, transfer lineage, or the intake snapshot.
CREATE TABLE enrollment_payment_agreement_revision (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  payment_request_id TEXT NOT NULL REFERENCES payment_request(id) ON DELETE RESTRICT,
  registration_draft_child_id TEXT NOT NULL REFERENCES registration_draft_child(id) ON DELETE RESTRICT,
  previous_payment_plan_code TEXT NOT NULL CHECK (previous_payment_plan_code IN ('single', 'two_installment')),
  proposed_payment_plan_code TEXT NOT NULL CHECK (proposed_payment_plan_code IN ('single', 'two_installment')),
  previous_pricing_snapshot_json TEXT NOT NULL,
  proposed_pricing_snapshot_json TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  review_fingerprint TEXT NOT NULL,
  revised_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  revised_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  CHECK (previous_payment_plan_code != proposed_payment_plan_code),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE INDEX idx_enrollment_payment_agreement_revision_child
  ON enrollment_payment_agreement_revision(registration_draft_child_id, revised_at, id);

CREATE TABLE enrollment_payment_agreement_revision_entry (
  id TEXT PRIMARY KEY,
  enrollment_payment_agreement_revision_id TEXT NOT NULL REFERENCES enrollment_payment_agreement_revision(id) ON DELETE RESTRICT,
  entry_state TEXT NOT NULL CHECK (entry_state IN ('previous', 'proposed')),
  payment_installment_id TEXT REFERENCES payment_installment(id) ON DELETE SET NULL,
  installment_number INTEGER NOT NULL CHECK (installment_number > 0),
  installment_kind TEXT NOT NULL CHECK (installment_kind IN ('initial', 'later')),
  amount_mnt INTEGER NOT NULL CHECK (amount_mnt > 0),
  due_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'partially_paid', 'paid', 'released')),
  allocated_amount_mnt INTEGER NOT NULL CHECK (allocated_amount_mnt >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (enrollment_payment_agreement_revision_id, entry_state, installment_number)
);

CREATE INDEX idx_enrollment_payment_agreement_revision_entry_revision
  ON enrollment_payment_agreement_revision_entry(enrollment_payment_agreement_revision_id, entry_state, installment_number);
