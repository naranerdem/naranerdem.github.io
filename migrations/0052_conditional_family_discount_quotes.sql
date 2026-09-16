-- A discounted family quote is not an earned discount. Existing award rows
-- remain effective until a guarded adoption explicitly classifies them.
CREATE TABLE conditional_family_discount_quote (
  id TEXT PRIMARY KEY,
  registration_draft_child_id TEXT NOT NULL REFERENCES registration_draft_child(id) ON DELETE RESTRICT,
  academic_year_id TEXT NOT NULL REFERENCES academic_year(id) ON DELETE RESTRICT,
  relationship_basis TEXT NOT NULL CHECK (relationship_basis IN ('same_submission', 'guardian', 'family_group', 'same_child_distinct_class')),
  relationship_key TEXT NOT NULL,
  basis_points INTEGER NOT NULL CHECK (basis_points BETWEEN 1 AND 10000),
  base_amount_mnt INTEGER NOT NULL CHECK (base_amount_mnt > 0),
  award_amount_mnt INTEGER NOT NULL CHECK (award_amount_mnt > 0),
  installment_strategy TEXT NOT NULL CHECK (installment_strategy IN ('one_payment', 'final_installment_first')),
  state TEXT NOT NULL CHECK (state IN ('quoted_pending', 'cash_coverage_ready', 'conditionally_confirmed', 'qualified', 'qualification_failed', 'cancelled', 'expired', 'reconciliation_review')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  linked_discount_award_id TEXT REFERENCES discount_award(id) ON DELETE RESTRICT,
  -- A contingent award-credit is never general child credit. It is a reviewed,
  -- quote-revision-bound promise from a qualifying donor directly to this
  -- eligible final installment, consumed only by the protected finalizer.
  contingent_source_quote_id TEXT REFERENCES conditional_family_discount_quote(id) ON DELETE RESTRICT,
  contingent_payment_installment_id TEXT REFERENCES payment_installment(id) ON DELETE RESTRICT,
  contingent_credit_amount_mnt INTEGER CHECK (contingent_credit_amount_mnt IS NULL OR contingent_credit_amount_mnt > 0),
  contingent_reason TEXT,
  contingent_operation_id TEXT UNIQUE,
  contingent_source_revision INTEGER,
  contingent_created_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  conditional_failure_due_at TEXT,
  resolution_reason TEXT,
  claim_id TEXT,
  claim_expires_at TEXT,
  claim_fence INTEGER NOT NULL DEFAULT 0 CHECK (claim_fence >= 0),
  last_error_code TEXT,
  last_error_at TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  updated_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE UNIQUE INDEX idx_conditional_family_discount_quote_current
  ON conditional_family_discount_quote(registration_draft_child_id, relationship_basis, relationship_key)
  WHERE state NOT IN ('cancelled', 'expired');
CREATE INDEX idx_conditional_family_discount_quote_resolution
  ON conditional_family_discount_quote(relationship_basis, relationship_key, state, claim_expires_at);
CREATE INDEX idx_conditional_family_discount_quote_child
  ON conditional_family_discount_quote(registration_draft_child_id, state, updated_at);
CREATE INDEX idx_conditional_family_discount_quote_contingent
  ON conditional_family_discount_quote(contingent_source_quote_id, contingent_payment_installment_id, state);

-- The historical row remains immutable evidence. Its financial effect is
-- explicitly classified only by the new lifecycle or adoption operation.
ALTER TABLE discount_award ADD COLUMN qualification_state TEXT NOT NULL DEFAULT 'earned'
  CHECK (qualification_state IN ('earned', 'provisional', 'failed', 'reconciliation_review'));
ALTER TABLE discount_award ADD COLUMN conditional_quote_id TEXT REFERENCES conditional_family_discount_quote(id) ON DELETE RESTRICT;
CREATE INDEX idx_discount_award_qualification_state
  ON discount_award(qualification_state, conditional_quote_id, status);

-- Reuse the existing staff partial-seat approval lifecycle. These fields bind
-- that approval to the exact conditional quote revision and reason.
ALTER TABLE payment_confirmation ADD COLUMN conditional_quote_id TEXT REFERENCES conditional_family_discount_quote(id) ON DELETE RESTRICT;
ALTER TABLE payment_confirmation ADD COLUMN conditional_quote_revision INTEGER;
ALTER TABLE payment_confirmation ADD COLUMN conditional_quote_reason TEXT;
CREATE INDEX idx_payment_confirmation_conditional_quote
  ON payment_confirmation(conditional_quote_id, status)
  WHERE conditional_quote_id IS NOT NULL;
