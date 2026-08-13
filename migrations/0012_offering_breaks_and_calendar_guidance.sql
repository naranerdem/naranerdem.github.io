-- Distinguish school-calendar guidance from Naran Erdem course breaks.
-- Existing period rows retain their original behavior: skip habitual annual
-- candidates during initial draft generation.

ALTER TABLE academic_year_break
  ADD COLUMN generation_behavior TEXT NOT NULL DEFAULT 'exclude_by_default'
    CHECK (generation_behavior IN ('exclude_by_default', 'warn_only'));

ALTER TABLE curriculum_program
  ADD COLUMN program_kind TEXT NOT NULL DEFAULT 'annual_course'
    CHECK (program_kind IN ('annual_course', 'summer_course'));

-- Existing summer fixtures and any prior summer Offering-associated programs
-- remain semantically summer programs after the additive default above.
UPDATE curriculum_program
SET program_kind = 'summer_course'
WHERE id IN (
  SELECT curriculum_program_id
  FROM activity_offering
  WHERE kind = 'summer_course' AND curriculum_program_id IS NOT NULL
);

CREATE TABLE activity_offering_break (
  id TEXT PRIMARY KEY,
  activity_offering_id TEXT NOT NULL REFERENCES activity_offering(id) ON DELETE RESTRICT,
  label TEXT NOT NULL,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  note TEXT,
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

CREATE INDEX idx_activity_offering_break_period
  ON activity_offering_break(activity_offering_id, starts_on, ends_on);

CREATE TABLE operational_default_import (
  template_key TEXT PRIMARY KEY,
  template_version INTEGER NOT NULL CHECK (template_version > 0),
  template_kind TEXT NOT NULL CHECK (template_kind IN ('program', 'school_calendar_period')),
  imported_at TEXT NOT NULL
);

-- Course payment and school-guidance defaults are domain rules, not merely
-- presentation defaults. Existing historical rows are left untouched.
CREATE TRIGGER require_paid_course_offering_insert
BEFORE INSERT ON activity_offering
WHEN NEW.kind IN ('annual_course', 'summer_course') AND NEW.charge_mode != 'paid'
BEGIN
  SELECT RAISE(ABORT, 'annual and summer offerings must be paid');
END;

CREATE TRIGGER require_paid_course_offering_update
BEFORE UPDATE OF kind, charge_mode ON activity_offering
WHEN NEW.kind IN ('annual_course', 'summer_course') AND NEW.charge_mode != 'paid'
BEGIN
  SELECT RAISE(ABORT, 'annual and summer offerings must be paid');
END;

CREATE TRIGGER require_annual_school_guidance_insert
BEFORE INSERT ON activity_offering
WHEN NEW.kind = 'annual_course' AND NEW.use_academic_year_breaks != 1
BEGIN
  SELECT RAISE(ABORT, 'annual offerings use school calendar guidance');
END;

CREATE TRIGGER require_annual_school_guidance_update
BEFORE UPDATE OF kind, use_academic_year_breaks ON activity_offering
WHEN NEW.kind = 'annual_course' AND NEW.use_academic_year_breaks != 1
BEGIN
  SELECT RAISE(ABORT, 'annual offerings use school calendar guidance');
END;

CREATE TRIGGER validate_offering_program_kind_insert
BEFORE INSERT ON activity_offering
WHEN NEW.curriculum_program_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM curriculum_program
    WHERE id = NEW.curriculum_program_id
      AND program_kind = CASE NEW.kind
        WHEN 'annual_course' THEN 'annual_course'
        WHEN 'summer_course' THEN 'summer_course'
        ELSE program_kind
      END
  )
BEGIN
  SELECT RAISE(ABORT, 'activity offering program kind must match');
END;

CREATE TRIGGER validate_offering_program_kind_update
BEFORE UPDATE OF kind, curriculum_program_id ON activity_offering
WHEN NEW.curriculum_program_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM curriculum_program
    WHERE id = NEW.curriculum_program_id
      AND program_kind = CASE NEW.kind
        WHEN 'annual_course' THEN 'annual_course'
        WHEN 'summer_course' THEN 'summer_course'
        ELSE program_kind
      END
  )
BEGIN
  SELECT RAISE(ABORT, 'activity offering program kind must match');
END;

CREATE TRIGGER require_course_offering_break_insert
BEFORE INSERT ON activity_offering_break
WHEN NOT EXISTS (
  SELECT 1 FROM activity_offering
  WHERE id = NEW.activity_offering_id AND kind IN ('annual_course', 'summer_course')
)
BEGIN
  SELECT RAISE(ABORT, 'offering breaks require a course offering');
END;

CREATE TRIGGER require_course_offering_break_update
BEFORE UPDATE OF activity_offering_id ON activity_offering_break
WHEN NOT EXISTS (
  SELECT 1 FROM activity_offering
  WHERE id = NEW.activity_offering_id AND kind IN ('annual_course', 'summer_course')
)
BEGIN
  SELECT RAISE(ABORT, 'offering breaks require a course offering');
END;
