import type { D1PreparedStatement, D1Result, WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";
import { getPaymentReminderSetting } from "./payment-reminders";
import { getRegistrationReinstatementEligibility } from "./registration-cancellation";
import { promotePaidDraftChild, promotePaidDraftChildren, recordAdditionalAdmissionDiagnostic } from "../services/canonical-enrollment-promotion";
import { getClassCapacityProjections } from "../services/class-capacity";
import { allocateWaitlistOffers } from "../services/waitlist-offers";
import { discountAwardsForChildren, effectiveInstallmentsForRows, recalculateDiscountAwardBalances } from "../services/discounts";
import { childCreditSummaryForChildren, creditPaymentReviewState } from "../services/child-credit-ledger";
import { pendingAdditionalClassCashSettlement } from "../services/additional-class-credit-settlement";
import { familyCreditSuggestionsForChild } from "./family-discounts";

type PaymentSource = "staff_manual_bank" | "staff_manual_cash";
type PaymentErrorCode = "forbidden" | "not_found" | "invalid" | "conflict" | "not_due" | "already_paid" | "family_credit_review_required";

export class PaymentReconciliationError extends Error {
  constructor(public readonly code: PaymentErrorCode) {
    super("Payment reconciliation failed.");
  }
}

interface PaymentRequestRow {
  id: string;
  registrationDraftId: string;
  paymentReference: string;
  isTest: number;
  testRunId: string | null;
}

interface InstallmentRow {
  id: string;
  paymentRequestId: string;
  registrationDraftChildId: string;
  installmentKind: "initial" | "later";
  installmentNumber: number;
  amountMnt: number;
  effectiveDueAt: string;
  status: "pending" | "partially_paid" | "paid" | "released";
  allocatedAmountMnt: number;
}

export interface PaymentConfirmationGraceSetting {
  graceMinutes: number;
  updatedAt: string;
}

function changes(result: D1Result<unknown> | undefined): number { return result?.meta?.changes ?? 0; }
function iso(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
function positive(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}
function operationId(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : null;
}
function audit(env: WorkerEnv, actor: StaffPrincipal, action: string, subjectType: string, subjectId: string,
  metadata: Record<string, unknown>, request: PaymentRequestRow, now: string): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO audit_event (
    id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at
  ) VALUES (?, ?, 'staff', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, action, subjectType, subjectId,
      JSON.stringify(metadata), env.APP_ENV, request.isTest, request.testRunId, now);
}

async function requestForId(env: WorkerEnv, requestId: string): Promise<PaymentRequestRow> {
  const row = await env.DB.prepare(`SELECT id, registration_draft_id AS registrationDraftId,
    payment_reference AS paymentReference, is_test AS isTest, test_run_id AS testRunId
    FROM payment_request WHERE id = ?`).bind(requestId).first<PaymentRequestRow>();
  if (!row) throw new PaymentReconciliationError("not_found");
  return row;
}

async function installmentsForRequest(env: WorkerEnv, paymentRequestId: string): Promise<InstallmentRow[]> {
  const result = await env.DB.prepare(`SELECT payment_installment.id, payment_installment.payment_request_id AS paymentRequestId,
    payment_installment.registration_draft_child_id AS registrationDraftChildId,
    payment_installment.installment_kind AS installmentKind, payment_installment.installment_number AS installmentNumber, payment_installment.amount_mnt AS amountMnt,
    payment_installment.effective_due_at AS effectiveDueAt, payment_installment.status,
    COALESCE(SUM(CASE WHEN payment_confirmation.status = 'undone' THEN 0 ELSE payment_allocation.allocated_amount_mnt END), 0)
      + COALESCE((SELECT SUM(-credit_entry.amount_mnt) FROM child_credit_entry AS credit_entry
        WHERE credit_entry.payment_installment_id = payment_installment.id AND credit_entry.entry_kind = 'credit_application'), 0) AS allocatedAmountMnt
    FROM payment_installment
    LEFT JOIN payment_allocation ON payment_allocation.payment_installment_id = payment_installment.id
    LEFT JOIN received_payment ON received_payment.id = payment_allocation.received_payment_id
    LEFT JOIN payment_confirmation ON payment_confirmation.received_payment_id = received_payment.id
    WHERE payment_installment.payment_request_id = ?
    GROUP BY payment_installment.id
    ORDER BY payment_installment.registration_draft_child_id, payment_installment.installment_number`).bind(paymentRequestId).all<InstallmentRow>();
  const raw = result.results.map((row) => ({ ...row, installmentNumber: Number(row.installmentNumber), amountMnt: Number(row.amountMnt), allocatedAmountMnt: Number(row.allocatedAmountMnt) }));
  const effective = new Map((await effectiveInstallmentsForRows(env.DB, raw.map((row) => ({
    id: row.id, registrationDraftChildId: row.registrationDraftChildId, installmentNumber: row.installmentNumber, amountMnt: row.amountMnt, allocatedAmountMnt: row.allocatedAmountMnt,
  })))).map((row) => [row.id, row]));
  return raw.map((row) => ({ ...row, amountMnt: effective.get(row.id)?.effectiveAmountMnt ?? row.amountMnt }));
}

export async function getPaymentConfirmationGraceSetting(env: WorkerEnv): Promise<PaymentConfirmationGraceSetting> {
  const row = await env.DB.prepare(`SELECT grace_minutes AS graceMinutes, updated_at AS updatedAt
    FROM payment_confirmation_grace_setting WHERE singleton = 1`).first<PaymentConfirmationGraceSetting>();
  if (!row) throw new PaymentReconciliationError("invalid");
  return row;
}

export async function updatePaymentConfirmationGraceSetting(env: WorkerEnv, actor: StaffPrincipal, input: {
  graceMinutes: number; expectedUpdatedAt: string;
}): Promise<PaymentConfirmationGraceSetting> {
  if (!hasStaffCapability(actor, "admin.settings.manage")) throw new PaymentReconciliationError("forbidden");
  if (!Number.isInteger(input.graceMinutes) || input.graceMinutes < 1 || input.graceMinutes > 60 || !input.expectedUpdatedAt) {
    throw new PaymentReconciliationError("invalid");
  }
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE payment_confirmation_grace_setting SET grace_minutes = ?, updated_at = ?
    WHERE singleton = 1 AND updated_at = ?`).bind(input.graceMinutes, now, input.expectedUpdatedAt).run();
  if (changes(result) !== 1) throw new PaymentReconciliationError("conflict");
  await env.DB.prepare(`INSERT INTO audit_event (
    id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at
  ) VALUES (?, ?, 'staff', ?, 'payment_confirmation_grace_changed', 'payment_confirmation_grace_setting', '1', ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, JSON.stringify({ graceMinutes: input.graceMinutes }),
      env.APP_ENV, env.APP_ENV === "staging" ? 1 : 0, env.APP_ENV === "staging" ? "staff-settings" : null, now).run();
  return { graceMinutes: input.graceMinutes, updatedAt: now };
}

export async function refreshInstallmentsAndDraft(env: WorkerEnv, request: PaymentRequestRow, now: string) {
  const installments = await installmentsForRequest(env, request.id);
  const statements: D1PreparedStatement[] = [];
  for (const installment of installments) {
    if (installment.status === "released") continue;
    const next = installment.allocatedAmountMnt >= installment.amountMnt ? "paid"
      : installment.allocatedAmountMnt > 0 ? "partially_paid" : "pending";
    if (next !== installment.status) {
      statements.push(env.DB.prepare(`UPDATE payment_installment SET status = ?, paid_at = ?, updated_at = ?
        WHERE id = ? AND status != 'released' AND EXISTS (
          SELECT 1 FROM registration_draft_child
          WHERE registration_draft_child.id = payment_installment.registration_draft_child_id
            AND registration_draft_child.status != 'cancelled'
        )`)
        .bind(next, next === "paid" ? now : null, now, installment.id));
    }
  }
  const initial = installments.filter((item) => item.installmentKind === "initial" && item.status !== "released");
  for (const installment of initial) {
    if (installment.allocatedAmountMnt >= installment.amountMnt) {
      statements.push(env.DB.prepare(`UPDATE registration_draft_child SET initial_payment_reconciled_at = ?, updated_at = ?
        WHERE id = ? AND status != 'cancelled' AND initial_payment_reconciled_at IS NULL`).bind(now, now, installment.registrationDraftChildId));
    }
  }
  const allInitialPaid = initial.length > 0 && initial.every((item) => item.allocatedAmountMnt >= item.amountMnt);
  if (allInitialPaid) {
    statements.push(env.DB.prepare(`UPDATE registration_draft SET initial_payment_reconciled_at = ?, updated_at = ?
      WHERE id = ? AND status != 'cancelled' AND initial_payment_reconciled_at IS NULL`).bind(now, now, request.registrationDraftId));
  }
  if (statements.length) await env.DB.batch(statements);
  return { installments, allInitialPaid };
}

export async function getInitialPaymentQueue(env: WorkerEnv, actor: StaffPrincipal, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "payment.view")) throw new PaymentReconciliationError("forbidden");
  const now = nowDate.toISOString();
  const result = await env.DB.prepare(`SELECT
    payment_request.id AS paymentRequestId, payment_request.payment_reference AS paymentReference,
    payment_request.transfer_description AS transferDescription,
    payment_installment.id AS installmentId, payment_installment.registration_draft_child_id AS registrationDraftChildId,
    payment_installment.amount_mnt AS expectedAmountMnt,
    payment_installment.effective_due_at AS paymentDueAt, payment_installment.status AS installmentStatus,
    COALESCE(SUM(CASE WHEN payment_confirmation.status = 'undone' THEN 0 ELSE payment_allocation.allocated_amount_mnt END), 0)
      + COALESCE((SELECT SUM(-credit_entry.amount_mnt) FROM child_credit_entry AS credit_entry
        WHERE credit_entry.payment_installment_id = payment_installment.id AND credit_entry.entry_kind = 'credit_application'), 0) AS allocatedAmountMnt,
    COALESCE(SUM(CASE WHEN payment_confirmation.status = 'undone' THEN 0 ELSE payment_allocation.allocated_amount_mnt END), 0) AS cashAllocatedAmountMnt,
    registration_draft_child.surname || ' ' || registration_draft_child.given_name AS childName,
    registration_draft_child.payment_plan_code AS paymentPlanCode,
    registration_draft_child.promotion_status AS promotionStatus,
    registration_draft_child.identity_resolution_status AS identityResolutionStatus,
    registration_draft_child.canonical_student_id AS canonicalStudentId,
    registration_draft_child.canonical_enrollment_id AS canonicalEnrollmentId,
    enrollment.updated_at AS canonicalEnrollmentUpdatedAt,
    MAX(CASE WHEN registration_capacity_hold.id IS NOT NULL THEN 1 ELSE 0 END) AS hasActiveInitialPaymentHold,
    COALESCE(guardian_account.full_name, registration_draft.guardian_full_name) AS guardianName,
    COALESCE(guardian_account.primary_phone, registration_draft.primary_phone) AS primaryPhone,
    COALESCE(guardian_account.secondary_phone, registration_draft.secondary_phone) AS secondaryPhone,
    COALESCE(guardian_account.facebook_name, registration_draft.facebook_name) AS guardianFacebookName,
    registration_draft.email, registration_draft.verified_at AS verifiedAt,
    class_session.display_label AS classLabel, class_session.weekday AS weekday,
    class_session.start_time AS startTime, class_session.end_time AS endTime,
    (SELECT later.id FROM payment_installment AS later WHERE later.registration_draft_child_id = registration_draft_child.id
      AND later.installment_kind = 'later' ORDER BY later.installment_number LIMIT 1) AS laterInstallmentId,
    (SELECT later.amount_mnt FROM payment_installment AS later WHERE later.registration_draft_child_id = registration_draft_child.id
      AND later.installment_kind = 'later' ORDER BY later.installment_number LIMIT 1) AS laterAmountMnt,
    (SELECT COALESCE(SUM(CASE WHEN later_confirmation.status = 'undone' THEN 0 ELSE later_allocation.allocated_amount_mnt END), 0)
        + COALESCE((SELECT SUM(-credit_entry.amount_mnt) FROM child_credit_entry AS credit_entry
          WHERE credit_entry.payment_installment_id = later.id AND credit_entry.entry_kind = 'credit_application'), 0)
      FROM payment_installment AS later
      LEFT JOIN payment_allocation AS later_allocation ON later_allocation.payment_installment_id = later.id
      LEFT JOIN payment_confirmation AS later_confirmation ON later_confirmation.received_payment_id = later_allocation.received_payment_id
      WHERE later.registration_draft_child_id = registration_draft_child.id AND later.installment_kind = 'later') AS laterAllocatedAmountMnt,
    (SELECT COALESCE(SUM(CASE WHEN later_confirmation.status = 'undone' THEN 0 ELSE later_allocation.allocated_amount_mnt END), 0)
      FROM payment_installment AS later
      LEFT JOIN payment_allocation AS later_allocation ON later_allocation.payment_installment_id = later.id
      LEFT JOIN payment_confirmation AS later_confirmation ON later_confirmation.received_payment_id = later_allocation.received_payment_id
      WHERE later.registration_draft_child_id = registration_draft_child.id AND later.installment_kind = 'later') AS laterCashAllocatedAmountMnt,
    (SELECT later.effective_due_at FROM payment_installment AS later WHERE later.registration_draft_child_id = registration_draft_child.id
      AND later.installment_kind = 'later' ORDER BY later.installment_number LIMIT 1) AS laterDueAt,
    MAX(CASE WHEN payment_confirmation.status = 'tentative' THEN received_payment.id END) AS tentativePaymentId,
    MAX(CASE WHEN payment_confirmation.status = 'tentative' THEN payment_confirmation.finalize_after END) AS finalizeAfter,
    MAX(CASE WHEN payment_confirmation.status IN ('tentative', 'finalized') THEN payment_confirmation.seat_confirmation_approved ELSE 0 END) AS seatConfirmationApproved,
    EXISTS(SELECT 1 FROM payment_confirmation AS unapproved_confirmation
      INNER JOIN payment_allocation AS unapproved_allocation ON unapproved_allocation.received_payment_id = unapproved_confirmation.received_payment_id
      INNER JOIN payment_installment AS unapproved_installment ON unapproved_installment.id = unapproved_allocation.payment_installment_id
      WHERE unapproved_confirmation.payment_request_id = payment_request.id
        AND unapproved_confirmation.status IN ('tentative', 'finalized')
        AND unapproved_confirmation.seat_confirmation_approved = 0
        AND unapproved_installment.registration_draft_child_id = registration_draft_child.id
        AND unapproved_installment.installment_kind = 'initial') AS hasUnapprovedInitialConfirmation,
    (SELECT confirmation.remaining_payment_due_at FROM payment_confirmation AS confirmation
      WHERE confirmation.payment_request_id = payment_request.id
        AND confirmation.status IN ('tentative', 'finalized')
        AND confirmation.remaining_payment_due_at IS NOT NULL
      ORDER BY confirmation.created_at DESC, confirmation.id DESC LIMIT 1) AS remainingPaymentDueAt,
    COALESCE(
      (SELECT code FROM enrollment_referral_code
        WHERE enrollment_id = registration_draft_child.canonical_enrollment_id AND status = 'active'
        ORDER BY activated_at DESC, id DESC LIMIT 1),
      (SELECT code FROM enrollment_referral_code
        INNER JOIN enrollment AS referral_enrollment ON referral_enrollment.id = enrollment_referral_code.enrollment_id
        WHERE enrollment_referral_code.student_id = registration_draft_child.canonical_student_id
          AND enrollment_referral_code.status = 'active' AND referral_enrollment.status = 'confirmed'
          AND referral_enrollment.transferred_out_at IS NULL
        ORDER BY enrollment_referral_code.activated_at ASC, enrollment_referral_code.id ASC LIMIT 1)
    ) AS ownReferralCode,
    (SELECT captured_code FROM registration_draft_referral
      WHERE registration_draft_child_id = registration_draft_child.id AND status = 'captured'
      ORDER BY created_at DESC LIMIT 1) AS usedReferralCode,
    EXISTS(SELECT 1 FROM payment_evidence AS claim WHERE claim.payment_request_id = payment_request.id
      AND claim.evidence_type = 'parent_claim' AND NOT EXISTS(SELECT 1 FROM payment_evidence AS resolution
        WHERE resolution.payment_request_id = claim.payment_request_id
          AND resolution.recorded_at >= claim.recorded_at
          AND resolution.evidence_type IN ('staff_manual_bank', 'staff_manual_cash', 'bank_statement', 'bank_sms', 'bank_api', 'qpay', 'staff_checked_not_found')))
      AS parentClaimed,
    (SELECT MAX(recorded_at) FROM payment_evidence AS checked WHERE checked.payment_request_id = payment_request.id
      AND checked.evidence_type = 'staff_checked_not_found') AS lastCheckedAt,
    (SELECT pending.target_registration_draft_child_id FROM additional_class_admission AS pending
      WHERE pending.source_registration_draft_child_id = registration_draft_child.id
        AND pending.status = 'pending_confirmation' ORDER BY pending.created_at DESC LIMIT 1) AS pendingAdditionalTargetChildId,
    (SELECT target.surname || ' ' || target.given_name FROM additional_class_admission AS pending
      INNER JOIN registration_draft_child AS target ON target.id = pending.target_registration_draft_child_id
      WHERE pending.source_registration_draft_child_id = registration_draft_child.id
        AND pending.status = 'pending_confirmation' ORDER BY pending.created_at DESC LIMIT 1) AS pendingAdditionalTargetChildName,
    (SELECT target_class.display_label FROM additional_class_admission AS pending
      INNER JOIN registration_draft_child AS target ON target.id = pending.target_registration_draft_child_id
      INNER JOIN class_session AS target_class ON target_class.id = target.selected_class_session_id
      WHERE pending.source_registration_draft_child_id = registration_draft_child.id
        AND pending.status = 'pending_confirmation' ORDER BY pending.created_at DESC LIMIT 1) AS pendingAdditionalTargetClassLabel,
    (SELECT target_class.weekday FROM additional_class_admission AS pending
      INNER JOIN registration_draft_child AS target ON target.id = pending.target_registration_draft_child_id
      INNER JOIN class_session AS target_class ON target_class.id = target.selected_class_session_id
      WHERE pending.source_registration_draft_child_id = registration_draft_child.id
        AND pending.status = 'pending_confirmation' ORDER BY pending.created_at DESC LIMIT 1) AS pendingAdditionalTargetWeekday,
    (SELECT target_class.start_time FROM additional_class_admission AS pending
      INNER JOIN registration_draft_child AS target ON target.id = pending.target_registration_draft_child_id
      INNER JOIN class_session AS target_class ON target_class.id = target.selected_class_session_id
      WHERE pending.source_registration_draft_child_id = registration_draft_child.id
        AND pending.status = 'pending_confirmation' ORDER BY pending.created_at DESC LIMIT 1) AS pendingAdditionalTargetStartTime,
    (SELECT target_class.end_time FROM additional_class_admission AS pending
      INNER JOIN registration_draft_child AS target ON target.id = pending.target_registration_draft_child_id
      INNER JOIN class_session AS target_class ON target_class.id = target.selected_class_session_id
      WHERE pending.source_registration_draft_child_id = registration_draft_child.id
        AND pending.status = 'pending_confirmation' ORDER BY pending.created_at DESC LIMIT 1) AS pendingAdditionalTargetEndTime,
    (SELECT pending.confirmation_claim_expires_at FROM additional_class_admission AS pending
      WHERE pending.source_registration_draft_child_id = registration_draft_child.id
        AND pending.status = 'pending_confirmation' ORDER BY pending.created_at DESC LIMIT 1) AS pendingAdditionalClaimExpiresAt,
    (SELECT pending.confirmation_last_error_code FROM additional_class_admission AS pending
      WHERE pending.source_registration_draft_child_id = registration_draft_child.id
        AND pending.status = 'pending_confirmation' ORDER BY pending.created_at DESC LIMIT 1) AS pendingAdditionalLastErrorCode
    FROM payment_installment
    INNER JOIN payment_request ON payment_request.id = payment_installment.payment_request_id
    INNER JOIN registration_draft_child ON registration_draft_child.id = payment_installment.registration_draft_child_id
    INNER JOIN registration_draft ON registration_draft.id = payment_request.registration_draft_id
    LEFT JOIN guardian_account ON guardian_account.id = registration_draft.canonical_guardian_account_id
    LEFT JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
    LEFT JOIN registration_capacity_hold ON registration_capacity_hold.registration_draft_child_id = registration_draft_child.id
      AND registration_capacity_hold.hold_type = 'initial_payment' AND registration_capacity_hold.status = 'active'
    INNER JOIN class_session ON class_session.id = COALESCE(registration_capacity_hold.class_session_id, registration_draft_child.selected_class_session_id)
    LEFT JOIN payment_allocation ON payment_allocation.payment_installment_id = payment_installment.id
    LEFT JOIN received_payment ON received_payment.id = payment_allocation.received_payment_id
    LEFT JOIN payment_confirmation ON payment_confirmation.received_payment_id = received_payment.id
    WHERE payment_installment.installment_kind = 'initial'
      AND payment_installment.status IN ('pending', 'partially_paid', 'paid')
      AND registration_draft.status != 'cancelled'
      AND registration_draft_child.status != 'cancelled'
    GROUP BY payment_installment.id
    ORDER BY parentClaimed DESC, payment_installment.effective_due_at < ? DESC,
      payment_installment.effective_due_at ASC, payment_request.created_at ASC`).bind(now).all<Record<string, unknown>>();
  const credits = await env.DB.prepare(`SELECT payment_credit.id, payment_credit.available_amount_mnt AS availableAmountMnt,
    registration_draft.guardian_full_name AS guardianName, payment_request.payment_reference AS paymentReference,
    GROUP_CONCAT(DISTINCT registration_draft_child.surname || ' ' || registration_draft_child.given_name) AS childNames
    FROM payment_credit
    INNER JOIN payment_request ON payment_request.id = payment_credit.payment_request_id
    INNER JOIN payment_installment ON payment_installment.payment_request_id = payment_request.id AND payment_installment.installment_kind = 'initial'
    INNER JOIN registration_draft_child ON registration_draft_child.id = payment_installment.registration_draft_child_id
    INNER JOIN registration_draft ON registration_draft.id = payment_request.registration_draft_id
    WHERE payment_credit.status = 'available'
    GROUP BY payment_credit.id
    ORDER BY payment_credit.created_at`).all<Record<string, unknown>>();
  const discountCredits = await env.DB.prepare(`SELECT root.id,
    root.amount_mnt + COALESCE(SUM(debit.amount_mnt), 0) - root.reserved_amount_mnt AS availableAmountMnt,
    registration_draft.guardian_full_name AS guardianName,
    registration_draft_child.surname || ' ' || registration_draft_child.given_name AS childNames,
    discount_award.award_type AS awardType
    FROM child_credit_entry AS root
    INNER JOIN discount_award ON discount_award.id = root.source_discount_award_id
    INNER JOIN registration_draft_child ON registration_draft_child.id = root.registration_draft_child_id
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    LEFT JOIN child_credit_entry AS debit ON debit.origin_entry_id = root.id
    WHERE discount_award.status = 'active' AND root.entry_kind = 'discount_award_credit'
    GROUP BY root.id HAVING root.amount_mnt + COALESCE(SUM(debit.amount_mnt), 0) - root.reserved_amount_mnt > 0
    ORDER BY root.created_at`).all<Record<string, unknown>>();
  const cancelled = await env.DB.prepare(`SELECT registration_draft_child.id AS registrationDraftChildId,
    registration_draft_child.surname || ' ' || registration_draft_child.given_name AS childName,
    registration_draft.guardian_full_name AS guardianName, class_session.display_label AS classLabel,
    class_session.weekday, class_session.start_time AS startTime, class_session.end_time AS endTime,
    enrollment.cancelled_at AS cancelledAt, audit_event.metadata_json AS cancellationMetadata
    FROM registration_draft_child
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    LEFT JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id
    LEFT JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
    LEFT JOIN audit_event ON audit_event.subject_type = 'registration_draft_child'
      AND audit_event.subject_id = registration_draft_child.id AND audit_event.action = 'registration_cancelled'
    WHERE registration_draft_child.status = 'cancelled'
    ORDER BY COALESCE(enrollment.cancelled_at, audit_event.occurred_at, registration_draft_child.updated_at) DESC LIMIT 50`).all<Record<string, unknown>>();
  const capacityRows = await getClassCapacityProjections(env.DB, env.APP_ENV, nowDate);
  const capacityLabels = await env.DB.prepare(`SELECT id, display_label AS classLabel, weekday, start_time AS startTime, end_time AS endTime
    FROM class_session WHERE status IN ('available', 'full')${env.APP_ENV === "production" ? " AND is_test = 0 AND is_test_only = 0" : ""}
    ORDER BY CASE stage_code WHEN 'stage_1' THEN 1 WHEN 'stage_2' THEN 2 WHEN 'stage_3' THEN 3 ELSE 9 END,
      CASE weekday WHEN 'Даваа' THEN 1 WHEN 'Мягмар' THEN 2 WHEN 'Лхагва' THEN 3 WHEN 'Пүрэв' THEN 4 WHEN 'Баасан' THEN 5 WHEN 'Бямба' THEN 6 WHEN 'Ням' THEN 7 ELSE 9 END,
      start_time, id`).all<{ id: string; classLabel: string; weekday: string; startTime: string; endTime: string }>();
  const capacityById = new Map(capacityRows.map((row) => [row.classSessionId, row]));
  const capacity = capacityLabels.results.map((label) => ({ ...label, ...(capacityById.get(label.id) ?? {
    capacity: 0, confirmedCount: 0, reservedInitialPaymentCount: 0, identityReviewCount: 0,
    legacyReservationCount: 0, offeredWaitlistCount: 0, waitlistCount: 0, freeSeats: 0,
  }) }));
  const rawItems = result.results.map((item) => ({ ...item,
    expectedAmountMnt: Number(item.expectedAmountMnt), allocatedAmountMnt: Number(item.allocatedAmountMnt),
    cashAllocatedAmountMnt: Number(item.cashAllocatedAmountMnt),
    parentClaimed: Boolean(item.parentClaimed), laterAmountMnt: item.laterAmountMnt == null ? null : Number(item.laterAmountMnt),
    laterAllocatedAmountMnt: Number(item.laterAllocatedAmountMnt ?? 0),
    laterCashAllocatedAmountMnt: Number(item.laterCashAllocatedAmountMnt ?? 0),
  })) as Array<Record<string, unknown> & { installmentId: string; registrationDraftChildId: string; expectedAmountMnt: number; allocatedAmountMnt: number; cashAllocatedAmountMnt: number; parentClaimed: boolean; laterInstallmentId: string | null; laterAmountMnt: number | null; laterAllocatedAmountMnt: number; laterCashAllocatedAmountMnt: number }>;
  const effectiveById = new Map((await effectiveInstallmentsForRows(env.DB, rawItems.flatMap((item) => [
    {
    id: String(item.installmentId), registrationDraftChildId: String(item.registrationDraftChildId), installmentNumber: 1,
    amountMnt: Number(item.expectedAmountMnt), allocatedAmountMnt: Number(item.allocatedAmountMnt),
    },
    item.laterInstallmentId && item.laterAmountMnt != null ? {
      id: String(item.laterInstallmentId), registrationDraftChildId: String(item.registrationDraftChildId), installmentNumber: 2,
      amountMnt: Number(item.laterAmountMnt), allocatedAmountMnt: Number(item.laterAllocatedAmountMnt),
    } : null,
  ].filter(Boolean) as Array<{ id: string; registrationDraftChildId: string; installmentNumber: number; amountMnt: number }>))).map((item) => [item.id, item]));
  const settlementByInstallment = new Map(await Promise.all(rawItems.map(async (item) => {
    const effective = effectiveById.get(String(item.installmentId));
    return [String(item.installmentId), await pendingAdditionalClassCashSettlement(env.DB, {
      registrationDraftChildId: String(item.registrationDraftChildId),
      paymentInstallmentId: String(item.installmentId),
      effectiveAmountMnt: Number(effective?.effectiveAmountMnt ?? item.expectedAmountMnt),
      allocatedAmountMnt: item.allocatedAmountMnt,
    })] as const;
  })));
  const awardByChild = await discountAwardsForChildren(env.DB, rawItems.map((item) => String(item.registrationDraftChildId)), true);
  const awardIds = [...awardByChild.values()].flat().map((award) => award.id);
  const awardCreditRows = awardIds.length ? await env.DB.prepare(`SELECT root.source_discount_award_id AS awardId,
      root.amount_mnt AS rootAmountMnt, root.reserved_amount_mnt AS reservedAmountMnt,
      COALESCE(SUM(CASE WHEN debit.amount_mnt < 0 THEN -debit.amount_mnt ELSE 0 END), 0) AS usedAmountMnt,
      root.amount_mnt + COALESCE(SUM(debit.amount_mnt), 0) - root.reserved_amount_mnt AS availableAmountMnt
    FROM child_credit_entry AS root
    LEFT JOIN child_credit_entry AS debit ON debit.origin_entry_id = root.id
    WHERE root.source_discount_award_id IN (${awardIds.map(() => "?").join(", ")})
    GROUP BY root.id`).bind(...awardIds).all<{ awardId: string; rootAmountMnt: number; reservedAmountMnt: number; usedAmountMnt: number; availableAmountMnt: number }>() : { results: [] };
  const awardCreditById = new Map(awardCreditRows.results.map((row) => [row.awardId, {
    rootAmountMnt: Number(row.rootAmountMnt), reservedAmountMnt: Number(row.reservedAmountMnt),
    usedAmountMnt: Number(row.usedAmountMnt), availableAmountMnt: Number(row.availableAmountMnt),
  }]));
  const creditByChild = await childCreditSummaryForChildren(env.DB, rawItems.map((item) => String(item.registrationDraftChildId)));
  const creditReviewByInstallment = new Map(await Promise.all(rawItems.flatMap((item) => [
    { childId: String(item.registrationDraftChildId), installmentId: String(item.installmentId) },
    ...(item.laterInstallmentId ? [{ childId: String(item.registrationDraftChildId), installmentId: String(item.laterInstallmentId) }] : []),
  ]).map(async ({ childId, installmentId }) => {
    try { return [installmentId, await creditPaymentReviewState(env.DB, childId, installmentId)] as const; }
    catch { return [installmentId, null] as const; }
  })));
  const familySuggestionByChild = new Map(await Promise.all(
    hasStaffCapability(actor, "payment.manage") ? rawItems.map(async (item) => {
      const childId = String(item.registrationDraftChildId);
      try {
        const suggestions = await familyCreditSuggestionsForChild(env, childId);
        return [childId, suggestions.find((suggestion) => suggestion.recipientChildId === childId) ?? null] as const;
      } catch { return [childId, null] as const; }
    }) : [],
  ));
  const cancelledItems = await Promise.all(cancelled.results.map(async (item) => ({
    ...item,
    canReinstate: hasStaffCapability(actor, "registration.manage")
      && await getRegistrationReinstatementEligibility(env, String(item.registrationDraftChildId), nowDate),
  })));
  return { now, canManageDiscounts: hasStaffCapability(actor, "admin.settings.manage"),
  canManageCredits: hasStaffCapability(actor, "payment.manage"),
  canManageReferrals: hasStaffCapability(actor, "registration.manage"),
  canContactParents: hasStaffCapability(actor, "registration.manage"),
  canCorrectRegistrations: hasStaffCapability(actor, "registration.manage"),
  canManageAdditionalClasses: hasStaffCapability(actor, "registration.manage"),
  canManageFamilyDiscounts: hasStaffCapability(actor, "registration.manage"),
  canManageTransfers: hasStaffCapability(actor, "registration.manage"),
  canCancelRegistrations: hasStaffCapability(actor, "registration.manage"), items: rawItems.map((item) => {
    const effective = effectiveById.get(String(item.installmentId));
    const later = item.laterInstallmentId ? effectiveById.get(String(item.laterInstallmentId)) : null;
    const awards = (awardByChild.get(String(item.registrationDraftChildId)) ?? []).map((award) => ({ ...award,
      creditState: awardCreditById.get(award.id) ?? null,
    }));
    const expectedAmountMnt = effective?.effectiveAmountMnt ?? item.expectedAmountMnt;
    const totalExpectedMnt = expectedAmountMnt + Number(later?.effectiveAmountMnt ?? 0);
    const totalPaidMnt = item.cashAllocatedAmountMnt + item.laterCashAllocatedAmountMnt;
    const totalCreditAppliedMnt = item.allocatedAmountMnt + item.laterAllocatedAmountMnt - totalPaidMnt;
    const credit = creditByChild.get(String(item.registrationDraftChildId));
    const initialOutstandingMnt = Math.max(0, expectedAmountMnt - item.allocatedAmountMnt);
    const settlement = settlementByInstallment.get(String(item.installmentId)) ?? null;
    const reservedCreditMnt = settlement?.reservedCreditMnt ?? 0;
    const cashRequiredMnt = settlement?.cashRequiredMnt ?? initialOutstandingMnt;
    const laterOutstandingMnt = later && item.laterInstallmentId
      ? Math.max(0, Number(later.effectiveAmountMnt) - item.laterAllocatedAmountMnt) : 0;
    // A two-installment agreement's first installment is deliberately
    // cash-only. Credit review belongs to its final scheduled installment,
    // even while the first installment is still outstanding.
    const creditMaySettleInitial = item.paymentPlanCode !== "two_installment";
    const creditApplicationInstallmentId = creditMaySettleInitial && initialOutstandingMnt > 0 ? String(item.installmentId)
      : laterOutstandingMnt > 0 ? String(item.laterInstallmentId) : null;
    const creditApplicationOutstandingMnt = creditMaySettleInitial && initialOutstandingMnt > 0 ? initialOutstandingMnt : laterOutstandingMnt;
    const creditReview = creditApplicationInstallmentId ? creditReviewByInstallment.get(creditApplicationInstallmentId) : null;
    return { ...item, expectedAmountMnt,
      laterAmountMnt: later?.effectiveAmountMnt ?? item.laterAmountMnt,
      totalPaidMnt,
      totalCreditAppliedMnt,
      reservedCreditMnt,
      cashRequiredMnt,
    totalRemainingMnt: Math.max(0, totalExpectedMnt - item.allocatedAmountMnt - item.laterAllocatedAmountMnt),
      availableCreditMnt: credit?.availableAmountMnt ?? 0,
      creditEntries: credit?.roots ?? [],
      creditApplicationInstallmentId,
      creditApplicationOutstandingMnt,
      creditReviewNeeded: Boolean(creditReview && creditReview.availableCreditMnt > 0 && creditReview.outstandingAmountMnt > 0 && !creditReview.reviewed),
      creditReviewResolved: Boolean(creditReview?.reviewed),
      familyCreditSuggestion: familySuggestionByChild.get(String(item.registrationDraftChildId)) ?? null,
      discountAmountMnt: effective?.discountAmountMnt ?? 0, discounts: awards,
      canConfirmSeat: !item.canonicalEnrollmentId && !Boolean(item.seatConfirmationApproved)
        && Boolean(item.hasUnapprovedInitialConfirmation) && item.allocatedAmountMnt >= expectedAmountMnt };
  }), credits: [
    ...credits.results.map((item) => ({ ...item, availableAmountMnt: Number(item.availableAmountMnt), creditKind: "payment" })),
    ...discountCredits.results.map((item) => ({ ...item, availableAmountMnt: Number(item.availableAmountMnt), creditKind: "discount" })),
  ],
  capacity, cancelledItems,
  waitlistItems: (await env.DB.prepare(`SELECT registration_draft_waitlist_entry.id, registration_draft_waitlist_entry.created_at AS createdAt,
    registration_draft_child.surname || ' ' || registration_draft_child.given_name AS childName,
    registration_draft.guardian_full_name AS guardianName, registration_draft.primary_phone AS primaryPhone, registration_draft.email, registration_draft.facebook_name AS guardianFacebookName,
    registration_draft_child.facebook_name AS childFacebookName, class_session.display_label AS classLabel,
    class_session.weekday AS weekday, class_session.start_time AS startTime, class_session.end_time AS endTime,
    (SELECT COUNT(*) FROM registration_draft_waitlist_entry AS earlier WHERE earlier.class_session_id = registration_draft_waitlist_entry.class_session_id
      AND earlier.status = 'active' AND (earlier.created_at < registration_draft_waitlist_entry.created_at OR (earlier.created_at = registration_draft_waitlist_entry.created_at AND earlier.id <= registration_draft_waitlist_entry.id))) AS fifoPosition
    FROM registration_draft_waitlist_entry
    INNER JOIN registration_draft_child ON registration_draft_child.id = registration_draft_waitlist_entry.registration_draft_child_id
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    INNER JOIN class_session ON class_session.id = registration_draft_waitlist_entry.class_session_id
    WHERE registration_draft_waitlist_entry.status = 'active'
    ORDER BY registration_draft_waitlist_entry.created_at ASC LIMIT 100`).all<Record<string, unknown>>()).results,
  waitlistOffers: (await env.DB.prepare(`SELECT waitlist_seat_offer.id, waitlist_seat_offer.status,
    waitlist_seat_offer.offered_at AS offeredAt, waitlist_seat_offer.respond_by_at AS respondByAt,
    waitlist_seat_offer.contact_last_at AS contactLastAt, waitlist_seat_offer.contact_last_channel AS contactLastChannel,
    registration_draft_child.surname || ' ' || registration_draft_child.given_name AS childName,
    registration_draft.guardian_full_name AS guardianName, registration_draft.primary_phone AS primaryPhone,
    registration_draft.email, registration_draft.facebook_name AS guardianFacebookName, registration_draft_child.facebook_name AS childFacebookName,
    class_session.display_label AS classLabel, class_session.weekday, class_session.start_time AS startTime, class_session.end_time AS endTime,
    EXISTS(SELECT 1 FROM registration_draft_child AS backup WHERE backup.id = registration_draft_child.id AND backup.canonical_enrollment_id IS NOT NULL) AS hasBackupEnrollment
    FROM waitlist_seat_offer
    INNER JOIN registration_draft_child ON registration_draft_child.id = waitlist_seat_offer.registration_draft_child_id
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    INNER JOIN class_session ON class_session.id = waitlist_seat_offer.class_session_id
    WHERE waitlist_seat_offer.status IN ('active', 'awaiting_transfer')
    ORDER BY waitlist_seat_offer.respond_by_at, waitlist_seat_offer.offered_at LIMIT 100`).all<Record<string, unknown>>()).results,
  recentWaitlistResponses: (await env.DB.prepare(`SELECT waitlist_seat_offer.id, waitlist_seat_offer.status,
    waitlist_seat_offer.resolved_at AS resolvedAt, registration_draft_child.surname || ' ' || registration_draft_child.given_name AS childName,
    registration_draft.guardian_full_name AS guardianName, registration_draft.primary_phone AS primaryPhone,
    class_session.display_label AS classLabel, class_session.weekday, class_session.start_time AS startTime, class_session.end_time AS endTime
    FROM waitlist_seat_offer
    INNER JOIN registration_draft_child ON registration_draft_child.id = waitlist_seat_offer.registration_draft_child_id
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    INNER JOIN class_session ON class_session.id = waitlist_seat_offer.class_session_id
    WHERE waitlist_seat_offer.status IN ('converted', 'declined') AND waitlist_seat_offer.resolved_at >= datetime(?, '-7 days')
    ORDER BY waitlist_seat_offer.resolved_at DESC LIMIT 20`).bind(now).all<Record<string, unknown>>()).results };
}

/**
 * A deliberately small export projection. It is separate from the richer
 * payment queue so the browser never needs opaque IDs, tokens, outbox content,
 * or authentication state merely to create a spreadsheet.
 */
export async function getRegistrationExportRows(env: WorkerEnv, actor: StaffPrincipal) {
  if (!hasStaffCapability(actor, "registration.view") || !hasStaffCapability(actor, "payment.view")) {
    throw new PaymentReconciliationError("forbidden");
  }
  const rows = await env.DB.prepare(`SELECT
    registration_draft_child.status AS childStatus,
    registration_draft.status AS draftStatus,
    registration_draft_child.surname || ' ' || registration_draft_child.given_name AS child,
    registration_draft_child.date_of_birth AS birthDate,
    registration_draft_child.current_grade AS grade,
    registration_draft_child.current_school AS school,
    registration_draft.guardian_full_name AS guardian,
    registration_draft.guardian_relationship AS relationship,
    registration_draft.primary_phone AS phone,
    registration_draft.secondary_phone AS secondaryPhone,
    registration_draft.email,
    registration_draft.verified_at AS verifiedAt,
    registration_draft.home_address AS address,
    academic_year.public_label AS academicYear,
    activity_offering.title AS offering,
    class_session.display_label || class_session.weekday || '' AS className,
    class_session.weekday, class_session.start_time AS startTime, class_session.end_time AS endTime,
    registration_draft_child.payment_plan_code AS paymentPlan,
    registration_draft.created_at AS registeredAt,
    registration_draft_child.id AS childId, registration_draft_child.canonical_enrollment_id AS canonicalEnrollmentId,
    (SELECT COALESCE(SUM(amount_mnt), 0) FROM payment_installment WHERE registration_draft_child_id = registration_draft_child.id) AS price,
    (SELECT COALESCE(SUM(award_amount_mnt), 0) FROM discount_award WHERE registration_draft_child_id = registration_draft_child.id AND status = 'active') AS discount,
    (SELECT COALESCE(SUM(allocation.allocated_amount_mnt), 0)
      FROM payment_allocation AS allocation
      INNER JOIN received_payment AS payment ON payment.id = allocation.received_payment_id
      LEFT JOIN payment_confirmation AS confirmation ON confirmation.received_payment_id = payment.id
      INNER JOIN payment_installment AS installment ON installment.id = allocation.payment_installment_id
      WHERE installment.registration_draft_child_id = registration_draft_child.id
        AND COALESCE(confirmation.status, '') != 'undone') AS paid,
    (SELECT COALESCE(SUM(-credit_entry.amount_mnt), 0)
      FROM child_credit_entry AS credit_entry
      INNER JOIN payment_installment AS installment ON installment.id = credit_entry.payment_installment_id
      WHERE installment.registration_draft_child_id = registration_draft_child.id
        AND credit_entry.entry_kind = 'credit_application') AS creditApplied,
    (SELECT effective_due_at FROM payment_installment WHERE registration_draft_child_id = registration_draft_child.id
      AND status IN ('pending', 'partially_paid') ORDER BY installment_number LIMIT 1) AS dueAt,
    COALESCE(
      (SELECT code FROM enrollment_referral_code WHERE enrollment_id = registration_draft_child.canonical_enrollment_id
        AND status = 'active' ORDER BY activated_at DESC, id DESC LIMIT 1),
      (SELECT code FROM enrollment_referral_code
        INNER JOIN enrollment AS referral_enrollment ON referral_enrollment.id = enrollment_referral_code.enrollment_id
        WHERE enrollment_referral_code.student_id = registration_draft_child.canonical_student_id
          AND enrollment_referral_code.status = 'active' AND referral_enrollment.status = 'confirmed'
          AND referral_enrollment.transferred_out_at IS NULL
        ORDER BY enrollment_referral_code.activated_at ASC, enrollment_referral_code.id ASC LIMIT 1)
    ) AS ownReferral,
    (SELECT captured_code FROM registration_draft_referral WHERE registration_draft_child_id = registration_draft_child.id
      AND status = 'captured' ORDER BY created_at DESC LIMIT 1) AS usedReferral
    FROM registration_draft_child
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    INNER JOIN academic_year ON academic_year.id = registration_draft.academic_year_id
    LEFT JOIN class_session ON class_session.id = COALESCE(registration_draft_child.selected_class_session_id, registration_draft_child.preferred_waitlist_class_session_id)
    LEFT JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
    ORDER BY registration_draft_child.id`).all<Record<string, unknown>>();
  const now = new Date();
  const statusRank: Record<string, number> = {
    "Төлбөр баталгаажсан": 10,
    "Хэсэгчлэн төлсөн": 20,
    "Хугацаа хэтэрсэн": 30,
    "Төлбөр хүлээж байна": 40,
    "Шалгах шаардлагатай": 50,
    "Кредит / буцаалт": 60,
    "Хүлээлгийн жагсаалт": 70,
    "Цуцлагдсан": 99,
  };
  const planLabel = (code: unknown) => code === "single" ? "Нэг удаа"
    : code === "two_installment" ? "2 хувааж"
      : "Тодруулаагүй";
  const projected = rows.results.map((row) => {
      const price = Number(row.price ?? 0);
      const discount = Number(row.discount ?? 0);
      const paid = Number(row.paid ?? 0);
      const creditApplied = Number(row.creditApplied ?? 0);
      const remaining = Math.max(price - discount - paid - creditApplied, 0);
      const dueAt = typeof row.dueAt === "string" ? row.dueAt : null;
      const due = dueAt && new Date(dueAt).getTime() < now.getTime();
      const status = row.childStatus === "cancelled" || row.draftStatus === "cancelled" ? "Цуцлагдсан"
        : row.childStatus === "waitlisted" ? "Хүлээлгийн жагсаалт"
          : row.childStatus === "seat_unavailable" ? "Шалгах шаардлагатай"
            : row.canonicalEnrollmentId ? (remaining > 0 ? "Хэсэгчлэн төлсөн" : "Төлбөр баталгаажсан")
              : due ? "Хугацаа хэтэрсэн"
                : "Төлбөр хүлээж байна";
      const className = [row.className, row.weekday && row.startTime ? `${row.weekday} ${row.startTime}–${row.endTime}` : ""].filter(Boolean).join(" · ");
      return {
        status, child: row.child, birthDate: row.birthDate, grade: row.grade, school: row.school,
        guardian: row.guardian, relationship: row.relationship, phone: row.phone, secondaryPhone: row.secondaryPhone, email: row.email,
        emailStatus: row.verifiedAt ? "Баталгаажсан" : "Баталгаажаагүй", address: row.address,
        academicYear: row.academicYear, offering: row.offering, className,
        paymentPlan: planLabel(row.paymentPlan),
        price, discount, paid, creditApplied, remaining, dueAt,
        ownReferral: row.ownReferral, usedReferral: row.usedReferral, registeredAt: row.registeredAt,
        sortSchedule: `${row.weekday ?? ""}\u0000${row.startTime ?? ""}\u0000${row.endTime ?? ""}`,
        sortClassName: className, sortChild: String(row.child ?? ""), sortId: String(row.childId ?? ""),
      };
    });
  return {
    generatedAt: new Date().toISOString(),
    rows: projected.sort((left, right) => (statusRank[left.status] ?? 80) - (statusRank[right.status] ?? 80)
      || left.sortSchedule.localeCompare(right.sortSchedule, "mn")
      || left.sortClassName.localeCompare(right.sortClassName, "mn")
      || left.sortChild.localeCompare(right.sortChild, "mn")
      || left.sortId.localeCompare(right.sortId)).map(({ sortSchedule, sortClassName, sortChild, sortId, ...row }) => row),
  };
}

export async function recordManualPayment(env: WorkerEnv, actor: StaffPrincipal, input: {
  paymentRequestId: string; allocations: Array<{ installmentId: string; amountMnt: number }>;
  source: PaymentSource; receivedAt?: string; receivedAmountMnt?: number; idempotencyKey: string;
  approveSeatConfirmation?: boolean; remainingPaymentDueAt?: string; proceedWithoutFamilyCredit?: boolean;
}, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "payment.manage")) throw new PaymentReconciliationError("forbidden");
  if (!input.idempotencyKey || input.idempotencyKey.length > 160 || !["staff_manual_bank", "staff_manual_cash"].includes(input.source)) {
    throw new PaymentReconciliationError("invalid");
  }
  const request = await requestForId(env, input.paymentRequestId);
  const existing = await env.DB.prepare(`SELECT id FROM received_payment WHERE idempotency_key = ?`).bind(input.idempotencyKey).first<{ id: string }>();
  if (existing) return { id: existing.id, idempotent: true };
  const receivedAt = iso(input.receivedAt) ?? nowDate.toISOString();
  const allocations = input.allocations.map((item) => ({ installmentId: String(item.installmentId ?? ""), amountMnt: positive(item.amountMnt) }));
  if (!allocations.length || allocations.some((item) => !item.installmentId || !item.amountMnt)) throw new PaymentReconciliationError("invalid");
  const installments = await installmentsForRequest(env, request.id);
  let total = 0;
  const allocatedByInstallment = new Map<string, number>();
  for (const allocation of allocations) {
    allocatedByInstallment.set(allocation.installmentId, (allocatedByInstallment.get(allocation.installmentId) ?? 0) + (allocation.amountMnt ?? 0));
  }
  for (const [installmentId, allocatedAmount] of allocatedByInstallment) {
    const installment = installments.find((item) => item.id === installmentId);
    if (!installment || installment.status === "released" || installment.allocatedAmountMnt + allocatedAmount > installment.amountMnt) {
      throw new PaymentReconciliationError("invalid");
    }
    total += allocatedAmount;
  }
  const familySuggestions = await Promise.all([...allocatedByInstallment.keys()].map(async (installmentId) => {
    const installment = installments.find((item) => item.id === installmentId);
    if (!installment) return null;
    const suggestions = await familyCreditSuggestionsForChild(env, installment.registrationDraftChildId);
    return suggestions.find((suggestion) => suggestion.recipientChildId === installment.registrationDraftChildId
      && suggestion.paymentInstallmentId === installmentId) ?? null;
  }));
  const activeFamilySuggestion = familySuggestions.find((suggestion) => suggestion && suggestion.proposedAmountMnt > 0) ?? null;
  if (activeFamilySuggestion && input.proceedWithoutFamilyCredit !== true) throw new PaymentReconciliationError("family_credit_review_required");
  const receivedAmount = input.receivedAmountMnt == null ? total : positive(input.receivedAmountMnt);
  if (!receivedAmount || total > receivedAmount) throw new PaymentReconciliationError("invalid");
  const initialAllocated = [...allocatedByInstallment.entries()].some(([id]) => installments.find((item) => item.id === id)?.installmentKind === "initial");
  const allInitialSatisfied = installments.filter((item) => item.installmentKind === "initial")
    .every((item) => item.allocatedAmountMnt + (allocatedByInstallment.get(item.id) ?? 0) >= item.amountMnt);
  const priorConfirmation = await env.DB.prepare(`SELECT
    MAX(CASE WHEN status IN ('tentative', 'finalized') THEN seat_confirmation_approved ELSE 0 END) AS seatApproved,
    (SELECT remaining_payment_due_at FROM payment_confirmation
      WHERE payment_request_id = ? AND status IN ('tentative', 'finalized') AND remaining_payment_due_at IS NOT NULL
      ORDER BY created_at DESC, id DESC LIMIT 1) AS remainingDueAt
    FROM payment_confirmation WHERE payment_request_id = ?`).bind(request.id, request.id)
    .first<{ seatApproved: number; remainingDueAt: string | null }>();
  const priorSeatApproved = Boolean(priorConfirmation?.seatApproved);
  // Meeting the effective initial-installment obligation is the normal seat
  // confirmation threshold for either payment plan. Staff can still make the
  // exceptional, auditable choice to approve a genuinely incomplete first
  // installment, but that path requires its own remaining-payment deadline.
  const seatApprovalRequested = initialAllocated && (allInitialSatisfied || Boolean(input.approveSeatConfirmation));
  const approvedPartial = seatApprovalRequested && !allInitialSatisfied;
  if (input.approveSeatConfirmation && priorSeatApproved) throw new PaymentReconciliationError("invalid");
  const needsRemainingDeadline = initialAllocated && !allInitialSatisfied && (seatApprovalRequested || priorSeatApproved);
  const suppliedRemainingDueAt = iso(input.remainingPaymentDueAt);
  const remainingDueAt = needsRemainingDeadline ? suppliedRemainingDueAt ?? priorConfirmation?.remainingDueAt ?? null : null;
  if (needsRemainingDeadline && (!remainingDueAt || new Date(remainingDueAt) <= nowDate)) throw new PaymentReconciliationError("invalid");
  if (!needsRemainingDeadline && input.remainingPaymentDueAt) throw new PaymentReconciliationError("invalid");
  const now = nowDate.toISOString();
  const grace = await getPaymentConfirmationGraceSetting(env);
  const reminder = await getPaymentReminderSetting(env);
  const finalizeAfter = new Date(nowDate.getTime() + grace.graceMinutes * 60_000).toISOString();
  const paymentId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [env.DB.prepare(`INSERT INTO received_payment (
    id, payment_request_id, received_amount_mnt, received_at, payment_source, reconciliation_status,
    confirmed_at, confirmed_by_staff_account_id, idempotency_key, created_at, updated_at, is_test, test_run_id
  ) VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?)`)
    .bind(paymentId, request.id, receivedAmount, receivedAt, input.source, now, actor.staffAccountId, input.idempotencyKey,
      now, now, request.isTest, request.testRunId)];
  for (const allocation of allocations) {
    statements.push(env.DB.prepare(`INSERT INTO payment_allocation (
      id, received_payment_id, payment_installment_id, allocated_amount_mnt, allocated_at,
      allocated_by_staff_account_id, created_at, is_test, test_run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), paymentId, allocation.installmentId, allocation.amountMnt, now,
        actor.staffAccountId, now, request.isTest, request.testRunId));
  }
  statements.push(env.DB.prepare(`INSERT INTO payment_evidence (
    id, payment_request_id, received_payment_id, registration_draft_id, evidence_type, recorded_at,
    recorded_by_staff_account_id, metadata_json, created_at, is_test, test_run_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), request.id, paymentId, request.registrationDraftId, input.source, now,
      actor.staffAccountId, JSON.stringify({ allocationCount: allocations.length }), now, request.isTest, request.testRunId));
  statements.push(audit(env, actor, "payment_recorded", "received_payment", paymentId,
    { source: input.source, receivedAt, amountMnt: receivedAmount, allocatedAmountMnt: total, allocationCount: allocations.length, finalizeAfter, approvedPartial, seatApprovalRequested,
      ...(activeFamilySuggestion ? { familyCreditDeclined: { donorRegistrationDraftChildId: activeFamilySuggestion.donorChildId,
        recipientRegistrationDraftChildId: activeFamilySuggestion.recipientChildId, paymentInstallmentId: activeFamilySuggestion.paymentInstallmentId,
        proposedAmountMnt: activeFamilySuggestion.proposedAmountMnt } } : {}) }, request, now));
  statements.push(env.DB.prepare(`INSERT INTO payment_confirmation (
    id, received_payment_id, payment_request_id, status, finalize_after, seat_confirmation_approved,
    remaining_payment_due_at, remaining_reminder_lead_minutes, remaining_reminder_at, created_at, updated_at, is_test, test_run_id
  ) VALUES (?, ?, ?, 'tentative', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), paymentId, request.id, finalizeAfter, seatApprovalRequested ? 1 : 0, remainingDueAt,
      needsRemainingDeadline ? reminder.laterReminderLeadMinutes : null,
      needsRemainingDeadline ? new Date(new Date(remainingDueAt!).getTime() - reminder.laterReminderLeadMinutes * 60_000).toISOString() : null,
      now, now, request.isTest, request.testRunId));
  await env.DB.batch(statements);
  await Promise.all([...new Set(installments.map((item) => item.registrationDraftChildId))]
    .map((childId) => recalculateDiscountAwardBalances(env.DB, childId, now)));
  return { id: paymentId, idempotent: false, finalizeAfter, approvedPartial, seatApprovalRequested };
}

export async function confirmSeatForSufficientPayment(
  env: WorkerEnv,
  actor: StaffPrincipal,
  paymentRequestId: string,
  nowDate = new Date(),
) {
  if (!hasStaffCapability(actor, "payment.manage")) throw new PaymentReconciliationError("forbidden");
  const request = await requestForId(env, paymentRequestId);
  const installments = await installmentsForRequest(env, request.id);
  const initial = installments.filter((item) => item.installmentKind === "initial" && item.status !== "released");
  if (!initial.length || !initial.every((item) => item.allocatedAmountMnt >= item.amountMnt)) {
    throw new PaymentReconciliationError("invalid");
  }
  const confirmation = await env.DB.prepare(`SELECT payment_confirmation.id, payment_confirmation.status,
    payment_confirmation.finalize_after AS finalizeAfter
    FROM payment_confirmation
    INNER JOIN payment_allocation ON payment_allocation.received_payment_id = payment_confirmation.received_payment_id
    INNER JOIN payment_installment ON payment_installment.id = payment_allocation.payment_installment_id
    WHERE payment_confirmation.payment_request_id = ?
      AND payment_confirmation.status IN ('tentative', 'finalized')
      AND payment_confirmation.seat_confirmation_approved = 0
      AND payment_installment.installment_kind = 'initial'
    ORDER BY CASE payment_confirmation.status WHEN 'finalized' THEN 0 ELSE 1 END,
      payment_confirmation.created_at DESC, payment_confirmation.id DESC LIMIT 1`)
    .bind(request.id).first<{ id: string; status: "tentative" | "finalized"; finalizeAfter: string }>();
  if (!confirmation) {
    const alreadyConfirmed = await env.DB.prepare(`SELECT 1 AS value FROM payment_confirmation
      WHERE payment_request_id = ? AND status IN ('tentative', 'finalized') AND seat_confirmation_approved = 1 LIMIT 1`)
      .bind(request.id).first();
    if (alreadyConfirmed) return { idempotent: true, pending: false };
    throw new PaymentReconciliationError("not_found");
  }
  const now = nowDate.toISOString();
  const changed = await env.DB.prepare(`UPDATE payment_confirmation
    SET seat_confirmation_approved = 1, remaining_payment_due_at = NULL,
      remaining_reminder_lead_minutes = NULL, remaining_reminder_at = NULL, updated_at = ?
    WHERE id = ? AND status IN ('tentative', 'finalized') AND seat_confirmation_approved = 0`)
    .bind(now, confirmation.id).run();
  if (changes(changed) !== 1) throw new PaymentReconciliationError("conflict");
  await env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at)
    VALUES (?, ?, 'staff', ?, 'seat_confirmation_corrected', 'payment_confirmation', ?, '{}', ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, confirmation.id, env.APP_ENV, request.isTest, request.testRunId, now).run();
  if (confirmation.status === "tentative") {
    return { idempotent: false, pending: true, finalizeAfter: confirmation.finalizeAfter };
  }
  const promotion = await promotePaidDraftChildren(env, actor, request.registrationDraftId, nowDate);
  return { idempotent: false, pending: false, promotion };
}

export async function undoTentativePaymentConfirmation(env: WorkerEnv, actor: StaffPrincipal, receivedPaymentId: string, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "payment.manage")) throw new PaymentReconciliationError("forbidden");
  const row = await env.DB.prepare(`SELECT payment_confirmation.id, payment_confirmation.payment_request_id AS paymentRequestId,
    payment_request.registration_draft_id AS registrationDraftId, payment_request.is_test AS isTest, payment_request.test_run_id AS testRunId
    FROM payment_confirmation INNER JOIN payment_request ON payment_request.id = payment_confirmation.payment_request_id
    WHERE payment_confirmation.received_payment_id = ? AND payment_confirmation.status = 'tentative'`).bind(receivedPaymentId)
    .first<{ id: string; paymentRequestId: string; registrationDraftId: string; isTest: number; testRunId: string | null }>();
  if (!row) throw new PaymentReconciliationError("not_found");
  const now = nowDate.toISOString();
  const result = await env.DB.prepare(`UPDATE payment_confirmation SET status = 'undone', undone_at = ?, undone_by_staff_account_id = ?, updated_at = ?
    WHERE id = ? AND status = 'tentative'`).bind(now, actor.staffAccountId, now, row.id).run();
  if (changes(result) !== 1) throw new PaymentReconciliationError("conflict");
  const children = await env.DB.prepare(`SELECT DISTINCT registration_draft_child_id AS childId FROM payment_installment
    WHERE payment_request_id = ?`).bind(row.paymentRequestId).all<{ childId: string }>();
  await Promise.all(children.results.map((child) => recalculateDiscountAwardBalances(env.DB, child.childId, now)));
  await env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at) VALUES (?, ?, 'staff', ?, 'tentative_payment_undone',
    'payment_confirmation', ?, '{}', ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, row.id, env.APP_ENV, row.isTest, row.testRunId, now).run();
  return { undone: true };
}

export async function finalizeDuePaymentConfirmations(env: WorkerEnv, nowDate = new Date()): Promise<number> {
  const now = nowDate.toISOString();
  const rows = await env.DB.prepare(`SELECT payment_confirmation.id, payment_confirmation.payment_request_id AS paymentRequestId,
    payment_confirmation.seat_confirmation_approved AS seatConfirmationApproved, payment_request.registration_draft_id AS registrationDraftId,
    payment_request.is_test AS isTest, payment_request.test_run_id AS testRunId
    FROM payment_confirmation INNER JOIN payment_request ON payment_request.id = payment_confirmation.payment_request_id
    WHERE payment_confirmation.status = 'tentative' AND payment_confirmation.finalize_after <= ? ORDER BY payment_confirmation.finalize_after LIMIT 100`)
    .bind(now).all<{ id: string; paymentRequestId: string; seatConfirmationApproved: number; registrationDraftId: string; isTest: number; testRunId: string | null }>();
  let finalized = 0;
  const systemActor = { staffAccountId: "system:payment-finalizer", roles: ["admin"], capabilities: ["payment.manage"] } as StaffPrincipal;
  for (const row of rows.results) {
    const changed = await env.DB.prepare(`UPDATE payment_confirmation SET status = 'finalized', finalized_at = ?, updated_at = ?
      WHERE id = ? AND status = 'tentative' AND finalize_after <= ?`).bind(now, now, row.id, now).run();
    if (!changes(changed)) continue;
    const request = await requestForId(env, row.paymentRequestId);
    const state = await refreshInstallmentsAndDraft(env, request, now);
    const promotion = await promotePaidDraftChildren(env, systemActor, request.registrationDraftId, nowDate);
    await env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
      metadata_json, environment, is_test, test_run_id, created_at) VALUES (?, ?, 'system', 'payment-finalizer',
      'payment_confirmation_finalized', 'payment_confirmation', ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), now, row.id, JSON.stringify({ allInitialPaid: state.allInitialPaid, promotion: promotion.map((entry) => entry.state) }),
        env.APP_ENV, row.isTest, row.testRunId, now).run();
    if (state.allInitialPaid) {
      try {
        const { sendPaymentConfirmedEmail } = await import("../email/registration-transactional");
        await sendPaymentConfirmedEmail(env, request.registrationDraftId, row.id);
      } catch {
        // The confirmation and its audit event are already durable; the queued email remains observable for retry.
      }
    }
    finalized += 1;
  }

  // Credit applications are accounting adjustments, not received payments.
  // They nevertheless use the same guarded grace/finalization boundary before
  // a qualifying initial installment may promote an enrollment.
  const creditRows = await env.DB.prepare(`SELECT credit_application_confirmation.id,
    credit_application_confirmation.payment_request_id AS paymentRequestId,
    credit_application_confirmation.registration_draft_child_id AS childId,
    payment_request.registration_draft_id AS registrationDraftId,
    credit_application_confirmation.is_test AS isTest, credit_application_confirmation.test_run_id AS testRunId
    FROM credit_application_confirmation
    INNER JOIN payment_request ON payment_request.id = credit_application_confirmation.payment_request_id
    WHERE credit_application_confirmation.status = 'tentative'
      AND credit_application_confirmation.finalize_after <= ?
    ORDER BY credit_application_confirmation.finalize_after LIMIT 100`).bind(now)
    .all<{ id: string; paymentRequestId: string; childId: string; registrationDraftId: string; isTest: number; testRunId: string | null }>();
  for (const row of creditRows.results) {
    const changed = await env.DB.prepare(`UPDATE credit_application_confirmation SET status = 'finalized', updated_at = ?
      WHERE id = ? AND status = 'tentative' AND finalize_after <= ?`).bind(now, row.id, now).run();
    if (!changes(changed)) continue;
    const request = await requestForId(env, row.paymentRequestId);
    const state = await refreshInstallmentsAndDraft(env, request, now);
    const promotion = await promotePaidDraftChildren(env, systemActor, row.registrationDraftId, nowDate);
    await env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
      metadata_json, environment, is_test, test_run_id, created_at) VALUES (?, ?, 'system', 'payment-finalizer',
      'credit_application_finalized', 'credit_application_confirmation', ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), now, row.id, JSON.stringify({ allInitialPaid: state.allInitialPaid, promotion: promotion.map((entry) => entry.state) }),
        env.APP_ENV, row.isTest, row.testRunId, now).run();
    finalized += 1;
  }

  // A previously deployed worker can have finalized a payment after an earlier
  // eligibility check, leaving the child marked not_eligible even though its
  // finalized seat approval now makes promotion valid. Retry only that narrow,
  // explicitly stranded state; normal confirmed and review-required children
  // are intentionally left alone.
  const stranded = await env.DB.prepare(`SELECT DISTINCT payment_request.registration_draft_id AS registrationDraftId,
    payment_request.is_test AS isTest, payment_request.test_run_id AS testRunId
    FROM payment_confirmation
    INNER JOIN payment_request ON payment_request.id = payment_confirmation.payment_request_id
    INNER JOIN payment_allocation ON payment_allocation.received_payment_id = payment_confirmation.received_payment_id
    INNER JOIN payment_installment ON payment_installment.id = payment_allocation.payment_installment_id
    INNER JOIN registration_draft_child ON registration_draft_child.id = payment_installment.registration_draft_child_id
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    WHERE payment_confirmation.status = 'finalized' AND payment_confirmation.seat_confirmation_approved = 1
      AND payment_installment.installment_kind = 'initial'
      AND registration_draft_child.canonical_enrollment_id IS NULL
      AND registration_draft_child.promotion_status = 'not_eligible'
      AND registration_draft.status != 'cancelled' AND registration_draft_child.status != 'cancelled'`)
    .all<{ registrationDraftId: string; isTest: number; testRunId: string | null }>();
  for (const row of stranded.results) {
    const promotion = await promotePaidDraftChildren(env, systemActor, row.registrationDraftId, nowDate);
    if (!promotion.length) continue;
    await env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
      metadata_json, environment, is_test, test_run_id, created_at) VALUES (?, ?, 'system', 'payment-finalizer',
      'payment_confirmation_promotion_retried', 'registration_draft', ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), now, row.registrationDraftId, JSON.stringify({ promotion: promotion.map((entry) => entry.state) }),
        env.APP_ENV, row.isTest, row.testRunId, now).run();
  }

  // A pending admission with a durable confirmation claim is recoverable after
  // the claim lease expires. Include targets without a canonical enrollment so
  // an interruption before promotion cannot strand an admission indefinitely.
  const pendingAdmissions = await env.DB.prepare(`SELECT additional_class_admission.target_registration_draft_child_id AS childId
    FROM additional_class_admission
    INNER JOIN registration_draft_child ON registration_draft_child.id = additional_class_admission.target_registration_draft_child_id
    WHERE additional_class_admission.status = 'pending_confirmation'
      AND registration_draft_child.status != 'cancelled'
      AND EXISTS (SELECT 1 FROM registration_draft WHERE registration_draft.id = registration_draft_child.registration_draft_id
        AND registration_draft.status != 'cancelled')`).all<{ childId: string }>();
  for (const row of pendingAdmissions.results) {
    try {
      const outcome = await promotePaidDraftChild(env, systemActor, row.childId, null, nowDate);
      if (outcome.state === "not_eligible") {
        const sourceStillCurrent = await env.DB.prepare(`SELECT 1 AS value FROM additional_class_admission
          INNER JOIN enrollment ON enrollment.id = additional_class_admission.source_enrollment_id
          INNER JOIN registration_draft_child AS source_child ON source_child.id = additional_class_admission.source_registration_draft_child_id
          WHERE additional_class_admission.target_registration_draft_child_id = ?
            AND additional_class_admission.status = 'pending_confirmation'
            AND enrollment.status = 'confirmed' AND enrollment.transferred_out_at IS NULL
            AND enrollment.student_id = additional_class_admission.canonical_student_id
            AND source_child.status != 'cancelled'`).bind(row.childId).first();
        if (!sourceStillCurrent) await recordAdditionalAdmissionDiagnostic(env, row.childId, "source_no_longer_current", now);
      }
    } catch {
      // The operation remains pending and retryable; persist only a bounded
      // diagnostic code, never a raw database or stack-trace error.
      await recordAdditionalAdmissionDiagnostic(env, row.childId, "retryable_confirmation_failure", now);
    }
  }
  return finalized;
}

export async function recordCheckedNotFound(env: WorkerEnv, actor: StaffPrincipal, paymentRequestId: string, checkOperationId: string, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "payment.manage")) throw new PaymentReconciliationError("forbidden");
  const request = await requestForId(env, paymentRequestId);
  const checkedOperationId = operationId(checkOperationId);
  if (!checkedOperationId) throw new PaymentReconciliationError("invalid");
  const existing = await env.DB.prepare(`SELECT payment_request_id AS paymentRequestId, evidence_type AS evidenceType
    FROM payment_evidence WHERE id = ?`).bind(checkedOperationId).first<{ paymentRequestId: string; evidenceType: string }>();
  const matchesOperation = (row: { paymentRequestId: string; evidenceType: string } | null) =>
    row?.paymentRequestId === request.id && row.evidenceType === "staff_checked_not_found";
  if (existing) {
    if (matchesOperation(existing)) return { idempotent: true };
    throw new PaymentReconciliationError("conflict");
  }
  const now = nowDate.toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO payment_evidence (id, payment_request_id, registration_draft_id, evidence_type,
      recorded_at, recorded_by_staff_account_id, created_at, is_test, test_run_id)
      VALUES (?, ?, ?, 'staff_checked_not_found', ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`)
      .bind(checkedOperationId, request.id, request.registrationDraftId, now, actor.staffAccountId, now, request.isTest, request.testRunId),
    env.DB.prepare(`INSERT INTO audit_event (
      id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
      metadata_json, environment, is_test, test_run_id, created_at
    ) VALUES (?, ?, 'staff', ?, 'payment_checked_not_found', 'payment_request', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`)
      .bind(`${checkedOperationId}:audit`, now, actor.staffAccountId, request.id,
        JSON.stringify({ operationId: checkedOperationId }), env.APP_ENV, request.isTest, request.testRunId, now),
  ]);
  if (changes(results[0])) return { idempotent: false };
  const concurrent = await env.DB.prepare(`SELECT payment_request_id AS paymentRequestId, evidence_type AS evidenceType
    FROM payment_evidence WHERE id = ?`).bind(checkedOperationId).first<{ paymentRequestId: string; evidenceType: string }>();
  if (matchesOperation(concurrent)) return { idempotent: true };
  throw new PaymentReconciliationError("conflict");
}

export async function releaseUnpaidSeat(env: WorkerEnv, actor: StaffPrincipal, paymentRequestId: string, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "payment.manage")) throw new PaymentReconciliationError("forbidden");
  const request = await requestForId(env, paymentRequestId);
  const now = nowDate.toISOString();
  const installments = await installmentsForRequest(env, request.id);
  const initial = installments.filter((item) => item.installmentKind === "initial");
  if (!initial.length || initial.every((item) => item.allocatedAmountMnt >= item.amountMnt)) throw new PaymentReconciliationError("already_paid");
  if (initial.some((item) => item.effectiveDueAt > now)) throw new PaymentReconciliationError("not_due");
  const claim = await env.DB.prepare(`SELECT 1 AS value FROM payment_evidence WHERE payment_request_id = ? AND evidence_type = 'parent_claim'`)
    .bind(request.id).first<{ value: number }>();
  const pendingConfirmation = await env.DB.prepare(`SELECT 1 AS value FROM payment_confirmation WHERE payment_request_id = ? AND status = 'tentative'`)
    .bind(request.id).first<{ value: number }>();
  if (pendingConfirmation) throw new PaymentReconciliationError("conflict");
  const confirmedSeat = await env.DB.prepare(`SELECT 1 AS value FROM payment_confirmation WHERE payment_request_id = ?
    AND status = 'finalized' AND seat_confirmation_approved = 1 UNION ALL SELECT 1 AS value FROM registration_draft_child
    WHERE registration_draft_id = ? AND canonical_enrollment_id IS NOT NULL LIMIT 1`).bind(request.id, request.registrationDraftId).first<{ value: number }>();
  if (confirmedSeat) throw new PaymentReconciliationError("already_paid");
  const hold = await env.DB.prepare(`UPDATE registration_capacity_hold SET status = 'released', released_at = ?,
    release_reason = 'staff_unpaid_release', updated_at = ?
    WHERE status = 'active' AND hold_type = 'initial_payment' AND registration_draft_child_id IN (
      SELECT registration_draft_child_id FROM payment_installment WHERE payment_request_id = ? AND installment_kind = 'initial'
    )`).bind(now, now, request.id).run();
  if (!changes(hold)) return { released: false, parentClaimed: Boolean(claim) };
  const payments = await env.DB.prepare(`SELECT received_payment.id, COALESCE(SUM(payment_allocation.allocated_amount_mnt), 0) AS amountMnt
    FROM received_payment INNER JOIN payment_allocation ON payment_allocation.received_payment_id = received_payment.id
    LEFT JOIN payment_confirmation ON payment_confirmation.received_payment_id = received_payment.id
    WHERE received_payment.payment_request_id = ? AND (payment_confirmation.status IS NULL OR payment_confirmation.status = 'finalized')
    GROUP BY received_payment.id HAVING SUM(payment_allocation.allocated_amount_mnt) > 0`).bind(request.id).all<{ id: string; amountMnt: number }>();
  await env.DB.batch([
    env.DB.prepare(`UPDATE payment_installment SET status = 'released', updated_at = ? WHERE payment_request_id = ?
      AND installment_kind = 'initial' AND status != 'paid'`).bind(now, request.id),
    env.DB.prepare(`UPDATE registration_draft_child SET status = 'seat_unavailable', updated_at = ? WHERE registration_draft_id = ?
      AND id IN (SELECT registration_draft_child_id FROM payment_installment WHERE payment_request_id = ? AND installment_kind = 'initial')`)
      .bind(now, request.registrationDraftId, request.id),
    env.DB.prepare(`UPDATE registration_draft SET status = 'seat_unavailable', updated_at = ? WHERE id = ?`).bind(now, request.registrationDraftId),
    audit(env, actor, "initial_payment_seat_released", "payment_request", request.id,
      { parentClaimed: Boolean(claim), creditCount: payments.results.length }, request, now),
    ...payments.results.map((payment) => env.DB.prepare(`INSERT OR IGNORE INTO payment_credit (
      id, received_payment_id, payment_request_id, available_amount_mnt, status, created_at, updated_at, is_test, test_run_id
    ) VALUES (?, ?, ?, ?, 'available', ?, ?, ?, ?)`)
      .bind(`credit:${payment.id}`, payment.id, request.id, Number(payment.amountMnt), now, now, request.isTest, request.testRunId)),
  ]);
  await allocateWaitlistOffers(env, undefined, nowDate);
  return { released: true, parentClaimed: Boolean(claim) };
}

export async function markPaymentCreditRefunded(env: WorkerEnv, actor: StaffPrincipal, creditId: string, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "payment.manage")) throw new PaymentReconciliationError("forbidden");
  const row = await env.DB.prepare(`SELECT id, payment_request_id AS paymentRequestId, is_test AS isTest, test_run_id AS testRunId
    FROM payment_credit WHERE id = ? AND status = 'available'`).bind(creditId).first<{ id: string; paymentRequestId: string; isTest: number; testRunId: string | null }>();
  if (!row) throw new PaymentReconciliationError("not_found");
  const now = nowDate.toISOString();
  const result = await env.DB.prepare(`UPDATE payment_credit SET status = 'refunded', refunded_at = ?, refunded_by_staff_account_id = ?, updated_at = ?
    WHERE id = ? AND status = 'available'`).bind(now, actor.staffAccountId, now, row.id).run();
  if (changes(result) !== 1) throw new PaymentReconciliationError("conflict");
  await env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at) VALUES (?, ?, 'staff', ?, 'payment_credit_refunded',
    'payment_credit', ?, '{}', ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, row.id, env.APP_ENV, row.isTest, row.testRunId, now).run();
  return { refunded: true };
}

export async function claimParentPayment(database: WorkerEnv["DB"], paymentRequestId: string, registrationDraftId: string,
  rawAccessToken: string, nowDate = new Date()) {
  const { draftForAccessToken, sessionOwnsDraft } = await import("../services/registration-submission");
  let ownsDraft = false;
  try { ownsDraft = (await draftForAccessToken(database, rawAccessToken, nowDate)).id === registrationDraftId; }
  catch { ownsDraft = await sessionOwnsDraft(database, rawAccessToken, registrationDraftId, nowDate); }
  if (!ownsDraft) throw new PaymentReconciliationError("forbidden");
  const request = await database.prepare(`SELECT id, registration_draft_id AS registrationDraftId,
    payment_reference AS paymentReference, is_test AS isTest, test_run_id AS testRunId FROM payment_request
    WHERE id = ? AND registration_draft_id = ?`).bind(paymentRequestId, registrationDraftId).first<PaymentRequestRow>();
  if (!request) throw new PaymentReconciliationError("not_found");
  const now = nowDate.toISOString();
  await database.prepare(`INSERT OR IGNORE INTO payment_evidence (id, payment_request_id, registration_draft_id,
    evidence_type, recorded_at, created_at, is_test, test_run_id) VALUES (?, ?, ?, 'parent_claim', ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), request.id, request.registrationDraftId, now, now, request.isTest, request.testRunId).run();
  return { claimed: true };
}
