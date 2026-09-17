-- Attendance recorded at a normal-class make-up visit is distinct from the
-- missed source occurrence. The source enrollment remains in its own class;
-- this table anchors the replacement attendance to its durable assignment.

CREATE TABLE course_makeup_attendance (
  id TEXT PRIMARY KEY,
  course_makeup_assignment_id TEXT NOT NULL REFERENCES course_makeup_assignment(id) ON DELETE RESTRICT,
  attendance_status TEXT CHECK (attendance_status IS NULL OR attendance_status IN ('present', 'late', 'absent')),
  recorded_calendar_slot_id TEXT NOT NULL REFERENCES class_calendar_slot(id) ON DELETE RESTRICT,
  scheduled_local_date TEXT NOT NULL,
  first_recorded_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  recorded_by_staff_account_id TEXT NOT NULL REFERENCES staff_account(id) ON DELETE RESTRICT,
  updated_by_staff_account_id TEXT NOT NULL REFERENCES staff_account(id) ON DELETE RESTRICT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (length(scheduled_local_date) = 10 AND substr(scheduled_local_date, 5, 1) = '-' AND substr(scheduled_local_date, 8, 1) = '-'),
  CHECK (test_run_id IS NULL OR is_test = 1),
  UNIQUE (course_makeup_assignment_id)
);

CREATE TABLE course_makeup_attendance_change (
  id TEXT PRIMARY KEY,
  course_makeup_attendance_id TEXT NOT NULL REFERENCES course_makeup_attendance(id) ON DELETE RESTRICT,
  previous_status TEXT CHECK (previous_status IS NULL OR previous_status IN ('present', 'late', 'absent')),
  new_status TEXT CHECK (new_status IS NULL OR new_status IN ('present', 'late', 'absent')),
  changed_by_staff_account_id TEXT NOT NULL REFERENCES staff_account(id) ON DELETE RESTRICT,
  changed_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (previous_status IS NOT new_status),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE INDEX idx_course_makeup_attendance_slot
  ON course_makeup_attendance(recorded_calendar_slot_id, attendance_status);
CREATE INDEX idx_course_makeup_attendance_assignment
  ON course_makeup_attendance(course_makeup_assignment_id, updated_at);

CREATE TRIGGER prevent_course_makeup_attendance_change_update
BEFORE UPDATE ON course_makeup_attendance_change
BEGIN
  SELECT RAISE(ABORT, 'course make-up attendance history is append-only');
END;

CREATE TRIGGER prevent_course_makeup_attendance_change_delete
BEFORE DELETE ON course_makeup_attendance_change
BEGIN
  SELECT RAISE(ABORT, 'course make-up attendance history is append-only');
END;

-- Only an active normal-class assignment may receive new or corrected
-- attendance, and its target identity must match the exact current slot.
CREATE TRIGGER validate_course_makeup_attendance_insert
BEFORE INSERT ON course_makeup_attendance
WHEN NOT EXISTS (
  SELECT 1
  FROM course_makeup_assignment AS assignment
  INNER JOIN course_makeup_resolution AS resolution
    ON resolution.id = assignment.resolution_id
  INNER JOIN class_calendar_slot AS slot
    ON slot.id = NEW.recorded_calendar_slot_id
  INNER JOIN class_calendar_revision AS revision
    ON revision.id = slot.class_calendar_revision_id
  INNER JOIN class_calendar AS calendar
    ON calendar.id = revision.class_calendar_id
  WHERE assignment.id = NEW.course_makeup_assignment_id
    AND assignment.status = 'active'
    AND assignment.target_kind = 'normal_class'
    AND resolution.status = 'active'
    AND resolution.decision = 'assigned'
    AND calendar.class_session_id = assignment.target_class_session_id
    AND slot.curriculum_lesson_id = assignment.target_curriculum_lesson_id
    AND slot.local_date = NEW.scheduled_local_date
    AND slot.status = 'scheduled'
    AND revision.status IN ('published', 'superseded')
)
BEGIN
  SELECT RAISE(ABORT, 'course make-up attendance must match an active normal target');
END;

CREATE TRIGGER validate_course_makeup_attendance_update
BEFORE UPDATE OF course_makeup_assignment_id, recorded_calendar_slot_id, scheduled_local_date
ON course_makeup_attendance
WHEN NOT EXISTS (
  SELECT 1
  FROM course_makeup_assignment AS assignment
  INNER JOIN course_makeup_resolution AS resolution
    ON resolution.id = assignment.resolution_id
  INNER JOIN class_calendar_slot AS slot
    ON slot.id = NEW.recorded_calendar_slot_id
  INNER JOIN class_calendar_revision AS revision
    ON revision.id = slot.class_calendar_revision_id
  INNER JOIN class_calendar AS calendar
    ON calendar.id = revision.class_calendar_id
  WHERE assignment.id = NEW.course_makeup_assignment_id
    AND assignment.status = 'active'
    AND assignment.target_kind = 'normal_class'
    AND resolution.status = 'active'
    AND resolution.decision = 'assigned'
    AND calendar.class_session_id = assignment.target_class_session_id
    AND slot.curriculum_lesson_id = assignment.target_curriculum_lesson_id
    AND slot.local_date = NEW.scheduled_local_date
    AND slot.status = 'scheduled'
    AND revision.status IN ('published', 'superseded')
)
BEGIN
  SELECT RAISE(ABORT, 'course make-up attendance must match an active normal target');
END;
