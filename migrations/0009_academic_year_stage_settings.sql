-- Teacher-facing annual settings that belong to a stage, not an individual class.
-- The existing class_session.facebook_group_url remains for historical compatibility;
-- new operational configuration uses this typed table instead.

CREATE TABLE academic_year_stage_setting (
  id TEXT PRIMARY KEY,
  academic_year_id TEXT NOT NULL REFERENCES academic_year(id) ON DELETE RESTRICT,
  stage_code TEXT NOT NULL CHECK (stage_code IN ('stage_1', 'stage_2', 'stage_3')),
  facebook_group_url TEXT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (academic_year_id, stage_code),
  CHECK (facebook_group_url IS NULL OR length(trim(facebook_group_url)) > 0),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE INDEX idx_academic_year_stage_setting_year_stage
  ON academic_year_stage_setting(academic_year_id, stage_code);
