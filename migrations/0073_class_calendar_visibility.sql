-- Calendar visibility is independent from public registration visibility and
-- class retirement. Current confirmed enrollment overrides this preference at
-- read time, so a class cannot disappear from the public calendar while it has
-- current learners.
ALTER TABLE class_session
  ADD COLUMN is_calendar_visible INTEGER NOT NULL DEFAULT 1
  CHECK (is_calendar_visible IN (0, 1));

CREATE INDEX idx_class_session_calendar_visibility
  ON class_session(is_calendar_visible, schedule_state, academic_year_id);
