-- One staff identity may use up to three login addresses. The child table is
-- authoritative; staff_account.email_normalized remains the primary-address
-- compatibility mirror for older administrative queries.

CREATE TABLE staff_account_email (
  id TEXT PRIMARY KEY,
  staff_account_id TEXT NOT NULL REFERENCES staff_account(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(trim(email)) > 3),
  CHECK (length(trim(email_normalized)) > 3)
);

CREATE UNIQUE INDEX idx_staff_account_email_one_primary
  ON staff_account_email(staff_account_id)
  WHERE is_primary = 1;

CREATE INDEX idx_staff_account_email_account
  ON staff_account_email(staff_account_id, is_primary DESC, created_at);

INSERT INTO staff_account_email (
  id, staff_account_id, email, email_normalized, is_primary,
  created_by_staff_account_id, created_at, updated_at
)
SELECT
  'staff-email-' || staff_account.id,
  staff_account.id,
  staff_account.email_normalized,
  staff_account.email_normalized,
  1,
  NULL,
  staff_account.created_at,
  staff_account.updated_at
FROM staff_account;

CREATE TRIGGER staff_account_email_max_three_insert
BEFORE INSERT ON staff_account_email
WHEN (
  SELECT COUNT(*) FROM staff_account_email
  WHERE staff_account_id = NEW.staff_account_id
) >= 3
BEGIN
  SELECT RAISE(ABORT, 'staff account may have at most three login emails');
END;

CREATE TRIGGER staff_account_email_max_three_move
BEFORE UPDATE OF staff_account_id ON staff_account_email
WHEN OLD.staff_account_id <> NEW.staff_account_id
  AND (
    SELECT COUNT(*) FROM staff_account_email
    WHERE staff_account_id = NEW.staff_account_id
  ) >= 3
BEGIN
  SELECT RAISE(ABORT, 'staff account may have at most three login emails');
END;

CREATE TRIGGER staff_account_email_primary_insert_sync
AFTER INSERT ON staff_account_email
WHEN NEW.is_primary = 1
BEGIN
  UPDATE staff_account
  SET email_normalized = NEW.email_normalized,
      updated_at = CASE WHEN updated_at > NEW.updated_at THEN updated_at ELSE NEW.updated_at END
  WHERE id = NEW.staff_account_id;
END;

CREATE TRIGGER staff_account_email_primary_update_sync
AFTER UPDATE OF is_primary, email, email_normalized ON staff_account_email
WHEN NEW.is_primary = 1
BEGIN
  UPDATE staff_account
  SET email_normalized = NEW.email_normalized,
      updated_at = CASE WHEN updated_at > NEW.updated_at THEN updated_at ELSE NEW.updated_at END
  WHERE id = NEW.staff_account_id;
END;

CREATE TRIGGER staff_account_email_primary_delete_guard
BEFORE DELETE ON staff_account_email
WHEN OLD.is_primary = 1
  AND EXISTS (SELECT 1 FROM staff_account WHERE id = OLD.staff_account_id)
BEGIN
  SELECT RAISE(ABORT, 'primary staff login email cannot be removed');
END;
