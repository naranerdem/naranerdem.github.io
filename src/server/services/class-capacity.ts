import type { AppEnvironment, D1Database } from "../env";

export interface ClassCapacityProjection {
  classSessionId: string;
  capacity: number;
  confirmedCount: number;
  reservedInitialPaymentCount: number;
  identityReviewCount: number;
  legacyReservationCount: number;
  offeredWaitlistCount: number;
  waitlistCount: number;
  freeSeats: number;
}

export interface ClassCapacityDiagnostic {
  classSessionId: string;
  classLabel: string;
  capacity: number;
  confirmed: Array<{ enrollmentId: string; childName: string; applicationChildId: string; registrationDraftChildId: string | null; status: string; isTest: number; testRunId: string | null }>;
  reservedInitialPayment: Array<{ holdId: string; registrationDraftChildId: string; childName: string; deadlineAt: string; isTest: number; testRunId: string | null }>;
  legacyReservations: Array<{ enrollmentId: string; applicationChildId: string; status: string; isTest: number; testRunId: string | null }>;
  offeredWaitlist: Array<{ offerId: string; waitlistEntryId: string; childName: string; status: string; isTest: number; testRunId: string | null }>;
  waiting: Array<{ waitlistEntryId: string; childName: string; isTest: number; testRunId: string | null }>;
  projection: ClassCapacityProjection;
}

interface CapacityRow {
  classSessionId: string;
  capacity: number;
  confirmedCount: number;
  reservedInitialPaymentCount: number;
  identityReviewCount: number;
  legacyReservationCount: number;
  offeredWaitlistCount: number;
  waitlistCount: number;
}

// Keep conditional capacity writes on the same definitions as the read
// projection. A draft hold linked to a canonical enrollment has already
// transferred its representation and must not consume a second seat.
export function classCapacityConsumedSql(environment: AppEnvironment, classIdExpression: string): string {
  const production = environment === "production";
  const enrollmentTestFilter = production ? "AND enrollment.is_test = 0" : "";
  const holdTestFilter = production ? "AND registration_capacity_hold.is_test = 0" : "";
  const offerTestFilter = production ? "AND waitlist_seat_offer.is_test = 0" : "";
  return `(
    (SELECT COUNT(*) FROM enrollment
      INNER JOIN application_child ON application_child.id = enrollment.application_child_id
      INNER JOIN pre_registration ON pre_registration.id = application_child.pre_registration_id
      WHERE enrollment.class_session_id = ${classIdExpression} AND enrollment.status = 'confirmed'
        AND application_child.status = 'enrolled' AND pre_registration.deleted_at IS NULL ${enrollmentTestFilter})
    + (SELECT COUNT(*) FROM enrollment
      INNER JOIN application_child ON application_child.id = enrollment.application_child_id
      INNER JOIN pre_registration ON pre_registration.id = application_child.pre_registration_id
      WHERE enrollment.class_session_id = ${classIdExpression} AND enrollment.status = 'awaiting_initial_payment'
        AND application_child.status = 'hold_created' AND pre_registration.deleted_at IS NULL ${enrollmentTestFilter})
    + (SELECT COUNT(*) FROM registration_capacity_hold
      LEFT JOIN registration_draft_child ON registration_draft_child.id = registration_capacity_hold.registration_draft_child_id
      WHERE registration_capacity_hold.class_session_id = ${classIdExpression} AND registration_capacity_hold.status = 'active'
        AND (registration_capacity_hold.hold_type = 'initial_payment' OR registration_capacity_hold.deadline_at > ?)
        AND registration_draft_child.canonical_enrollment_id IS NULL ${holdTestFilter})
    + (SELECT COUNT(*) FROM waitlist_seat_offer
      WHERE waitlist_seat_offer.class_session_id = ${classIdExpression}
        AND waitlist_seat_offer.status IN ('active', 'awaiting_transfer') ${offerTestFilter})
  )`;
}

// This is deliberately a projection, not a stored counter. It is the one
// capacity definition used by the public catalogue, staff queue, and offers.
export async function getClassCapacityProjections(
  database: D1Database,
  environment: AppEnvironment,
  nowDate = new Date(),
  classIds?: string[],
): Promise<ClassCapacityProjection[]> {
  const production = environment === "production";
  const ids = [...new Set((classIds ?? []).filter(Boolean))];
  const classFilter = ids.length ? `AND class_session.id IN (${ids.map(() => "?").join(", ")})` : "";
  const testFilter = production ? `AND enrollment.is_test = 0` : "";
  const draftTestFilter = production ? `AND registration_capacity_hold.is_test = 0` : "";
  const offerTestFilter = production ? `AND waitlist_seat_offer.is_test = 0` : "";
  const waitlistTestFilter = production ? `AND registration_draft_waitlist_entry.is_test = 0` : "";
  const classTestFilter = production ? `AND class_session.is_test = 0 AND class_session.is_test_only = 0` : "";
  const result = await database.prepare(`
    SELECT class_session.id AS classSessionId, class_session.capacity,
      COALESCE(confirmed.count, 0) AS confirmedCount,
      COALESCE(reserved.count, 0) AS reservedInitialPaymentCount,
      COALESCE(review.count, 0) AS identityReviewCount,
      COALESCE(legacy.count, 0) AS legacyReservationCount,
      COALESCE(offers.count, 0) AS offeredWaitlistCount,
      COALESCE(waiting.count, 0) AS waitlistCount
    FROM class_session
    LEFT JOIN (
      SELECT enrollment.class_session_id, COUNT(*) AS count
      FROM enrollment
      INNER JOIN application_child ON application_child.id = enrollment.application_child_id
      INNER JOIN pre_registration ON pre_registration.id = application_child.pre_registration_id
      WHERE enrollment.status = 'confirmed' AND application_child.status = 'enrolled'
        AND pre_registration.deleted_at IS NULL ${testFilter}
      GROUP BY enrollment.class_session_id
    ) confirmed ON confirmed.class_session_id = class_session.id
    LEFT JOIN (
      SELECT enrollment.class_session_id, COUNT(*) AS count
      FROM enrollment
      INNER JOIN application_child ON application_child.id = enrollment.application_child_id
      INNER JOIN pre_registration ON pre_registration.id = application_child.pre_registration_id
      WHERE enrollment.status = 'awaiting_initial_payment' AND application_child.status = 'hold_created'
        AND pre_registration.deleted_at IS NULL ${testFilter}
      GROUP BY enrollment.class_session_id
    ) legacy ON legacy.class_session_id = class_session.id
    LEFT JOIN (
      SELECT registration_capacity_hold.class_session_id, COUNT(*) AS count
      FROM registration_capacity_hold
      LEFT JOIN registration_draft_child ON registration_draft_child.id = registration_capacity_hold.registration_draft_child_id
      WHERE registration_capacity_hold.status = 'active' AND (registration_capacity_hold.hold_type = 'initial_payment' OR registration_capacity_hold.deadline_at > ?)
        AND registration_draft_child.canonical_enrollment_id IS NULL ${draftTestFilter}
      GROUP BY registration_capacity_hold.class_session_id
    ) reserved ON reserved.class_session_id = class_session.id
    LEFT JOIN (
      SELECT registration_capacity_hold.class_session_id, COUNT(*) AS count
      FROM registration_capacity_hold
      INNER JOIN registration_draft_child ON registration_draft_child.id = registration_capacity_hold.registration_draft_child_id
      WHERE registration_capacity_hold.status = 'active' AND registration_capacity_hold.hold_type = 'initial_payment'
        AND registration_draft_child.canonical_enrollment_id IS NULL
        AND registration_draft_child.promotion_status = 'pending'
        AND registration_draft_child.identity_resolution_status = 'needs_identity_review' ${draftTestFilter}
      GROUP BY registration_capacity_hold.class_session_id
    ) review ON review.class_session_id = class_session.id
    LEFT JOIN (
      SELECT class_session_id, COUNT(*) AS count FROM waitlist_seat_offer
      WHERE status IN ('active', 'awaiting_transfer') ${offerTestFilter}
      GROUP BY class_session_id
    ) offers ON offers.class_session_id = class_session.id
    LEFT JOIN (
      SELECT class_session_id, COUNT(*) AS count FROM registration_draft_waitlist_entry
      WHERE status = 'active' ${waitlistTestFilter}
      GROUP BY class_session_id
    ) waiting ON waiting.class_session_id = class_session.id
    WHERE 1 = 1 ${classTestFilter} ${classFilter}
    ORDER BY CASE class_session.stage_code
      WHEN 'stage_1' THEN 1 WHEN 'stage_2' THEN 2 WHEN 'stage_3' THEN 3 ELSE 9 END,
      CASE class_session.weekday
        WHEN 'Даваа' THEN 1 WHEN 'Мягмар' THEN 2 WHEN 'Лхагва' THEN 3
        WHEN 'Пүрэв' THEN 4 WHEN 'Баасан' THEN 5 WHEN 'Бямба' THEN 6 WHEN 'Ням' THEN 7 ELSE 9 END,
      class_session.start_time, class_session.id
  `).bind(nowDate.toISOString(), ...ids).all<CapacityRow>();
  return result.results.map((row) => {
    const consumed = Number(row.confirmedCount) + Number(row.reservedInitialPaymentCount)
      + Number(row.legacyReservationCount) + Number(row.offeredWaitlistCount);
    return { ...row, capacity: Number(row.capacity), confirmedCount: Number(row.confirmedCount),
      reservedInitialPaymentCount: Number(row.reservedInitialPaymentCount), identityReviewCount: Number(row.identityReviewCount), legacyReservationCount: Number(row.legacyReservationCount), offeredWaitlistCount: Number(row.offeredWaitlistCount),
      waitlistCount: Number(row.waitlistCount), freeSeats: Math.max(Number(row.capacity) - consumed, 0) };
  });
}

// Deliberately read-only and not used by normal teacher UI. This lets staging
// operators inspect the exact rows behind an unexpected capacity total.
export async function getClassCapacityDiagnostic(
  database: D1Database,
  environment: AppEnvironment,
  classSessionId: string,
  nowDate = new Date(),
): Promise<ClassCapacityDiagnostic | null> {
  const projection = (await getClassCapacityProjections(database, environment, nowDate, [classSessionId]))[0];
  if (!projection) return null;
  const classRow = await database.prepare(`SELECT display_label AS classLabel FROM class_session WHERE id = ?`).bind(classSessionId)
    .first<{ classLabel: string }>();
  if (!classRow) return null;
  const production = environment === "production";
  const testFilter = production ? "AND enrollment.is_test = 0" : "";
  const holdTestFilter = production ? "AND registration_capacity_hold.is_test = 0" : "";
  const offerTestFilter = production ? "AND waitlist_seat_offer.is_test = 0" : "";
  const waitlistTestFilter = production ? "AND registration_draft_waitlist_entry.is_test = 0" : "";
  const [confirmed, reservedInitialPayment, legacyReservations, offeredWaitlist, waiting] = await Promise.all([
    database.prepare(`SELECT enrollment.id AS enrollmentId,
      COALESCE(student.surname || ' ' || student.given_name, registration_draft_child.surname || ' ' || registration_draft_child.given_name, '') AS childName,
      application_child.id AS applicationChildId, registration_draft_child.id AS registrationDraftChildId,
      enrollment.status, enrollment.is_test AS isTest, enrollment.test_run_id AS testRunId
      FROM enrollment INNER JOIN application_child ON application_child.id = enrollment.application_child_id
      LEFT JOIN student ON student.id = application_child.student_id
      LEFT JOIN registration_draft_child ON registration_draft_child.canonical_enrollment_id = enrollment.id
      WHERE enrollment.class_session_id = ? AND enrollment.status = 'confirmed' AND application_child.status = 'enrolled' ${testFilter}
      ORDER BY enrollment.created_at, enrollment.id`).bind(classSessionId).all<ClassCapacityDiagnostic["confirmed"][number]>(),
    database.prepare(`SELECT registration_capacity_hold.id AS holdId, registration_capacity_hold.registration_draft_child_id AS registrationDraftChildId,
      registration_draft_child.surname || ' ' || registration_draft_child.given_name AS childName,
      registration_capacity_hold.deadline_at AS deadlineAt, registration_capacity_hold.is_test AS isTest, registration_capacity_hold.test_run_id AS testRunId
      FROM registration_capacity_hold INNER JOIN registration_draft_child ON registration_draft_child.id = registration_capacity_hold.registration_draft_child_id
      WHERE registration_capacity_hold.class_session_id = ? AND registration_capacity_hold.status = 'active'
        AND (registration_capacity_hold.hold_type = 'initial_payment' OR registration_capacity_hold.deadline_at > ?)
        AND registration_draft_child.canonical_enrollment_id IS NULL ${holdTestFilter}
      ORDER BY registration_capacity_hold.created_at, registration_capacity_hold.id`).bind(classSessionId, nowDate.toISOString()).all<ClassCapacityDiagnostic["reservedInitialPayment"][number]>(),
    database.prepare(`SELECT enrollment.id AS enrollmentId, application_child.id AS applicationChildId,
      enrollment.status, enrollment.is_test AS isTest, enrollment.test_run_id AS testRunId
      FROM enrollment INNER JOIN application_child ON application_child.id = enrollment.application_child_id
      INNER JOIN pre_registration ON pre_registration.id = application_child.pre_registration_id
      WHERE enrollment.class_session_id = ? AND enrollment.status = 'awaiting_initial_payment'
        AND application_child.status = 'hold_created' AND pre_registration.deleted_at IS NULL ${testFilter}
      ORDER BY enrollment.created_at, enrollment.id`).bind(classSessionId).all<ClassCapacityDiagnostic["legacyReservations"][number]>(),
    database.prepare(`SELECT waitlist_seat_offer.id AS offerId, waitlist_seat_offer.waitlist_entry_id AS waitlistEntryId,
      registration_draft_child.surname || ' ' || registration_draft_child.given_name AS childName,
      waitlist_seat_offer.status, waitlist_seat_offer.is_test AS isTest, waitlist_seat_offer.test_run_id AS testRunId
      FROM waitlist_seat_offer INNER JOIN registration_draft_child ON registration_draft_child.id = waitlist_seat_offer.registration_draft_child_id
      WHERE waitlist_seat_offer.class_session_id = ? AND waitlist_seat_offer.status IN ('active', 'awaiting_transfer') ${offerTestFilter}
      ORDER BY waitlist_seat_offer.created_at, waitlist_seat_offer.id`).bind(classSessionId).all<ClassCapacityDiagnostic["offeredWaitlist"][number]>(),
    database.prepare(`SELECT registration_draft_waitlist_entry.id AS waitlistEntryId,
      registration_draft_child.surname || ' ' || registration_draft_child.given_name AS childName,
      registration_draft_waitlist_entry.is_test AS isTest, registration_draft_waitlist_entry.test_run_id AS testRunId
      FROM registration_draft_waitlist_entry INNER JOIN registration_draft_child ON registration_draft_child.id = registration_draft_waitlist_entry.registration_draft_child_id
      WHERE registration_draft_waitlist_entry.class_session_id = ? AND registration_draft_waitlist_entry.status = 'active' ${waitlistTestFilter}
      ORDER BY registration_draft_waitlist_entry.created_at, registration_draft_waitlist_entry.id`).bind(classSessionId).all<ClassCapacityDiagnostic["waiting"][number]>(),
  ]);
  return { classSessionId, classLabel: classRow.classLabel, capacity: projection.capacity,
    confirmed: confirmed.results, reservedInitialPayment: reservedInitialPayment.results, legacyReservations: legacyReservations.results,
    offeredWaitlist: offeredWaitlist.results, waiting: waiting.results, projection };
}
