-- A pending additional-class admission may reserve already-available child
-- credit for its selected final installment. The reservation is not a credit
-- application: it is released on terminal non-confirmation and consumed only
-- by the fenced canonical-confirmation continuation.
ALTER TABLE child_credit_entry
  ADD COLUMN reserved_amount_mnt INTEGER NOT NULL DEFAULT 0 CHECK (reserved_amount_mnt >= 0);

ALTER TABLE additional_class_admission
  ADD COLUMN proposed_existing_credit_mnt INTEGER NOT NULL DEFAULT 0 CHECK (proposed_existing_credit_mnt >= 0);
ALTER TABLE additional_class_admission
  ADD COLUMN proposed_source_award_credit_mnt INTEGER NOT NULL DEFAULT 0 CHECK (proposed_source_award_credit_mnt >= 0);
ALTER TABLE additional_class_admission
  ADD COLUMN proposed_credit_installment_number INTEGER;

CREATE TABLE additional_class_credit_reservation (
  id TEXT PRIMARY KEY,
  admission_id TEXT NOT NULL REFERENCES additional_class_admission(id) ON DELETE RESTRICT,
  source_credit_entry_id TEXT REFERENCES child_credit_entry(id) ON DELETE RESTRICT,
  target_payment_installment_id TEXT NOT NULL REFERENCES payment_installment(id) ON DELETE RESTRICT,
  reservation_kind TEXT NOT NULL CHECK (reservation_kind IN ('existing_credit', 'source_award_credit')),
  amount_mnt INTEGER NOT NULL CHECK (amount_mnt > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'released')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  CHECK (test_run_id IS NULL OR is_test = 1),
  CHECK ((reservation_kind = 'existing_credit' AND source_credit_entry_id IS NOT NULL)
    OR (reservation_kind = 'source_award_credit' AND source_credit_entry_id IS NULL))
);

CREATE INDEX idx_additional_class_credit_reservation_admission
  ON additional_class_credit_reservation(admission_id, status);
CREATE INDEX idx_additional_class_credit_reservation_target
  ON additional_class_credit_reservation(target_payment_installment_id, status);
CREATE UNIQUE INDEX idx_additional_class_credit_reservation_pending_root
  ON additional_class_credit_reservation(source_credit_entry_id)
  WHERE status = 'pending' AND source_credit_entry_id IS NOT NULL;
