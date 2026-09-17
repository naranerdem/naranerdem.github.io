-- Normal make-up visits consume a seat for one exact target lesson. Keep the
-- trigger aligned with the shared class-capacity projection: confirmed and
-- legacy enrollments, active draft holds, active waitlist offers, and active
-- transfer reservations each consume capacity before a make-up can be booked.
-- Migration 0018 used raw enrollment counts and therefore disagreed with the
-- public/staff capacity projection.

DROP TRIGGER IF EXISTS validate_course_makeup_normal_capacity_insert;

CREATE TRIGGER validate_course_makeup_normal_capacity_insert
BEFORE INSERT ON course_makeup_assignment
WHEN NEW.status = 'active'
  AND NEW.target_kind = 'normal_class'
  AND (
    SELECT capacity FROM class_session WHERE id = NEW.target_class_session_id
  ) <= (
    SELECT COUNT(*) FROM enrollment
      INNER JOIN application_child ON application_child.id = enrollment.application_child_id
      INNER JOIN pre_registration ON pre_registration.id = application_child.pre_registration_id
      WHERE enrollment.class_session_id = NEW.target_class_session_id
        AND enrollment.status = 'confirmed'
        AND enrollment.transferred_out_at IS NULL
        AND application_child.status = 'enrolled'
        AND pre_registration.deleted_at IS NULL
  ) + (
    SELECT COUNT(*) FROM enrollment
      INNER JOIN application_child ON application_child.id = enrollment.application_child_id
      INNER JOIN pre_registration ON pre_registration.id = application_child.pre_registration_id
      WHERE enrollment.class_session_id = NEW.target_class_session_id
        AND enrollment.status = 'awaiting_initial_payment'
        AND application_child.status = 'hold_created'
        AND pre_registration.deleted_at IS NULL
  ) + (
    SELECT COUNT(*) FROM registration_capacity_hold
      LEFT JOIN registration_draft_child ON registration_draft_child.id = registration_capacity_hold.registration_draft_child_id
      WHERE registration_capacity_hold.class_session_id = NEW.target_class_session_id
        AND registration_capacity_hold.status = 'active'
        AND (registration_capacity_hold.hold_type = 'initial_payment'
          OR registration_capacity_hold.deadline_at > datetime('now'))
        AND registration_draft_child.canonical_enrollment_id IS NULL
  ) + (
    SELECT COUNT(*) FROM waitlist_seat_offer
      WHERE waitlist_seat_offer.class_session_id = NEW.target_class_session_id
        AND waitlist_seat_offer.status IN ('active', 'awaiting_transfer')
  ) + (
    SELECT COUNT(*) FROM class_transfer_target_reservation
      WHERE class_transfer_target_reservation.class_session_id = NEW.target_class_session_id
        AND class_transfer_target_reservation.status = 'active'
  ) + (
    SELECT COUNT(*) FROM course_makeup_assignment
      WHERE target_kind = 'normal_class'
        AND target_class_session_id = NEW.target_class_session_id
        AND target_curriculum_lesson_id = NEW.target_curriculum_lesson_id
        AND status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'make-up target capacity is full');
END;
