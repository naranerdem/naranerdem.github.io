-- Special make-up sessions have no regular calendar slot. Keep their attendance
-- distinct from normal-class make-up attendance while anchoring every mark to
-- the immutable special occurrence and its durable assignment.

CREATE TABLE course_makeup_special_attendance (
  id TEXT PRIMARY KEY,
  course_makeup_assignment_id TEXT NOT NULL REFERENCES course_makeup_assignment(id) ON DELETE RESTRICT,
  special_occurrence_id TEXT NOT NULL REFERENCES course_makeup_special_occurrence(id) ON DELETE RESTRICT,
  attendance_status TEXT CHECK (attendance_status IS NULL OR attendance_status IN ('present', 'late', 'absent')),
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

CREATE TABLE course_makeup_special_attendance_change (
  id TEXT PRIMARY KEY,
  course_makeup_special_attendance_id TEXT NOT NULL REFERENCES course_makeup_special_attendance(id) ON DELETE RESTRICT,
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

CREATE INDEX idx_course_makeup_special_attendance_occurrence
  ON course_makeup_special_attendance(special_occurrence_id, attendance_status);
CREATE INDEX idx_course_makeup_special_attendance_assignment
  ON course_makeup_special_attendance(course_makeup_assignment_id, updated_at);

CREATE TRIGGER prevent_course_makeup_special_attendance_change_update
BEFORE UPDATE ON course_makeup_special_attendance_change
BEGIN
  SELECT RAISE(ABORT, 'special make-up attendance history is append-only');
END;

CREATE TRIGGER prevent_course_makeup_special_attendance_change_delete
BEFORE DELETE ON course_makeup_special_attendance_change
BEGIN
  SELECT RAISE(ABORT, 'special make-up attendance history is append-only');
END;

-- A new or corrected mark must remain bound to the same active special
-- occurrence that the active assignment was booked into.
CREATE TRIGGER validate_course_makeup_special_attendance_insert
BEFORE INSERT ON course_makeup_special_attendance
WHEN NOT EXISTS (
  SELECT 1
  FROM course_makeup_assignment AS assignment
  INNER JOIN course_makeup_resolution AS resolution
    ON resolution.id = assignment.resolution_id
  INNER JOIN course_makeup_special_occurrence AS special
    ON special.id = assignment.target_special_occurrence_id
  WHERE assignment.id = NEW.course_makeup_assignment_id
    AND assignment.status = 'active'
    AND assignment.target_kind = 'special'
    AND resolution.status = 'active'
    AND resolution.decision = 'assigned'
    AND special.status = 'active'
    AND special.id = NEW.special_occurrence_id
    AND special.local_date = NEW.scheduled_local_date
)
BEGIN
  SELECT RAISE(ABORT, 'special make-up attendance must match an active special target');
END;

CREATE TRIGGER validate_course_makeup_special_attendance_update
BEFORE UPDATE OF course_makeup_assignment_id, special_occurrence_id, scheduled_local_date, attendance_status
ON course_makeup_special_attendance
WHEN NOT EXISTS (
  SELECT 1
  FROM course_makeup_assignment AS assignment
  INNER JOIN course_makeup_resolution AS resolution
    ON resolution.id = assignment.resolution_id
  INNER JOIN course_makeup_special_occurrence AS special
    ON special.id = assignment.target_special_occurrence_id
  WHERE assignment.id = NEW.course_makeup_assignment_id
    AND assignment.status = 'active'
    AND assignment.target_kind = 'special'
    AND resolution.status = 'active'
    AND resolution.decision = 'assigned'
    AND special.status = 'active'
    AND special.id = NEW.special_occurrence_id
    AND special.local_date = NEW.scheduled_local_date
)
BEGIN
  SELECT RAISE(ABORT, 'special make-up attendance must match an active special target');
END;

CREATE TRIGGER prevent_attended_special_makeup_assignment_cancellation
BEFORE UPDATE OF status ON course_makeup_assignment
WHEN OLD.status = 'active' AND NEW.status = 'cancelled' AND EXISTS (
  SELECT 1 FROM course_makeup_special_attendance
  WHERE course_makeup_assignment_id = OLD.id AND attendance_status IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'cannot cancel attended special make-up assignment');
END;

CREATE TRIGGER prevent_attended_special_makeup_occurrence_cancellation
BEFORE UPDATE OF status ON course_makeup_special_occurrence
WHEN OLD.status = 'active' AND NEW.status = 'cancelled' AND EXISTS (
  SELECT 1
  FROM course_makeup_special_attendance AS attendance
  INNER JOIN course_makeup_assignment AS assignment
    ON assignment.id = attendance.course_makeup_assignment_id
  WHERE assignment.target_special_occurrence_id = OLD.id
    AND attendance.attendance_status IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'cannot cancel attended special make-up occurrence');
END;

-- One learner is expected once per special session even when multiple missed
-- lessons would otherwise make the learner selectable more than once.
CREATE TRIGGER prevent_duplicate_special_makeup_attendee
BEFORE INSERT ON course_makeup_assignment
WHEN NEW.target_kind = 'special' AND EXISTS (
  SELECT 1
  FROM course_makeup_resolution AS incoming
  INNER JOIN enrollment AS incoming_enrollment
    ON incoming_enrollment.id = incoming.source_enrollment_id
  INNER JOIN course_makeup_assignment AS existing
    ON existing.target_special_occurrence_id = NEW.target_special_occurrence_id
    AND existing.target_kind = 'special' AND existing.status = 'active'
  INNER JOIN course_makeup_resolution AS booked
    ON booked.id = existing.resolution_id
  INNER JOIN enrollment AS booked_enrollment
    ON booked_enrollment.id = booked.source_enrollment_id
  WHERE incoming.id = NEW.resolution_id
    AND booked_enrollment.student_id = incoming_enrollment.student_id
)
BEGIN
  SELECT RAISE(ABORT, 'learner already booked into this special make-up occurrence');
END;

CREATE TRIGGER prevent_duplicate_special_makeup_attendee_retarget
BEFORE UPDATE OF resolution_id, target_kind, target_special_occurrence_id, status
ON course_makeup_assignment
WHEN NEW.target_kind = 'special' AND NEW.status = 'active' AND EXISTS (
  SELECT 1
  FROM course_makeup_resolution AS incoming
  INNER JOIN enrollment AS incoming_enrollment
    ON incoming_enrollment.id = incoming.source_enrollment_id
  INNER JOIN course_makeup_assignment AS existing
    ON existing.target_special_occurrence_id = NEW.target_special_occurrence_id
    AND existing.target_kind = 'special' AND existing.status = 'active'
    AND existing.id <> NEW.id
  INNER JOIN course_makeup_resolution AS booked
    ON booked.id = existing.resolution_id
  INNER JOIN enrollment AS booked_enrollment
    ON booked_enrollment.id = booked.source_enrollment_id
  WHERE incoming.id = NEW.resolution_id
    AND booked_enrollment.student_id = incoming_enrollment.student_id
)
BEGIN
  SELECT RAISE(ABORT, 'learner already booked into this special make-up occurrence');
END;
