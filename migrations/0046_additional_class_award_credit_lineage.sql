-- Additional-class confirmation can turn a newly earned source award into
-- child credit when immutable received allocations already cover the source
-- agreement. Preserve that credit as a normal ledger root with a durable link
-- back to the award that created it.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE child_credit_operation_new (
  id TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('manual_add', 'manual_correction', 'apply', 'transfer', 'refund', 'discount_award_credit')),
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
    'credit_application', 'credit_transfer_debit', 'credit_transfer_credit', 'refund', 'discount_award_credit'
  )),
  amount_mnt INTEGER NOT NULL CHECK (amount_mnt != 0),
  origin_entry_id TEXT REFERENCES child_credit_entry_new(id) ON DELETE RESTRICT,
  source_payment_credit_id TEXT UNIQUE REFERENCES payment_credit(id) ON DELETE RESTRICT,
  source_class_transfer_credit_id TEXT UNIQUE REFERENCES class_transfer_credit(id) ON DELETE RESTRICT,
  source_discount_award_id TEXT UNIQUE REFERENCES discount_award(id) ON DELETE RESTRICT,
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

INSERT INTO child_credit_operation_new (
  id, operation_type, source_student_id, source_registration_draft_child_id,
  target_student_id, target_registration_draft_child_id, amount_mnt, reason,
  external_reference, created_by_staff_account_id, request_fingerprint, is_test,
  test_run_id, created_at
) SELECT id, operation_type, source_student_id, source_registration_draft_child_id,
  target_student_id, target_registration_draft_child_id, amount_mnt, reason,
  external_reference, created_by_staff_account_id, request_fingerprint, is_test,
  test_run_id, created_at
  FROM child_credit_operation;

-- Copy credit roots before debits because rows retain their immutable root FK.
INSERT INTO child_credit_entry_new (
  id, canonical_student_id, registration_draft_child_id, operation_id, entry_kind,
  amount_mnt, origin_entry_id, source_payment_credit_id,
  source_class_transfer_credit_id, payment_installment_id, correction_of_entry_id,
  created_by_staff_account_id, reason, external_reference, is_test, test_run_id,
  created_at
) SELECT id, canonical_student_id, registration_draft_child_id, operation_id, entry_kind,
  amount_mnt, origin_entry_id, source_payment_credit_id,
  source_class_transfer_credit_id, payment_installment_id, correction_of_entry_id,
  created_by_staff_account_id, reason, external_reference, is_test, test_run_id,
  created_at
  FROM child_credit_entry WHERE amount_mnt > 0;

INSERT INTO child_credit_entry_new (
  id, canonical_student_id, registration_draft_child_id, operation_id, entry_kind,
  amount_mnt, origin_entry_id, source_payment_credit_id,
  source_class_transfer_credit_id, payment_installment_id, correction_of_entry_id,
  created_by_staff_account_id, reason, external_reference, is_test, test_run_id,
  created_at
) SELECT id, canonical_student_id, registration_draft_child_id, operation_id, entry_kind,
  amount_mnt, origin_entry_id, source_payment_credit_id,
  source_class_transfer_credit_id, payment_installment_id, correction_of_entry_id,
  created_by_staff_account_id, reason, external_reference, is_test, test_run_id,
  created_at
  FROM child_credit_entry WHERE amount_mnt < 0;

DROP TABLE child_credit_entry;
DROP TABLE child_credit_operation;

ALTER TABLE child_credit_operation_new RENAME TO child_credit_operation;
ALTER TABLE child_credit_entry_new RENAME TO child_credit_entry;

CREATE INDEX idx_child_credit_entry_student ON child_credit_entry(canonical_student_id, created_at);
CREATE INDEX idx_child_credit_entry_draft_child ON child_credit_entry(registration_draft_child_id, created_at);
CREATE INDEX idx_child_credit_entry_origin ON child_credit_entry(origin_entry_id, created_at);
CREATE INDEX idx_child_credit_entry_installment ON child_credit_entry(payment_installment_id, created_at);
CREATE INDEX idx_child_credit_entry_discount_award ON child_credit_entry(source_discount_award_id);
CREATE INDEX idx_child_credit_operation_draft_child ON child_credit_operation(source_registration_draft_child_id, created_at);
