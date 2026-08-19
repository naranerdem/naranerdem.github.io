-- One typed policy for new accepted registration payment reservations.
-- This is not a generic application settings table.
CREATE TABLE initial_payment_deadline_setting (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  deadline_minutes INTEGER NOT NULL CHECK (deadline_minutes BETWEEN 1 AND 10080),
  updated_at TEXT NOT NULL
);

INSERT INTO initial_payment_deadline_setting (singleton, deadline_minutes, updated_at)
VALUES (1, 1440, '2026-08-19T00:00:00.000Z');
