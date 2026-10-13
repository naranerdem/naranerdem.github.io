import type { WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

export class AttendancePaymentCardError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "invalid") {
    super("Attendance payment card lookup failed.");
    this.name = "AttendancePaymentCardError";
  }
}

// Canonical enrollments created by older registrations use a stable
// `<registration-child-id>:enrollment` identity.  Keep the input bounded and
// structural, but do not reject that recorded form before lineage resolution.
const enrollmentIdPattern = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,159}$/;

// Loaded only when staff explicitly search for a credit recipient, not when
// opening a card. This is identity data; the existing transfer service remains
// responsible for all financial eligibility and mutation checks.
export async function attendanceCreditRecipients(env: WorkerEnv, actor: StaffPrincipal, enrollmentId: string, query: string) {
  if (!hasStaffCapability(actor, "payment.manage")) throw new AttendancePaymentCardError("forbidden");
  if (query.trim().length < 2 || query.length > 80) throw new AttendancePaymentCardError("invalid");
  const source = await attendancePaymentCardTarget(env, actor, enrollmentId);
  const term = `%${query.trim().replace(/[\\%_]/g, '\\$&')}%`;
  const result = await env.DB.prepare(`SELECT child.id AS registrationDraftChildId,
      child.canonical_student_id AS canonicalStudentId, child.canonical_enrollment_id AS canonicalEnrollmentId,
      child.surname || ' ' || child.given_name AS childName,
      draft.guardian_full_name AS guardianName, class.display_label AS classLabel,
      class.weekday, class.start_time AS startTime, class.end_time AS endTime, class.stage_code AS stageCode
    FROM registration_draft_child AS child
    INNER JOIN enrollment ON enrollment.id = child.canonical_enrollment_id
    INNER JOIN registration_draft AS draft ON draft.id = child.registration_draft_id
    INNER JOIN class_session AS class ON class.id = enrollment.class_session_id
    WHERE child.id != ? AND child.status != 'cancelled' AND draft.status != 'cancelled'
      AND enrollment.status = 'confirmed' AND enrollment.transferred_out_at IS NULL
      AND (child.surname || ' ' || child.given_name LIKE ? ESCAPE '\\')
    ORDER BY child.surname, child.given_name, child.id LIMIT 31`).bind(source.registrationDraftChildId, term).all();
  return { items: result.results.slice(0, 30), more: result.results.length > 30 };
}

// An attendance occurrence can legitimately point to a source enrollment that
// has since transferred. Follow completed transfer lineage to the current
// registration child instead of resolving by a displayed name.
export async function attendancePaymentCardTarget(
  env: WorkerEnv,
  actor: StaffPrincipal,
  enrollmentId: string,
): Promise<{ registrationDraftChildId: string; currentEnrollmentId: string; transferredSinceOccurrence: boolean }> {
  if (!hasStaffCapability(actor, "payment.view")) throw new AttendancePaymentCardError("forbidden");
  if (!enrollmentIdPattern.test(enrollmentId)) throw new AttendancePaymentCardError("invalid");
  const row = await env.DB.prepare(`WITH RECURSIVE lineage(enrollment_id, depth) AS (
    SELECT ? AS enrollment_id, 0 AS depth
    UNION ALL
    SELECT class_transfer.target_enrollment_id, lineage.depth + 1
    FROM class_transfer
    INNER JOIN lineage ON lineage.enrollment_id = class_transfer.source_enrollment_id
    WHERE class_transfer.status = 'completed'
      AND class_transfer.target_enrollment_id IS NOT NULL
      AND lineage.depth < 16
  )
  SELECT registration_draft_child.id AS registrationDraftChildId,
    lineage.enrollment_id AS currentEnrollmentId,
    lineage.depth AS transferDepth
  FROM lineage
  INNER JOIN registration_draft_child
    ON registration_draft_child.canonical_enrollment_id = lineage.enrollment_id
  ORDER BY lineage.depth DESC
  LIMIT 1`).bind(enrollmentId).first<{
    registrationDraftChildId: string;
    currentEnrollmentId: string;
    transferDepth: number;
  }>();
  if (!row) throw new AttendancePaymentCardError("not_found");
  return {
    registrationDraftChildId: row.registrationDraftChildId,
    currentEnrollmentId: row.currentEnrollmentId,
    transferredSinceOccurrence: Number(row.transferDepth) > 0,
  };
}
