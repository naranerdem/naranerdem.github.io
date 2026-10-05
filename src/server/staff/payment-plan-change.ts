import type { D1PreparedStatement, WorkerEnv } from "../env";
import { effectiveInstallmentsForRows } from "../services/discounts";
import { cancelUnauthorisedPaymentReminderStatements } from "../email/payment-reminder-delivery";
import { getPaymentReminderSetting } from "./payment-reminders";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

type PaymentPlanCode = "single" | "two_installment";
type ChangeErrorCode = "forbidden" | "not_found" | "invalid" | "unsupported" | "conflict";

export class PaymentPlanChangeError extends Error {
  constructor(public readonly code: ChangeErrorCode) {
    super("Payment-plan change failed.");
    this.name = "PaymentPlanChangeError";
  }
}

type InstallmentSnapshot = {
  id: string;
  installmentNumber: number;
  installmentKind: "initial" | "later";
  amountMnt: number;
  effectiveAmountMnt: number;
  allocatedAmountMnt: number;
  cashAllocatedAmountMnt: number;
  dueAt: string;
  status: "pending" | "partially_paid" | "paid" | "released";
  updatedAt: string;
};

type AgreementSnapshot = {
  paymentRequestId: string;
  registrationDraftId: string;
  childId: string;
  childUpdatedAt: string;
  enrollmentId: string;
  enrollmentUpdatedAt: string;
  originalPlanCode: PaymentPlanCode;
  effectivePlanCode: PaymentPlanCode;
  classSessionId: string;
  classLabel: string;
  pricingUpdatedAt: string;
  twoInstallmentEnabled: number;
  oneTimeAmountMnt: number;
  firstInstallmentAmountMnt: number | null;
  secondInstallmentAmountMnt: number | null;
  secondInstallmentDueOn: string | null;
  paymentConfirmationId: string | null;
  paymentConfirmationDueAt: string | null;
  paymentConfirmationUpdatedAt: string | null;
  installments: InstallmentSnapshot[];
  dependencyCount: number;
  nonFinalizedAllocationCount: number;
  sendingMilestoneCount: number;
  pendingTransferCount: number;
};

const changed = (result: { meta?: { changes?: number } } | undefined) => result?.meta?.changes ?? 0;
const clean = (value: unknown, max = 500) => typeof value === "string" ? value.normalize("NFKC").trim().slice(0, max) : "";
const isOperationId = (value: unknown): value is string => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function mongoliaEndOfDay(value: string): string | null {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!matched) return null;
  const [year, month, day] = matched.slice(1).map(Number);
  const instant = new Date(Date.UTC(year, month - 1, day, 15, 59, 59, 999));
  return instant.getUTCFullYear() === year && instant.getUTCMonth() === month - 1 && instant.getUTCDate() === day
    ? instant.toISOString() : null;
}

function validInstant(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.toISOString() !== value ? null : value;
}

async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function proposedPricingSnapshot(snapshot: AgreementSnapshot, plan: PaymentPlanCode, proposedRemainingDueAt?: string) {
  return {
    pricingUpdatedAt: snapshot.pricingUpdatedAt,
    classSessionId: snapshot.classSessionId,
    classLabel: snapshot.classLabel,
    paymentPlanCode: plan,
    oneTimeAmountMnt: snapshot.oneTimeAmountMnt,
    firstInstallmentAmountMnt: snapshot.firstInstallmentAmountMnt,
    secondInstallmentAmountMnt: snapshot.secondInstallmentAmountMnt,
    secondInstallmentDueOn: snapshot.secondInstallmentDueOn,
    policyRemainingDueAt: snapshot.secondInstallmentDueOn ? mongoliaEndOfDay(snapshot.secondInstallmentDueOn) : null,
    proposedRemainingDueAt: proposedRemainingDueAt ?? null,
  };
}

function currentAgreementSnapshot(snapshot: AgreementSnapshot) {
  return {
    paymentPlanCode: snapshot.effectivePlanCode,
    totalAmountMnt: snapshot.installments.reduce((total, entry) => total + entry.effectiveAmountMnt, 0),
    installments: snapshot.installments.map((entry) => ({
      installmentNumber: entry.installmentNumber,
      installmentKind: entry.installmentKind,
      amountMnt: entry.effectiveAmountMnt,
      dueAt: entry.dueAt,
      allocatedAmountMnt: entry.allocatedAmountMnt,
      status: entry.status,
    })),
    effectiveRemainingDueAt: snapshot.paymentConfirmationDueAt ?? snapshot.installments.find((entry) => entry.status !== "paid")?.dueAt ?? null,
  };
}

async function snapshotForChange(env: WorkerEnv, paymentRequestId: string, childId: string): Promise<AgreementSnapshot> {
  const row = await env.DB.prepare(`SELECT payment_request.id AS paymentRequestId,
      payment_request.registration_draft_id AS registrationDraftId,
      child.id AS childId, child.updated_at AS childUpdatedAt,
      child.payment_plan_code AS originalPlanCode,
      enrollment.id AS enrollmentId, enrollment.updated_at AS enrollmentUpdatedAt,
      enrollment.class_session_id AS classSessionId,
      class_session.display_label AS classLabel,
      pricing.one_time_amount_mnt AS oneTimeAmountMnt,
      pricing.two_installment_enabled AS twoInstallmentEnabled,
      pricing.first_installment_amount_mnt AS firstInstallmentAmountMnt,
      pricing.second_installment_amount_mnt AS secondInstallmentAmountMnt,
      pricing.second_installment_due_on AS secondInstallmentDueOn,
      pricing.updated_at AS pricingUpdatedAt,
      (SELECT confirmation.id FROM payment_confirmation AS confirmation
        INNER JOIN payment_allocation AS allocation ON allocation.received_payment_id = confirmation.received_payment_id
        INNER JOIN payment_installment AS allocated_installment ON allocated_installment.id = allocation.payment_installment_id
        WHERE confirmation.payment_request_id = payment_request.id
          AND confirmation.status IN ('tentative', 'finalized')
          AND confirmation.remaining_payment_due_at IS NOT NULL
          AND allocated_installment.registration_draft_child_id = child.id
        ORDER BY confirmation.created_at DESC, confirmation.id DESC LIMIT 1) AS paymentConfirmationId,
      (SELECT confirmation.remaining_payment_due_at FROM payment_confirmation AS confirmation
        INNER JOIN payment_allocation AS allocation ON allocation.received_payment_id = confirmation.received_payment_id
        INNER JOIN payment_installment AS allocated_installment ON allocated_installment.id = allocation.payment_installment_id
        WHERE confirmation.payment_request_id = payment_request.id
          AND confirmation.status IN ('tentative', 'finalized')
          AND confirmation.remaining_payment_due_at IS NOT NULL
          AND allocated_installment.registration_draft_child_id = child.id
        ORDER BY confirmation.created_at DESC, confirmation.id DESC LIMIT 1) AS paymentConfirmationDueAt,
      (SELECT confirmation.updated_at FROM payment_confirmation AS confirmation
        INNER JOIN payment_allocation AS allocation ON allocation.received_payment_id = confirmation.received_payment_id
        INNER JOIN payment_installment AS allocated_installment ON allocated_installment.id = allocation.payment_installment_id
        WHERE confirmation.payment_request_id = payment_request.id
          AND confirmation.status IN ('tentative', 'finalized')
          AND confirmation.remaining_payment_due_at IS NOT NULL
          AND allocated_installment.registration_draft_child_id = child.id
        ORDER BY confirmation.created_at DESC, confirmation.id DESC LIMIT 1) AS paymentConfirmationUpdatedAt,
      COALESCE((SELECT proposed_payment_plan_code
        FROM enrollment_payment_agreement_revision AS revision
        WHERE revision.registration_draft_child_id = child.id
        ORDER BY revision.revised_at DESC, revision.id DESC LIMIT 1), child.payment_plan_code) AS effectivePlanCode,
      (SELECT COUNT(*) FROM payment_credit WHERE payment_request_id = payment_request.id)
        + (SELECT COUNT(*) FROM child_credit_entry WHERE registration_draft_child_id = child.id)
        + (SELECT COUNT(*) FROM enrollment_fee_adjustment WHERE registration_draft_child_id = child.id)
        + (SELECT COUNT(*) FROM payment_fee_waiver WHERE registration_draft_child_id = child.id)
        + (SELECT COUNT(*) FROM payment_receipt_correction WHERE registration_draft_child_id = child.id)
        + (SELECT COUNT(*) FROM staff_outstanding_payment_approval WHERE registration_draft_child_id = child.id)
        + (SELECT COUNT(*) FROM registration_draft_referral WHERE registration_draft_child_id = child.id) AS dependencyCount,
      (SELECT COUNT(*) FROM payment_notification_milestone
        WHERE registration_draft_child_id = child.id AND status = 'sending') AS sendingMilestoneCount,
      (SELECT COUNT(*) FROM payment_allocation AS allocation
        INNER JOIN payment_installment AS installment ON installment.id = allocation.payment_installment_id
        LEFT JOIN payment_confirmation AS confirmation ON confirmation.received_payment_id = allocation.received_payment_id
        WHERE installment.payment_request_id = payment_request.id AND installment.registration_draft_child_id = child.id
          AND COALESCE(confirmation.status, '') != 'finalized') AS nonFinalizedAllocationCount,
      (SELECT COUNT(*) FROM class_transfer
        WHERE source_enrollment_id = enrollment.id AND status IN ('pending_difference', 'ready_to_complete')) AS pendingTransferCount
    FROM payment_request
    INNER JOIN registration_draft_child AS child ON child.registration_draft_id = payment_request.registration_draft_id
    INNER JOIN enrollment ON enrollment.id = child.canonical_enrollment_id
      AND enrollment.status = 'confirmed' AND enrollment.transferred_out_at IS NULL
    INNER JOIN class_session ON class_session.id = enrollment.class_session_id
    INNER JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
    INNER JOIN offering_course_pricing AS pricing ON pricing.activity_offering_id = activity_offering.id
    WHERE payment_request.id = ? AND child.id = ? AND child.status != 'cancelled'`).bind(paymentRequestId, childId)
    .first<AgreementSnapshot>();
  if (!row || !["single", "two_installment"].includes(String(row.originalPlanCode)) || !["single", "two_installment"].includes(String(row.effectivePlanCode))) {
    throw new PaymentPlanChangeError("not_found");
  }

  const installments = await env.DB.prepare(`SELECT installment.id,
      installment.installment_number AS installmentNumber,
      installment.installment_kind AS installmentKind,
      installment.amount_mnt AS amountMnt, installment.effective_due_at AS dueAt,
      installment.status, installment.updated_at AS updatedAt,
      COALESCE(SUM(CASE WHEN confirmation.status = 'finalized' THEN allocation.allocated_amount_mnt ELSE 0 END), 0) AS allocatedAmountMnt,
      COALESCE(SUM(CASE WHEN confirmation.status = 'finalized' THEN allocation.allocated_amount_mnt ELSE 0 END), 0) AS cashAllocatedAmountMnt
    FROM payment_installment AS installment
    LEFT JOIN payment_allocation AS allocation ON allocation.payment_installment_id = installment.id
    LEFT JOIN payment_confirmation AS confirmation ON confirmation.received_payment_id = allocation.received_payment_id
    WHERE installment.payment_request_id = ? AND installment.registration_draft_child_id = ?
      AND installment.status != 'released'
    GROUP BY installment.id ORDER BY installment.installment_number, installment.id`).bind(paymentRequestId, childId)
    .all<Omit<InstallmentSnapshot, "effectiveAmountMnt">>();
  const raw = installments.results.map((entry) => ({ ...entry,
    installmentNumber: Number(entry.installmentNumber), amountMnt: Number(entry.amountMnt),
    allocatedAmountMnt: Number(entry.allocatedAmountMnt), cashAllocatedAmountMnt: Number(entry.cashAllocatedAmountMnt),
  }));
  const effective = new Map((await effectiveInstallmentsForRows(env.DB, raw.map((entry) => ({
    id: entry.id, registrationDraftChildId: childId, installmentNumber: entry.installmentNumber,
    amountMnt: entry.amountMnt, allocatedAmountMnt: entry.allocatedAmountMnt,
  })))).map((entry) => [entry.id, entry.effectiveAmountMnt]));
  return { ...row,
    oneTimeAmountMnt: Number(row.oneTimeAmountMnt),
    twoInstallmentEnabled: Number(row.twoInstallmentEnabled),
    firstInstallmentAmountMnt: row.firstInstallmentAmountMnt == null ? null : Number(row.firstInstallmentAmountMnt),
    secondInstallmentAmountMnt: row.secondInstallmentAmountMnt == null ? null : Number(row.secondInstallmentAmountMnt),
    dependencyCount: Number(row.dependencyCount), nonFinalizedAllocationCount: Number(row.nonFinalizedAllocationCount),
    sendingMilestoneCount: Number(row.sendingMilestoneCount),
    pendingTransferCount: Number(row.pendingTransferCount),
    installments: raw.map((entry) => ({ ...entry,
      installmentKind: entry.installmentKind as InstallmentSnapshot["installmentKind"],
      status: entry.status as InstallmentSnapshot["status"],
      effectiveAmountMnt: Number(effective.get(entry.id) ?? entry.amountMnt),
    })),
  };
}

function reviewedAgreement(snapshot: AgreementSnapshot, proposedPlanCode: unknown, proposedRemainingDueAt?: unknown) {
  if (proposedPlanCode !== "two_installment" || snapshot.effectivePlanCode !== "single") throw new PaymentPlanChangeError("unsupported");
  const first = snapshot.installments[0];
  const policyRemainingDueAt = snapshot.secondInstallmentDueOn ? mongoliaEndOfDay(snapshot.secondInstallmentDueOn) : null;
  const currentRemainingDueAt = snapshot.paymentConfirmationDueAt ?? first?.dueAt ?? null;
  const requestedRemainingDueAt = clean(proposedRemainingDueAt, 40);
  const nextRemainingDueAt = requestedRemainingDueAt ? validInstant(requestedRemainingDueAt) : currentRemainingDueAt;
  if (snapshot.twoInstallmentEnabled !== 1 || !snapshot.firstInstallmentAmountMnt || !snapshot.secondInstallmentAmountMnt || !policyRemainingDueAt
    || !currentRemainingDueAt || !nextRemainingDueAt
    || snapshot.installments.length !== 1 || !first || first.installmentKind !== "initial"
    || first.amountMnt !== snapshot.oneTimeAmountMnt || first.effectiveAmountMnt !== first.amountMnt
    || first.cashAllocatedAmountMnt !== snapshot.firstInstallmentAmountMnt
    || first.allocatedAmountMnt !== snapshot.firstInstallmentAmountMnt
    || snapshot.dependencyCount || snapshot.nonFinalizedAllocationCount || snapshot.sendingMilestoneCount || snapshot.pendingTransferCount) {
    throw new PaymentPlanChangeError("unsupported");
  }
  const previousTotalMnt = snapshot.installments.reduce((total, entry) => total + entry.effectiveAmountMnt, 0);
  const paidMnt = snapshot.installments.reduce((total, entry) => total + entry.cashAllocatedAmountMnt, 0);
  const proposed = [
    { id: first.id, installmentNumber: 1, installmentKind: "initial" as const, amountMnt: snapshot.firstInstallmentAmountMnt,
      dueAt: first.dueAt, allocatedAmountMnt: first.allocatedAmountMnt, status: "paid" as const },
    { id: null, installmentNumber: 2, installmentKind: "later" as const, amountMnt: snapshot.secondInstallmentAmountMnt,
      dueAt: nextRemainingDueAt, allocatedAmountMnt: 0, status: "pending" as const },
  ];
  if (paidMnt !== proposed[0].amountMnt || proposed[0].amountMnt + proposed[1].amountMnt <= paidMnt) {
    throw new PaymentPlanChangeError("unsupported");
  }
  return { previousTotalMnt, paidMnt, previousOutstandingMnt: previousTotalMnt - paidMnt,
    proposedTotalMnt: proposed.reduce((total, entry) => total + entry.amountMnt, 0),
    proposedOutstandingMnt: proposed.slice(1).reduce((total, entry) => total + entry.amountMnt - entry.allocatedAmountMnt, 0),
    currentRemainingDueAt, proposedRemainingDueAt: nextRemainingDueAt, policyRemainingDueAt, proposed };
}

export async function previewEnrollmentPaymentPlanChange(env: WorkerEnv, actor: StaffPrincipal, input: {
  paymentRequestId: string; registrationDraftChildId: string; proposedPaymentPlanCode: PaymentPlanCode; proposedRemainingDueAt?: string; reason: string;
}) {
  if (!hasStaffCapability(actor, "payment.manage")) throw new PaymentPlanChangeError("forbidden");
  const reason = clean(input.reason);
  if (!reason) throw new PaymentPlanChangeError("invalid");
  const snapshot = await snapshotForChange(env, String(input.paymentRequestId ?? ""), String(input.registrationDraftChildId ?? ""));
  const reviewed = reviewedAgreement(snapshot, input.proposedPaymentPlanCode, input.proposedRemainingDueAt);
  const reviewFingerprint = await fingerprint({ snapshot: {
    paymentRequestId: snapshot.paymentRequestId, childUpdatedAt: snapshot.childUpdatedAt,
    enrollmentUpdatedAt: snapshot.enrollmentUpdatedAt, effectivePlanCode: snapshot.effectivePlanCode,
    agreement: currentAgreementSnapshot(snapshot),
    pricing: proposedPricingSnapshot(snapshot, input.proposedPaymentPlanCode, reviewed.proposedRemainingDueAt), installments: snapshot.installments,
    paymentConfirmationId: snapshot.paymentConfirmationId, paymentConfirmationDueAt: snapshot.paymentConfirmationDueAt,
    paymentConfirmationUpdatedAt: snapshot.paymentConfirmationUpdatedAt,
  }, proposed: reviewed.proposed, proposedPaymentPlanCode: input.proposedPaymentPlanCode,
  proposedRemainingDueAt: reviewed.proposedRemainingDueAt, reason });
  return {
    previousPaymentPlanCode: snapshot.effectivePlanCode,
    proposedPaymentPlanCode: input.proposedPaymentPlanCode,
    originalPaymentPlanCode: snapshot.originalPlanCode,
    pricingBasis: { classLabel: snapshot.classLabel, pricingUpdatedAt: snapshot.pricingUpdatedAt,
      previous: currentAgreementSnapshot(snapshot), proposed: proposedPricingSnapshot(snapshot, input.proposedPaymentPlanCode, reviewed.proposedRemainingDueAt) },
    previousInstallments: snapshot.installments.map((entry) => ({ ...entry, amountMnt: entry.effectiveAmountMnt })),
    proposedInstallments: reviewed.proposed,
    previousTotalMnt: reviewed.previousTotalMnt,
    proposedTotalMnt: reviewed.proposedTotalMnt,
    paidMnt: reviewed.paidMnt,
    previousOutstandingMnt: reviewed.previousOutstandingMnt,
    proposedOutstandingMnt: reviewed.proposedOutstandingMnt,
    currentRemainingDueAt: reviewed.currentRemainingDueAt,
    proposedRemainingDueAt: reviewed.proposedRemainingDueAt,
    policyRemainingDueAt: reviewed.policyRemainingDueAt,
    reason,
    reviewFingerprint,
  };
}

export async function reviseEnrollmentPaymentPlan(env: WorkerEnv, actor: StaffPrincipal, input: {
  paymentRequestId: string; registrationDraftChildId: string; proposedPaymentPlanCode: PaymentPlanCode;
  proposedRemainingDueAt?: string; reason: string; reviewFingerprint: string; operationId: string;
}, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "payment.manage")) throw new PaymentPlanChangeError("forbidden");
  const operation = String(input.operationId ?? "").toLowerCase();
  if (!isOperationId(operation)) throw new PaymentPlanChangeError("invalid");
  const existing = await env.DB.prepare(`SELECT payment_request_id AS paymentRequestId,
      registration_draft_child_id AS childId, proposed_payment_plan_code AS proposedPaymentPlanCode,
      review_fingerprint AS reviewFingerprint
    FROM enrollment_payment_agreement_revision WHERE operation_id = ?`).bind(operation)
    .first<{ paymentRequestId: string; childId: string; proposedPaymentPlanCode: PaymentPlanCode; reviewFingerprint: string }>();
  if (existing) {
    if (existing.paymentRequestId !== input.paymentRequestId || existing.childId !== input.registrationDraftChildId
      || existing.proposedPaymentPlanCode !== input.proposedPaymentPlanCode || existing.reviewFingerprint !== input.reviewFingerprint) throw new PaymentPlanChangeError("conflict");
    return { operationId: operation, idempotent: true };
  }
  const review = await previewEnrollmentPaymentPlanChange(env, actor, input);
  if (review.reviewFingerprint !== String(input.reviewFingerprint ?? "")) throw new PaymentPlanChangeError("conflict");
  const snapshot = await snapshotForChange(env, String(input.paymentRequestId ?? ""), String(input.registrationDraftChildId ?? ""));
  const reviewed = reviewedAgreement(snapshot, input.proposedPaymentPlanCode, input.proposedRemainingDueAt);
  const now = nowDate.toISOString();
  const revisionId = crypto.randomUUID();
  const laterInstallmentId = crypto.randomUUID();
  const reminder = await getPaymentReminderSetting(env);
  const proposedLater = reviewed.proposed[1];
  const reminderAt = new Date(new Date(proposedLater.dueAt).getTime() - reminder.laterReminderLeadMinutes * 60_000).toISOString();
  const first = snapshot.installments[0];
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`INSERT INTO enrollment_payment_agreement_revision (
      id, operation_id, payment_request_id, registration_draft_child_id, previous_payment_plan_code,
      proposed_payment_plan_code, previous_pricing_snapshot_json, proposed_pricing_snapshot_json,
      reason, review_fingerprint, revised_by_staff_account_id, revised_at, is_test, test_run_id
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, payment_request.is_test, payment_request.test_run_id
      FROM payment_request
      INNER JOIN registration_draft_child AS child ON child.registration_draft_id = payment_request.registration_draft_id
      INNER JOIN enrollment ON enrollment.id = child.canonical_enrollment_id
      INNER JOIN class_session ON class_session.id = enrollment.class_session_id
      INNER JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
      INNER JOIN offering_course_pricing AS pricing ON pricing.activity_offering_id = activity_offering.id
      WHERE payment_request.id = ? AND child.id = ? AND child.updated_at = ?
        AND enrollment.id = ? AND enrollment.status = 'confirmed' AND enrollment.transferred_out_at IS NULL AND enrollment.updated_at = ?
        AND pricing.updated_at = ? AND pricing.one_time_amount_mnt = ? AND pricing.first_installment_amount_mnt = ?
        AND pricing.second_installment_amount_mnt = ? AND pricing.second_installment_due_on = ?
        AND pricing.two_installment_enabled = 1
        AND (? IS NULL OR EXISTS (SELECT 1 FROM payment_confirmation AS confirmation
          WHERE confirmation.id = ? AND confirmation.status IN ('tentative', 'finalized')
            AND confirmation.remaining_payment_due_at = ? AND confirmation.updated_at = ?))
        AND NOT EXISTS (SELECT 1 FROM enrollment_payment_agreement_revision WHERE registration_draft_child_id = child.id)
        AND NOT EXISTS (SELECT 1 FROM payment_credit WHERE payment_request_id = payment_request.id)
        AND NOT EXISTS (SELECT 1 FROM child_credit_entry WHERE registration_draft_child_id = child.id)
        AND NOT EXISTS (SELECT 1 FROM enrollment_fee_adjustment WHERE registration_draft_child_id = child.id)
        AND NOT EXISTS (SELECT 1 FROM payment_fee_waiver WHERE registration_draft_child_id = child.id)
        AND NOT EXISTS (SELECT 1 FROM payment_receipt_correction WHERE registration_draft_child_id = child.id)
        AND NOT EXISTS (SELECT 1 FROM staff_outstanding_payment_approval WHERE registration_draft_child_id = child.id)
        AND NOT EXISTS (SELECT 1 FROM registration_draft_referral WHERE registration_draft_child_id = child.id)
        AND NOT EXISTS (SELECT 1 FROM payment_notification_milestone WHERE registration_draft_child_id = child.id AND status = 'sending')
        AND NOT EXISTS (SELECT 1 FROM class_transfer WHERE source_enrollment_id = enrollment.id AND status IN ('pending_difference', 'ready_to_complete'))
        AND EXISTS (SELECT 1 FROM payment_installment WHERE id = ? AND payment_request_id = payment_request.id
          AND registration_draft_child_id = child.id AND installment_number = 1 AND installment_kind = 'initial'
          AND amount_mnt = ? AND effective_due_at = ? AND status = ? AND updated_at = ?)
        AND NOT EXISTS (SELECT 1 FROM payment_installment WHERE payment_request_id = payment_request.id
          AND registration_draft_child_id = child.id AND status != 'released' AND id != ?)`)
      .bind(revisionId, operation, snapshot.paymentRequestId, snapshot.childId, snapshot.effectivePlanCode,
        input.proposedPaymentPlanCode, JSON.stringify(currentAgreementSnapshot(snapshot)),
        JSON.stringify(proposedPricingSnapshot(snapshot, input.proposedPaymentPlanCode, reviewed.proposedRemainingDueAt)), review.reason, review.reviewFingerprint,
        actor.staffAccountId, now, snapshot.paymentRequestId, snapshot.childId, snapshot.childUpdatedAt,
        snapshot.enrollmentId, snapshot.enrollmentUpdatedAt, snapshot.pricingUpdatedAt, snapshot.oneTimeAmountMnt,
        snapshot.firstInstallmentAmountMnt, snapshot.secondInstallmentAmountMnt, snapshot.secondInstallmentDueOn,
        snapshot.paymentConfirmationId, snapshot.paymentConfirmationId, snapshot.paymentConfirmationDueAt, snapshot.paymentConfirmationUpdatedAt,
        first.id, first.amountMnt, first.dueAt, first.status, first.updatedAt, first.id),
    env.DB.prepare(`UPDATE registration_draft_child SET updated_at = ?
      WHERE id = ? AND updated_at = ?
        AND EXISTS (SELECT 1 FROM enrollment_payment_agreement_revision WHERE id = ?)`)
      .bind(now, snapshot.childId, snapshot.childUpdatedAt, revisionId),
    ...snapshot.installments.map((entry) => env.DB.prepare(`INSERT INTO enrollment_payment_agreement_revision_entry (
      id, enrollment_payment_agreement_revision_id, entry_state, payment_installment_id, installment_number,
      installment_kind, amount_mnt, due_at, status, allocated_amount_mnt, created_at
    ) VALUES (?, ?, 'previous', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), revisionId, entry.id, entry.installmentNumber, entry.installmentKind,
        entry.amountMnt, entry.dueAt, entry.status, entry.allocatedAmountMnt, now)),
    env.DB.prepare(`UPDATE payment_installment SET amount_mnt = ?, status = 'paid', paid_at = COALESCE(paid_at, ?), updated_at = ?
      WHERE id = ? AND amount_mnt = ? AND updated_at = ?
        AND EXISTS (SELECT 1 FROM enrollment_payment_agreement_revision WHERE id = ?)`)
      .bind(snapshot.firstInstallmentAmountMnt, now, now, first.id, first.amountMnt, first.updatedAt, revisionId),
    ...(snapshot.paymentConfirmationId ? [env.DB.prepare(`UPDATE payment_confirmation
      SET remaining_payment_due_at = ?, remaining_reminder_lead_minutes = NULL, remaining_reminder_at = NULL, updated_at = ?
      WHERE id = ? AND status IN ('tentative', 'finalized') AND remaining_payment_due_at = ? AND updated_at = ?
        AND EXISTS (SELECT 1 FROM enrollment_payment_agreement_revision WHERE id = ?)`)
      .bind(reviewed.proposedRemainingDueAt, now, snapshot.paymentConfirmationId,
        snapshot.paymentConfirmationDueAt, snapshot.paymentConfirmationUpdatedAt, revisionId)] : []),
    env.DB.prepare(`INSERT INTO payment_installment (id, payment_request_id, registration_draft_child_id,
      installment_number, installment_kind, amount_mnt, original_due_at, effective_due_at, reminder_lead_minutes,
      reminder_at, status, created_at, updated_at, canonical_application_child_id, canonical_enrollment_id, is_test, test_run_id)
      SELECT ?, ?, ?, 2, 'later', ?, ?, ?, ?, ?, 'pending', ?, ?,
        child.canonical_application_child_id, child.canonical_enrollment_id, payment_request.is_test, payment_request.test_run_id
      FROM payment_request INNER JOIN registration_draft_child AS child ON child.id = ?
      WHERE payment_request.id = ? AND EXISTS (SELECT 1 FROM enrollment_payment_agreement_revision WHERE id = ?)
        AND EXISTS (SELECT 1 FROM payment_installment WHERE id = ? AND status = 'paid' AND updated_at = ?)`)
      .bind(laterInstallmentId, snapshot.paymentRequestId, snapshot.childId, proposedLater.amountMnt,
        proposedLater.dueAt, proposedLater.dueAt, reminder.laterReminderLeadMinutes, reminderAt, now, now,
        snapshot.childId, snapshot.paymentRequestId, revisionId, first.id, now),
    ...reviewed.proposed.map((entry) => env.DB.prepare(`INSERT INTO enrollment_payment_agreement_revision_entry (
      id, enrollment_payment_agreement_revision_id, entry_state, payment_installment_id, installment_number,
      installment_kind, amount_mnt, due_at, status, allocated_amount_mnt, created_at
    ) VALUES (?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), revisionId, entry.id ?? laterInstallmentId, entry.installmentNumber, entry.installmentKind,
        entry.amountMnt, entry.dueAt, entry.status, entry.allocatedAmountMnt, now)),
    env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
      metadata_json, environment, is_test, test_run_id, created_at)
      SELECT ?, ?, 'staff', ?, 'enrollment_payment_agreement_revised', 'enrollment_payment_agreement_revision', ?, ?, ?,
        payment_request.is_test, payment_request.test_run_id, ? FROM payment_request
      WHERE payment_request.id = ? AND EXISTS (SELECT 1 FROM enrollment_payment_agreement_revision WHERE id = ?)`)
      .bind(crypto.randomUUID(), now, actor.staffAccountId, revisionId, JSON.stringify({ operationId: operation,
        previousPaymentPlanCode: snapshot.effectivePlanCode, proposedPaymentPlanCode: input.proposedPaymentPlanCode,
        previousTotalMnt: review.previousTotalMnt, proposedTotalMnt: review.proposedTotalMnt, paidMnt: review.paidMnt,
        previousOutstandingMnt: review.previousOutstandingMnt, proposedOutstandingMnt: review.proposedOutstandingMnt,
        previousRemainingDueAt: review.currentRemainingDueAt, proposedRemainingDueAt: review.proposedRemainingDueAt,
        policyRemainingDueAt: review.policyRemainingDueAt,
        reason: review.reason }), env.APP_ENV, now, snapshot.paymentRequestId, revisionId),
    ...cancelUnauthorisedPaymentReminderStatements(env, snapshot.childId, now,
      ["initial_reminder", "initial_overdue", "partial_balance_reminder"]),
  ];
  const results = await env.DB.batch(statements);
  if (changed(results[0]) !== 1 || changed(results[1]) !== 1) throw new PaymentPlanChangeError("conflict");
  const persisted = await env.DB.prepare(`SELECT revision.proposed_payment_plan_code AS plan,
      (SELECT COUNT(*) FROM enrollment_payment_agreement_revision_entry WHERE enrollment_payment_agreement_revision_id = revision.id) AS entryCount,
      (SELECT amount_mnt FROM payment_installment WHERE id = ?) AS firstAmountMnt,
      (SELECT status FROM payment_installment WHERE id = ?) AS firstStatus,
      (SELECT amount_mnt FROM payment_installment WHERE id = ?) AS secondAmountMnt,
      (SELECT effective_due_at FROM payment_installment WHERE id = ?) AS secondDueAt
    FROM enrollment_payment_agreement_revision AS revision WHERE revision.id = ? AND revision.operation_id = ?`)
    .bind(first.id, first.id, laterInstallmentId, laterInstallmentId, revisionId, operation)
    .first<{ plan: string; entryCount: number; firstAmountMnt: number; firstStatus: string; secondAmountMnt: number; secondDueAt: string }>();
  if (!persisted || persisted.plan !== input.proposedPaymentPlanCode || Number(persisted.entryCount) !== 3
    || Number(persisted.firstAmountMnt) !== snapshot.firstInstallmentAmountMnt || persisted.firstStatus !== "paid"
    || Number(persisted.secondAmountMnt) !== proposedLater.amountMnt || persisted.secondDueAt !== proposedLater.dueAt) {
    throw new PaymentPlanChangeError("conflict");
  }
  return { operationId: operation, idempotent: false, revisionId };
}
