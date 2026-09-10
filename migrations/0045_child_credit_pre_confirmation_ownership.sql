-- Credit may be recorded against a registration child before canonical
-- promotion. The draft-child identity remains the durable operation owner;
-- canonical_student_id is attached atomically when promotion succeeds.
-- Wrangler applies remote D1 migrations inside a transaction. `foreign_keys`
-- cannot be toggled there, so defer checks until the rebuilt tables have been
-- renamed back to their durable names.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE child_credit_operation_new (
  id TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('manual_add', 'manual_correction', 'apply', 'transfer', 'refund')),
  source_student_id TEXT REFERENCES student(id) ON DELETE RESTRICT,
  source_registration_draft_child_id TEXT REFERENCES registration_draft_child(id) ON DELETE RESTRICT,
  target_student_id TEXT REFERENCES student(id) ON DELETE RESTRICT,
  target_registration_draft_child_id TEXT REFERENCES registration_draft_child(id) ON DELETE RESTRICT,
  amount_mnt INTEGER NOT NULL CHECK (amount_mnt > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  external_reference TEXT,
  created_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  request_fingerprint TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (test_run_id IS NULL OR is_test = 1),
  CHECK (source_student_id IS NOT NULL OR source_registration_draft_child_id IS NOT NULL)
);

CREATE TABLE child_credit_entry_new (
  id TEXT PRIMARY KEY,
  canonical_student_id TEXT REFERENCES student(id) ON DELETE RESTRICT,
  registration_draft_child_id TEXT REFERENCES registration_draft_child(id) ON DELETE RESTRICT,
  operation_id TEXT REFERENCES child_credit_operation_new(id) ON DELETE RESTRICT,
  entry_kind TEXT NOT NULL CHECK (entry_kind IN (
    'payment_release', 'transfer_difference', 'manual_addition', 'manual_correction',
    'credit_application', 'credit_transfer_debit', 'credit_transfer_credit', 'refund'
  )),
  amount_mnt INTEGER NOT NULL CHECK (amount_mnt != 0),
  origin_entry_id TEXT REFERENCES child_credit_entry_new(id) ON DELETE RESTRICT,
  source_payment_credit_id TEXT UNIQUE REFERENCES payment_credit(id) ON DELETE RESTRICT,
  source_class_transfer_credit_id TEXT UNIQUE REFERENCES class_transfer_credit(id) ON DELETE RESTRICT,
  payment_installment_id TEXT REFERENCES payment_installment(id) ON DELETE RESTRICT,
  correction_of_entry_id TEXT REFERENCES child_credit_entry_new(id) ON DELETE RESTRICT,
  created_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  external_reference TEXT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (test_run_id IS NULL OR is_test = 1),
  CHECK ((amount_mnt < 0 AND origin_entry_id IS NOT NULL) OR amount_mnt > 0),
  CHECK (canonical_student_id IS NOT NULL OR registration_draft_child_id IS NOT NULL)
);

CREATE TABLE credit_application_confirmation_new (
  id TEXT PRIMARY KEY,
  child_credit_operation_id TEXT NOT NULL UNIQUE REFERENCES child_credit_operation_new(id) ON DELETE RESTRICT,
  payment_request_id TEXT NOT NULL REFERENCES payment_request(id) ON DELETE RESTRICT,
  registration_draft_child_id TEXT NOT NULL REFERENCES registration_draft_child(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('tentative', 'finalized', 'undone')),
  finalize_after TEXT NOT NULL,
  seat_confirmation_approved INTEGER NOT NULL DEFAULT 1 CHECK (seat_confirmation_approved IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE TABLE child_credit_payment_review_new (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  canonical_student_id TEXT REFERENCES student(id) ON DELETE RESTRICT,
  registration_draft_child_id TEXT NOT NULL REFERENCES registration_draft_child(id) ON DELETE RESTRICT,
  payment_installment_id TEXT NOT NULL REFERENCES payment_installment(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('leave_unused')),
  available_credit_mnt INTEGER NOT NULL CHECK (available_credit_mnt > 0),
  outstanding_amount_mnt INTEGER NOT NULL CHECK (outstanding_amount_mnt > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  created_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  request_fingerprint TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

INSERT INTO child_credit_operation_new (
  id, operation_type, source_student_id, target_student_id, amount_mnt, reason,
  external_reference, created_by_staff_account_id, request_fingerprint, is_test,
  test_run_id, created_at
) SELECT id, operation_type, source_student_id, target_student_id, amount_mnt, reason,
  external_reference, created_by_staff_account_id, request_fingerprint, is_test,
  test_run_id, created_at
  FROM child_credit_operation;

INSERT INTO child_credit_entry_new (
  id, canonical_student_id, operation_id, entry_kind, amount_mnt, origin_entry_id,
  source_payment_credit_id, source_class_transfer_credit_id, payment_installment_id,
  correction_of_entry_id, created_by_staff_account_id, reason, external_reference,
  is_test, test_run_id, created_at
) SELECT id, canonical_student_id, operation_id, entry_kind, amount_mnt, origin_entry_id,
  source_payment_credit_id, source_class_transfer_credit_id, payment_installment_id,
  correction_of_entry_id, created_by_staff_account_id, reason, external_reference,
  is_test, test_run_id, created_at
  FROM child_credit_entry
  WHERE amount_mnt > 0;

-- Existing debits reference their immutable root. D1 enforces those references
-- while the migration runs, so copy the roots before their applications,
-- transfers, refunds, and corrections.
INSERT INTO child_credit_entry_new (
  id, canonical_student_id, operation_id, entry_kind, amount_mnt, origin_entry_id,
  source_payment_credit_id, source_class_transfer_credit_id, payment_installment_id,
  correction_of_entry_id, created_by_staff_account_id, reason, external_reference,
  is_test, test_run_id, created_at
) SELECT id, canonical_student_id, operation_id, entry_kind, amount_mnt, origin_entry_id,
  source_payment_credit_id, source_class_transfer_credit_id, payment_installment_id,
  correction_of_entry_id, created_by_staff_account_id, reason, external_reference,
  is_test, test_run_id, created_at
  FROM child_credit_entry
  WHERE amount_mnt < 0;

INSERT INTO credit_application_confirmation_new (
  id, child_credit_operation_id, payment_request_id, registration_draft_child_id,
  status, finalize_after, seat_confirmation_approved, created_at, updated_at,
  is_test, test_run_id
) SELECT id, child_credit_operation_id, payment_request_id, registration_draft_child_id,
  status, finalize_after, seat_confirmation_approved, created_at, updated_at,
  is_test, test_run_id
  FROM credit_application_confirmation;

INSERT INTO child_credit_payment_review_new (
  id, operation_id, canonical_student_id, payment_installment_id, decision,
  available_credit_mnt, outstanding_amount_mnt, reason, created_by_staff_account_id,
  request_fingerprint, is_test, test_run_id, created_at, updated_at,
  registration_draft_child_id
) SELECT review.id, review.operation_id, review.canonical_student_id, review.payment_installment_id, review.decision,
  review.available_credit_mnt, review.outstanding_amount_mnt, review.reason, review.created_by_staff_account_id,
  review.request_fingerprint, review.is_test, review.test_run_id, review.created_at, review.updated_at,
  installment.registration_draft_child_id
  FROM child_credit_payment_review AS review
  INNER JOIN payment_installment AS installment ON installment.id = review.payment_installment_id;

DROP TABLE credit_application_confirmation;
DROP TABLE child_credit_payment_review;
DROP TABLE child_credit_entry;
DROP TABLE child_credit_operation;

ALTER TABLE child_credit_operation_new RENAME TO child_credit_operation;
ALTER TABLE child_credit_entry_new RENAME TO child_credit_entry;
ALTER TABLE credit_application_confirmation_new RENAME TO credit_application_confirmation;
ALTER TABLE child_credit_payment_review_new RENAME TO child_credit_payment_review;

CREATE INDEX idx_child_credit_entry_student ON child_credit_entry(canonical_student_id, created_at);
CREATE INDEX idx_child_credit_entry_draft_child ON child_credit_entry(registration_draft_child_id, created_at);
CREATE INDEX idx_child_credit_entry_origin ON child_credit_entry(origin_entry_id, created_at);
CREATE INDEX idx_child_credit_entry_installment ON child_credit_entry(payment_installment_id, created_at);
CREATE INDEX idx_child_credit_operation_draft_child ON child_credit_operation(source_registration_draft_child_id, created_at);
CREATE INDEX idx_child_credit_payment_review_installment ON child_credit_payment_review(payment_installment_id, created_at DESC);
