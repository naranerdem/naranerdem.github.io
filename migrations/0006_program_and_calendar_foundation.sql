-- Academic-year program and explicit class calendar foundation.
-- Program lessons are independent from habitual class-session slots. Published
-- program and calendar revisions are immutable; later changes create revisions.

CREATE TABLE curriculum_program (
  id TEXT PRIMARY KEY,
  academic_year_id TEXT NOT NULL REFERENCES academic_year(id) ON DELETE RESTRICT,
  stage_code TEXT NOT NULL CHECK (stage_code IN ('stage_1', 'stage_2', 'stage_3')),
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'superseded', 'archived')),
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (academic_year_id, stage_code, revision_number),
  CHECK (length(trim(display_name)) > 0),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE UNIQUE INDEX idx_curriculum_program_one_published_stage
  ON curriculum_program(academic_year_id, stage_code)
  WHERE status = 'published';

CREATE TABLE curriculum_lesson (
  id TEXT PRIMARY KEY,
  curriculum_program_id TEXT NOT NULL REFERENCES curriculum_program(id) ON DELETE RESTRICT,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  title TEXT NOT NULL,
  internal_note TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (curriculum_program_id, sequence_number),
  CHECK (length(trim(title)) > 0),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE TABLE academic_year_break (
  id TEXT PRIMARY KEY,
  academic_year_id TEXT NOT NULL REFERENCES academic_year(id) ON DELETE RESTRICT,
  label TEXT NOT NULL,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  excludes_habitual_slots INTEGER NOT NULL DEFAULT 1 CHECK (excludes_habitual_slots IN (0, 1)),
  source_note TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(trim(label)) > 0),
  CHECK (length(starts_on) = 10 AND substr(starts_on, 5, 1) = '-' AND substr(starts_on, 8, 1) = '-'),
  CHECK (length(ends_on) = 10 AND substr(ends_on, 5, 1) = '-' AND substr(ends_on, 8, 1) = '-'),
  CHECK (ends_on >= starts_on),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE TABLE class_calendar (
  id TEXT PRIMARY KEY,
  class_session_id TEXT NOT NULL UNIQUE REFERENCES class_session(id) ON DELETE RESTRICT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Ulaanbaatar' CHECK (timezone = 'Asia/Ulaanbaatar'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE TABLE class_calendar_revision (
  id TEXT PRIMARY KEY,
  class_calendar_id TEXT NOT NULL REFERENCES class_calendar(id) ON DELETE RESTRICT,
  curriculum_program_id TEXT NOT NULL REFERENCES curriculum_program(id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'superseded', 'archived')),
  first_candidate_date TEXT NOT NULL,
  locked_through_sequence INTEGER NOT NULL DEFAULT 0 CHECK (locked_through_sequence >= 0),
  based_on_revision_id TEXT REFERENCES class_calendar_revision(id) ON DELETE RESTRICT,
  published_at TEXT,
  superseded_at TEXT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (class_calendar_id, revision_number),
  CHECK (length(first_candidate_date) = 10 AND substr(first_candidate_date, 5, 1) = '-' AND substr(first_candidate_date, 8, 1) = '-'),
  CHECK ((status = 'published' AND published_at IS NOT NULL) OR status != 'published'),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE UNIQUE INDEX idx_class_calendar_one_published_revision
  ON class_calendar_revision(class_calendar_id)
  WHERE status = 'published';

CREATE TABLE class_calendar_revision_override (
  id TEXT PRIMARY KEY,
  class_calendar_revision_id TEXT NOT NULL REFERENCES class_calendar_revision(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  behavior TEXT NOT NULL CHECK (behavior IN ('exclude', 'restore')),
  reason_label TEXT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (class_calendar_revision_id, local_date),
  CHECK (length(local_date) = 10 AND substr(local_date, 5, 1) = '-' AND substr(local_date, 8, 1) = '-'),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE TABLE class_calendar_slot (
  id TEXT PRIMARY KEY,
  class_calendar_revision_id TEXT NOT NULL REFERENCES class_calendar_revision(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  slot_source TEXT NOT NULL CHECK (slot_source IN ('generated', 'manual_extra', 'manual_restore')),
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'no_class', 'cancelled')),
  curriculum_lesson_id TEXT REFERENCES curriculum_lesson(id) ON DELETE RESTRICT,
  cancelled_lesson_sequence INTEGER,
  cancelled_lesson_title TEXT,
  reason_label TEXT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (class_calendar_revision_id, local_date, start_time, end_time),
  CHECK (length(local_date) = 10 AND substr(local_date, 5, 1) = '-' AND substr(local_date, 8, 1) = '-'),
  CHECK (length(start_time) = 5 AND length(end_time) = 5),
  CHECK (
    (status = 'scheduled' AND curriculum_lesson_id IS NOT NULL AND cancelled_lesson_sequence IS NULL AND cancelled_lesson_title IS NULL)
    OR (status = 'no_class' AND curriculum_lesson_id IS NULL AND cancelled_lesson_sequence IS NULL AND cancelled_lesson_title IS NULL)
    OR (status = 'cancelled' AND curriculum_lesson_id IS NULL AND cancelled_lesson_sequence > 0 AND length(trim(cancelled_lesson_title)) > 0)
  ),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE UNIQUE INDEX idx_class_calendar_slot_one_lesson_per_revision
  ON class_calendar_slot(class_calendar_revision_id, curriculum_lesson_id)
  WHERE curriculum_lesson_id IS NOT NULL;

CREATE INDEX idx_curriculum_lesson_program_sequence
  ON curriculum_lesson(curriculum_program_id, sequence_number);
CREATE INDEX idx_academic_year_break_dates
  ON academic_year_break(academic_year_id, status, starts_on, ends_on);
CREATE INDEX idx_class_calendar_revision_published
  ON class_calendar_revision(class_calendar_id, status, revision_number);
CREATE INDEX idx_class_calendar_slot_schedule
  ON class_calendar_slot(class_calendar_revision_id, local_date, start_time);

-- Lesson identity is immutable once a program stops being a draft.
CREATE TRIGGER prevent_non_draft_program_identity_update
BEFORE UPDATE OF academic_year_id, stage_code, revision_number, display_name ON curriculum_program
WHEN OLD.status != 'draft'
BEGIN
  SELECT RAISE(ABORT, 'published curriculum program identity is immutable');
END;

CREATE TRIGGER prevent_published_program_draft_reopen
BEFORE UPDATE OF status ON curriculum_program
WHEN OLD.status = 'published' AND NEW.status NOT IN ('published', 'superseded', 'archived')
BEGIN
  SELECT RAISE(ABORT, 'published curriculum program cannot return to draft');
END;

CREATE TRIGGER require_lesson_for_published_program_insert
BEFORE INSERT ON curriculum_program
WHEN NEW.status = 'published'
BEGIN
  SELECT RAISE(ABORT, 'published curriculum program must be created from a draft');
END;

CREATE TRIGGER require_lesson_for_published_program_update
BEFORE UPDATE OF status ON curriculum_program
WHEN NEW.status = 'published'
  AND NOT EXISTS (
    SELECT 1 FROM curriculum_lesson WHERE curriculum_program_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'published curriculum program requires at least one lesson');
END;

CREATE TRIGGER prevent_non_draft_program_delete
BEFORE DELETE ON curriculum_program
WHEN OLD.status != 'draft'
BEGIN
  SELECT RAISE(ABORT, 'published curriculum program cannot be deleted');
END;

CREATE TRIGGER prevent_lesson_insert_for_non_draft_program
BEFORE INSERT ON curriculum_lesson
WHEN (SELECT status FROM curriculum_program WHERE id = NEW.curriculum_program_id) != 'draft'
BEGIN
  SELECT RAISE(ABORT, 'curriculum lessons may only be changed in a draft program');
END;

CREATE TRIGGER prevent_lesson_update_for_non_draft_program
BEFORE UPDATE ON curriculum_lesson
WHEN (SELECT status FROM curriculum_program WHERE id = OLD.curriculum_program_id) != 'draft'
  OR (SELECT status FROM curriculum_program WHERE id = NEW.curriculum_program_id) != 'draft'
BEGIN
  SELECT RAISE(ABORT, 'curriculum lessons may only be changed in a draft program');
END;

CREATE TRIGGER prevent_lesson_delete_for_non_draft_program
BEFORE DELETE ON curriculum_lesson
WHEN (SELECT status FROM curriculum_program WHERE id = OLD.curriculum_program_id) != 'draft'
BEGIN
  SELECT RAISE(ABORT, 'curriculum lessons may only be changed in a draft program');
END;

-- A class calendar can use only the program for the same academic year/stage.
CREATE TRIGGER validate_calendar_revision_program_insert
BEFORE INSERT ON class_calendar_revision
WHEN NOT EXISTS (
  SELECT 1
  FROM class_calendar
  INNER JOIN class_session ON class_session.id = class_calendar.class_session_id
  INNER JOIN curriculum_program ON curriculum_program.id = NEW.curriculum_program_id
  WHERE class_calendar.id = NEW.class_calendar_id
    AND class_session.academic_year_id = curriculum_program.academic_year_id
    AND class_session.stage_code = curriculum_program.stage_code
)
BEGIN
  SELECT RAISE(ABORT, 'calendar revision program must match class session year and stage');
END;

CREATE TRIGGER validate_calendar_revision_program_update
BEFORE UPDATE OF class_calendar_id, curriculum_program_id ON class_calendar_revision
WHEN NOT EXISTS (
  SELECT 1
  FROM class_calendar
  INNER JOIN class_session ON class_session.id = class_calendar.class_session_id
  INNER JOIN curriculum_program ON curriculum_program.id = NEW.curriculum_program_id
  WHERE class_calendar.id = NEW.class_calendar_id
    AND class_session.academic_year_id = curriculum_program.academic_year_id
    AND class_session.stage_code = curriculum_program.stage_code
)
BEGIN
  SELECT RAISE(ABORT, 'calendar revision program must match class session year and stage');
END;

CREATE TRIGGER prevent_non_draft_calendar_revision_identity_update
BEFORE UPDATE OF class_calendar_id, curriculum_program_id, revision_number, first_candidate_date, locked_through_sequence, based_on_revision_id ON class_calendar_revision
WHEN OLD.status != 'draft'
BEGIN
  SELECT RAISE(ABORT, 'published calendar revision identity is immutable');
END;

CREATE TRIGGER prevent_published_calendar_revision_draft_reopen
BEFORE UPDATE OF status ON class_calendar_revision
WHEN OLD.status = 'published' AND NEW.status NOT IN ('published', 'superseded', 'archived')
BEGIN
  SELECT RAISE(ABORT, 'published calendar revision cannot return to draft');
END;

CREATE TRIGGER require_published_program_for_published_calendar
BEFORE UPDATE OF status ON class_calendar_revision
WHEN NEW.status = 'published'
  AND (SELECT status FROM curriculum_program WHERE id = NEW.curriculum_program_id) != 'published'
BEGIN
  SELECT RAISE(ABORT, 'published calendar revision requires a published program');
END;

CREATE TRIGGER require_published_program_for_published_calendar_insert
BEFORE INSERT ON class_calendar_revision
WHEN NEW.status = 'published'
BEGIN
  SELECT RAISE(ABORT, 'published calendar revision must be created from a draft');
END;

CREATE TRIGGER prevent_non_draft_calendar_revision_delete
BEFORE DELETE ON class_calendar_revision
WHEN OLD.status != 'draft'
BEGIN
  SELECT RAISE(ABORT, 'published calendar revision cannot be deleted');
END;

CREATE TRIGGER prevent_slot_insert_for_non_draft_calendar_revision
BEFORE INSERT ON class_calendar_slot
WHEN (SELECT status FROM class_calendar_revision WHERE id = NEW.class_calendar_revision_id) != 'draft'
BEGIN
  SELECT RAISE(ABORT, 'calendar slots may only be changed in a draft revision');
END;

CREATE TRIGGER prevent_slot_update_for_non_draft_calendar_revision
BEFORE UPDATE ON class_calendar_slot
WHEN (SELECT status FROM class_calendar_revision WHERE id = OLD.class_calendar_revision_id) != 'draft'
  OR (SELECT status FROM class_calendar_revision WHERE id = NEW.class_calendar_revision_id) != 'draft'
BEGIN
  SELECT RAISE(ABORT, 'calendar slots may only be changed in a draft revision');
END;

CREATE TRIGGER prevent_slot_delete_for_non_draft_calendar_revision
BEFORE DELETE ON class_calendar_slot
WHEN (SELECT status FROM class_calendar_revision WHERE id = OLD.class_calendar_revision_id) != 'draft'
BEGIN
  SELECT RAISE(ABORT, 'calendar slots may only be changed in a draft revision');
END;

CREATE TRIGGER validate_slot_lesson_program_insert
BEFORE INSERT ON class_calendar_slot
WHEN NEW.curriculum_lesson_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM class_calendar_revision
    INNER JOIN curriculum_lesson ON curriculum_lesson.id = NEW.curriculum_lesson_id
    WHERE class_calendar_revision.id = NEW.class_calendar_revision_id
      AND class_calendar_revision.curriculum_program_id = curriculum_lesson.curriculum_program_id
  )
BEGIN
  SELECT RAISE(ABORT, 'calendar slot lesson must belong to revision program');
END;

CREATE TRIGGER validate_slot_lesson_program_update
BEFORE UPDATE OF class_calendar_revision_id, curriculum_lesson_id ON class_calendar_slot
WHEN NEW.curriculum_lesson_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM class_calendar_revision
    INNER JOIN curriculum_lesson ON curriculum_lesson.id = NEW.curriculum_lesson_id
    WHERE class_calendar_revision.id = NEW.class_calendar_revision_id
      AND class_calendar_revision.curriculum_program_id = curriculum_lesson.curriculum_program_id
  )
BEGIN
  SELECT RAISE(ABORT, 'calendar slot lesson must belong to revision program');
END;

CREATE TRIGGER prevent_override_insert_for_non_draft_calendar_revision
BEFORE INSERT ON class_calendar_revision_override
WHEN (SELECT status FROM class_calendar_revision WHERE id = NEW.class_calendar_revision_id) != 'draft'
BEGIN
  SELECT RAISE(ABORT, 'calendar overrides may only be changed in a draft revision');
END;

CREATE TRIGGER prevent_override_update_for_non_draft_calendar_revision
BEFORE UPDATE ON class_calendar_revision_override
WHEN (SELECT status FROM class_calendar_revision WHERE id = OLD.class_calendar_revision_id) != 'draft'
  OR (SELECT status FROM class_calendar_revision WHERE id = NEW.class_calendar_revision_id) != 'draft'
BEGIN
  SELECT RAISE(ABORT, 'calendar overrides may only be changed in a draft revision');
END;

CREATE TRIGGER prevent_override_delete_for_non_draft_calendar_revision
BEFORE DELETE ON class_calendar_revision_override
WHEN (SELECT status FROM class_calendar_revision WHERE id = OLD.class_calendar_revision_id) != 'draft'
BEGIN
  SELECT RAISE(ABORT, 'calendar overrides may only be changed in a draft revision');
END;
