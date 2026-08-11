-- Staging-first public registration state. Unverified submissions remain
-- separate from canonical guardian, student, pre-registration, and enrollment
-- identity until a later reconciliation workflow is deliberately implemented.

CREATE TABLE registration_draft (
  id TEXT PRIMARY KEY,
  access_token_hash TEXT NOT NULL UNIQUE,
  academic_year_id TEXT NOT NULL REFERENCES academic_year(id) ON DELETE RESTRICT,
  guardian_full_name TEXT NOT NULL,
  guardian_relationship TEXT NOT NULL,
  primary_phone TEXT NOT NULL,
  secondary_phone TEXT,
  email TEXT NOT NULL,
  normalized_email TEXT NOT NULL,
  facebook_name TEXT,
  home_address TEXT NOT NULL,
  payment_plan_code TEXT NOT NULL,
  parent_rules_version TEXT NOT NULL,
  student_rules_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending_email',
    'email_delivery_failed',
    'email_verified',
    'awaiting_initial_payment',
    'waitlisted',
    'seat_unavailable',
    'cancelled',
    'expired'
  )),
  email_last_sent_at TEXT,
  verified_at TEXT,
  expires_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 1 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(access_token_hash) = 64),
  CHECK (length(trim(guardian_full_name)) > 0),
  CHECK (length(trim(primary_phone)) > 0),
  CHECK (length(trim(normalized_email)) > 3),
  CHECK (length(trim(home_address)) > 0),
  CHECK (expires_at > created_at),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE TABLE registration_draft_child (
  id TEXT PRIMARY KEY,
  registration_draft_id TEXT NOT NULL REFERENCES registration_draft(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  surname TEXT NOT NULL,
  given_name TEXT NOT NULL,
  gender TEXT NOT NULL CHECK (gender IN ('female', 'male', 'not_specified')),
  date_of_birth TEXT NOT NULL,
  current_grade TEXT NOT NULL,
  current_school TEXT,
  returning_status TEXT NOT NULL CHECK (returning_status IN ('new', 'returning')),
  previous_stage_code TEXT CHECK (previous_stage_code IS NULL OR previous_stage_code IN ('stage_1', 'stage_2', 'stage_3', 'unknown')),
  selected_stage_code TEXT NOT NULL CHECK (selected_stage_code IN ('stage_1', 'stage_2', 'stage_3')),
  selected_class_session_id TEXT REFERENCES class_session(id) ON DELETE RESTRICT,
  preferred_waitlist_class_session_id TEXT REFERENCES class_session(id) ON DELETE RESTRICT,
  code_input TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'draft',
    'provisional_hold',
    'awaiting_initial_payment',
    'waitlisted',
    'seat_unavailable',
    'cancelled'
  )),
  is_test INTEGER NOT NULL DEFAULT 1 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (registration_draft_id, position),
  CHECK (length(trim(surname)) > 0),
  CHECK (length(trim(given_name)) > 0),
  CHECK (length(date_of_birth) = 10),
  CHECK (selected_class_session_id IS NOT NULL OR preferred_waitlist_class_session_id IS NOT NULL),
  CHECK (preferred_waitlist_class_session_id IS NULL OR preferred_waitlist_class_session_id != selected_class_session_id),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE TABLE registration_capacity_hold (
  id TEXT PRIMARY KEY,
  registration_draft_child_id TEXT NOT NULL UNIQUE REFERENCES registration_draft_child(id) ON DELETE CASCADE,
  class_session_id TEXT NOT NULL REFERENCES class_session(id) ON DELETE RESTRICT,
  hold_type TEXT NOT NULL CHECK (hold_type IN ('provisional_email_confirmation', 'initial_payment')),
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired', 'cancelled')),
  deadline_at TEXT NOT NULL,
  converted_at TEXT,
  released_at TEXT,
  release_reason TEXT,
  is_test INTEGER NOT NULL DEFAULT 1 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (deadline_at > created_at),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE TABLE registration_draft_waitlist_entry (
  id TEXT PRIMARY KEY,
  registration_draft_child_id TEXT NOT NULL UNIQUE REFERENCES registration_draft_child(id) ON DELETE CASCADE,
  class_session_id TEXT NOT NULL REFERENCES class_session(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active', 'offered', 'offer_expired', 'accepted', 'deactivated', 'cancelled')),
  offered_at TEXT,
  offer_expires_at TEXT,
  is_test INTEGER NOT NULL DEFAULT 1 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

ALTER TABLE outbound_email
  ADD COLUMN registration_draft_id TEXT REFERENCES registration_draft(id) ON DELETE SET NULL;

ALTER TABLE email_verification_challenge
  ADD COLUMN registration_draft_id TEXT REFERENCES registration_draft(id) ON DELETE CASCADE;

ALTER TABLE verified_email_session
  ADD COLUMN registration_draft_id TEXT REFERENCES registration_draft(id) ON DELETE CASCADE;

CREATE INDEX idx_registration_draft_email_status
  ON registration_draft(normalized_email, status, expires_at);
CREATE INDEX idx_registration_draft_expiry
  ON registration_draft(expires_at, status);
CREATE INDEX idx_registration_draft_child_draft
  ON registration_draft_child(registration_draft_id, position);
CREATE INDEX idx_registration_capacity_class_deadline
  ON registration_capacity_hold(class_session_id, status, deadline_at);
CREATE INDEX idx_registration_capacity_draft_child
  ON registration_capacity_hold(registration_draft_child_id, hold_type, status);
CREATE INDEX idx_registration_waitlist_fifo
  ON registration_draft_waitlist_entry(class_session_id, status, created_at, id);
CREATE INDEX idx_registration_challenge_draft
  ON email_verification_challenge(registration_draft_id, status, expires_at);
CREATE INDEX idx_verified_email_session_draft
  ON verified_email_session(registration_draft_id, expires_at, revoked_at);
CREATE INDEX idx_outbound_email_registration_draft
  ON outbound_email(registration_draft_id, status, queued_at);
