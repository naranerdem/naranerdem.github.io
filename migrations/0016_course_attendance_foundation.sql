-- Daily course attendance is keyed by the durable class + curriculum lesson
-- identity. Calendar-slot/date fields are provenance snapshots only: later
-- calendar revisions must not invalidate a recorded attendance decision.

CREATE TABLE course_attendance (
  id TEXT PRIMARY KEY,
  enrollment_id TEXT NOT NULL REFERENCES enrollment(id) ON DELETE RESTRICT,
  class_session_id TEXT NOT NULL REFERENCES class_session(id) ON DELETE RESTRICT,
  curriculum_lesson_id TEXT NOT NULL REFERENCES curriculum_lesson(id) ON DELETE RESTRICT,
  attendance_status TEXT CHECK (attendance_status IS NULL OR attendance_status IN ('present', 'late', 'absent')),
  recorded_calendar_slot_id TEXT REFERENCES class_calendar_slot(id) ON DELETE RESTRICT,
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
  UNIQUE (enrollment_id, class_session_id, curriculum_lesson_id)
);

CREATE TABLE course_attendance_change (
  id TEXT PRIMARY KEY,
  course_attendance_id TEXT NOT NULL REFERENCES course_attendance(id) ON DELETE RESTRICT,
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

-- A prior absence notice is intentionally separate from the attendance result.
-- One durable row can be cancelled and later corrected without discarding its
-- history or suggesting that a notice itself proves an absence.
CREATE TABLE course_absence_notice (
  id TEXT PRIMARY KEY,
  enrollment_id TEXT NOT NULL REFERENCES enrollment(id) ON DELETE RESTRICT,
  class_session_id TEXT NOT NULL REFERENCES class_session(id) ON DELETE RESTRICT,
  curriculum_lesson_id TEXT NOT NULL REFERENCES curriculum_lesson(id) ON DELETE RESTRICT,
  notice_source TEXT NOT NULL CHECK (notice_source IN ('staff_manual')),
  status TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
  note TEXT,
  recorded_calendar_slot_id TEXT REFERENCES class_calendar_slot(id) ON DELETE RESTRICT,
  scheduled_local_date TEXT NOT NULL,
  created_by_staff_account_id TEXT NOT NULL REFERENCES staff_account(id) ON DELETE RESTRICT,
  updated_by_staff_account_id TEXT NOT NULL REFERENCES staff_account(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cancelled_at TEXT,
  cancelled_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE RESTRICT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  CHECK (length(scheduled_local_date) = 10 AND substr(scheduled_local_date, 5, 1) = '-' AND substr(scheduled_local_date, 8, 1) = '-'),
  CHECK ((status = 'active' AND cancelled_at IS NULL AND cancelled_by_staff_account_id IS NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by_staff_account_id IS NOT NULL)),
  CHECK (note IS NULL OR length(trim(note)) > 0),
  CHECK (test_run_id IS NULL OR is_test = 1),
  UNIQUE (enrollment_id, class_session_id, curriculum_lesson_id)
);

CREATE TABLE course_absence_notice_change (
  id TEXT PRIMARY KEY,
  course_absence_notice_id TEXT NOT NULL REFERENCES course_absence_notice(id) ON DELETE RESTRICT,
  previous_status TEXT CHECK (previous_status IS NULL OR previous_status IN ('active', 'cancelled')),
  new_status TEXT NOT NULL CHECK (new_status IN ('active', 'cancelled')),
  previous_note TEXT,
  new_note TEXT,
  changed_by_staff_account_id TEXT NOT NULL REFERENCES staff_account(id) ON DELETE RESTRICT,
  changed_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (previous_status IS NOT new_status OR previous_note IS NOT new_note),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE INDEX idx_course_attendance_occurrence
  ON course_attendance(class_session_id, curriculum_lesson_id, attendance_status);
CREATE INDEX idx_course_attendance_enrollment
  ON course_attendance(enrollment_id, updated_at);
CREATE INDEX idx_course_attendance_change_record
  ON course_attendance_change(course_attendance_id, changed_at);
CREATE INDEX idx_course_absence_notice_occurrence
  ON course_absence_notice(class_session_id, curriculum_lesson_id, status);
CREATE INDEX idx_course_absence_notice_change_record
  ON course_absence_notice_change(course_absence_notice_id, changed_at);

CREATE TRIGGER prevent_course_attendance_change_update
BEFORE UPDATE ON course_attendance_change
BEGIN
  SELECT RAISE(ABORT, 'course attendance history is append-only');
END;

CREATE TRIGGER prevent_course_attendance_change_delete
BEFORE DELETE ON course_attendance_change
BEGIN
  SELECT RAISE(ABORT, 'course attendance history is append-only');
END;

CREATE TRIGGER prevent_course_absence_notice_change_update
BEFORE UPDATE ON course_absence_notice_change
BEGIN
  SELECT RAISE(ABORT, 'absence notice history is append-only');
END;

CREATE TRIGGER prevent_course_absence_notice_change_delete
BEFORE DELETE ON course_absence_notice_change
BEGIN
  SELECT RAISE(ABORT, 'absence notice history is append-only');
END;

-- Browser values are never trusted to combine an enrollment from one class
-- with a lesson occurrence from another. The same pinned Offering program
-- proves that this is a normal annual/summer course lesson, not an event.
CREATE TRIGGER validate_course_attendance_enrollment_insert
BEFORE INSERT ON course_attendance
WHEN NOT EXISTS (
  SELECT 1 FROM enrollment
  WHERE enrollment.id = NEW.enrollment_id
    AND enrollment.class_session_id = NEW.class_session_id
)
BEGIN
  SELECT RAISE(ABORT, 'course attendance enrollment must belong to class session');
END;

CREATE TRIGGER validate_course_attendance_enrollment_update
BEFORE UPDATE OF enrollment_id, class_session_id ON course_attendance
WHEN NOT EXISTS (
  SELECT 1 FROM enrollment
  WHERE enrollment.id = NEW.enrollment_id
    AND enrollment.class_session_id = NEW.class_session_id
)
BEGIN
  SELECT RAISE(ABORT, 'course attendance enrollment must belong to class session');
END;

CREATE TRIGGER validate_course_attendance_lesson_insert
BEFORE INSERT ON course_attendance
WHEN NOT EXISTS (
  SELECT 1
  FROM class_session
  INNER JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
  INNER JOIN curriculum_lesson ON curriculum_lesson.id = NEW.curriculum_lesson_id
  WHERE class_session.id = NEW.class_session_id
    AND activity_offering.kind IN ('annual_course', 'summer_course')
    AND activity_offering.curriculum_program_id = curriculum_lesson.curriculum_program_id
)
BEGIN
  SELECT RAISE(ABORT, 'course attendance lesson must belong to class offering program');
END;

CREATE TRIGGER validate_course_attendance_lesson_update
BEFORE UPDATE OF class_session_id, curriculum_lesson_id ON course_attendance
WHEN NOT EXISTS (
  SELECT 1
  FROM class_session
  INNER JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
  INNER JOIN curriculum_lesson ON curriculum_lesson.id = NEW.curriculum_lesson_id
  WHERE class_session.id = NEW.class_session_id
    AND activity_offering.kind IN ('annual_course', 'summer_course')
    AND activity_offering.curriculum_program_id = curriculum_lesson.curriculum_program_id
)
BEGIN
  SELECT RAISE(ABORT, 'course attendance lesson must belong to class offering program');
END;

CREATE TRIGGER validate_course_attendance_slot_insert
BEFORE INSERT ON course_attendance
WHEN NEW.recorded_calendar_slot_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM class_calendar_slot
    INNER JOIN class_calendar_revision ON class_calendar_revision.id = class_calendar_slot.class_calendar_revision_id
    INNER JOIN class_calendar ON class_calendar.id = class_calendar_revision.class_calendar_id
    WHERE class_calendar_slot.id = NEW.recorded_calendar_slot_id
      AND class_calendar.class_session_id = NEW.class_session_id
      AND class_calendar_slot.curriculum_lesson_id = NEW.curriculum_lesson_id
      AND class_calendar_slot.local_date = NEW.scheduled_local_date
      AND class_calendar_slot.status = 'scheduled'
      AND class_calendar_revision.status IN ('published', 'superseded')
  )
BEGIN
  SELECT RAISE(ABORT, 'course attendance slot provenance must match occurrence');
END;

CREATE TRIGGER validate_course_attendance_slot_update
BEFORE UPDATE OF class_session_id, curriculum_lesson_id, recorded_calendar_slot_id, scheduled_local_date ON course_attendance
WHEN NEW.recorded_calendar_slot_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM class_calendar_slot
    INNER JOIN class_calendar_revision ON class_calendar_revision.id = class_calendar_slot.class_calendar_revision_id
    INNER JOIN class_calendar ON class_calendar.id = class_calendar_revision.class_calendar_id
    WHERE class_calendar_slot.id = NEW.recorded_calendar_slot_id
      AND class_calendar.class_session_id = NEW.class_session_id
      AND class_calendar_slot.curriculum_lesson_id = NEW.curriculum_lesson_id
      AND class_calendar_slot.local_date = NEW.scheduled_local_date
      AND class_calendar_slot.status = 'scheduled'
      AND class_calendar_revision.status IN ('published', 'superseded')
  )
BEGIN
  SELECT RAISE(ABORT, 'course attendance slot provenance must match occurrence');
END;

CREATE TRIGGER validate_course_absence_notice_enrollment_insert
BEFORE INSERT ON course_absence_notice
WHEN NOT EXISTS (
  SELECT 1 FROM enrollment
  WHERE enrollment.id = NEW.enrollment_id
    AND enrollment.class_session_id = NEW.class_session_id
)
BEGIN
  SELECT RAISE(ABORT, 'absence notice enrollment must belong to class session');
END;

CREATE TRIGGER validate_course_absence_notice_enrollment_update
BEFORE UPDATE OF enrollment_id, class_session_id ON course_absence_notice
WHEN NOT EXISTS (
  SELECT 1 FROM enrollment
  WHERE enrollment.id = NEW.enrollment_id
    AND enrollment.class_session_id = NEW.class_session_id
)
BEGIN
  SELECT RAISE(ABORT, 'absence notice enrollment must belong to class session');
END;

CREATE TRIGGER validate_course_absence_notice_lesson_insert
BEFORE INSERT ON course_absence_notice
WHEN NOT EXISTS (
  SELECT 1
  FROM class_session
  INNER JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
  INNER JOIN curriculum_lesson ON curriculum_lesson.id = NEW.curriculum_lesson_id
  WHERE class_session.id = NEW.class_session_id
    AND activity_offering.kind IN ('annual_course', 'summer_course')
    AND activity_offering.curriculum_program_id = curriculum_lesson.curriculum_program_id
)
BEGIN
  SELECT RAISE(ABORT, 'absence notice lesson must belong to class offering program');
END;

CREATE TRIGGER validate_course_absence_notice_lesson_update
BEFORE UPDATE OF class_session_id, curriculum_lesson_id ON course_absence_notice
WHEN NOT EXISTS (
  SELECT 1
  FROM class_session
  INNER JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
  INNER JOIN curriculum_lesson ON curriculum_lesson.id = NEW.curriculum_lesson_id
  WHERE class_session.id = NEW.class_session_id
    AND activity_offering.kind IN ('annual_course', 'summer_course')
    AND activity_offering.curriculum_program_id = curriculum_lesson.curriculum_program_id
)
BEGIN
  SELECT RAISE(ABORT, 'absence notice lesson must belong to class offering program');
END;

CREATE TRIGGER validate_course_absence_notice_slot_insert
BEFORE INSERT ON course_absence_notice
WHEN NEW.recorded_calendar_slot_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM class_calendar_slot
    INNER JOIN class_calendar_revision ON class_calendar_revision.id = class_calendar_slot.class_calendar_revision_id
    INNER JOIN class_calendar ON class_calendar.id = class_calendar_revision.class_calendar_id
    WHERE class_calendar_slot.id = NEW.recorded_calendar_slot_id
      AND class_calendar.class_session_id = NEW.class_session_id
      AND class_calendar_slot.curriculum_lesson_id = NEW.curriculum_lesson_id
      AND class_calendar_slot.local_date = NEW.scheduled_local_date
      AND class_calendar_slot.status = 'scheduled'
      AND class_calendar_revision.status IN ('published', 'superseded')
  )
BEGIN
  SELECT RAISE(ABORT, 'absence notice slot provenance must match occurrence');
END;

CREATE TRIGGER validate_course_absence_notice_slot_update
BEFORE UPDATE OF class_session_id, curriculum_lesson_id, recorded_calendar_slot_id, scheduled_local_date ON course_absence_notice
WHEN NEW.recorded_calendar_slot_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM class_calendar_slot
    INNER JOIN class_calendar_revision ON class_calendar_revision.id = class_calendar_slot.class_calendar_revision_id
    INNER JOIN class_calendar ON class_calendar.id = class_calendar_revision.class_calendar_id
    WHERE class_calendar_slot.id = NEW.recorded_calendar_slot_id
      AND class_calendar.class_session_id = NEW.class_session_id
      AND class_calendar_slot.curriculum_lesson_id = NEW.curriculum_lesson_id
      AND class_calendar_slot.local_date = NEW.scheduled_local_date
      AND class_calendar_slot.status = 'scheduled'
      AND class_calendar_revision.status IN ('published', 'superseded')
  )
BEGIN
  SELECT RAISE(ABORT, 'absence notice slot provenance must match occurrence');
END;
