-- A late referral can be historically valid even when both referral benefits
-- were already paid outside the application. Keep that fact separate from
-- payment credit and active discounts so it cannot change tuition or create
-- spendable credit.
CREATE TABLE late_referral_external_settlement_operation (
  id TEXT PRIMARY KEY,
  referred_registration_draft_child_id TEXT NOT NULL UNIQUE REFERENCES registration_draft_child(id) ON DELETE RESTRICT,
  referral_code_id TEXT NOT NULL REFERENCES enrollment_referral_code(id) ON DELETE RESTRICT,
  referring_enrollment_id TEXT NOT NULL REFERENCES enrollment(id) ON DELETE RESTRICT,
  -- The guarded batch creates the canonical referral immediately after this
  -- operation row. Keep the durable identifier without a forward FK so D1
  -- can use the operation insert as its all-or-nothing stale-review gate.
  referral_id TEXT NOT NULL UNIQUE,
  review_fingerprint TEXT NOT NULL,
  recorded_by_staff_account_id TEXT NOT NULL REFERENCES staff_account(id) ON DELETE RESTRICT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE TABLE late_referral_external_settlement (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES late_referral_external_settlement_operation(id) ON DELETE RESTRICT,
  referral_id TEXT NOT NULL REFERENCES referral(id) ON DELETE RESTRICT,
  beneficiary_registration_draft_child_id TEXT NOT NULL REFERENCES registration_draft_child(id) ON DELETE RESTRICT,
  benefit_type TEXT NOT NULL CHECK (benefit_type IN ('referred_child', 'referrer')),
  entitlement_base_mnt INTEGER NOT NULL CHECK (entitlement_base_mnt > 0),
  entitlement_basis_points INTEGER NOT NULL CHECK (entitlement_basis_points BETWEEN 1 AND 10000),
  entitlement_amount_mnt INTEGER NOT NULL CHECK (entitlement_amount_mnt > 0),
  external_refund_amount_mnt INTEGER NOT NULL CHECK (external_refund_amount_mnt > 0),
  external_refunded_at TEXT NOT NULL,
  external_refund_method TEXT NOT NULL CHECK (external_refund_method IN ('cash', 'bank_transfer', 'other')),
  external_paid_by_note TEXT,
  external_reference TEXT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  recorded_by_staff_account_id TEXT NOT NULL REFERENCES staff_account(id) ON DELETE RESTRICT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (test_run_id IS NULL OR is_test = 1),
  UNIQUE (referral_id, benefit_type),
  UNIQUE (operation_id, benefit_type)
);

CREATE INDEX idx_late_referral_external_settlement_beneficiary
  ON late_referral_external_settlement(beneficiary_registration_draft_child_id, created_at);
