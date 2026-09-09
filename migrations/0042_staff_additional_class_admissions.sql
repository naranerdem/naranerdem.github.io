-- A staff-selected additional class is a new ordinary registration draft that
-- is bound to an existing canonical child.  This record freezes the approved
-- family/same-child award promise until ordinary payment confirmation promotes
-- the target draft; it never represents a direct enrollment.
CREATE TABLE additional_class_admission (
  id TEXT PRIMARY KEY,
  source_registration_draft_child_id TEXT NOT NULL REFERENCES registration_draft_child(id) ON DELETE RESTRICT,
  source_enrollment_id TEXT NOT NULL REFERENCES enrollment(id) ON DELETE RESTRICT,
  target_registration_draft_id TEXT NOT NULL UNIQUE REFERENCES registration_draft(id) ON DELETE RESTRICT,
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
  is_test INTEGER NOT NULL CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE INDEX idx_additional_class_admission_source
  ON additional_class_admission(source_registration_draft_child_id, status);
CREATE INDEX idx_additional_class_admission_target_status
  ON additional_class_admission(target_registration_draft_child_id, status);
