-- A browser retry must not create a second reservation. The opaque key is
-- scoped to the registration draft and intentionally has no business meaning.

ALTER TABLE registration_draft ADD COLUMN submission_idempotency_key TEXT;

CREATE UNIQUE INDEX idx_registration_draft_submission_idempotency
  ON registration_draft(submission_idempotency_key)
  WHERE submission_idempotency_key IS NOT NULL;
