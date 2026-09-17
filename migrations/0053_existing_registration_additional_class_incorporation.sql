-- An incoming ordinary registration can contribute one child/class entry to an
-- existing child's additional-class admission. The original 0042 table made
-- the whole target draft unique because staff-created admissions always use a
-- new one-child draft. Preserve all existing admissions while allowing one
-- selected child from a multi-child incoming draft.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE additional_class_admission_new (
  id TEXT PRIMARY KEY,
  source_registration_draft_child_id TEXT NOT NULL REFERENCES registration_draft_child(id) ON DELETE RESTRICT,
  source_enrollment_id TEXT NOT NULL REFERENCES enrollment(id) ON DELETE RESTRICT,
  target_registration_draft_id TEXT NOT NULL REFERENCES registration_draft(id) ON DELETE RESTRICT,
  target_registration_draft_child_id TEXT NOT NULL UNIQUE REFERENCES registration_draft_child(id) ON DELETE RESTRICT,
  canonical_student_id TEXT NOT NULL REFERENCES student(id) ON DELETE RESTRICT,
  canonical_guardian_account_id TEXT NOT NULL REFERENCES guardian_account(id) ON DELETE RESTRICT,
  created_by_staff_account_id TEXT NOT NULL REFERENCES staff_account(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE,
  policy_updated_at TEXT NOT NULL,
  family_basis_points INTEGER NOT NULL CHECK (family_basis_points BETWEEN 1 AND 10000),
  source_base_amount_mnt INTEGER NOT NULL CHECK (source_base_amount_mnt > 0),
  source_award_amount_mnt INTEGER NOT NULL CHECK (source_award_amount_mnt >= 0),
  target_base_amount_mnt INTEGER NOT NULL CHECK (target_base_amount_mnt > 0),
  target_award_amount_mnt INTEGER NOT NULL CHECK (target_award_amount_mnt > 0),
  status TEXT NOT NULL CHECK (status IN ('pending_confirmation', 'confirmed', 'cancelled', 'expired')),
  activated_at TEXT,
  confirmation_claim_id TEXT,
  confirmation_claimed_at TEXT,
  confirmation_claim_expires_at TEXT,
  confirmation_fence INTEGER NOT NULL DEFAULT 0,
  confirmation_last_error_code TEXT,
  confirmation_last_error_at TEXT,
  proposed_existing_credit_mnt INTEGER NOT NULL DEFAULT 0 CHECK (proposed_existing_credit_mnt >= 0),
  proposed_source_award_credit_mnt INTEGER NOT NULL DEFAULT 0 CHECK (proposed_source_award_credit_mnt >= 0),
  proposed_credit_installment_number INTEGER,
  origin_kind TEXT NOT NULL DEFAULT 'staff_created' CHECK (origin_kind IN ('staff_created', 'existing_registration')),
  is_test INTEGER NOT NULL CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

INSERT INTO additional_class_admission_new (
  id, source_registration_draft_child_id, source_enrollment_id, target_registration_draft_id,
  target_registration_draft_child_id, canonical_student_id, canonical_guardian_account_id,
  created_by_staff_account_id, idempotency_key, policy_updated_at, family_basis_points,
  source_base_amount_mnt, source_award_amount_mnt, target_base_amount_mnt, target_award_amount_mnt,
  status, activated_at, confirmation_claim_id, confirmation_claimed_at, confirmation_claim_expires_at,
  confirmation_fence, confirmation_last_error_code, confirmation_last_error_at,
  proposed_existing_credit_mnt, proposed_source_award_credit_mnt, proposed_credit_installment_number,
  origin_kind, is_test, test_run_id, created_at, updated_at
)
SELECT id, source_registration_draft_child_id, source_enrollment_id, target_registration_draft_id,
  target_registration_draft_child_id, canonical_student_id, canonical_guardian_account_id,
  created_by_staff_account_id, idempotency_key, policy_updated_at, family_basis_points,
  source_base_amount_mnt, source_award_amount_mnt, target_base_amount_mnt, target_award_amount_mnt,
  status, activated_at, confirmation_claim_id, confirmation_claimed_at, confirmation_claim_expires_at,
  confirmation_fence, confirmation_last_error_code, confirmation_last_error_at,
  proposed_existing_credit_mnt, proposed_source_award_credit_mnt, proposed_credit_installment_number,
  'staff_created', is_test, test_run_id, created_at, updated_at
FROM additional_class_admission;

DROP TABLE additional_class_admission;
ALTER TABLE additional_class_admission_new RENAME TO additional_class_admission;

CREATE INDEX idx_additional_class_admission_source
  ON additional_class_admission(source_registration_draft_child_id, status);
CREATE INDEX idx_additional_class_admission_target_status
  ON additional_class_admission(target_registration_draft_child_id, status);
CREATE INDEX idx_additional_class_admission_target_draft
  ON additional_class_admission(target_registration_draft_id, status);
CREATE INDEX idx_additional_class_admission_confirmation_claim
  ON additional_class_admission(status, confirmation_claim_expires_at);
