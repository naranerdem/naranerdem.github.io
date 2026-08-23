import type { AppEnvironment, D1Database } from "../env";

export interface ClassCapacityProjection {
  classSessionId: string;
  capacity: number;
  confirmedCount: number;
  reservedInitialPaymentCount: number;
  offeredWaitlistCount: number;
  waitlistCount: number;
  freeSeats: number;
}

interface CapacityRow {
  classSessionId: string;
  capacity: number;
  confirmedCount: number;
  reservedInitialPaymentCount: number;
  offeredWaitlistCount: number;
  waitlistCount: number;
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
      COALESCE(reserved.count, 0) + COALESCE(legacy.count, 0) AS reservedInitialPaymentCount,
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
      SELECT class_session_id, COUNT(*) AS count FROM registration_capacity_hold
      WHERE status = 'active' AND (hold_type = 'initial_payment' OR deadline_at > ?) ${draftTestFilter}
      GROUP BY class_session_id
    ) reserved ON reserved.class_session_id = class_session.id
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
    ORDER BY class_session.weekday, class_session.start_time, class_session.id
  `).bind(nowDate.toISOString(), ...ids).all<CapacityRow>();
  return result.results.map((row) => {
    const consumed = Number(row.confirmedCount) + Number(row.reservedInitialPaymentCount) + Number(row.offeredWaitlistCount);
    return { ...row, capacity: Number(row.capacity), confirmedCount: Number(row.confirmedCount),
      reservedInitialPaymentCount: Number(row.reservedInitialPaymentCount), offeredWaitlistCount: Number(row.offeredWaitlistCount),
      waitlistCount: Number(row.waitlistCount), freeSeats: Math.max(Number(row.capacity) - consumed, 0) };
  });
}
