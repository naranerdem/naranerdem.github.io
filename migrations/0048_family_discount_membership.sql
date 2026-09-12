-- Staff-confirmed families are durable relationship evidence, not an identity
-- merge.  Awards retain the group that qualified them and confirmation
-- operations make retries/reviews auditable without storing personal data.
ALTER TABLE discount_award
  ADD COLUMN family_group_id TEXT REFERENCES family_group(id) ON DELETE RESTRICT;

CREATE INDEX idx_discount_award_family_group
  ON discount_award(family_group_id, status, awarded_at)
  WHERE family_group_id IS NOT NULL;

CREATE UNIQUE INDEX idx_family_group_member_one_active_student
  ON family_group_member(student_id)
  WHERE status = 'active';

CREATE TABLE family_group_confirmation (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  family_group_id TEXT NOT NULL REFERENCES family_group(id) ON DELETE RESTRICT,
  primary_student_id TEXT NOT NULL REFERENCES student(id) ON DELETE RESTRICT,
  related_student_id TEXT NOT NULL REFERENCES student(id) ON DELETE RESTRICT,
  created_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  request_fingerprint TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (test_run_id IS NULL OR is_test = 1),
  CHECK (primary_student_id <> related_student_id)
);

CREATE INDEX idx_family_group_confirmation_group
  ON family_group_confirmation(family_group_id, created_at);
