-- A reviewed regular-calendar change is a single durable operation. The row
-- makes a network retry safe without making future schedule revisions mutable.
CREATE TABLE course_day_change_operation (
  operation_id TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL,
  schedule_lock_version INTEGER NOT NULL UNIQUE,
  action TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_by_staff_account_id TEXT NOT NULL REFERENCES staff_account(id) ON DELETE RESTRICT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

-- One room means every reviewed regular schedule operation shares one fence.
-- The operation insert claims the current version before any revision writes;
-- a competing batch fails atomically on the unique version instead of leaving
-- independently-planned overlapping slots behind.
CREATE TABLE course_schedule_change_lock (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version >= 0),
  updated_at TEXT NOT NULL
);

INSERT INTO course_schedule_change_lock (singleton, version, updated_at)
VALUES (1, 0, '1970-01-01T00:00:00.000Z');

CREATE TRIGGER validate_course_day_change_operation_lock
BEFORE INSERT ON course_day_change_operation
WHEN NEW.schedule_lock_version != (
  SELECT version FROM course_schedule_change_lock WHERE singleton = 1
)
BEGIN
  SELECT RAISE(ABORT, 'stale course schedule change lock');
END;

CREATE TRIGGER advance_course_day_change_schedule_lock
AFTER INSERT ON course_day_change_operation
BEGIN
  UPDATE course_schedule_change_lock
  SET version = NEW.schedule_lock_version + 1,
      updated_at = NEW.created_at
  WHERE singleton = 1;
END;

CREATE INDEX idx_course_day_change_operation_subject
  ON course_day_change_operation(subject_id, created_at);
