-- A plain waitlist entry never occupies a class seat. A separate offer is the
-- durable, capacity-consuming state while a family is deciding.
CREATE TABLE waitlist_offer_response_setting (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  response_minutes INTEGER NOT NULL CHECK (response_minutes BETWEEN 1 AND 10080),
  updated_at TEXT NOT NULL
);

INSERT INTO waitlist_offer_response_setting (singleton, response_minutes, updated_at)
VALUES (1, 1440, '2026-08-23T00:00:00.000Z');

CREATE TABLE waitlist_seat_offer (
  id TEXT PRIMARY KEY,
  waitlist_entry_id TEXT NOT NULL UNIQUE REFERENCES registration_draft_waitlist_entry(id) ON DELETE RESTRICT,
  registration_draft_child_id TEXT NOT NULL REFERENCES registration_draft_child(id) ON DELETE RESTRICT,
  class_session_id TEXT NOT NULL REFERENCES class_session(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active', 'awaiting_transfer', 'converted', 'declined', 'closed')),
  response_token_hash TEXT NOT NULL UNIQUE,
  offered_at TEXT NOT NULL,
  respond_by_at TEXT NOT NULL,
  resolved_at TEXT,
  decision_source TEXT CHECK (decision_source IN ('parent_link', 'staff_phone', 'staff_messenger', 'staff_other')),
  close_reason TEXT,
  contact_last_at TEXT,
  contact_last_channel TEXT CHECK (contact_last_channel IS NULL OR contact_last_channel IN ('phone', 'messenger', 'other')),
  contact_last_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  is_test INTEGER NOT NULL DEFAULT 1 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (respond_by_at > offered_at),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE INDEX idx_waitlist_offer_capacity
  ON waitlist_seat_offer(class_session_id, status, offered_at);
CREATE INDEX idx_waitlist_offer_response
  ON waitlist_seat_offer(response_token_hash, status);
CREATE INDEX idx_waitlist_offer_due
  ON waitlist_seat_offer(status, respond_by_at);
