-- Stable logical Program identities sit above immutable curriculum revisions.
-- Offerings and calendars remain pinned to a concrete revision for history.

CREATE TABLE curriculum_program_family (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('annual_course', 'summer_course')),
  display_name TEXT NOT NULL,
  annual_stage_code TEXT CHECK (annual_stage_code IN ('stage_1', 'stage_2', 'stage_3')),
  current_published_program_id TEXT REFERENCES curriculum_program(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(trim(display_name)) > 0),
  CHECK (
    (kind = 'annual_course' AND annual_stage_code IS NOT NULL)
    OR (kind = 'summer_course' AND annual_stage_code IS NULL)
  ),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE UNIQUE INDEX idx_curriculum_program_family_annual_stage
  ON curriculum_program_family(annual_stage_code)
  WHERE kind = 'annual_course';
CREATE INDEX idx_curriculum_program_family_current
  ON curriculum_program_family(current_published_program_id);

ALTER TABLE curriculum_program ADD COLUMN program_family_id TEXT REFERENCES curriculum_program_family(id) ON DELETE RESTRICT;
ALTER TABLE curriculum_program ADD COLUMN based_on_program_id TEXT REFERENCES curriculum_program(id) ON DELETE RESTRICT;
ALTER TABLE curriculum_program ADD COLUMN published_at TEXT;

CREATE INDEX idx_curriculum_program_family_revision
  ON curriculum_program(program_family_id, revision_number DESC);

-- Existing annual rows become historical revisions beneath one stable stage
-- identity. Existing summer rows keep one identity each because no prior
-- grouping information exists to safely infer otherwise.
INSERT OR IGNORE INTO curriculum_program_family (
  id, kind, display_name, annual_stage_code, current_published_program_id,
  status, is_test, test_run_id, created_at, updated_at
)
SELECT
  'annual-program-' || stage_code,
  'annual_course',
  CASE stage_code
    WHEN 'stage_1' THEN '1-р шат'
    WHEN 'stage_2' THEN '2-р шат'
    WHEN 'stage_3' THEN '3-р шат'
  END,
  stage_code,
  NULL,
  'active',
  0,
  NULL,
  MIN(created_at),
  MAX(updated_at)
FROM curriculum_program
WHERE program_kind = 'annual_course'
GROUP BY stage_code;

INSERT OR IGNORE INTO curriculum_program_family (
  id, kind, display_name, annual_stage_code, current_published_program_id,
  status, is_test, test_run_id, created_at, updated_at
)
SELECT
  'summer-program-' || id,
  'summer_course',
  display_name,
  NULL,
  NULL,
  'active',
  is_test,
  test_run_id,
  created_at,
  updated_at
FROM curriculum_program
WHERE program_kind = 'summer_course';

UPDATE curriculum_program
SET program_family_id = CASE
  WHEN program_kind = 'annual_course' THEN 'annual-program-' || stage_code
  ELSE 'summer-program-' || id
END;

UPDATE curriculum_program
SET published_at = updated_at
WHERE status IN ('published', 'superseded') AND published_at IS NULL;

UPDATE curriculum_program_family
SET current_published_program_id = (
  SELECT program.id
  FROM curriculum_program AS program
  WHERE program.program_family_id = curriculum_program_family.id
    AND program.status = 'published'
  ORDER BY program.is_test ASC, program.updated_at DESC, program.revision_number DESC
  LIMIT 1
);

CREATE TRIGGER validate_curriculum_program_family_insert
BEFORE INSERT ON curriculum_program
WHEN NEW.program_family_id IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM curriculum_program_family AS family
    WHERE family.id = NEW.program_family_id
      AND family.kind = NEW.program_kind
      AND (family.kind != 'annual_course' OR family.annual_stage_code = NEW.stage_code)
  )
BEGIN
  SELECT RAISE(ABORT, 'curriculum program must belong to a compatible program family');
END;

CREATE TRIGGER validate_curriculum_program_family_update
BEFORE UPDATE OF program_family_id, program_kind, stage_code ON curriculum_program
WHEN NEW.program_family_id IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM curriculum_program_family AS family
    WHERE family.id = NEW.program_family_id
      AND family.kind = NEW.program_kind
      AND (family.kind != 'annual_course' OR family.annual_stage_code = NEW.stage_code)
  )
BEGIN
  SELECT RAISE(ABORT, 'curriculum program must belong to a compatible program family');
END;

CREATE TRIGGER validate_curriculum_program_draft_base_insert
BEFORE INSERT ON curriculum_program
WHEN NEW.based_on_program_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM curriculum_program AS source
    WHERE source.id = NEW.based_on_program_id
      AND source.program_family_id = NEW.program_family_id
      AND source.status = 'published'
  )
BEGIN
  SELECT RAISE(ABORT, 'program draft base must be the family current published program');
END;

CREATE TRIGGER validate_curriculum_program_draft_base_update
BEFORE UPDATE OF based_on_program_id ON curriculum_program
WHEN NEW.based_on_program_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM curriculum_program AS source
    WHERE source.id = NEW.based_on_program_id
      AND source.program_family_id = NEW.program_family_id
      AND source.status = 'published'
  )
BEGIN
  SELECT RAISE(ABORT, 'program draft base must be the family current published program');
END;

CREATE TRIGGER validate_curriculum_program_family_current_insert
BEFORE INSERT ON curriculum_program_family
WHEN NEW.current_published_program_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM curriculum_program AS program
    WHERE program.id = NEW.current_published_program_id
      AND program.program_family_id = NEW.id
      AND program.status = 'published'
  )
BEGIN
  SELECT RAISE(ABORT, 'program family current revision must be its published program');
END;

CREATE TRIGGER validate_curriculum_program_family_current_update
BEFORE UPDATE OF current_published_program_id ON curriculum_program_family
WHEN NEW.current_published_program_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM curriculum_program AS program
    WHERE program.id = NEW.current_published_program_id
      AND program.program_family_id = NEW.id
      AND program.status = 'published'
  )
BEGIN
  SELECT RAISE(ABORT, 'program family current revision must be its published program');
END;

CREATE TRIGGER prevent_annual_program_family_delete
BEFORE DELETE ON curriculum_program_family
WHEN OLD.kind = 'annual_course'
BEGIN
  SELECT RAISE(ABORT, 'annual program families cannot be deleted');
END;

-- Annual program revisions are now reusable over new configured academic years.
-- Summer revisions retain their original internal academic-year context.
DROP TRIGGER validate_activity_offering_program_insert;
DROP TRIGGER validate_activity_offering_program_update;

CREATE TRIGGER validate_activity_offering_program_insert
BEFORE INSERT ON activity_offering
WHEN NEW.curriculum_program_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM curriculum_program AS program
    INNER JOIN curriculum_program_family AS family ON family.id = program.program_family_id
    WHERE program.id = NEW.curriculum_program_id
      AND program.program_kind = NEW.kind
      AND (
        (NEW.kind = 'annual_course' AND family.annual_stage_code = NEW.stage_code)
        OR (NEW.kind = 'summer_course' AND program.academic_year_id = NEW.academic_year_id)
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'activity offering program must match its logical program and context');
END;

CREATE TRIGGER validate_activity_offering_program_update
BEFORE UPDATE OF curriculum_program_id, academic_year_id, stage_code ON activity_offering
WHEN NEW.curriculum_program_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM curriculum_program AS program
    INNER JOIN curriculum_program_family AS family ON family.id = program.program_family_id
    WHERE program.id = NEW.curriculum_program_id
      AND program.program_kind = NEW.kind
      AND (
        (NEW.kind = 'annual_course' AND family.annual_stage_code = NEW.stage_code)
        OR (NEW.kind = 'summer_course' AND program.academic_year_id = NEW.academic_year_id)
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'activity offering program must match its logical program and context');
END;

DROP TRIGGER validate_calendar_revision_program_insert;
DROP TRIGGER validate_calendar_revision_program_update;

CREATE TRIGGER validate_calendar_revision_program_insert
BEFORE INSERT ON class_calendar_revision
WHEN NOT EXISTS (
  SELECT 1
  FROM class_calendar
  INNER JOIN class_session ON class_session.id = class_calendar.class_session_id
  INNER JOIN curriculum_program AS program ON program.id = NEW.curriculum_program_id
  INNER JOIN curriculum_program_family AS family ON family.id = program.program_family_id
  WHERE class_calendar.id = NEW.class_calendar_id
    AND (
      (program.program_kind = 'annual_course' AND family.annual_stage_code = class_session.stage_code)
      OR (program.program_kind = 'summer_course' AND program.academic_year_id = class_session.academic_year_id AND program.stage_code = class_session.stage_code)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'calendar revision program must match class session program identity');
END;

CREATE TRIGGER validate_calendar_revision_program_update
BEFORE UPDATE OF class_calendar_id, curriculum_program_id ON class_calendar_revision
WHEN NOT EXISTS (
  SELECT 1
  FROM class_calendar
  INNER JOIN class_session ON class_session.id = class_calendar.class_session_id
  INNER JOIN curriculum_program AS program ON program.id = NEW.curriculum_program_id
  INNER JOIN curriculum_program_family AS family ON family.id = program.program_family_id
  WHERE class_calendar.id = NEW.class_calendar_id
    AND (
      (program.program_kind = 'annual_course' AND family.annual_stage_code = class_session.stage_code)
      OR (program.program_kind = 'summer_course' AND program.academic_year_id = class_session.academic_year_id AND program.stage_code = class_session.stage_code)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'calendar revision program must match class session program identity');
END;

-- A newly generated calendar for an existing Offering must be able to use the
-- Offering's pinned historical revision after a newer family revision publishes.
DROP TRIGGER require_published_program_for_published_calendar;

CREATE TRIGGER require_published_program_for_published_calendar
BEFORE UPDATE OF status ON class_calendar_revision
WHEN NEW.status = 'published'
  AND NOT EXISTS (
    SELECT 1 FROM curriculum_program
    WHERE curriculum_program.id = NEW.curriculum_program_id
      AND (
        curriculum_program.status = 'published'
        OR (
          curriculum_program.status = 'superseded'
          AND (
            EXISTS (
              SELECT 1 FROM class_calendar
              INNER JOIN class_session ON class_session.id = class_calendar.class_session_id
              INNER JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
              WHERE class_calendar.id = NEW.class_calendar_id
                AND activity_offering.curriculum_program_id = NEW.curriculum_program_id
            )
            OR EXISTS (
              SELECT 1 FROM class_calendar_revision AS base_revision
              WHERE base_revision.id = NEW.based_on_revision_id
                AND base_revision.class_calendar_id = NEW.class_calendar_id
                AND base_revision.curriculum_program_id = NEW.curriculum_program_id
                AND base_revision.status IN ('published', 'superseded')
            )
          )
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'published calendar revision requires its offering or historical base program');
END;
