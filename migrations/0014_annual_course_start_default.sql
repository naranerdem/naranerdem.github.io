-- One typed, global default for the editable start date of a new annual course.
-- This is deliberately not a generic settings table.

CREATE TABLE annual_course_start_default (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  day INTEGER NOT NULL CHECK (day BETWEEN 1 AND 31),
  updated_at TEXT NOT NULL
);

INSERT INTO annual_course_start_default (singleton, month, day, updated_at)
VALUES (1, 10, 1, '2026-08-14T00:00:00.000Z');
