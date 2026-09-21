-- A class can remain configured while its recurring timetable is deliberately
-- not offered. This is distinct from registration availability and public
-- catalog visibility, which remain separately controlled operational states.
ALTER TABLE class_session
  ADD COLUMN schedule_state TEXT NOT NULL DEFAULT 'active'
  CHECK (schedule_state IN ('active', 'removed'));

CREATE INDEX idx_class_session_schedule_state
  ON class_session(schedule_state, academic_year_id, activity_offering_id);

-- Calendar rows are configuration, not customer history. A removed and
-- otherwise unused class may therefore be deleted after the service creates
-- this short-lived context. Existing published-revision protection remains in
-- force for every other path.
CREATE TABLE unused_class_deletion_context (
  class_session_id TEXT PRIMARY KEY REFERENCES class_session(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

DROP TRIGGER prevent_non_draft_calendar_revision_identity_update;
CREATE TRIGGER prevent_non_draft_calendar_revision_identity_update
BEFORE UPDATE OF class_calendar_id, curriculum_program_id, revision_number, first_candidate_date, locked_through_sequence, based_on_revision_id ON class_calendar_revision
WHEN OLD.status != 'draft'
  AND NOT EXISTS (
    SELECT 1 FROM unused_offering_deletion_context AS context
    INNER JOIN class_calendar ON class_calendar.id = OLD.class_calendar_id
    INNER JOIN class_session ON class_session.id = class_calendar.class_session_id
    WHERE context.activity_offering_id = class_session.activity_offering_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM unused_class_deletion_context AS context
    INNER JOIN class_calendar ON class_calendar.id = OLD.class_calendar_id
    WHERE context.class_session_id = class_calendar.class_session_id
  )
BEGIN
  SELECT RAISE(ABORT, 'published calendar revision identity is immutable');
END;

DROP TRIGGER prevent_published_calendar_revision_draft_reopen;
CREATE TRIGGER prevent_published_calendar_revision_draft_reopen
BEFORE UPDATE OF status ON class_calendar_revision
WHEN OLD.status = 'published' AND NEW.status NOT IN ('published', 'superseded', 'archived')
  AND NOT EXISTS (
    SELECT 1 FROM unused_offering_deletion_context AS context
    INNER JOIN class_calendar ON class_calendar.id = OLD.class_calendar_id
    INNER JOIN class_session ON class_session.id = class_calendar.class_session_id
    WHERE context.activity_offering_id = class_session.activity_offering_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM unused_class_deletion_context AS context
    INNER JOIN class_calendar ON class_calendar.id = OLD.class_calendar_id
    WHERE context.class_session_id = class_calendar.class_session_id
  )
BEGIN
  SELECT RAISE(ABORT, 'published calendar revision cannot return to draft');
END;

DROP TRIGGER prevent_non_draft_calendar_revision_delete;
CREATE TRIGGER prevent_non_draft_calendar_revision_delete
BEFORE DELETE ON class_calendar_revision
WHEN OLD.status != 'draft'
  AND NOT EXISTS (
    SELECT 1 FROM unused_offering_deletion_context AS context
    INNER JOIN class_calendar ON class_calendar.id = OLD.class_calendar_id
    INNER JOIN class_session ON class_session.id = class_calendar.class_session_id
    WHERE context.activity_offering_id = class_session.activity_offering_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM unused_class_deletion_context AS context
    INNER JOIN class_calendar ON class_calendar.id = OLD.class_calendar_id
    WHERE context.class_session_id = class_calendar.class_session_id
  )
BEGIN
  SELECT RAISE(ABORT, 'published calendar revision cannot be deleted');
END;

-- These guards close the gap between a staff review and the final durable
-- write. They intentionally protect only new commitments; historical rows
-- remain readable after a class is removed from the active timetable.
CREATE TRIGGER prevent_inactive_class_registration_draft_selection_insert
BEFORE INSERT ON registration_draft_child
WHEN NEW.selected_class_session_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM class_session WHERE id = NEW.selected_class_session_id AND schedule_state = 'active')
BEGIN
  SELECT RAISE(ABORT, 'inactive class cannot accept registration');
END;

CREATE TRIGGER prevent_inactive_class_registration_draft_selection_update
BEFORE UPDATE OF selected_class_session_id ON registration_draft_child
WHEN NEW.selected_class_session_id IS NOT NULL
  AND NEW.selected_class_session_id IS NOT OLD.selected_class_session_id
  AND NOT EXISTS (SELECT 1 FROM class_session WHERE id = NEW.selected_class_session_id AND schedule_state = 'active')
BEGIN
  SELECT RAISE(ABORT, 'inactive class cannot accept registration');
END;

CREATE TRIGGER prevent_inactive_class_registration_draft_waitlist_insert
BEFORE INSERT ON registration_draft_waitlist_entry
WHEN NOT EXISTS (SELECT 1 FROM class_session WHERE id = NEW.class_session_id AND schedule_state = 'active')
BEGIN
  SELECT RAISE(ABORT, 'inactive class cannot accept waitlist commitment');
END;

CREATE TRIGGER prevent_inactive_class_application_child_insert
BEFORE INSERT ON application_child
WHEN NEW.selected_class_session_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM class_session WHERE id = NEW.selected_class_session_id AND schedule_state = 'active')
BEGIN
  SELECT RAISE(ABORT, 'inactive class cannot accept registration');
END;

CREATE TRIGGER prevent_inactive_class_hold_insert
BEFORE INSERT ON registration_capacity_hold
WHEN NOT EXISTS (SELECT 1 FROM class_session WHERE id = NEW.class_session_id AND schedule_state = 'active')
BEGIN
  SELECT RAISE(ABORT, 'inactive class cannot accept payment commitment');
END;

CREATE TRIGGER prevent_inactive_class_enrollment_insert
BEFORE INSERT ON enrollment
WHEN NOT EXISTS (SELECT 1 FROM class_session WHERE id = NEW.class_session_id AND schedule_state = 'active')
BEGIN
  SELECT RAISE(ABORT, 'inactive class cannot accept enrollment');
END;

CREATE TRIGGER prevent_inactive_class_enrollment_transfer_update
BEFORE UPDATE OF class_session_id ON enrollment
WHEN NEW.class_session_id IS NOT OLD.class_session_id
  AND NOT EXISTS (SELECT 1 FROM class_session WHERE id = NEW.class_session_id AND schedule_state = 'active')
BEGIN
  SELECT RAISE(ABORT, 'inactive class cannot accept enrollment');
END;

CREATE TRIGGER prevent_inactive_class_transfer_reservation_insert
BEFORE INSERT ON class_transfer_target_reservation
WHEN NOT EXISTS (SELECT 1 FROM class_session WHERE id = NEW.class_session_id AND schedule_state = 'active')
BEGIN
  SELECT RAISE(ABORT, 'inactive class cannot accept transfer reservation');
END;

CREATE TRIGGER prevent_inactive_class_waitlist_offer_insert
BEFORE INSERT ON waitlist_seat_offer
WHEN NOT EXISTS (SELECT 1 FROM class_session WHERE id = NEW.class_session_id AND schedule_state = 'active')
BEGIN
  SELECT RAISE(ABORT, 'inactive class cannot accept waitlist offer');
END;

CREATE TRIGGER prevent_inactive_class_waitlist_entry_insert
BEFORE INSERT ON waitlist_entry
WHEN NOT EXISTS (SELECT 1 FROM class_session WHERE id = NEW.class_session_id AND schedule_state = 'active')
BEGIN
  SELECT RAISE(ABORT, 'inactive class cannot accept waitlist commitment');
END;

CREATE TRIGGER prevent_inactive_class_makeup_target_insert
BEFORE INSERT ON course_makeup_assignment
WHEN NEW.target_kind = 'normal_class'
  AND NOT EXISTS (SELECT 1 FROM class_session WHERE id = NEW.target_class_session_id AND schedule_state = 'active')
BEGIN
  SELECT RAISE(ABORT, 'inactive class cannot accept make-up booking');
END;

CREATE TRIGGER prevent_inactive_class_makeup_target_update
BEFORE UPDATE OF target_kind, target_class_session_id ON course_makeup_assignment
WHEN NEW.target_kind = 'normal_class'
  AND NOT EXISTS (SELECT 1 FROM class_session WHERE id = NEW.target_class_session_id AND schedule_state = 'active')
BEGIN
  SELECT RAISE(ABORT, 'inactive class cannot accept make-up booking');
END;
