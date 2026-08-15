-- Course Offerings carry a creation default for new class and make-up times.
-- Concrete classes and existing calendar slots retain their explicit times.
ALTER TABLE activity_offering
  ADD COLUMN default_class_duration_minutes INTEGER
  CHECK (
    default_class_duration_minutes IS NULL
    OR (default_class_duration_minutes BETWEEN 15 AND 360)
  );

UPDATE activity_offering
SET default_class_duration_minutes = CASE
  WHEN kind = 'annual_course' AND stage_code = 'stage_3' THEN 105
  WHEN kind IN ('annual_course', 'summer_course') THEN 80
  ELSE NULL
END
WHERE default_class_duration_minutes IS NULL;
