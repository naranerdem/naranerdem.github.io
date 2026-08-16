-- Ordinary public registration is opened explicitly for selected Offerings.
-- Dates are Mongolia-local civil dates interpreted by the application layer.

CREATE TABLE registration_window (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(trim(name)) > 0),
  CHECK (length(starts_on) = 10 AND substr(starts_on, 5, 1) = '-' AND substr(starts_on, 8, 1) = '-'),
  CHECK (length(ends_on) = 10 AND substr(ends_on, 5, 1) = '-' AND substr(ends_on, 8, 1) = '-'),
  CHECK (ends_on >= starts_on),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE TABLE registration_window_offering (
  registration_window_id TEXT NOT NULL REFERENCES registration_window(id) ON DELETE CASCADE,
  activity_offering_id TEXT NOT NULL REFERENCES activity_offering(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (registration_window_id, activity_offering_id)
);

CREATE INDEX idx_registration_window_active_dates
  ON registration_window(starts_on, ends_on, is_test);
CREATE INDEX idx_registration_window_offering_offering
  ON registration_window_offering(activity_offering_id, registration_window_id);
