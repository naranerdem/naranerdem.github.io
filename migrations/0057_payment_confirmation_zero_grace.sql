-- Zero is an explicit immediate-finalization setting. SQLite cannot alter a
-- CHECK constraint in place, so replace this single-row settings table while
-- preserving the existing value and update timestamp.
CREATE TABLE payment_confirmation_grace_setting_next (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  grace_minutes INTEGER NOT NULL CHECK (grace_minutes BETWEEN 0 AND 60),
  updated_at TEXT NOT NULL
);

INSERT INTO payment_confirmation_grace_setting_next (singleton, grace_minutes, updated_at)
SELECT singleton, grace_minutes, updated_at
FROM payment_confirmation_grace_setting;

DROP TABLE payment_confirmation_grace_setting;
ALTER TABLE payment_confirmation_grace_setting_next RENAME TO payment_confirmation_grace_setting;
