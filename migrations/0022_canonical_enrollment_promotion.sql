-- Canonical enrollment promotion keeps paid draft reservations safe while
-- creating the long-lived guardian, student, application, and enrollment rows.
-- Draft waitlist entries remain the sole FIFO authority for now; they gain a
-- link to the canonical application rather than being duplicated.

ALTER TABLE registration_draft ADD COLUMN canonical_guardian_account_id TEXT
  REFERENCES guardian_account(id) ON DELETE RESTRICT;
ALTER TABLE registration_draft ADD COLUMN canonical_pre_registration_id TEXT
  REFERENCES pre_registration(id) ON DELETE RESTRICT;
ALTER TABLE registration_draft ADD COLUMN guardian_resolution_status TEXT NOT NULL DEFAULT 'not_eligible'
  CHECK (guardian_resolution_status IN ('not_eligible', 'resolved', 'needs_review', 'failed'));

ALTER TABLE registration_draft_child ADD COLUMN canonical_student_id TEXT
  REFERENCES student(id) ON DELETE RESTRICT;
ALTER TABLE registration_draft_child ADD COLUMN canonical_application_child_id TEXT
  REFERENCES application_child(id) ON DELETE RESTRICT;
ALTER TABLE registration_draft_child ADD COLUMN canonical_enrollment_id TEXT
  REFERENCES enrollment(id) ON DELETE RESTRICT;
ALTER TABLE registration_draft_child ADD COLUMN identity_resolution_status TEXT NOT NULL DEFAULT 'not_eligible'
  CHECK (identity_resolution_status IN (
    'not_eligible', 'auto_resolved', 'needs_identity_review',
    'manual_existing', 'manual_new', 'promoted', 'failed'
  ));
ALTER TABLE registration_draft_child ADD COLUMN promotion_status TEXT NOT NULL DEFAULT 'not_eligible'
  CHECK (promotion_status IN ('not_eligible', 'pending', 'promoted', 'failed'));

ALTER TABLE pre_registration ADD COLUMN parent_rules_version TEXT;
ALTER TABLE pre_registration ADD COLUMN student_rules_version TEXT;

ALTER TABLE payment_installment ADD COLUMN canonical_application_child_id TEXT
  REFERENCES application_child(id) ON DELETE SET NULL;
ALTER TABLE payment_installment ADD COLUMN canonical_enrollment_id TEXT
  REFERENCES enrollment(id) ON DELETE SET NULL;

ALTER TABLE registration_draft_waitlist_entry ADD COLUMN canonical_application_child_id TEXT
  REFERENCES application_child(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX idx_registration_draft_canonical_pre_registration
  ON registration_draft(canonical_pre_registration_id)
  WHERE canonical_pre_registration_id IS NOT NULL;
CREATE UNIQUE INDEX idx_registration_draft_child_canonical_application
  ON registration_draft_child(canonical_application_child_id)
  WHERE canonical_application_child_id IS NOT NULL;
CREATE UNIQUE INDEX idx_registration_draft_child_canonical_enrollment
  ON registration_draft_child(canonical_enrollment_id)
  WHERE canonical_enrollment_id IS NOT NULL;
CREATE INDEX idx_registration_draft_child_identity_review
  ON registration_draft_child(identity_resolution_status, promotion_status, initial_payment_reconciled_at);
CREATE INDEX idx_payment_installment_canonical_enrollment
  ON payment_installment(canonical_enrollment_id, status);
CREATE INDEX idx_registration_draft_waitlist_canonical_application
  ON registration_draft_waitlist_entry(canonical_application_child_id, status);
