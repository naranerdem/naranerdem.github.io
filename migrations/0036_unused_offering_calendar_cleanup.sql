-- A wholly unused Offering may be removed together with planning-only calendar
-- history. The short-lived context is created only by the guarded aggregate
-- deletion service and is removed in the same D1 batch.
CREATE TABLE unused_offering_deletion_context (
  activity_offering_id TEXT PRIMARY KEY REFERENCES activity_offering(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

DROP TRIGGER prevent_non_draft_calendar_revision_identity_update;
CREATE TRIGGER prevent_non_draft_calendar_revision_identity_update
BEFORE UPDATE OF class_calendar_id, curriculum_program_id, revision_number, first_candidate_date, locked_through_sequence, based_on_revision_id ON class_calendar_revision
WHEN OLD.status != 'draft'
  AND NOT EXISTS (
    SELECT 1
    FROM unused_offering_deletion_context AS context
    INNER JOIN class_calendar ON class_calendar.id = OLD.class_calendar_id
    INNER JOIN class_session ON class_session.id = class_calendar.class_session_id
    WHERE context.activity_offering_id = class_session.activity_offering_id
  )
BEGIN
  SELECT RAISE(ABORT, 'published calendar revision identity is immutable');
END;

DROP TRIGGER prevent_published_calendar_revision_draft_reopen;
CREATE TRIGGER prevent_published_calendar_revision_draft_reopen
BEFORE UPDATE OF status ON class_calendar_revision
WHEN OLD.status = 'published' AND NEW.status NOT IN ('published', 'superseded', 'archived')
  AND NOT EXISTS (
    SELECT 1
    FROM unused_offering_deletion_context AS context
    INNER JOIN class_calendar ON class_calendar.id = OLD.class_calendar_id
    INNER JOIN class_session ON class_session.id = class_calendar.class_session_id
    WHERE context.activity_offering_id = class_session.activity_offering_id
  )
BEGIN
  SELECT RAISE(ABORT, 'published calendar revision cannot return to draft');
END;

DROP TRIGGER prevent_non_draft_calendar_revision_delete;
CREATE TRIGGER prevent_non_draft_calendar_revision_delete
BEFORE DELETE ON class_calendar_revision
WHEN OLD.status != 'draft'
  AND NOT EXISTS (
    SELECT 1
    FROM unused_offering_deletion_context AS context
    INNER JOIN class_calendar ON class_calendar.id = OLD.class_calendar_id
    INNER JOIN class_session ON class_session.id = class_calendar.class_session_id
    WHERE context.activity_offering_id = class_session.activity_offering_id
  )
BEGIN
  SELECT RAISE(ABORT, 'published calendar revision cannot be deleted');
END;
