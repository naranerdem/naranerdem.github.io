-- Course pricing is owned by the annual/summer Offering. Registration drafts
-- retain a per-child snapshot so later price edits only affect new requests.
CREATE TABLE offering_course_pricing (
  activity_offering_id TEXT PRIMARY KEY REFERENCES activity_offering(id) ON DELETE RESTRICT,
  one_time_amount_mnt INTEGER NOT NULL CHECK (one_time_amount_mnt > 0),
  two_installment_enabled INTEGER NOT NULL DEFAULT 0 CHECK (two_installment_enabled IN (0, 1)),
  first_installment_amount_mnt INTEGER,
  second_installment_amount_mnt INTEGER,
  second_installment_due_on TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (two_installment_enabled = 0
      AND first_installment_amount_mnt IS NULL
      AND second_installment_amount_mnt IS NULL
      AND second_installment_due_on IS NULL)
    OR
    (two_installment_enabled = 1
      AND first_installment_amount_mnt > 0
      AND second_installment_amount_mnt > 0
      AND length(second_installment_due_on) = 10)
  )
);

CREATE TABLE payment_collection_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  bank_name TEXT,
  account_holder_name TEXT,
  account_number TEXT,
  transfer_instruction TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO payment_collection_settings (
  singleton, bank_name, account_holder_name, account_number, transfer_instruction, updated_at
) VALUES (1, NULL, NULL, NULL, NULL, '2026-08-15T00:00:00.000Z');

ALTER TABLE registration_draft_child ADD COLUMN payment_plan_code TEXT
  CHECK (payment_plan_code IS NULL OR payment_plan_code IN ('single', 'two_installment'));
ALTER TABLE registration_draft_child ADD COLUMN initial_payment_amount_mnt INTEGER
  CHECK (initial_payment_amount_mnt IS NULL OR initial_payment_amount_mnt > 0);
ALTER TABLE registration_draft_child ADD COLUMN second_payment_amount_mnt INTEGER
  CHECK (second_payment_amount_mnt IS NULL OR second_payment_amount_mnt > 0);
ALTER TABLE registration_draft_child ADD COLUMN second_payment_due_on TEXT;

CREATE INDEX idx_offering_course_pricing_updated
  ON offering_course_pricing(updated_at);
