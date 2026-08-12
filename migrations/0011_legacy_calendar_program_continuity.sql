-- Preserve change-revision continuity for calendars published before Offerings
-- existed. New initial calendars must still inherit the Offering's current
-- program; only a revision based directly on existing published history may
-- continue that same historical program after it has been superseded.

DROP TRIGGER validate_offering_calendar_program_insert;
DROP TRIGGER validate_offering_calendar_program_update;
DROP TRIGGER require_published_program_for_published_calendar;

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
AND NOT EXISTS (
  SELECT 1 FROM class_calendar_revision AS base_revision
  WHERE base_revision.id = NEW.based_on_revision_id
    AND base_revision.class_calendar_id = NEW.class_calendar_id
    AND base_revision.curriculum_program_id = NEW.curriculum_program_id
    AND base_revision.status IN ('published', 'superseded')
)
BEGIN
  SELECT RAISE(ABORT, 'calendar revision must inherit the activity offering or its published base program');
END;

CREATE TRIGGER validate_offering_calendar_program_update
BEFORE UPDATE OF class_calendar_id, curriculum_program_id, based_on_revision_id ON class_calendar_revision
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
AND NOT EXISTS (
  SELECT 1 FROM class_calendar_revision AS base_revision
  WHERE base_revision.id = NEW.based_on_revision_id
    AND base_revision.class_calendar_id = NEW.class_calendar_id
    AND base_revision.curriculum_program_id = NEW.curriculum_program_id
    AND base_revision.status IN ('published', 'superseded')
)
BEGIN
  SELECT RAISE(ABORT, 'calendar revision must inherit the activity offering or its published base program');
END;

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
          AND EXISTS (
            SELECT 1 FROM class_calendar_revision AS base_revision
            WHERE base_revision.id = NEW.based_on_revision_id
              AND base_revision.class_calendar_id = NEW.class_calendar_id
              AND base_revision.curriculum_program_id = NEW.curriculum_program_id
              AND base_revision.status IN ('published', 'superseded')
          )
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'published calendar revision requires a current or historical base program');
END;
