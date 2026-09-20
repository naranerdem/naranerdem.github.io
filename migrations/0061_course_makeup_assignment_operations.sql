-- Durable operations for reviewed additions to an existing destination and
-- individual booking cancellation. Existing attempts remain untouched.
CREATE TABLE course_makeup_assignment_operation (
  operation_id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('assign_existing', 'cancel_assignment')),
  request_fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL,
  performed_by_staff_account_id TEXT NOT NULL REFERENCES staff_account(id) ON DELETE RESTRICT,
  performed_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE INDEX idx_course_makeup_assignment_operation_performed
  ON course_makeup_assignment_operation(performed_at);
