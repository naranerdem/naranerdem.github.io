-- A finalized manual receipt is immutable evidence. A staff correction retires
-- its confirmation from projections and records a linked replacement receipt.
CREATE TABLE payment_receipt_correction (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  original_received_payment_id TEXT NOT NULL UNIQUE REFERENCES received_payment(id) ON DELETE RESTRICT,
  corrected_received_payment_id TEXT NOT NULL UNIQUE REFERENCES received_payment(id) ON DELETE RESTRICT,
  payment_request_id TEXT NOT NULL REFERENCES payment_request(id) ON DELETE RESTRICT,
  registration_draft_child_id TEXT NOT NULL REFERENCES registration_draft_child(id) ON DELETE RESTRICT,
  original_received_amount_mnt INTEGER NOT NULL CHECK (original_received_amount_mnt > 0),
  corrected_received_amount_mnt INTEGER NOT NULL CHECK (corrected_received_amount_mnt > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  review_fingerprint TEXT NOT NULL,
  corrected_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  corrected_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  CHECK (corrected_received_amount_mnt < original_received_amount_mnt),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE INDEX idx_payment_receipt_correction_child
  ON payment_receipt_correction(registration_draft_child_id, corrected_at);

-- Keep the active installment rows authoritative while retaining every prior
-- plan as an immutable staff-reviewed snapshot. This avoids duplicate debt
-- rows when an enrollment moves from two installments to three.
CREATE TABLE payment_installment_schedule_revision (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  payment_request_id TEXT NOT NULL REFERENCES payment_request(id) ON DELETE RESTRICT,
  registration_draft_child_id TEXT NOT NULL REFERENCES registration_draft_child(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  review_fingerprint TEXT NOT NULL,
  revised_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  revised_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE TABLE payment_installment_schedule_revision_entry (
  id TEXT PRIMARY KEY,
  payment_installment_schedule_revision_id TEXT NOT NULL REFERENCES payment_installment_schedule_revision(id) ON DELETE RESTRICT,
  payment_installment_id TEXT REFERENCES payment_installment(id) ON DELETE SET NULL,
  installment_number INTEGER NOT NULL CHECK (installment_number > 0),
  amount_mnt INTEGER NOT NULL CHECK (amount_mnt >= 0),
  due_at TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (payment_installment_schedule_revision_id, installment_number)
);

CREATE INDEX idx_payment_installment_schedule_revision_child
  ON payment_installment_schedule_revision(registration_draft_child_id, revised_at);
