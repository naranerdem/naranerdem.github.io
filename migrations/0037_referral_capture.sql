-- Canonical referral codes are issued only for confirmed enrollments. Draft
-- capture preserves a validated source relationship until canonical promotion.

CREATE TABLE enrollment_referral_code (
  id TEXT PRIMARY KEY,
  enrollment_id TEXT NOT NULL UNIQUE REFERENCES enrollment(id) ON DELETE RESTRICT,
  student_id TEXT NOT NULL REFERENCES student(id) ON DELETE RESTRICT,
  code TEXT NOT NULL COLLATE NOCASE UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  activated_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(code) BETWEEN 6 AND 24),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE TABLE registration_draft_referral (
  registration_draft_child_id TEXT PRIMARY KEY REFERENCES registration_draft_child(id) ON DELETE CASCADE,
  referral_code_id TEXT NOT NULL REFERENCES enrollment_referral_code(id) ON DELETE RESTRICT,
  referring_enrollment_id TEXT NOT NULL REFERENCES enrollment(id) ON DELETE RESTRICT,
  captured_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('captured', 'promoted', 'disqualified')),
  disqualification_reason TEXT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE INDEX idx_enrollment_referral_code_active
  ON enrollment_referral_code(code, status, is_test);
CREATE INDEX idx_registration_draft_referral_code
  ON registration_draft_referral(referral_code_id, status);
