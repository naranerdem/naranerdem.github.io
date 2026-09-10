-- Child credit is an immutable, child-owned ledger. It complements rather
-- than rewrites received-payment, allocation, or selected-plan history.
CREATE TABLE child_credit_operation (
  id TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('manual_add', 'manual_correction', 'apply', 'transfer', 'refund')),
  source_student_id TEXT NOT NULL REFERENCES student(id) ON DELETE RESTRICT,
  target_student_id TEXT REFERENCES student(id) ON DELETE RESTRICT,
  amount_mnt INTEGER NOT NULL CHECK (amount_mnt > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  external_reference TEXT,
  created_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  request_fingerprint TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE TABLE child_credit_entry (
  id TEXT PRIMARY KEY,
  canonical_student_id TEXT NOT NULL REFERENCES student(id) ON DELETE RESTRICT,
  operation_id TEXT REFERENCES child_credit_operation(id) ON DELETE RESTRICT,
  entry_kind TEXT NOT NULL CHECK (entry_kind IN (
    'payment_release', 'transfer_difference', 'manual_addition', 'manual_correction',
    'credit_application', 'credit_transfer_debit', 'credit_transfer_credit', 'refund'
  )),
  amount_mnt INTEGER NOT NULL CHECK (amount_mnt != 0),
  origin_entry_id TEXT REFERENCES child_credit_entry(id) ON DELETE RESTRICT,
  source_payment_credit_id TEXT UNIQUE REFERENCES payment_credit(id) ON DELETE RESTRICT,
  source_class_transfer_credit_id TEXT UNIQUE REFERENCES class_transfer_credit(id) ON DELETE RESTRICT,
  payment_installment_id TEXT REFERENCES payment_installment(id) ON DELETE RESTRICT,
  correction_of_entry_id TEXT REFERENCES child_credit_entry(id) ON DELETE RESTRICT,
  created_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  external_reference TEXT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (test_run_id IS NULL OR is_test = 1),
  CHECK ((amount_mnt < 0 AND origin_entry_id IS NOT NULL) OR amount_mnt > 0)
);

CREATE INDEX idx_child_credit_entry_student ON child_credit_entry(canonical_student_id, created_at);
CREATE INDEX idx_child_credit_entry_origin ON child_credit_entry(origin_entry_id, created_at);
CREATE INDEX idx_child_credit_entry_installment ON child_credit_entry(payment_installment_id, created_at);

-- Debit admission is guarded by the child-credit service inside the same D1
-- batch as every operation. D1's migration query endpoint cannot safely carry
-- trigger bodies, so no trigger DDL is used in this migration.

-- Existing available credit becomes one immutable origin exactly once. Rows
-- without canonical identity remain on their existing reconciliation path.
INSERT OR IGNORE INTO child_credit_entry (
  id, canonical_student_id, entry_kind, amount_mnt, source_payment_credit_id,
  reason, is_test, test_run_id, created_at
)
SELECT 'child-credit:payment:' || payment_credit.id, registration_draft_child.canonical_student_id,
  'payment_release', payment_credit.available_amount_mnt, payment_credit.id,
  'Released payment credit', payment_credit.is_test, payment_credit.test_run_id, payment_credit.created_at
FROM payment_credit
INNER JOIN payment_request ON payment_request.id = payment_credit.payment_request_id
INNER JOIN payment_installment ON payment_installment.payment_request_id = payment_request.id
  AND payment_installment.installment_kind = 'initial'
INNER JOIN registration_draft_child ON registration_draft_child.id = payment_installment.registration_draft_child_id
WHERE registration_draft_child.canonical_student_id IS NOT NULL;

INSERT OR IGNORE INTO child_credit_entry (
  id, canonical_student_id, entry_kind, amount_mnt, source_class_transfer_credit_id,
  reason, is_test, test_run_id, created_at
)
SELECT 'child-credit:transfer:' || class_transfer_credit.id, enrollment.student_id,
  'transfer_difference', class_transfer_credit.available_amount_mnt, class_transfer_credit.id,
  'Class transfer price difference', class_transfer_credit.is_test, class_transfer_credit.test_run_id, class_transfer_credit.created_at
FROM class_transfer_credit
INNER JOIN class_transfer ON class_transfer.id = class_transfer_credit.class_transfer_id
INNER JOIN enrollment ON enrollment.id = class_transfer.source_enrollment_id
;

-- The service mirrors future legacy credit state idempotently. These explicit
-- inserts preserve pre-existing closure history without parser-sensitive CASE
-- expressions in the D1 migration query endpoint.
INSERT OR IGNORE INTO child_credit_entry (
  id, canonical_student_id, entry_kind, amount_mnt, origin_entry_id, reason,
  is_test, test_run_id, created_at
)
SELECT 'child-credit:payment-close:' || payment_credit.id || ':refunded', root.canonical_student_id,
  'refund',
  -(root.amount_mnt + COALESCE((SELECT SUM(debit.amount_mnt) FROM child_credit_entry AS debit
    WHERE debit.origin_entry_id = root.id), 0)), root.id,
  'Marked refunded',
  payment_credit.is_test, payment_credit.test_run_id, payment_credit.updated_at
FROM payment_credit
INNER JOIN child_credit_entry AS root ON root.source_payment_credit_id = payment_credit.id
WHERE payment_credit.status = 'refunded'
  AND root.amount_mnt + COALESCE((SELECT SUM(debit.amount_mnt) FROM child_credit_entry AS debit
    WHERE debit.origin_entry_id = root.id), 0) > 0;

INSERT OR IGNORE INTO child_credit_entry (
  id, canonical_student_id, entry_kind, amount_mnt, origin_entry_id, reason,
  is_test, test_run_id, created_at
)
SELECT 'child-credit:payment-close:' || payment_credit.id || ':allocated', root.canonical_student_id,
  'credit_application',
  -(root.amount_mnt + COALESCE((SELECT SUM(debit.amount_mnt) FROM child_credit_entry AS debit
    WHERE debit.origin_entry_id = root.id), 0)), root.id,
  'Allocated by reinstatement',
  payment_credit.is_test, payment_credit.test_run_id, payment_credit.updated_at
FROM payment_credit
INNER JOIN child_credit_entry AS root ON root.source_payment_credit_id = payment_credit.id
WHERE payment_credit.status = 'allocated'
  AND root.amount_mnt + COALESCE((SELECT SUM(debit.amount_mnt) FROM child_credit_entry AS debit
    WHERE debit.origin_entry_id = root.id), 0) > 0;

INSERT OR IGNORE INTO child_credit_entry (
  id, canonical_student_id, entry_kind, amount_mnt, origin_entry_id, reason,
  is_test, test_run_id, created_at
)
SELECT 'child-credit:transfer-close:' || class_transfer_credit.id || ':refunded', root.canonical_student_id,
  'refund',
  -(root.amount_mnt + COALESCE((SELECT SUM(debit.amount_mnt) FROM child_credit_entry AS debit
    WHERE debit.origin_entry_id = root.id), 0)), root.id,
  'Marked refunded',
  class_transfer_credit.is_test, class_transfer_credit.test_run_id, class_transfer_credit.updated_at
FROM class_transfer_credit
INNER JOIN child_credit_entry AS root ON root.source_class_transfer_credit_id = class_transfer_credit.id
WHERE class_transfer_credit.status = 'refunded'
  AND root.amount_mnt + COALESCE((SELECT SUM(debit.amount_mnt) FROM child_credit_entry AS debit
    WHERE debit.origin_entry_id = root.id), 0) > 0;

INSERT OR IGNORE INTO child_credit_entry (
  id, canonical_student_id, entry_kind, amount_mnt, origin_entry_id, reason,
  is_test, test_run_id, created_at
)
SELECT 'child-credit:transfer-close:' || class_transfer_credit.id || ':allocated', root.canonical_student_id,
  'credit_application',
  -(root.amount_mnt + COALESCE((SELECT SUM(debit.amount_mnt) FROM child_credit_entry AS debit
    WHERE debit.origin_entry_id = root.id), 0)), root.id,
  'Allocated by reconciliation',
  class_transfer_credit.is_test, class_transfer_credit.test_run_id, class_transfer_credit.updated_at
FROM class_transfer_credit
INNER JOIN child_credit_entry AS root ON root.source_class_transfer_credit_id = class_transfer_credit.id
WHERE class_transfer_credit.status = 'allocated'
  AND root.amount_mnt + COALESCE((SELECT SUM(debit.amount_mnt) FROM child_credit_entry AS debit
    WHERE debit.origin_entry_id = root.id), 0) > 0;

CREATE TABLE credit_application_confirmation (
  id TEXT PRIMARY KEY,
  child_credit_operation_id TEXT NOT NULL UNIQUE REFERENCES child_credit_operation(id) ON DELETE RESTRICT,
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

CREATE INDEX idx_credit_application_confirmation_finalize
  ON credit_application_confirmation(status, finalize_after);

-- A payment reminder may resume only after staff explicitly leaves the
-- currently usable credit unallocated for this exact obligation snapshot.
CREATE TABLE child_credit_payment_review (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  canonical_student_id TEXT NOT NULL REFERENCES student(id) ON DELETE RESTRICT,
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

CREATE INDEX idx_child_credit_payment_review_installment
  ON child_credit_payment_review(payment_installment_id, created_at DESC);
