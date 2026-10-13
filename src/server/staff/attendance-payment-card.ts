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
