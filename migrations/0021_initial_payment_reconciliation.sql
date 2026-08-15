-- Initial-payment reconciliation. A provisional email-confirmation hold may
-- expire; an active initial-payment reservation never releases merely because
-- its payment deadline passes.

CREATE TABLE payment_request (
  id TEXT PRIMARY KEY,
  registration_draft_id TEXT NOT NULL UNIQUE REFERENCES registration_draft(id) ON DELETE RESTRICT,
  payment_reference TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 1 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  CHECK (length(payment_reference) BETWEEN 6 AND 32),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE TABLE payment_installment (
  id TEXT PRIMARY KEY,
  payment_request_id TEXT NOT NULL REFERENCES payment_request(id) ON DELETE RESTRICT,
  registration_draft_child_id TEXT NOT NULL REFERENCES registration_draft_child(id) ON DELETE RESTRICT,
  installment_number INTEGER NOT NULL CHECK (installment_number >= 1),
  installment_kind TEXT NOT NULL CHECK (installment_kind IN ('initial', 'later')),
  amount_mnt INTEGER NOT NULL CHECK (amount_mnt > 0),
  original_due_at TEXT NOT NULL,
  effective_due_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'partially_paid', 'paid', 'released')),
  paid_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 1 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  UNIQUE (registration_draft_child_id, installment_number),
  CHECK (effective_due_at >= original_due_at),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE TABLE received_payment (
  id TEXT PRIMARY KEY,
  payment_request_id TEXT REFERENCES payment_request(id) ON DELETE SET NULL,
  received_amount_mnt INTEGER NOT NULL CHECK (received_amount_mnt > 0),
  received_at TEXT NOT NULL,
  payment_source TEXT NOT NULL CHECK (payment_source IN (
    'staff_manual_bank', 'staff_manual_cash', 'bank_statement', 'bank_sms', 'bank_api', 'qpay'
  )),
  reconciliation_status TEXT NOT NULL CHECK (reconciliation_status IN ('confirmed', 'needs_attention')),
  confirmed_at TEXT NOT NULL,
  confirmed_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 1 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE TABLE payment_allocation (
  id TEXT PRIMARY KEY,
  received_payment_id TEXT NOT NULL REFERENCES received_payment(id) ON DELETE RESTRICT,
  payment_installment_id TEXT NOT NULL REFERENCES payment_installment(id) ON DELETE RESTRICT,
  allocated_amount_mnt INTEGER NOT NULL CHECK (allocated_amount_mnt > 0),
  allocated_at TEXT NOT NULL,
  allocated_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 1 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE TABLE payment_evidence (
  id TEXT PRIMARY KEY,
  payment_request_id TEXT NOT NULL REFERENCES payment_request(id) ON DELETE RESTRICT,
  received_payment_id TEXT REFERENCES received_payment(id) ON DELETE SET NULL,
  registration_draft_id TEXT NOT NULL REFERENCES registration_draft(id) ON DELETE RESTRICT,
  payment_installment_id TEXT REFERENCES payment_installment(id) ON DELETE SET NULL,
  evidence_type TEXT NOT NULL CHECK (evidence_type IN (
    'staff_manual_bank', 'staff_manual_cash', 'parent_claim', 'staff_checked_not_found',
    'bank_statement', 'bank_sms', 'bank_api', 'qpay', 'receipt_attachment'
  )),
  recorded_at TEXT NOT NULL,
  recorded_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 1 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

ALTER TABLE registration_draft ADD COLUMN initial_payment_reconciled_at TEXT;
ALTER TABLE registration_draft_child ADD COLUMN initial_payment_reconciled_at TEXT;

CREATE UNIQUE INDEX idx_payment_evidence_parent_claim_once
  ON payment_evidence(payment_request_id, evidence_type)
  WHERE evidence_type = 'parent_claim';
CREATE INDEX idx_payment_installment_request_status
  ON payment_installment(payment_request_id, installment_kind, status, effective_due_at);
CREATE INDEX idx_payment_installment_child
  ON payment_installment(registration_draft_child_id, installment_number);
CREATE INDEX idx_received_payment_request
  ON received_payment(payment_request_id, received_at);
CREATE INDEX idx_payment_allocation_payment
  ON payment_allocation(received_payment_id);
CREATE INDEX idx_payment_allocation_installment
  ON payment_allocation(payment_installment_id);
CREATE INDEX idx_payment_evidence_request_type
  ON payment_evidence(payment_request_id, evidence_type, recorded_at);
