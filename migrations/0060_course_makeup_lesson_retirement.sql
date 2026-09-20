-- A retirement belongs to a named curriculum lesson in one program and
-- academic year. It suppresses future make-up booking without rewriting the
-- underlying absence, assignment, attendance, or decision history.
CREATE TABLE course_makeup_lesson_state (
  id TEXT PRIMARY KEY,
  academic_year_id TEXT NOT NULL REFERENCES academic_year(id) ON DELETE RESTRICT,
  curriculum_program_id TEXT NOT NULL REFERENCES curriculum_program(id) ON DELETE RESTRICT,
  curriculum_lesson_id TEXT NOT NULL REFERENCES curriculum_lesson(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  retired_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE RESTRICT,
  retired_at TEXT,
  restored_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE RESTRICT,
  restored_at TEXT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (test_run_id IS NULL OR is_test = 1),
  UNIQUE (academic_year_id, curriculum_program_id, curriculum_lesson_id)
);

CREATE INDEX idx_course_makeup_lesson_state_status
  ON course_makeup_lesson_state(academic_year_id, curriculum_program_id, status);

-- The durable operation records make retrying a lost response safe and bind a
-- reviewed group snapshot to the action that was actually committed.
CREATE TABLE course_makeup_lesson_operation (
  operation_id TEXT PRIMARY KEY,
  lesson_state_id TEXT REFERENCES course_makeup_lesson_state(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('retire', 'restore', 'assign_normal', 'create_special')),
  expected_revision INTEGER NOT NULL DEFAULT 0 CHECK (expected_revision >= 0),
  request_fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL,
  performed_by_staff_account_id TEXT NOT NULL REFERENCES staff_account(id) ON DELETE RESTRICT,
  performed_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE INDEX idx_course_makeup_lesson_operation_state
  ON course_makeup_lesson_operation(lesson_state_id, performed_at);

CREATE TRIGGER validate_course_makeup_lesson_state_operation
BEFORE INSERT ON course_makeup_lesson_operation
WHEN NEW.action IN ('retire', 'restore') AND NOT EXISTS (
  SELECT 1 FROM course_makeup_lesson_state
  WHERE id = NEW.lesson_state_id
    AND revision = NEW.expected_revision + 1
    AND status = CASE WHEN NEW.action = 'retire' THEN 'retired' ELSE 'active' END
)
BEGIN
  SELECT RAISE(ABORT, 'make-up lesson state changed');
END;

-- A retirement snapshot explains which durable cases were waiting when the
-- group was retired. It is audit evidence only; restoring the lesson always
-- re-evaluates current eligibility instead of blindly reopening rows.
CREATE TABLE course_makeup_lesson_retirement_case (
  operation_id TEXT NOT NULL REFERENCES course_makeup_lesson_operation(operation_id) ON DELETE RESTRICT,
  course_makeup_case_id TEXT NOT NULL REFERENCES course_makeup_case(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (operation_id, course_makeup_case_id)
);

-- No write path may book a new attempt for a retired lesson. Existing active
-- attempts are intentionally unaffected so attendance and cancellation can be
-- completed with their original identities intact.
CREATE TRIGGER prevent_course_makeup_assignment_for_retired_lesson
BEFORE INSERT ON course_makeup_assignment
WHEN EXISTS (
  SELECT 1
  FROM course_makeup_resolution AS resolution
  INNER JOIN curriculum_lesson AS lesson
    ON lesson.id = resolution.source_curriculum_lesson_id
  INNER JOIN curriculum_program AS program
    ON program.id = lesson.curriculum_program_id
  INNER JOIN course_makeup_lesson_state AS lesson_state
    ON lesson_state.academic_year_id = program.academic_year_id
    AND lesson_state.curriculum_program_id = program.id
    AND lesson_state.curriculum_lesson_id = lesson.id
    AND lesson_state.status = 'retired'
  WHERE resolution.id = NEW.resolution_id
)
BEGIN
  SELECT RAISE(ABORT, 'make-up lesson is retired');
END;
