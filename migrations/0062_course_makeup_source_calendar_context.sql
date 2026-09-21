-- A published calendar revision can legitimately retain a historical program
-- after its Offering moves to a newer program revision. Make-up source
-- eligibility already uses that published calendar context; the original
-- trigger incorrectly required the Offering's current program instead.
DROP TRIGGER validate_course_makeup_source_insert;

CREATE TRIGGER validate_course_makeup_source_insert
BEFORE INSERT ON course_makeup_resolution
WHEN NOT EXISTS (
  SELECT 1
  FROM enrollment
  INNER JOIN class_session ON class_session.id = enrollment.class_session_id
  INNER JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
  INNER JOIN class_calendar ON class_calendar.class_session_id = class_session.id
  INNER JOIN class_calendar_revision
    ON class_calendar_revision.class_calendar_id = class_calendar.id
    AND class_calendar_revision.status = 'published'
  INNER JOIN curriculum_lesson
    ON curriculum_lesson.id = NEW.source_curriculum_lesson_id
    AND curriculum_lesson.curriculum_program_id = class_calendar_revision.curriculum_program_id
  WHERE enrollment.id = NEW.source_enrollment_id
    AND class_session.id = NEW.source_class_session_id
    AND activity_offering.kind IN ('annual_course', 'summer_course')
)
BEGIN
  SELECT RAISE(ABORT, 'make-up source must match enrollment class and published calendar lesson');
END;
