import type { WorkerEnv } from "../env";
import { sha256 } from "../auth/crypto";
import { effectiveInstallmentsForRows } from "./discounts";

export class ParentAccessError extends Error {
  constructor(public readonly code: "session_required") {
    super("Parent access is unavailable.");
  }
}

interface ParentInstallmentRow {
  childId: string; childName: string; offeringLabel: string; classLabel: string;
  childStatus: string; enrollmentStatus: string | null; referralCode: string | null;
  installmentId: string | null; installmentNumber: number | null; amountMnt: number | null; allocatedAmountMnt: number | null;
  remainingPaymentDueAt: string | null;
}

async function guardianForSession(env: WorkerEnv, rawSessionToken: string, now: string) {
  if (!rawSessionToken || rawSessionToken.length > 256) throw new ParentAccessError("session_required");
  const tokenHash = await sha256(rawSessionToken);
  const row = await env.DB.prepare(`SELECT registration_draft.canonical_guardian_account_id AS guardianId,
    registration_draft.is_test AS isTest
    FROM verified_email_session
    INNER JOIN registration_draft ON registration_draft.id = verified_email_session.registration_draft_id
    WHERE verified_email_session.session_token_hash = ? AND verified_email_session.expires_at > ?
      AND verified_email_session.revoked_at IS NULL AND registration_draft.canonical_guardian_account_id IS NOT NULL`)
    .bind(tokenHash, now).first<{ guardianId: string; isTest: number }>();
  if (!row) throw new ParentAccessError("session_required");
  return row;
}

export async function getParentDashboard(env: WorkerEnv, rawSessionToken: string, nowDate = new Date()) {
  const now = nowDate.toISOString();
  const session = await guardianForSession(env, rawSessionToken, now);
  const rows = await env.DB.prepare(`SELECT registration_draft_child.id AS childId,
    trim(registration_draft_child.surname || ' ' || registration_draft_child.given_name) AS childName,
    COALESCE(activity_offering.title, class_session.stage_code) AS offeringLabel,
    COALESCE(class_meeting_rule.weekly_weekday, class_session.weekday) || ' ' || COALESCE(class_meeting_rule.start_time, class_session.start_time) || '–' || COALESCE(class_meeting_rule.end_time, class_session.end_time) AS classLabel,
    registration_draft_child.status AS childStatus, enrollment.status AS enrollmentStatus,
    enrollment_referral_code.code AS referralCode,
    payment_installment.id AS installmentId, payment_installment.installment_number AS installmentNumber,
    payment_installment.amount_mnt AS amountMnt,
    COALESCE(SUM(CASE WHEN payment_confirmation.status = 'undone' THEN 0 ELSE payment_allocation.allocated_amount_mnt END), 0) AS allocatedAmountMnt,
    (SELECT confirmation.remaining_payment_due_at FROM payment_confirmation AS confirmation
      INNER JOIN received_payment AS receipt ON receipt.id = confirmation.received_payment_id
      INNER JOIN payment_allocation AS allocation ON allocation.received_payment_id = receipt.id
      WHERE allocation.payment_installment_id = payment_installment.id AND confirmation.status = 'finalized'
        AND confirmation.remaining_payment_due_at IS NOT NULL
      ORDER BY confirmation.created_at DESC, confirmation.id DESC LIMIT 1) AS remainingPaymentDueAt
    FROM registration_draft
    INNER JOIN registration_draft_child ON registration_draft_child.registration_draft_id = registration_draft.id
    LEFT JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
    LEFT JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id
    LEFT JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
    LEFT JOIN class_meeting_rule ON class_meeting_rule.class_session_id = class_session.id
    LEFT JOIN payment_installment ON payment_installment.registration_draft_child_id = registration_draft_child.id
      AND payment_installment.status != 'released'
    LEFT JOIN payment_allocation ON payment_allocation.payment_installment_id = payment_installment.id
    LEFT JOIN received_payment ON received_payment.id = payment_allocation.received_payment_id
    LEFT JOIN payment_confirmation ON payment_confirmation.received_payment_id = received_payment.id
    LEFT JOIN enrollment_referral_code ON enrollment_referral_code.enrollment_id = enrollment.id AND enrollment_referral_code.status = 'active'
    WHERE registration_draft.canonical_guardian_account_id = ? AND registration_draft.is_test = ?
    GROUP BY payment_installment.id
    ORDER BY registration_draft.created_at DESC, registration_draft_child.position, payment_installment.installment_number`)
    .bind(session.guardianId, session.isTest).all<ParentInstallmentRow>();
  const effective = new Map((await effectiveInstallmentsForRows(env.DB, rows.results.flatMap((row) => row.installmentId ? [{
    id: row.installmentId, registrationDraftChildId: row.childId, installmentNumber: Number(row.installmentNumber),
    amountMnt: Number(row.amountMnt), allocatedAmountMnt: Number(row.allocatedAmountMnt),
  }] : []))).map((row) => [row.id, row]));
  const children = new Map<string, { id: string; childName: string; offeringLabel: string; classLabel: string; status: string; paidAmountMnt: number; remainingAmountMnt: number; remainingPaymentDueAt: string | null; referralCode: string | null }>();
  for (const row of rows.results) {
    const child = children.get(row.childId) ?? {
      id: row.childId, childName: row.childName, offeringLabel: row.offeringLabel, classLabel: row.classLabel,
      status: row.childStatus === "cancelled" || row.enrollmentStatus === "cancelled" ? "cancelled" : row.enrollmentStatus === "confirmed" ? "confirmed" : row.childStatus,
      paidAmountMnt: 0, remainingAmountMnt: 0, remainingPaymentDueAt: null, referralCode: row.referralCode,
    };
    if (row.installmentId) {
      const amount = effective.get(row.installmentId)?.effectiveAmountMnt ?? Number(row.amountMnt);
      child.paidAmountMnt += Number(row.allocatedAmountMnt);
      child.remainingAmountMnt += Math.max(0, amount - Number(row.allocatedAmountMnt));
      child.remainingPaymentDueAt ??= row.remainingPaymentDueAt;
    }
    children.set(row.childId, child);
  }
  return { children: [...children.values()] };
}

export async function logoutParentSession(env: WorkerEnv, rawSessionToken: string, nowDate = new Date()) {
  if (!rawSessionToken || rawSessionToken.length > 256) return;
  const tokenHash = await sha256(rawSessionToken);
  await env.DB.prepare(`UPDATE verified_email_session SET revoked_at = ? WHERE session_token_hash = ? AND revoked_at IS NULL`)
    .bind(nowDate.toISOString(), tokenHash).run();
}
