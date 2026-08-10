-- Ordinary registration selects one concrete class. Ranked choices are not part
-- of the public registration or waitlist model.

ALTER TABLE application_child
  ADD COLUMN selected_class_session_id TEXT REFERENCES class_session(id) ON DELETE RESTRICT;

DROP TABLE ranked_class_preference;

CREATE TABLE waitlist_entry_v2 (
  id TEXT PRIMARY KEY,
  application_child_id TEXT NOT NULL UNIQUE REFERENCES application_child(id) ON DELETE CASCADE,
  class_session_id TEXT NOT NULL REFERENCES class_session(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active', 'offered', 'offer_expired', 'accepted', 'deactivated', 'cancelled')),
  offered_at TEXT,
  offer_expires_at TEXT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (application_child_id, class_session_id),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

INSERT INTO waitlist_entry_v2 (
  id, application_child_id, class_session_id, status, offered_at,
  offer_expires_at, is_test, test_run_id, created_at, updated_at
)
SELECT
  id, application_child_id, class_session_id, status, offered_at,
  offer_expires_at, is_test, test_run_id, created_at, updated_at
FROM waitlist_entry;

DROP TABLE waitlist_entry;
ALTER TABLE waitlist_entry_v2 RENAME TO waitlist_entry;

CREATE INDEX idx_waitlist_class_status_created
  ON waitlist_entry(class_session_id, status, created_at, id);
