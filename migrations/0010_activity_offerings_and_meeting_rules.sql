-- Concrete annual courses, summer courses, and events.
-- Existing academic-year, stage, class-session, and calendar identities remain
-- intact. New scheduling authority is additive so current registration foreign
-- keys continue to work unchanged.

CREATE TABLE activity_offering (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('annual_course', 'summer_course', 'event')),
  title TEXT NOT NULL,
  academic_year_id TEXT REFERENCES academic_year(id) ON DELETE RESTRICT,
  stage_code TEXT CHECK (stage_code IS NULL OR stage_code IN ('stage_1', 'stage_2', 'stage_3')),
  level_label TEXT,
  starts_on TEXT,
  ends_on TEXT,
  curriculum_program_id TEXT REFERENCES curriculum_program(id) ON DELETE RESTRICT,
  use_academic_year_breaks INTEGER NOT NULL CHECK (use_academic_year_breaks IN (0, 1)),
  charge_mode TEXT NOT NULL CHECK (charge_mode IN ('free', 'paid')),
  facebook_group_url TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(trim(title)) > 0),
  CHECK (level_label IS NULL OR length(trim(level_label)) > 0),
  CHECK (starts_on IS NULL OR (length(starts_on) = 10 AND substr(starts_on, 5, 1) = '-' AND substr(starts_on, 8, 1) = '-')),
  CHECK (ends_on IS NULL OR (length(ends_on) = 10 AND substr(ends_on, 5, 1) = '-' AND substr(ends_on, 8, 1) = '-')),
  CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on),
  CHECK (facebook_group_url IS NULL OR length(trim(facebook_group_url)) > 0),
  CHECK (kind != 'annual_course' OR (academic_year_id IS NOT NULL AND stage_code IS NOT NULL)),
  CHECK (kind != 'event' OR (academic_year_id IS NULL AND stage_code IS NULL AND curriculum_program_id IS NULL)),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE UNIQUE INDEX idx_activity_offering_annual_stage
  ON activity_offering(academic_year_id, stage_code)
  WHERE kind = 'annual_course' AND status = 'active';
CREATE INDEX idx_activity_offering_kind_period
  ON activity_offering(kind, status, starts_on, ends_on);
CREATE INDEX idx_activity_offering_program
  ON activity_offering(curriculum_program_id);

ALTER TABLE class_session
  ADD COLUMN activity_offering_id TEXT REFERENCES activity_offering(id) ON DELETE RESTRICT;

CREATE INDEX idx_class_session_activity_offering
  ON class_session(activity_offering_id, status, start_time);

CREATE TABLE class_meeting_rule (
  class_session_id TEXT PRIMARY KEY REFERENCES class_session(id) ON DELETE CASCADE,
  recurrence_kind TEXT NOT NULL CHECK (recurrence_kind IN ('weekly', 'weekdays', 'daily')),
  first_date TEXT NOT NULL,
  last_date TEXT,
  weekly_weekday TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(first_date) = 10 AND substr(first_date, 5, 1) = '-' AND substr(first_date, 8, 1) = '-'),
  CHECK (last_date IS NULL OR (length(last_date) = 10 AND substr(last_date, 5, 1) = '-' AND substr(last_date, 8, 1) = '-')),
  CHECK (last_date IS NULL OR last_date >= first_date),
  CHECK (length(start_time) = 5 AND length(end_time) = 5 AND end_time > start_time),
  CHECK (
    (recurrence_kind = 'weekly' AND weekly_weekday IS NOT NULL AND length(trim(weekly_weekday)) > 0)
    OR (recurrence_kind IN ('weekdays', 'daily') AND weekly_weekday IS NULL)
  )
);

CREATE INDEX idx_class_meeting_rule_period
  ON class_meeting_rule(recurrence_kind, first_date, last_date);

CREATE TABLE offering_event_occurrence (
  id TEXT PRIMARY KEY,
  activity_offering_id TEXT NOT NULL REFERENCES activity_offering(id) ON DELETE RESTRICT,
  local_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  registration_status TEXT NOT NULL DEFAULT 'closed' CHECK (registration_status IN ('closed', 'open', 'cancelled')),
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(local_date) = 10 AND substr(local_date, 5, 1) = '-' AND substr(local_date, 8, 1) = '-'),
  CHECK (length(start_time) = 5 AND length(end_time) = 5 AND end_time > start_time),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE INDEX idx_offering_event_occurrence_date
  ON offering_event_occurrence(activity_offering_id, local_date, start_time);
CREATE UNIQUE INDEX idx_offering_event_occurrence_offering
  ON offering_event_occurrence(activity_offering_id);

-- Preserve current annual behavior by creating one Offering per existing
-- academic-year/stage and attaching every existing ClassSession to it.
INSERT INTO activity_offering (
  id, kind, title, academic_year_id, stage_code, starts_on, ends_on,
  curriculum_program_id, use_academic_year_breaks, charge_mode,
  facebook_group_url, status, is_test, test_run_id, created_at, updated_at
)
SELECT
  'annual-offering-' || class_session.academic_year_id || '-' || class_session.stage_code,
  'annual_course',
  academic_year.public_label || ' · ' || CASE class_session.stage_code
    WHEN 'stage_1' THEN '1-р шат'
    WHEN 'stage_2' THEN '2-р шат'
    ELSE '3-р шат'
  END,
  class_session.academic_year_id,
  class_session.stage_code,
  academic_year.starts_on,
  academic_year.ends_on,
  (
    SELECT program.id FROM curriculum_program AS program
    WHERE program.academic_year_id = class_session.academic_year_id
      AND program.stage_code = class_session.stage_code
      AND program.status = 'published'
    ORDER BY program.revision_number DESC LIMIT 1
  ),
  1,
  'paid',
  (
    SELECT setting.facebook_group_url FROM academic_year_stage_setting AS setting
    WHERE setting.academic_year_id = class_session.academic_year_id
      AND setting.stage_code = class_session.stage_code
  ),
  'active',
  MAX(class_session.is_test),
  MAX(class_session.test_run_id),
  MIN(class_session.created_at),
  MAX(class_session.updated_at)
FROM class_session
INNER JOIN academic_year ON academic_year.id = class_session.academic_year_id
GROUP BY class_session.academic_year_id, class_session.stage_code;

UPDATE class_session
SET activity_offering_id = 'annual-offering-' || academic_year_id || '-' || stage_code
WHERE activity_offering_id IS NULL;

INSERT INTO class_meeting_rule (
  class_session_id, recurrence_kind, first_date, last_date, weekly_weekday,
  start_time, end_time, created_at, updated_at
)
SELECT
  class_session.id,
  'weekly',
  COALESCE(
    (SELECT revision.first_candidate_date
     FROM class_calendar
     INNER JOIN class_calendar_revision AS revision ON revision.class_calendar_id = class_calendar.id
     WHERE class_calendar.class_session_id = class_session.id
     ORDER BY revision.revision_number DESC LIMIT 1),
    academic_year.starts_on,
    '1970-01-01'
  ),
  NULL,
  class_session.weekday,
  class_session.start_time,
  class_session.end_time,
  class_session.created_at,
  class_session.updated_at
FROM class_session
INNER JOIN academic_year ON academic_year.id = class_session.academic_year_id;

-- Identity-critical Offering changes cannot invalidate durable class/event or
-- published-calendar history. Harmless title and communication edits remain
-- available through the service layer.
CREATE TRIGGER validate_activity_offering_program_insert
BEFORE INSERT ON activity_offering
WHEN NEW.curriculum_program_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM curriculum_program
    WHERE curriculum_program.id = NEW.curriculum_program_id
      AND curriculum_program.academic_year_id = NEW.academic_year_id
      AND (NEW.kind != 'annual_course' OR curriculum_program.stage_code = NEW.stage_code)
  )
BEGIN
  SELECT RAISE(ABORT, 'activity offering program must match its context');
END;

CREATE TRIGGER validate_activity_offering_program_update
BEFORE UPDATE OF curriculum_program_id, academic_year_id, stage_code ON activity_offering
WHEN NEW.curriculum_program_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM curriculum_program
    WHERE curriculum_program.id = NEW.curriculum_program_id
      AND curriculum_program.academic_year_id = NEW.academic_year_id
      AND (NEW.kind != 'annual_course' OR curriculum_program.stage_code = NEW.stage_code)
  )
BEGIN
  SELECT RAISE(ABORT, 'activity offering program must match its context');
END;

CREATE TRIGGER prevent_used_offering_context_update
BEFORE UPDATE OF kind, academic_year_id, stage_code ON activity_offering
WHEN EXISTS (SELECT 1 FROM class_session WHERE activity_offering_id = OLD.id)
  OR EXISTS (SELECT 1 FROM offering_event_occurrence WHERE activity_offering_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'used activity offering identity is immutable');
END;

CREATE TRIGGER prevent_published_calendar_offering_plan_update
BEFORE UPDATE OF curriculum_program_id, use_academic_year_breaks, starts_on, ends_on ON activity_offering
WHEN (
  NEW.curriculum_program_id IS NOT OLD.curriculum_program_id
  OR NEW.use_academic_year_breaks != OLD.use_academic_year_breaks
  OR NEW.starts_on IS NOT OLD.starts_on
  OR NEW.ends_on IS NOT OLD.ends_on
)
AND EXISTS (
  SELECT 1 FROM class_session
  INNER JOIN class_calendar ON class_calendar.class_session_id = class_session.id
  INNER JOIN class_calendar_revision ON class_calendar_revision.class_calendar_id = class_calendar.id
  WHERE class_session.activity_offering_id = OLD.id
    AND class_calendar_revision.status = 'published'
)
BEGIN
  SELECT RAISE(ABORT, 'published calendar offering plan is immutable');
END;

CREATE TRIGGER validate_class_offering_insert
BEFORE INSERT ON class_session
WHEN NEW.activity_offering_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM activity_offering
    LEFT JOIN curriculum_program ON curriculum_program.id = activity_offering.curriculum_program_id
    WHERE activity_offering.id = NEW.activity_offering_id
      AND activity_offering.kind IN ('annual_course', 'summer_course')
      AND NEW.academic_year_id = COALESCE(activity_offering.academic_year_id, curriculum_program.academic_year_id)
      AND NEW.stage_code = COALESCE(activity_offering.stage_code, curriculum_program.stage_code)
  )
BEGIN
  SELECT RAISE(ABORT, 'class session must match its activity offering context');
END;

CREATE TRIGGER validate_class_offering_update
BEFORE UPDATE OF activity_offering_id, academic_year_id, stage_code ON class_session
WHEN NEW.activity_offering_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM activity_offering
    LEFT JOIN curriculum_program ON curriculum_program.id = activity_offering.curriculum_program_id
    WHERE activity_offering.id = NEW.activity_offering_id
      AND activity_offering.kind IN ('annual_course', 'summer_course')
      AND NEW.academic_year_id = COALESCE(activity_offering.academic_year_id, curriculum_program.academic_year_id)
      AND NEW.stage_code = COALESCE(activity_offering.stage_code, curriculum_program.stage_code)
  )
BEGIN
  SELECT RAISE(ABORT, 'class session must match its activity offering context');
END;

CREATE TRIGGER require_event_offering_for_occurrence_insert
BEFORE INSERT ON offering_event_occurrence
WHEN (SELECT kind FROM activity_offering WHERE id = NEW.activity_offering_id) != 'event'
BEGIN
  SELECT RAISE(ABORT, 'event occurrence requires an event offering');
END;

CREATE TRIGGER require_event_offering_for_occurrence_update
BEFORE UPDATE OF activity_offering_id ON offering_event_occurrence
WHEN (SELECT kind FROM activity_offering WHERE id = NEW.activity_offering_id) != 'event'
BEGIN
  SELECT RAISE(ABORT, 'event occurrence requires an event offering');
END;

CREATE TRIGGER validate_offering_calendar_program_insert
BEFORE INSERT ON class_calendar_revision
WHEN EXISTS (
  SELECT 1 FROM class_calendar
  INNER JOIN class_session ON class_session.id = class_calendar.class_session_id
  WHERE class_calendar.id = NEW.class_calendar_id
    AND class_session.activity_offering_id IS NOT NULL
)
AND NOT EXISTS (
  SELECT 1 FROM class_calendar
  INNER JOIN class_session ON class_session.id = class_calendar.class_session_id
  INNER JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
  WHERE class_calendar.id = NEW.class_calendar_id
    AND activity_offering.curriculum_program_id = NEW.curriculum_program_id
)
BEGIN
  SELECT RAISE(ABORT, 'calendar revision must inherit the activity offering program');
END;

CREATE TRIGGER validate_offering_calendar_program_update
BEFORE UPDATE OF class_calendar_id, curriculum_program_id ON class_calendar_revision
WHEN EXISTS (
  SELECT 1 FROM class_calendar
  INNER JOIN class_session ON class_session.id = class_calendar.class_session_id
  WHERE class_calendar.id = NEW.class_calendar_id
    AND class_session.activity_offering_id IS NOT NULL
)
AND NOT EXISTS (
  SELECT 1 FROM class_calendar
  INNER JOIN class_session ON class_session.id = class_calendar.class_session_id
  INNER JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
  WHERE class_calendar.id = NEW.class_calendar_id
    AND activity_offering.curriculum_program_id = NEW.curriculum_program_id
)
BEGIN
  SELECT RAISE(ABORT, 'calendar revision must inherit the activity offering program');
END;
