-- Public listing is independent of registration availability and operational use.
-- Existing classes remain visible by default.
ALTER TABLE class_session
  ADD COLUMN is_publicly_visible INTEGER NOT NULL DEFAULT 1
  CHECK (is_publicly_visible IN (0, 1));

CREATE INDEX idx_class_session_public_visibility
  ON class_session(is_publicly_visible, status, academic_year_id);
