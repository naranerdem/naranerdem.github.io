import type { D1PreparedStatement, D1Result, WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";
import { allocateWaitlistOffers } from "../services/waitlist-offers";
import { getClassCapacityProjections } from "../services/class-capacity";

export type RegistrationCancellationReason = "guardian_request" | "payment_overdue" | "other";

export class RegistrationCancellationError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "invalid" | "conflict" | "withdrawal_required" | "reinstatement_blocked") {
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

interface ReinstatementRow extends CancellationRow {
  studentId: string | null;
  applicationChildStatus: string | null;
  preRegistrationStatus: string | null;
}

interface ReinstatementCredit {
  id: string;
  receivedPaymentId: string;
  status: string;
  refundedAt: string | null;
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

async function reinstatementRowForChild(env: WorkerEnv, childId: string): Promise<ReinstatementRow | null> {
  return env.DB.prepare(`SELECT registration_draft_child.id AS childId,
    registration_draft_child.registration_draft_id AS draftId,
    registration_draft_child.selected_class_session_id AS classSessionId,
    registration_draft_child.status AS childStatus, registration_draft.status AS draftStatus,
    registration_draft_child.canonical_enrollment_id AS enrollmentId,
    enrollment.status AS enrollmentStatus,
    registration_draft_child.canonical_application_child_id AS applicationChildId,
    application_child.status AS applicationChildStatus,
    registration_draft.canonical_pre_registration_id AS preRegistrationId,
    pre_registration.status AS preRegistrationStatus,
    registration_draft_child.canonical_student_id AS studentId,
    registration_draft_child.is_test AS isTest, registration_draft_child.test_run_id AS testRunId
    FROM registration_draft_child
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    LEFT JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
    LEFT JOIN application_child ON application_child.id = registration_draft_child.canonical_application_child_id
    LEFT JOIN pre_registration ON pre_registration.id = registration_draft.canonical_pre_registration_id
    WHERE registration_draft_child.id = ?`).bind(childId).first<ReinstatementRow>();
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

async function reinstatementCredits(env: WorkerEnv, childId: string): Promise<ReinstatementCredit[]> {
  const rows = await env.DB.prepare(`SELECT payment_credit.id, payment_credit.received_payment_id AS receivedPaymentId,
    payment_credit.status, payment_credit.refunded_at AS refundedAt
    FROM payment_credit
    INNER JOIN payment_allocation ON payment_allocation.received_payment_id = payment_credit.received_payment_id
    INNER JOIN payment_installment ON payment_installment.id = payment_allocation.payment_installment_id
    WHERE payment_installment.registration_draft_child_id = ?
    GROUP BY payment_credit.id`).bind(childId).all<ReinstatementCredit>();
  return rows.results;
}

async function activeWaitlistOfferExists(env: WorkerEnv, classSessionId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS value FROM waitlist_seat_offer
    WHERE class_session_id = ? AND status IN ('active', 'awaiting_transfer') LIMIT 1`).bind(classSessionId)
    .first<{ value: number }>();
  return Boolean(row);
}

async function replacementEnrollmentExists(env: WorkerEnv, row: ReinstatementRow): Promise<boolean> {
  if (!row.studentId || !row.enrollmentId) return true;
  const replacement = await env.DB.prepare(`SELECT 1 AS value FROM enrollment
    WHERE student_id = ? AND id != ? AND status IN ('awaiting_initial_payment', 'confirmed') LIMIT 1`)
    .bind(row.studentId, row.enrollmentId).first<{ value: number }>();
  return Boolean(replacement);
}

async function cancellationAuditId(env: WorkerEnv, childId: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT id FROM audit_event
    WHERE action = 'registration_cancelled' AND subject_type = 'registration_draft_child' AND subject_id = ?
    ORDER BY occurred_at DESC, id DESC LIMIT 1`).bind(childId).first<{ id: string }>();
  return row?.id ?? null;
}

async function canReinstate(env: WorkerEnv, row: ReinstatementRow, nowDate: Date): Promise<{ eligible: boolean; cancellationAuditId: string | null }> {
  if (row.childStatus !== 'cancelled' || row.draftStatus !== 'cancelled' || row.enrollmentStatus !== 'cancelled'
    || !row.enrollmentId || !row.applicationChildId || !row.preRegistrationId || !row.studentId) {
    return { eligible: false, cancellationAuditId: null };
  }
  const [hasHistory, hasReplacement, hasOffer, auditId, credits, capacity] = await Promise.all([
    hasAttendanceHistory(env, row.enrollmentId),
    replacementEnrollmentExists(env, row),
    activeWaitlistOfferExists(env, row.classSessionId),
    cancellationAuditId(env, row.childId),
    reinstatementCredits(env, row.childId),
    getClassCapacityProjections(env.DB, env.APP_ENV, nowDate, [row.classSessionId]),
  ]);
  const creditIsSettled = credits.some((credit) => credit.status !== 'available' || credit.refundedAt);
  return {
    eligible: Boolean(auditId) && !hasHistory && !hasReplacement && !hasOffer && !creditIsSettled
      && Boolean(capacity[0]) && capacity[0].freeSeats > 0,
    cancellationAuditId: auditId,
  };
}

export async function getRegistrationReinstatementEligibility(env: WorkerEnv, childId: string, nowDate = new Date()): Promise<boolean> {
  const row = await reinstatementRowForChild(env, childId);
  return Boolean(row && row.classSessionId && (await canReinstate(env, row, nowDate)).eligible);
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

async function releasedLaterInstallments(env: WorkerEnv, childId: string): Promise<Array<{ id: string; amountMnt: number; allocatedAmountMnt: number }>> {
  const rows = await env.DB.prepare(`SELECT payment_installment.id, payment_installment.amount_mnt AS amountMnt,
    COALESCE(SUM(CASE WHEN payment_confirmation.status = 'undone' THEN 0 ELSE payment_allocation.allocated_amount_mnt END), 0) AS allocatedAmountMnt
    FROM payment_installment
    LEFT JOIN payment_allocation ON payment_allocation.payment_installment_id = payment_installment.id
    LEFT JOIN payment_confirmation ON payment_confirmation.received_payment_id = payment_allocation.received_payment_id
    WHERE payment_installment.registration_draft_child_id = ?
      AND payment_installment.installment_kind = 'later' AND payment_installment.status = 'released'
    GROUP BY payment_installment.id`).bind(childId).all<{ id: string; amountMnt: number; allocatedAmountMnt: number }>();
  return rows.results.map((item) => ({ ...item, amountMnt: Number(item.amountMnt), allocatedAmountMnt: Number(item.allocatedAmountMnt) }));
}

function capacityAvailableSql(classIdExpression: string): string {
  return `(SELECT target.capacity
    - (SELECT COUNT(*) FROM enrollment
      INNER JOIN application_child ON application_child.id = enrollment.application_child_id
      INNER JOIN pre_registration ON pre_registration.id = application_child.pre_registration_id
      WHERE enrollment.class_session_id = target.id AND enrollment.status = 'confirmed'
        AND application_child.status = 'enrolled' AND pre_registration.deleted_at IS NULL)
    - (SELECT COUNT(*) FROM enrollment
      INNER JOIN application_child ON application_child.id = enrollment.application_child_id
      INNER JOIN pre_registration ON pre_registration.id = application_child.pre_registration_id
      WHERE enrollment.class_session_id = target.id AND enrollment.status = 'awaiting_initial_payment'
        AND application_child.status = 'hold_created' AND pre_registration.deleted_at IS NULL)
    - (SELECT COUNT(*) FROM registration_capacity_hold
      LEFT JOIN registration_draft_child ON registration_draft_child.id = registration_capacity_hold.registration_draft_child_id
      WHERE registration_capacity_hold.class_session_id = target.id AND registration_capacity_hold.status = 'active'
        AND (registration_capacity_hold.hold_type = 'initial_payment' OR registration_capacity_hold.deadline_at > datetime('now'))
        AND registration_draft_child.canonical_enrollment_id IS NULL)
    - (SELECT COUNT(*) FROM waitlist_seat_offer
      WHERE waitlist_seat_offer.class_session_id = target.id AND waitlist_seat_offer.status IN ('active', 'awaiting_transfer'))
    FROM class_session AS target WHERE target.id = ${classIdExpression}) > 0`;
}

export async function reinstateRegistration(env: WorkerEnv, actor: StaffPrincipal, input: { registrationDraftChildId: string }, nowDate = new Date()) {
  if (!hasStaffCapability(actor, 'registration.manage')) throw new RegistrationCancellationError('forbidden');
  if (!input.registrationDraftChildId) throw new RegistrationCancellationError('invalid');
  const row = await reinstatementRowForChild(env, input.registrationDraftChildId);
  if (!row || !row.classSessionId) throw new RegistrationCancellationError('not_found');
  if (row.childStatus !== 'cancelled' && row.enrollmentStatus === 'confirmed') {
    return { reinstated: false, idempotent: true, classSessionId: row.classSessionId };
  }
  const eligibility = await canReinstate(env, row, nowDate);
  if (!eligibility.eligible || !eligibility.cancellationAuditId) throw new RegistrationCancellationError('reinstatement_blocked');

  const now = nowDate.toISOString();
  const installments = await releasedLaterInstallments(env, row.childId);
  const credits = await reinstatementCredits(env, row.childId);
  const gate = env.DB.prepare(`UPDATE enrollment SET status = 'confirmed', cancelled_at = NULL, cancellation_reason = NULL, updated_at = ?
    WHERE id = ? AND status = 'cancelled'
      AND NOT EXISTS (SELECT 1 FROM waitlist_seat_offer
        WHERE class_session_id = enrollment.class_session_id AND status IN ('active', 'awaiting_transfer'))
      AND ${capacityAvailableSql('enrollment.class_session_id')}`).bind(now, row.enrollmentId);
  const statements: D1PreparedStatement[] = [
    gate,
    env.DB.prepare(`UPDATE application_child SET status = 'enrolled', updated_at = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM enrollment WHERE id = ? AND status = 'confirmed')`)
      .bind(now, row.applicationChildId, row.enrollmentId),
    env.DB.prepare(`UPDATE registration_draft_child SET status = 'awaiting_initial_payment',
      identity_resolution_status = 'promoted', promotion_status = 'promoted', updated_at = ?
      WHERE id = ? AND status = 'cancelled' AND EXISTS (SELECT 1 FROM enrollment WHERE id = ? AND status = 'confirmed')`)
      .bind(now, row.childId, row.enrollmentId),
    env.DB.prepare(`UPDATE registration_draft SET status = 'awaiting_initial_payment', updated_at = ?
      WHERE id = ? AND status = 'cancelled' AND EXISTS (SELECT 1 FROM registration_draft_child
        WHERE id = ? AND status != 'cancelled')`).bind(now, row.draftId, row.childId),
    env.DB.prepare(`UPDATE pre_registration SET status = 'completed', cancelled_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'cancelled' AND EXISTS (SELECT 1 FROM application_child
        WHERE id = ? AND status = 'enrolled')`).bind(now, row.preRegistrationId, row.applicationChildId),
    ...installments.map((installment) => env.DB.prepare(`UPDATE payment_installment SET status = ?, updated_at = ?
      WHERE id = ? AND status = 'released' AND EXISTS (SELECT 1 FROM enrollment WHERE id = ? AND status = 'confirmed')`)
      .bind(installment.allocatedAmountMnt >= installment.amountMnt ? 'paid' : installment.allocatedAmountMnt > 0 ? 'partially_paid' : 'pending', now, installment.id, row.enrollmentId)),
    env.DB.prepare(`UPDATE payment_notification_milestone SET status = 'pending', processing_started_at = NULL,
      last_error_code = NULL, updated_at = ?
      WHERE registration_draft_child_id = ? AND milestone_type = 'later_reminder' AND status = 'cancelled'
        AND scheduled_at > ? AND outbound_email_id IS NULL
        AND EXISTS (SELECT 1 FROM enrollment WHERE id = ? AND status = 'confirmed')`)
      .bind(now, row.childId, now, row.enrollmentId),
    ...credits.map((credit) => env.DB.prepare(`UPDATE payment_credit SET status = 'allocated', updated_at = ?
      WHERE id = ? AND status = 'available' AND refunded_at IS NULL
        AND EXISTS (SELECT 1 FROM enrollment WHERE id = ? AND status = 'confirmed')`)
      .bind(now, credit.id, row.enrollmentId)),
    env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
      metadata_json, environment, is_test, test_run_id, created_at)
      SELECT ?, ?, 'staff', ?, 'registration_reinstated', 'registration_draft_child', ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM enrollment WHERE id = ? AND status = 'confirmed')`)
      .bind(crypto.randomUUID(), now, actor.staffAccountId, row.childId,
        JSON.stringify({ cancellationAuditEventId: eligibility.cancellationAuditId, enrollmentId: row.enrollmentId,
          restoredLaterInstallmentIds: installments.map((installment) => installment.id), closedCreditIds: credits.map((credit) => credit.id) }),
        env.APP_ENV, row.isTest, row.testRunId, now, row.enrollmentId),
  ];
  const results = await env.DB.batch(statements);
  if (changes(results[0]) !== 1) {
    const current = await reinstatementRowForChild(env, row.childId);
    if (current && current.childStatus !== 'cancelled' && current.enrollmentStatus === 'confirmed') {
      return { reinstated: false, idempotent: true, classSessionId: row.classSessionId };
    }
    throw new RegistrationCancellationError('conflict');
  }
  return { reinstated: true, idempotent: false, classSessionId: row.classSessionId,
    restoredLaterInstallmentCount: installments.length, closedCreditCount: credits.length };
}
