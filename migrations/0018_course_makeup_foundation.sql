-- Teacher-mediated course make-up planning. Effective absence remains derived
-- from attendance after the source occurrence ends; no make-up row is created
-- automatically. Normal targets use durable class + CurriculumLesson identity
-- so a safe calendar reflow changes the date without losing the assignment.

CREATE TABLE course_makeup_resolution (
  id TEXT PRIMARY KEY,
  source_enrollment_id TEXT NOT NULL REFERENCES enrollment(id) ON DELETE RESTRICT,
  source_class_session_id TEXT NOT NULL REFERENCES class_session(id) ON DELETE RESTRICT,
  source_curriculum_lesson_id TEXT NOT NULL REFERENCES curriculum_lesson(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('no_makeup', 'assigned')),
  status TEXT NOT NULL CHECK (status IN ('active', 'invalidated')),
  note TEXT,
  decided_by_staff_account_id TEXT NOT NULL REFERENCES staff_account(id) ON DELETE RESTRICT,
  decided_at TEXT NOT NULL,
  invalidated_at TEXT,
  invalidated_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE RESTRICT,
  invalidation_reason TEXT CHECK (invalidation_reason IS NULL OR invalidation_reason IN (
    'source_attendance_corrected', 'assignment_cancelled', 'special_occurrence_cancelled'
  )),
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (note IS NULL OR length(trim(note)) > 0),
  CHECK (
    (status = 'active' AND invalidated_at IS NULL AND invalidated_by_staff_account_id IS NULL AND invalidation_reason IS NULL)
    OR
    (status = 'invalidated' AND invalidated_at IS NOT NULL AND invalidated_by_staff_account_id IS NOT NULL AND invalidation_reason IS NOT NULL)
  ),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE UNIQUE INDEX idx_course_makeup_resolution_one_active
  ON course_makeup_resolution(
    source_enrollment_id,
    source_class_session_id,
    source_curriculum_lesson_id
  )
  WHERE status = 'active';

CREATE INDEX idx_course_makeup_resolution_source
  ON course_makeup_resolution(source_class_session_id, source_curriculum_lesson_id, status);

CREATE TABLE course_makeup_special_occurrence (
  id TEXT PRIMARY KEY,
  curriculum_lesson_id TEXT NOT NULL REFERENCES curriculum_lesson(id) ON DELETE RESTRICT,
  local_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
  note TEXT,
  created_by_staff_account_id TEXT NOT NULL REFERENCES staff_account(id) ON DELETE RESTRICT,
  cancelled_at TEXT,
  cancelled_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE RESTRICT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(local_date) = 10 AND substr(local_date, 5, 1) = '-' AND substr(local_date, 8, 1) = '-'),
  CHECK (length(start_time) = 5 AND length(end_time) = 5 AND end_time > start_time),
  CHECK (note IS NULL OR length(trim(note)) > 0),
  CHECK (
    (status = 'active' AND cancelled_at IS NULL AND cancelled_by_staff_account_id IS NULL)
    OR
    (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by_staff_account_id IS NOT NULL)
  ),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE INDEX idx_course_makeup_special_occurrence_schedule
  ON course_makeup_special_occurrence(status, local_date, start_time);

CREATE TABLE course_makeup_assignment (
  id TEXT PRIMARY KEY,
  resolution_id TEXT NOT NULL REFERENCES course_makeup_resolution(id) ON DELETE RESTRICT,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('normal_class', 'special')),
  target_class_session_id TEXT REFERENCES class_session(id) ON DELETE RESTRICT,
  target_special_occurrence_id TEXT REFERENCES course_makeup_special_occurrence(id) ON DELETE RESTRICT,
  target_curriculum_lesson_id TEXT NOT NULL REFERENCES curriculum_lesson(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
  assigned_by_staff_account_id TEXT NOT NULL REFERENCES staff_account(id) ON DELETE RESTRICT,
  assigned_at TEXT NOT NULL,
  cancelled_at TEXT,
  cancelled_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE RESTRICT,
  cancellation_reason TEXT CHECK (cancellation_reason IS NULL OR cancellation_reason IN (
    'source_attendance_corrected', 'teacher_reopened', 'special_occurrence_cancelled'
  )),
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (target_kind = 'normal_class' AND target_class_session_id IS NOT NULL AND target_special_occurrence_id IS NULL)
    OR
    (target_kind = 'special' AND target_class_session_id IS NULL AND target_special_occurrence_id IS NOT NULL)
  ),
  CHECK (
    (status = 'active' AND cancelled_at IS NULL AND cancelled_by_staff_account_id IS NULL AND cancellation_reason IS NULL)
    OR
    (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by_staff_account_id IS NOT NULL AND cancellation_reason IS NOT NULL)
  ),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE UNIQUE INDEX idx_course_makeup_assignment_one_active_resolution
  ON course_makeup_assignment(resolution_id)
  WHERE status = 'active';

CREATE INDEX idx_course_makeup_assignment_normal_target
  ON course_makeup_assignment(
    target_class_session_id,
    target_curriculum_lesson_id,
    status
  )
  WHERE target_kind = 'normal_class';

CREATE INDEX idx_course_makeup_assignment_special_target
  ON course_makeup_assignment(target_special_occurrence_id, status)
  WHERE target_kind = 'special';

CREATE TRIGGER validate_course_makeup_source_insert
BEFORE INSERT ON course_makeup_resolution
WHEN NOT EXISTS (
  SELECT 1
  FROM enrollment
  INNER JOIN class_session ON class_session.id = enrollment.class_session_id
  INNER JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
  INNER JOIN curriculum_lesson ON curriculum_lesson.id = NEW.source_curriculum_lesson_id
  WHERE enrollment.id = NEW.source_enrollment_id
    AND class_session.id = NEW.source_class_session_id
    AND activity_offering.kind IN ('annual_course', 'summer_course')
    AND activity_offering.curriculum_program_id = curriculum_lesson.curriculum_program_id
)
BEGIN
  SELECT RAISE(ABORT, 'make-up source must match enrollment class and offering lesson');
END;

CREATE TRIGGER prevent_course_makeup_resolution_identity_update
BEFORE UPDATE OF source_enrollment_id, source_class_session_id,
  source_curriculum_lesson_id, decision ON course_makeup_resolution
BEGIN
  SELECT RAISE(ABORT, 'make-up resolution identity is immutable');
END;

CREATE TRIGGER prevent_course_makeup_resolution_reactivation
BEFORE UPDATE OF status ON course_makeup_resolution
WHEN OLD.status = 'invalidated' AND NEW.status != 'invalidated'
BEGIN
  SELECT RAISE(ABORT, 'invalidated make-up resolution cannot be reactivated');
END;

CREATE TRIGGER prevent_course_makeup_resolution_delete
BEFORE DELETE ON course_makeup_resolution
BEGIN
  SELECT RAISE(ABORT, 'make-up resolution history cannot be deleted');
END;

CREATE TRIGGER prevent_course_makeup_special_identity_update
BEFORE UPDATE OF curriculum_lesson_id, local_date, start_time, end_time, capacity
ON course_makeup_special_occurrence
BEGIN
  SELECT RAISE(ABORT, 'special make-up occurrence identity is immutable');
END;

CREATE TRIGGER prevent_course_makeup_special_reactivation
BEFORE UPDATE OF status ON course_makeup_special_occurrence
WHEN OLD.status = 'cancelled' AND NEW.status != 'cancelled'
BEGIN
  SELECT RAISE(ABORT, 'cancelled special make-up occurrence cannot be reactivated');
END;

CREATE TRIGGER prevent_course_makeup_special_delete
BEFORE DELETE ON course_makeup_special_occurrence
BEGIN
  SELECT RAISE(ABORT, 'special make-up occurrence history cannot be deleted');
END;

CREATE TRIGGER validate_course_makeup_assignment_target_insert
BEFORE INSERT ON course_makeup_assignment
WHEN NOT EXISTS (
  SELECT 1
  FROM course_makeup_resolution AS resolution
  WHERE resolution.id = NEW.resolution_id
    AND resolution.status = 'active'
    AND resolution.decision = 'assigned'
    AND resolution.source_curriculum_lesson_id = NEW.target_curriculum_lesson_id
)
OR (
  NEW.target_kind = 'normal_class'
  AND NOT EXISTS (
    SELECT 1
    FROM class_calendar_slot AS slot
    INNER JOIN class_calendar_revision AS revision
      ON revision.id = slot.class_calendar_revision_id
    INNER JOIN class_calendar AS calendar
      ON calendar.id = revision.class_calendar_id
    INNER JOIN class_session ON class_session.id = calendar.class_session_id
    INNER JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
    WHERE class_session.id = NEW.target_class_session_id
      AND class_session.status IN ('available', 'full')
      AND activity_offering.status = 'active'
      AND activity_offering.kind IN ('annual_course', 'summer_course')
      AND revision.status = 'published'
      AND slot.status = 'scheduled'
      AND slot.curriculum_lesson_id = NEW.target_curriculum_lesson_id
  )
)
OR (
  NEW.target_kind = 'special'
  AND NOT EXISTS (
    SELECT 1 FROM course_makeup_special_occurrence
    WHERE id = NEW.target_special_occurrence_id
      AND status = 'active'
      AND curriculum_lesson_id = NEW.target_curriculum_lesson_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'make-up assignment must use an active same-lesson target');
END;

CREATE TRIGGER validate_course_makeup_normal_capacity_insert
BEFORE INSERT ON course_makeup_assignment
WHEN NEW.status = 'active'
  AND NEW.target_kind = 'normal_class'
  AND (
    SELECT capacity FROM class_session WHERE id = NEW.target_class_session_id
  ) <= (
    SELECT COUNT(*) FROM enrollment
    WHERE class_session_id = NEW.target_class_session_id
      AND status IN ('confirmed', 'completed')
  ) + (
    SELECT COUNT(*) FROM course_makeup_assignment
    WHERE target_kind = 'normal_class'
      AND target_class_session_id = NEW.target_class_session_id
      AND target_curriculum_lesson_id = NEW.target_curriculum_lesson_id
      AND status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'make-up target capacity is full');
END;

CREATE TRIGGER validate_course_makeup_special_capacity_insert
BEFORE INSERT ON course_makeup_assignment
WHEN NEW.status = 'active'
  AND NEW.target_kind = 'special'
  AND (
    SELECT capacity FROM course_makeup_special_occurrence
    WHERE id = NEW.target_special_occurrence_id
  ) <= (
    SELECT COUNT(*) FROM course_makeup_assignment
    WHERE target_kind = 'special'
      AND target_special_occurrence_id = NEW.target_special_occurrence_id
      AND status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'special make-up occurrence capacity is full');
END;

CREATE TRIGGER prevent_course_makeup_assignment_identity_update
BEFORE UPDATE OF resolution_id, target_kind, target_class_session_id,
  target_special_occurrence_id, target_curriculum_lesson_id
ON course_makeup_assignment
BEGIN
  SELECT RAISE(ABORT, 'make-up assignment identity is immutable');
END;

CREATE TRIGGER prevent_course_makeup_assignment_reactivation
BEFORE UPDATE OF status ON course_makeup_assignment
WHEN OLD.status = 'cancelled' AND NEW.status != 'cancelled'
BEGIN
  SELECT RAISE(ABORT, 'cancelled make-up assignment cannot be reactivated');
END;

CREATE TRIGGER prevent_course_makeup_assignment_delete
BEFORE DELETE ON course_makeup_assignment
BEGIN
  SELECT RAISE(ABORT, 'make-up assignment history cannot be deleted');
END;
