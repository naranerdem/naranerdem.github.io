-- A pending additional-class admission needs a short, durable confirmation
-- claim.  These fields are coordination state only: activated_at remains the
-- historical timestamp at which the promised awards actually activated.
ALTER TABLE additional_class_admission ADD COLUMN confirmation_claim_id TEXT;
ALTER TABLE additional_class_admission ADD COLUMN confirmation_claimed_at TEXT;
ALTER TABLE additional_class_admission ADD COLUMN confirmation_claim_expires_at TEXT;
ALTER TABLE additional_class_admission ADD COLUMN confirmation_fence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE additional_class_admission ADD COLUMN confirmation_last_error_code TEXT;
ALTER TABLE additional_class_admission ADD COLUMN confirmation_last_error_at TEXT;

CREATE INDEX idx_additional_class_admission_confirmation_claim
  ON additional_class_admission(status, confirmation_claim_expires_at);

-- Staging builds before this migration temporarily stored a confirmation lease
-- in activated_at. Pending admissions have not activated their award promise,
-- so clear only those overloaded values. Confirmed activation history stays
-- untouched.
UPDATE additional_class_admission
  SET activated_at = NULL
  WHERE status = 'pending_confirmation' AND activated_at IS NOT NULL;
