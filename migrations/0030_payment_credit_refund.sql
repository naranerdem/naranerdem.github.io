-- Money received for a reservation that is later released remains auditable
-- available credit until staff explicitly reallocates or refunds it.
CREATE TABLE payment_credit (
  id TEXT PRIMARY KEY,
  received_payment_id TEXT NOT NULL UNIQUE REFERENCES received_payment(id) ON DELETE RESTRICT,
  payment_request_id TEXT NOT NULL REFERENCES payment_request(id) ON DELETE RESTRICT,
  available_amount_mnt INTEGER NOT NULL CHECK (available_amount_mnt > 0),
  status TEXT NOT NULL CHECK (status IN ('available', 'refunded', 'allocated')),
  refunded_at TEXT,
  refunded_by_staff_account_id TEXT REFERENCES staff_account(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 1 CHECK (is_test IN (0, 1)),
  test_run_id TEXT,
  CHECK (test_run_id IS NULL OR is_test = 1)
);

CREATE INDEX idx_payment_credit_status ON payment_credit(status, created_at);
