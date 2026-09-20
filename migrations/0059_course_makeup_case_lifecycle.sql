-- A make-up case is the durable owner of one original absence. Resolutions and
-- assignments remain immutable attempts, so a missed attempt can be reviewed
-- and rebooked without losing its destination attendance history.

CREATE TABLE course_makeup_case (
  id TEXT PRIMARY KEY,
  source_enrollment_id TEXT NOT NULL REFERENCES enrollment(id) ON DELETE RESTRICT,
  source_class_session_id TEXT NOT NULL REFERENCES class_session(id) ON DELETE RESTRICT,
  source_curriculum_lesson_id TEXT NOT NULL REFERENCES curriculum_lesson(id) ON DELETE RESTRICT,
  current_resolution_id TEXT REFERENCES course_makeup_resolution(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'resolved', 'reconciliation')),
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (test_run_id IS NULL OR is_test = 1),
  UNIQUE (source_enrollment_id, source_class_session_id, source_curriculum_lesson_id)
);

ALTER TABLE course_makeup_resolution
  ADD COLUMN case_id TEXT REFERENCES course_makeup_case(id) ON DELETE RESTRICT;

CREATE INDEX idx_course_makeup_resolution_case
  ON course_makeup_resolution(case_id, status, decided_at);
CREATE INDEX idx_course_makeup_case_current
  ON course_makeup_case(current_resolution_id, state);

-- Existing rows are historical attempts. Backfill an anchor only; do not infer
-- a destination attendance result from elapsed time.
INSERT INTO course_makeup_case (
  id, source_enrollment_id, source_class_session_id, source_curriculum_lesson_id,
  current_resolution_id, state, is_test, test_run_id, created_at, updated_at
)
SELECT
  'makeup-case-' || lower(hex(randomblob(16))),
  source_enrollment_id, source_class_session_id, source_curriculum_lesson_id,
  (
    SELECT newer.id
    FROM course_makeup_resolution AS newer
    WHERE newer.source_enrollment_id = course_makeup_resolution.source_enrollment_id
      AND newer.source_class_session_id = course_makeup_resolution.source_class_session_id
      AND newer.source_curriculum_lesson_id = course_makeup_resolution.source_curriculum_lesson_id
      AND newer.status = 'active'
    ORDER BY newer.decided_at DESC, newer.id DESC
    LIMIT 1
  ),
  CASE WHEN EXISTS (
    SELECT 1 FROM course_makeup_resolution AS active_resolution
    WHERE active_resolution.source_enrollment_id = course_makeup_resolution.source_enrollment_id
      AND active_resolution.source_class_session_id = course_makeup_resolution.source_class_session_id
      AND active_resolution.source_curriculum_lesson_id = course_makeup_resolution.source_curriculum_lesson_id
      AND active_resolution.status = 'active' AND active_resolution.decision = 'no_makeup'
  ) THEN 'closed' ELSE 'open' END,
  MAX(is_test), MAX(test_run_id), MIN(created_at), MAX(updated_at)
FROM course_makeup_resolution
GROUP BY source_enrollment_id, source_class_session_id, source_curriculum_lesson_id;

UPDATE course_makeup_resolution
SET case_id = (
  SELECT course_makeup_case.id
  FROM course_makeup_case
  WHERE course_makeup_case.source_enrollment_id = course_makeup_resolution.source_enrollment_id
    AND course_makeup_case.source_class_session_id = course_makeup_resolution.source_class_session_id
    AND course_makeup_case.source_curriculum_lesson_id = course_makeup_resolution.source_curriculum_lesson_id
)
WHERE case_id IS NULL;

-- A prior marked attempt remains active for correction protection while a new
-- attempt may become the case's current attempt.
DROP INDEX idx_course_makeup_resolution_one_active;

CREATE TRIGGER prevent_course_makeup_case_identity_update
BEFORE UPDATE OF source_enrollment_id, source_class_session_id, source_curriculum_lesson_id
ON course_makeup_case
BEGIN
  SELECT RAISE(ABORT, 'make-up case source identity is immutable');
END;

CREATE TRIGGER prevent_course_makeup_case_delete
BEFORE DELETE ON course_makeup_case
BEGIN
  SELECT RAISE(ABORT, 'make-up case history cannot be deleted');
END;

-- Preserve curriculum and capacity identity. A future session with no saved
-- special attendance may move as one audited operation; recorded sessions stay
-- anchored to their original date/time.
DROP TRIGGER prevent_course_makeup_special_identity_update;

CREATE TRIGGER prevent_course_makeup_special_curriculum_or_capacity_update
BEFORE UPDATE OF curriculum_lesson_id, capacity
ON course_makeup_special_occurrence
BEGIN
  SELECT RAISE(ABORT, 'special make-up curriculum and capacity are immutable');
END;

CREATE TRIGGER prevent_attended_special_makeup_schedule_update
BEFORE UPDATE OF local_date, start_time, end_time
ON course_makeup_special_occurrence
WHEN EXISTS (
  SELECT 1
  FROM course_makeup_special_attendance AS attendance
  INNER JOIN course_makeup_assignment AS assignment
    ON assignment.id = attendance.course_makeup_assignment_id
  WHERE assignment.target_special_occurrence_id = OLD.id
    AND attendance.attendance_status IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'cannot move special make-up session with recorded attendance');
END;

-- One-room conflicts are also enforced at the write boundary. This closes the
-- race between a special-session request and a regular calendar publication.
CREATE TRIGGER validate_course_makeup_special_room_insert
BEFORE INSERT ON course_makeup_special_occurrence
WHEN NEW.status = 'active' AND (
  EXISTS (
    SELECT 1 FROM course_makeup_special_occurrence AS existing
    WHERE existing.status = 'active' AND existing.local_date = NEW.local_date
      AND existing.start_time < NEW.end_time AND existing.end_time > NEW.start_time
  )
  OR EXISTS (
    SELECT 1
    FROM class_calendar_slot AS slot
    INNER JOIN class_calendar_revision AS revision
      ON revision.id = slot.class_calendar_revision_id AND revision.status = 'published'
    WHERE slot.status = 'scheduled' AND slot.local_date = NEW.local_date
      AND slot.start_time < NEW.end_time AND slot.end_time > NEW.start_time
  )
)
BEGIN
  SELECT RAISE(ABORT, 'special make-up room time conflicts');
END;

CREATE TRIGGER validate_course_makeup_special_room_update
BEFORE UPDATE OF local_date, start_time, end_time, status
ON course_makeup_special_occurrence
WHEN NEW.status = 'active' AND (
  EXISTS (
    SELECT 1 FROM course_makeup_special_occurrence AS existing
    WHERE existing.id <> NEW.id AND existing.status = 'active' AND existing.local_date = NEW.local_date
      AND existing.start_time < NEW.end_time AND existing.end_time > NEW.start_time
  )
  OR EXISTS (
    SELECT 1
    FROM class_calendar_slot AS slot
    INNER JOIN class_calendar_revision AS revision
      ON revision.id = slot.class_calendar_revision_id AND revision.status = 'published'
    WHERE slot.status = 'scheduled' AND slot.local_date = NEW.local_date
      AND slot.start_time < NEW.end_time AND slot.end_time > NEW.start_time
  )
)
BEGIN
  SELECT RAISE(ABORT, 'special make-up room time conflicts');
END;

CREATE TRIGGER validate_regular_calendar_publication_against_special_makeups
BEFORE UPDATE OF status ON class_calendar_revision
WHEN NEW.status = 'published' AND OLD.status <> 'published' AND EXISTS (
  SELECT 1
  FROM class_calendar_slot AS slot
  INNER JOIN course_makeup_special_occurrence AS special
    ON special.status = 'active' AND special.local_date = slot.local_date
      AND special.start_time < slot.end_time AND special.end_time > slot.start_time
  WHERE slot.class_calendar_revision_id = NEW.id AND slot.status = 'scheduled'
)
BEGIN
  SELECT RAISE(ABORT, 'regular calendar conflicts with special make-up room time');
END;

CREATE TABLE course_makeup_special_schedule_operation (
  operation_id TEXT PRIMARY KEY,
  special_occurrence_id TEXT NOT NULL REFERENCES course_makeup_special_occurrence(id) ON DELETE RESTRICT,
  expected_updated_at TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL,
  performed_by_staff_account_id TEXT NOT NULL REFERENCES staff_account(id) ON DELETE RESTRICT,
  performed_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE INDEX idx_course_makeup_special_schedule_operation_occurrence
  ON course_makeup_special_schedule_operation(special_occurrence_id, performed_at);

CREATE TRIGGER validate_course_makeup_special_schedule_operation_snapshot
BEFORE INSERT ON course_makeup_special_schedule_operation
WHEN NOT EXISTS (
  SELECT 1 FROM course_makeup_special_occurrence
  WHERE id = NEW.special_occurrence_id AND status = 'active' AND updated_at = NEW.expected_updated_at
)
BEGIN
  SELECT RAISE(ABORT, 'special make-up schedule changed');
END;
