-- New registrations reserve their initial-payment seat immediately. Email
-- verification remains a separate contact-channel fact on registration_draft.
-- Existing provisional-email rows retain their original lifecycle semantics.

ALTER TABLE payment_collection_settings ADD COLUMN iban TEXT;
ALTER TABLE payment_request ADD COLUMN transfer_description TEXT;

CREATE INDEX idx_payment_request_transfer_description
  ON payment_request(transfer_description, created_at);
