-- Presentation preference only. Existing capabilities remain authoritative.
ALTER TABLE teacher_dashboard_preferences ADD COLUMN attendance_student_cards_enabled INTEGER
  NOT NULL DEFAULT 1 CHECK (attendance_student_cards_enabled IN (0, 1));
