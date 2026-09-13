-- The existing archive list remains the admin list. This independent teacher
-- list is resolved at delivery time and then snapshotted on the Outbox row.
ALTER TABLE email_archive_bcc_setting ADD COLUMN teacher_recipients_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(teacher_recipients_json));
