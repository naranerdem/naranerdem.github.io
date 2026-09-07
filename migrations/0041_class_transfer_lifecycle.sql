-- A guarded class transfer keeps the confirmed source enrollment active until
-- a separately reserved target can be completed. It is deliberately distinct
-- from cancellation, waitlist offers, and ordinary registration holds.

ALTER TABLE enrollment ADD COLUMN transferred_out_at TEXT;
ALTER TABLE enrollment ADD COLUMN superseded_by_transfer_id TEXT;

CREATE TABLE class_transfer (
  id TEXT PRIMARY KEY,
  source_enrollment_id TEXT NOT NULL REFERENCES enrollment(id) ON DELETE RESTRICT,
  source_application_child_id TEXT NOT NULL REFERENCES application_child(id) ON DELETE RESTRICT,
  source_class_session_id TEXT NOT NULL REFERENCES class_session(id) ON DELETE RESTRICT,
  target_class_session_id TEXT NOT NULL REFERENCES class_session(id) ON DELETE RESTRICT,
  target_enrollment_id TEXT REFERENCES enrollment(id) ON DELETE RESTRICT,
  target_application_child_id TEXT REFERENCES application_child(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending_difference', 'ready_to_complete', 'completed', 'declined', 'closed')),
  reason TEXT NOT NULL,
  created_by_staff_account_id TEXT NOT NULL REFERENCES staff_account(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  source_payment_plan_code TEXT,
  target_payment_plan_code TEXT,
  source_pricing_snapshot_json TEXT NOT NULL,
  target_pricing_snapshot_json TEXT NOT NULL,
  source_effective_charge_mnt INTEGER NOT NULL CHECK (source_effective_charge_mnt >= 0),
  target_effective_charge_mnt INTEGER NOT NULL CHECK (target_effective_charge_mnt >= 0),
  recognized_paid_mnt INTEGER NOT NULL CHECK (recognized_paid_mnt >= 0),
  required_difference_mnt INTEGER NOT NULL CHECK (required_difference_mnt >= 0),
  resulting_credit_mnt INTEGER NOT NULL CHECK (resulting_credit_mnt >= 0),
  ready_at TEXT,
  completed_at TEXT,
  declined_at TEXT,
  closed_at TEXT,
  close_reason TEXT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (source_class_session_id != target_class_session_id),
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE UNIQUE INDEX idx_class_transfer_one_active_source
  ON class_transfer(source_enrollment_id)
  WHERE status IN ('pending_difference', 'ready_to_complete');
CREATE INDEX idx_class_transfer_target_status
  ON class_transfer(target_class_session_id, status, created_at);
CREATE INDEX idx_class_transfer_source_status
  ON class_transfer(source_enrollment_id, status, created_at);

CREATE TABLE class_transfer_target_reservation (
  id TEXT PRIMARY KEY,
  class_transfer_id TEXT NOT NULL UNIQUE REFERENCES class_transfer(id) ON DELETE RESTRICT,
  class_session_id TEXT NOT NULL REFERENCES class_session(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'released')),
  resolved_at TEXT,
  released_at TEXT,
  release_reason TEXT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE UNIQUE INDEX idx_class_transfer_target_active_seat
  ON class_transfer_target_reservation(class_transfer_id)
  WHERE status = 'active';
CREATE INDEX idx_class_transfer_reservation_capacity
  ON class_transfer_target_reservation(class_session_id, status, created_at);

CREATE TABLE class_transfer_payment_obligation (
  id TEXT PRIMARY KEY,
  class_transfer_id TEXT NOT NULL UNIQUE REFERENCES class_transfer(id) ON DELETE RESTRICT,
  amount_mnt INTEGER NOT NULL CHECK (amount_mnt > 0),
  received_amount_mnt INTEGER NOT NULL DEFAULT 0 CHECK (received_amount_mnt >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'partially_paid', 'paid', 'released')),
  paid_at TEXT,
  released_at TEXT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE TABLE class_transfer_payment (
  id TEXT PRIMARY KEY,
  class_transfer_payment_obligation_id TEXT NOT NULL REFERENCES class_transfer_payment_obligation(id) ON DELETE RESTRICT,
  received_payment_id TEXT NOT NULL UNIQUE REFERENCES received_payment(id) ON DELETE RESTRICT,
  allocated_amount_mnt INTEGER NOT NULL CHECK (allocated_amount_mnt > 0),
  allocated_at TEXT NOT NULL,
  allocated_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE TABLE class_transfer_credit (
  id TEXT PRIMARY KEY,
  class_transfer_id TEXT NOT NULL UNIQUE REFERENCES class_transfer(id) ON DELETE RESTRICT,
  available_amount_mnt INTEGER NOT NULL CHECK (available_amount_mnt > 0),
  status TEXT NOT NULL CHECK (status IN ('available', 'refunded', 'allocated')),
  refunded_at TEXT,
  refunded_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE INDEX idx_class_transfer_credit_status ON class_transfer_credit(status, created_at);
CREATE INDEX idx_enrollment_current_class ON enrollment(class_session_id, status, transferred_out_at);
