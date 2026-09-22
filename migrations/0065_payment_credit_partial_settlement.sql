-- A released-payment credit is refundable cash, not a discount award.  Keep
-- its original receipt amount immutable while tracking the unrefunded and
-- untransferred remainder for partial staff settlements.
ALTER TABLE payment_credit ADD COLUMN remaining_amount_mnt INTEGER;

UPDATE payment_credit
SET remaining_amount_mnt = CASE WHEN status = 'available' THEN available_amount_mnt ELSE 0 END
WHERE remaining_amount_mnt IS NULL;

CREATE INDEX idx_payment_credit_available_remainder
  ON payment_credit(status, remaining_amount_mnt, created_at);

-- This deliberately remains nullable for the old-Worker/new-schema interval.
-- The compatible Worker always writes a bounded value; the old Worker can
-- still complete its existing all-or-nothing release/refund lifecycle.
CREATE TRIGGER payment_credit_remaining_amount_bounds_insert
BEFORE INSERT ON payment_credit
WHEN NEW.remaining_amount_mnt IS NOT NULL
  AND (NEW.remaining_amount_mnt < 0 OR NEW.remaining_amount_mnt > NEW.available_amount_mnt)
BEGIN
  SELECT RAISE(ABORT, 'payment_credit remaining amount is out of range');
END;

CREATE TRIGGER payment_credit_remaining_amount_bounds_update
BEFORE UPDATE OF remaining_amount_mnt ON payment_credit
WHEN NEW.remaining_amount_mnt IS NOT NULL
  AND (NEW.remaining_amount_mnt < 0 OR NEW.remaining_amount_mnt > NEW.available_amount_mnt)
BEGIN
  SELECT RAISE(ABORT, 'payment_credit remaining amount is out of range');
END;
