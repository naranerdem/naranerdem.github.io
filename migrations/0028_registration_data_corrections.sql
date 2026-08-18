-- Human typo corrections keep a compact before/after record without changing
-- payment, rules, class choice, or identity-resolution provenance.
CREATE TABLE registration_data_correction (
  id TEXT PRIMARY KEY,
  registration_draft_id TEXT NOT NULL REFERENCES registration_draft(id) ON DELETE RESTRICT,
  registration_draft_child_id TEXT NOT NULL REFERENCES registration_draft_child(id) ON DELETE RESTRICT,
  corrected_by_staff_account_id TEXT NOT NULL REFERENCES staff_account(id) ON DELETE RESTRICT,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 1 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  CHECK (test_run_id IS NULL OR is_test = 1)
);
CREATE INDEX idx_registration_data_correction_child
  ON registration_data_correction(registration_draft_child_id, created_at);
