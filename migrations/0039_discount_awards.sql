-- Typed future-award policy and an auditable discount ledger. Raw pricing and
-- received-payment records remain immutable; effective obligations are derived
-- from active awards.
CREATE TABLE discount_policy_setting (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  family_multi_child_basis_points INTEGER NOT NULL CHECK (family_multi_child_basis_points BETWEEN 0 AND 10000),
  referrer_basis_points INTEGER NOT NULL CHECK (referrer_basis_points BETWEEN 0 AND 10000),
  referred_child_basis_points INTEGER NOT NULL CHECK (referred_child_basis_points BETWEEN 0 AND 10000),
  updated_at TEXT NOT NULL
);

INSERT INTO discount_policy_setting (
  singleton, family_multi_child_basis_points, referrer_basis_points, referred_child_basis_points, updated_at
) VALUES (1, 1000, 500, 200, '2026-09-03T00:00:00.000Z');

CREATE TABLE discount_award (
  id TEXT PRIMARY KEY,
  registration_draft_child_id TEXT NOT NULL REFERENCES registration_draft_child(id) ON DELETE RESTRICT,
  beneficiary_enrollment_id TEXT REFERENCES enrollment(id) ON DELETE RESTRICT,
  award_type TEXT NOT NULL CHECK (award_type IN ('family_multi_child', 'referral_referred', 'referral_referrer')),
  source_registration_draft_child_id TEXT REFERENCES registration_draft_child(id) ON DELETE RESTRICT,
  source_referral_id TEXT REFERENCES referral(id) ON DELETE RESTRICT,
  basis_points INTEGER NOT NULL CHECK (basis_points BETWEEN 1 AND 10000),
  base_amount_mnt INTEGER NOT NULL CHECK (base_amount_mnt > 0),
  award_amount_mnt INTEGER NOT NULL CHECK (award_amount_mnt > 0),
  applied_amount_mnt INTEGER NOT NULL DEFAULT 0 CHECK (applied_amount_mnt >= 0),
  credit_amount_mnt INTEGER NOT NULL DEFAULT 0 CHECK (credit_amount_mnt >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'reversed')),
  reason TEXT NOT NULL,
  awarded_at TEXT NOT NULL,
  reversed_at TEXT,
  reversed_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  reversal_reason TEXT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (test_run_id IS NULL OR is_test = 1),
  CHECK (applied_amount_mnt + credit_amount_mnt <= award_amount_mnt)
);

CREATE UNIQUE INDEX idx_discount_award_family_once
  ON discount_award(registration_draft_child_id)
  WHERE award_type = 'family_multi_child';
CREATE UNIQUE INDEX idx_discount_award_referred_once
  ON discount_award(registration_draft_child_id)
  WHERE award_type = 'referral_referred';
CREATE UNIQUE INDEX idx_discount_award_referrer_once
  ON discount_award(source_referral_id)
  WHERE award_type = 'referral_referrer' AND source_referral_id IS NOT NULL;
CREATE INDEX idx_discount_award_child_status
  ON discount_award(registration_draft_child_id, status, awarded_at);
