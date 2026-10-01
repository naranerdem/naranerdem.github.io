-- A reminder can be cancelled until a durable provider-send authorization is
-- recorded. The marker preserves the unavoidable in-flight boundary: a later
-- cancellation never pretends that an already-authorized email was recalled.
ALTER TABLE outbound_email ADD COLUMN delivery_authorized_at TEXT;

CREATE INDEX idx_outbound_email_delivery_authorization
  ON outbound_email(delivery_authorized_at, status)
  WHERE delivery_authorized_at IS NOT NULL;
