-- Sanitized staff Outbox snapshots and the small admin-only internal archive list.
-- Raw message bodies and bearer tokens are never persisted for Outbox display.

ALTER TABLE outbound_email ADD COLUMN email_sensitivity TEXT
  CHECK (email_sensitivity IN ('archive_bcc_safe', 'sensitive_capability'));
ALTER TABLE outbound_email ADD COLUMN outbox_subject TEXT;
ALTER TABLE outbound_email ADD COLUMN outbox_text TEXT;
ALTER TABLE outbound_email ADD COLUMN bcc_recipients_json TEXT
  CHECK (bcc_recipients_json IS NULL OR json_valid(bcc_recipients_json));

CREATE TABLE email_archive_bcc_setting (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  recipients_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(recipients_json)),
  updated_at TEXT NOT NULL
);

INSERT INTO email_archive_bcc_setting (singleton, recipients_json, updated_at)
VALUES (1, '[]', '2026-09-01T00:00:00.000Z');

CREATE INDEX idx_outbound_email_outbox_recent
  ON outbound_email(queued_at DESC, id DESC);
