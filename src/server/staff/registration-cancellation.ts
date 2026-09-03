import type { D1PreparedStatement, D1Result, WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";
import { allocateWaitlistOffers } from "../services/waitlist-offers";

export type RegistrationCancellationReason = "guardian_request" | "payment_overdue" | "other";

export class RegistrationCancellationError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "invalid" | "conflict" | "withdrawal_required") {
    super("Registration cancellation failed.");
  }
}

interface CancellationRow {
  childId: string;
  draftId: string;
  classSessionId: string;
  childStatus: string;
  draftStatus: string;
  enrollmentId: string | null;
  enrollmentStatus: string | null;
  applicationChildId: string | null;
  preRegistrationId: string | null;
  isTest: number;
  testRunId: string | null;
}

function changes(result: D1Result<unknown> | undefined): number { return result?.meta?.changes ?? 0; }

function note(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFKC").trim().slice(0, 500) : "";
}

function reason(value: unknown): RegistrationCancellationReason | null {
  return value === "guardian_request" || value === "payment_overdue" || value === "other" ? value : null;
}

async function rowForChild(env: WorkerEnv, childId: string): Promise<CancellationRow | null> {
  return env.DB.prepare(`SELECT registration_draft_child.id AS childId,
    registration_draft_child.registration_draft_id AS draftId,
    registration_draft_child.selected_class_session_id AS classSessionId,
    registration_draft_child.status AS childStatus, registration_draft.status AS draftStatus,
    registration_draft_child.canonical_enrollment_id AS enrollmentId,
    enrollment.status AS enrollmentStatus,
    registration_draft_child.canonical_application_child_id AS applicationChildId,
    registration_draft.canonical_pre_registration_id AS preRegistrationId,
    registration_draft_child.is_test AS isTest, registration_draft_child.test_run_id AS testRunId
    FROM registration_draft_child
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    LEFT JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
    WHERE registration_draft_child.id = ?`).bind(childId).first<CancellationRow>();
}

async function hasAttendanceHistory(env: WorkerEnv, enrollmentId: string | null): Promise<boolean> {
  if (!enrollmentId) return false;
  const row = await env.DB.prepare(`SELECT 1 AS value
    WHERE EXISTS (SELECT 1 FROM course_attendance WHERE enrollment_id = ?)
       OR EXISTS (SELECT 1 FROM course_absence_notice WHERE enrollment_id = ?)
       OR EXISTS (SELECT 1 FROM course_makeup_resolution WHERE source_enrollment_id = ?)`)
    .bind(enrollmentId, enrollmentId, enrollmentId).first<{ value: number }>();
  return Boolean(row);
}

async function receivedPaymentCredits(env: WorkerEnv, childId: string): Promise<Array<{ paymentId: string; paymentRequestId: string; amountMnt: number }>> {
  const result = await env.DB.prepare(`SELECT received_payment.id AS paymentId,
    received_payment.payment_request_id AS paymentRequestId,
    SUM(payment_allocation.allocated_amount_mnt) AS amountMnt
    FROM received_payment
    INNER JOIN payment_allocation ON payment_allocation.received_payment_id = received_payment.id
    INNER JOIN payment_installment ON payment_installment.id = payment_allocation.payment_installment_id
    LEFT JOIN payment_confirmation ON payment_confirmation.received_payment_id = received_payment.id
    WHERE payment_installment.registration_draft_child_id = ?
      AND (payment_confirmation.status IS NULL OR payment_confirmation.status != 'undone')
      AND NOT EXISTS (
        SELECT 1 FROM payment_allocation AS other_allocation
        INNER JOIN payment_installment AS other_installment ON other_installment.id = other_allocation.payment_installment_id
        WHERE other_allocation.received_payment_id = received_payment.id
          AND other_installment.registration_draft_child_id != ?
      )
    GROUP BY received_payment.id, received_payment.payment_request_id
    HAVING SUM(payment_allocation.allocated_amount_mnt) > 0`).bind(childId, childId)
    .all<{ paymentId: string; paymentRequestId: string; amountMnt: number }>();
  return result.results.map((item) => ({ ...item, amountMnt: Number(item.amountMnt) }));
}

export async function cancelRegistration(env: WorkerEnv, actor: StaffPrincipal, input: {
  registrationDraftChildId: string;
  reason: unknown;
  note?: unknown;
}, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "registration.manage")) throw new RegistrationCancellationError("forbidden");
  const cancellationReason = reason(input.reason);
  const cancellationNote = note(input.note);
  if (!input.registrationDraftChildId || !cancellationReason || (cancellationReason === "other" && !cancellationNote)) {
    throw new RegistrationCancellationError("invalid");
  }
  const row = await rowForChild(env, input.registrationDraftChildId);
  if (!row || !row.classSessionId) throw new RegistrationCancellationError("not_found");
  if (row.childStatus === "cancelled") return { cancelled: false, idempotent: true, classSessionId: row.classSessionId, creditCount: 0 };
  if (await hasAttendanceHistory(env, row.enrollmentId)) throw new RegistrationCancellationError("withdrawal_required");

  const now = nowDate.toISOString();
  // This conditional gate is intentionally first. It makes a replay or a racing
  // finalizer observe terminal state before any capacity representation changes.
  const gate = await env.DB.prepare(`UPDATE registration_draft_child SET status = 'cancelled',
    identity_resolution_status = 'not_eligible', promotion_status = 'failed', updated_at = ?
    WHERE id = ? AND status != 'cancelled'`).bind(now, row.childId).run();
  if (changes(gate) !== 1) {
    const current = await rowForChild(env, row.childId);
    if (current?.childStatus === "cancelled") return { cancelled: false, idempotent: true, classSessionId: row.classSessionId, creditCount: 0 };
    throw new RegistrationCancellationError("conflict");
  }

  const credits = await receivedPaymentCredits(env, row.childId);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`UPDATE registration_capacity_hold SET status = 'cancelled', released_at = ?,
      release_reason = 'staff_registration_cancelled', updated_at = ?
      WHERE registration_draft_child_id = ? AND status = 'active'`).bind(now, now, row.childId),
    env.DB.prepare(`UPDATE enrollment SET status = 'cancelled', cancelled_at = ?, cancellation_reason = ?, updated_at = ?
      WHERE id = ? AND status != 'cancelled'`).bind(now, cancellationReason, now, row.enrollmentId),
    env.DB.prepare(`UPDATE application_child SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND status != 'cancelled'`).bind(now, row.applicationChildId),
    env.DB.prepare(`UPDATE payment_installment SET status = 'released', updated_at = ?
      WHERE registration_draft_child_id = ? AND status != 'paid' AND status != 'released'`).bind(now, row.childId),
    env.DB.prepare(`UPDATE payment_confirmation SET status = 'undone', undone_at = ?, updated_at = ?
      WHERE status = 'tentative' AND received_payment_id IN (
        SELECT payment_allocation.received_payment_id FROM payment_allocation
        INNER JOIN payment_installment ON payment_installment.id = payment_allocation.payment_installment_id
        WHERE payment_installment.registration_draft_child_id = ?
      ) AND NOT EXISTS (
        SELECT 1 FROM payment_allocation AS other_allocation
        INNER JOIN payment_installment AS other_installment ON other_installment.id = other_allocation.payment_installment_id
        WHERE other_allocation.received_payment_id = payment_confirmation.received_payment_id
          AND other_installment.registration_draft_child_id != ?
      )`).bind(now, now, row.childId, row.childId),
    env.DB.prepare(`UPDATE payment_notification_milestone SET status = 'cancelled', updated_at = ?
      WHERE registration_draft_child_id = ? AND status IN ('pending', 'failed', 'sending')`).bind(now, row.childId),
    env.DB.prepare(`UPDATE registration_draft SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND NOT EXISTS (
        SELECT 1 FROM registration_draft_child WHERE registration_draft_id = ? AND status != 'cancelled'
      )`).bind(now, row.draftId, row.draftId),
    env.DB.prepare(`UPDATE pre_registration SET status = 'cancelled', cancelled_at = ?, updated_at = ?
      WHERE id = ? AND NOT EXISTS (
        SELECT 1 FROM application_child WHERE pre_registration_id = ? AND status != 'cancelled'
      )`).bind(now, now, row.preRegistrationId, row.preRegistrationId),
    env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
      metadata_json, environment, is_test, test_run_id, created_at) VALUES (?, ?, 'staff', ?, 'registration_cancelled',
      'registration_draft_child', ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), now, actor.staffAccountId, row.childId,
        JSON.stringify({ reason: cancellationReason, note: cancellationNote || null, prior: {
          childStatus: row.childStatus, draftStatus: row.draftStatus, enrollmentStatus: row.enrollmentStatus,
        }, creditCount: credits.length }), env.APP_ENV, row.isTest, row.testRunId, now),
    ...credits.map((credit) => env.DB.prepare(`INSERT OR IGNORE INTO payment_credit (
      id, received_payment_id, payment_request_id, available_amount_mnt, status, created_at, updated_at, is_test, test_run_id
    ) VALUES (?, ?, ?, ?, 'available', ?, ?, ?, ?)`)
      .bind(`credit:${credit.paymentId}`, credit.paymentId, credit.paymentRequestId, credit.amountMnt, now, now, row.isTest, row.testRunId)),
  ];
  await env.DB.batch(statements);
  // Allocation uses the same projection as the public catalogue. It sees the
  // cancelled hold/enrollment as non-consuming before it offers this one seat.
  await allocateWaitlistOffers(env, row.classSessionId, nowDate);
  return { cancelled: true, idempotent: false, classSessionId: row.classSessionId, creditCount: credits.length };
}
