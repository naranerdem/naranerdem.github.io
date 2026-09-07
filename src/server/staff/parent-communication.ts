import type { WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";
import { sendEnrollmentConfirmationEmail } from "../email/registration-transactional";
import { enrollmentManualMessage } from "../email/templates/enrollment-confirmation";
import { paymentReminderTemplate } from "../email/templates/payment-reminder";
import { effectiveInstallmentsForRows, getDiscountPolicySetting } from "../services/discounts";

export class ParentCommunicationError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "cooldown") {
    super("Parent communication is unavailable.");
  }
}

type ConfirmedMessageSource = {
  lifecycle: "confirmed"; draftId: string; childName: string; academicYearLabel: string;
  offeringLabel: string; classLabel: string; referralCode: string | null;
};

type PendingPaymentMessageSource = {
  lifecycle: "pending_payment"; draftId: string; childName: string; classLabel: string;
  installmentId: string; rawAmountMnt: number; allocatedAmountMnt: number; dueAt: string;
  parentClaimed: boolean; bankName: string | null; accountHolderName: string | null;
  accountNumber: string | null; iban: string | null; transferInstruction: string | null;
};

async function source(env: WorkerEnv, actor: StaffPrincipal, childId: string): Promise<ConfirmedMessageSource | PendingPaymentMessageSource> {
  if (!hasStaffCapability(actor, "registration.manage")) throw new ParentCommunicationError("forbidden");
  const confirmed = await env.DB.prepare(`SELECT registration_draft.id AS draftId,
    trim(registration_draft_child.surname || ' ' || registration_draft_child.given_name) AS childName,
    academic_year.public_label AS academicYearLabel,
    COALESCE(activity_offering.title, class_session.stage_code) AS offeringLabel,
    COALESCE(class_meeting_rule.weekly_weekday, class_session.weekday) || ' ' || COALESCE(class_meeting_rule.start_time, class_session.start_time) || '–' || COALESCE(class_meeting_rule.end_time, class_session.end_time) AS classLabel,
    enrollment_referral_code.code AS referralCode
    FROM registration_draft_child
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    INNER JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id AND enrollment.status = 'confirmed'
    INNER JOIN academic_year ON academic_year.id = enrollment.academic_year_id
    INNER JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id
    LEFT JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
    LEFT JOIN class_meeting_rule ON class_meeting_rule.class_session_id = class_session.id
    LEFT JOIN enrollment_referral_code ON enrollment_referral_code.enrollment_id = enrollment.id AND enrollment_referral_code.status = 'active'
    WHERE registration_draft_child.id = ? AND registration_draft_child.status != 'cancelled'`)
    .bind(childId).first<Omit<ConfirmedMessageSource, "lifecycle">>();
  if (confirmed) return { ...confirmed, lifecycle: "confirmed" };

  const pending = await env.DB.prepare(`SELECT registration_draft.id AS draftId,
    trim(registration_draft_child.surname || ' ' || registration_draft_child.given_name) AS childName,
    COALESCE(activity_offering.title, class_session.stage_code) || ' · ' ||
      COALESCE(class_meeting_rule.weekly_weekday, class_session.weekday) || ' ' ||
      COALESCE(class_meeting_rule.start_time, class_session.start_time) || '–' ||
      COALESCE(class_meeting_rule.end_time, class_session.end_time) AS classLabel,
    payment_installment.id AS installmentId, payment_installment.amount_mnt AS rawAmountMnt,
    COALESCE(SUM(CASE WHEN payment_confirmation.status = 'undone' THEN 0 ELSE payment_allocation.allocated_amount_mnt END), 0) AS allocatedAmountMnt,
    payment_installment.effective_due_at AS dueAt,
    EXISTS(SELECT 1 FROM payment_evidence WHERE payment_evidence.payment_request_id = payment_request.id
      AND payment_evidence.evidence_type = 'parent_claim') AS parentClaimed,
    payment_collection_settings.bank_name AS bankName, payment_collection_settings.account_holder_name AS accountHolderName,
    payment_collection_settings.account_number AS accountNumber, payment_collection_settings.iban,
    payment_collection_settings.transfer_instruction AS transferInstruction
    FROM registration_draft_child
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    INNER JOIN registration_capacity_hold ON registration_capacity_hold.registration_draft_child_id = registration_draft_child.id
      AND registration_capacity_hold.hold_type = 'initial_payment' AND registration_capacity_hold.status = 'active'
    INNER JOIN payment_installment ON payment_installment.registration_draft_child_id = registration_draft_child.id
      AND payment_installment.installment_kind = 'initial' AND payment_installment.status IN ('pending', 'partially_paid')
    INNER JOIN payment_request ON payment_request.id = payment_installment.payment_request_id
    INNER JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id
    LEFT JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
    LEFT JOIN class_meeting_rule ON class_meeting_rule.class_session_id = class_session.id
    LEFT JOIN payment_allocation ON payment_allocation.payment_installment_id = payment_installment.id
    LEFT JOIN received_payment ON received_payment.id = payment_allocation.received_payment_id
    LEFT JOIN payment_confirmation ON payment_confirmation.received_payment_id = received_payment.id
    LEFT JOIN payment_collection_settings ON payment_collection_settings.singleton = 1
    WHERE registration_draft_child.id = ? AND registration_draft_child.status != 'cancelled'
      AND registration_draft.status != 'cancelled' AND registration_draft_child.canonical_enrollment_id IS NULL
    GROUP BY registration_draft_child.id, payment_installment.id`).bind(childId).first<Omit<PendingPaymentMessageSource, "lifecycle">>();
  if (!pending) throw new ParentCommunicationError("not_found");
  return { ...pending, lifecycle: "pending_payment", rawAmountMnt: Number(pending.rawAmountMnt), allocatedAmountMnt: Number(pending.allocatedAmountMnt), parentClaimed: Boolean(pending.parentClaimed) };
}

async function audit(env: WorkerEnv, actor: StaffPrincipal, action: string, childId: string, draftId: string, lifecycle?: string) {
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at)
    SELECT ?, ?, 'staff', ?, ?, 'registration_draft_child', ?, ?, ?, registration_draft.is_test, registration_draft.test_run_id, ?
    FROM registration_draft WHERE registration_draft.id = ?`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, action, childId, JSON.stringify({ registrationDraftId: draftId, ...(lifecycle ? { lifecycle } : {}) }), env.APP_ENV, now, draftId).run();
}

export async function resendParentEnrollmentSummary(env: WorkerEnv, actor: StaffPrincipal, childId: string) {
  const row = await source(env, actor, childId);
  const cutoff = new Date(Date.now() - 60_000).toISOString();
  const recent = await env.DB.prepare(`SELECT 1 AS value FROM outbound_email
    WHERE registration_draft_id = ? AND event_type = 'parent_enrollment_resend' AND queued_at > ?`).bind(row.draftId, cutoff).first();
  if (recent) throw new ParentCommunicationError("cooldown");
  const sent = await sendEnrollmentConfirmationEmail(env, row.draftId, { resend: true });
  if (!sent) throw new ParentCommunicationError("not_found");
  await audit(env, actor, "parent_enrollment_summary_resent", childId, row.draftId);
  return { ok: true };
}

export async function generateParentManualMessage(env: WorkerEnv, actor: StaffPrincipal, childId: string) {
  const row = await source(env, actor, childId);
  if (row.lifecycle === "pending_payment") {
    const effective = await effectiveInstallmentsForRows(env.DB, [{
      id: row.installmentId, registrationDraftChildId: childId, installmentNumber: 1,
      amountMnt: row.rawAmountMnt, allocatedAmountMnt: row.allocatedAmountMnt,
    }]);
    const amountMnt = Math.max(0, Number(effective[0]?.effectiveAmountMnt ?? row.rawAmountMnt) - row.allocatedAmountMnt);
    if (!amountMnt) throw new ParentCommunicationError("not_found");
    await audit(env, actor, "parent_manual_message_generated", childId, row.draftId, row.lifecycle);
    return {
      text: paymentReminderTemplate({
        milestoneType: "initial_reminder", childName: row.childName, classLabel: row.classLabel, amountMnt, dueAt: row.dueAt,
        parentClaimed: row.parentClaimed, bankName: row.bankName, accountHolderName: row.accountHolderName,
        accountNumber: row.accountNumber, iban: row.iban, transferInstruction: row.transferInstruction,
      }).text,
    };
  }
  await audit(env, actor, "parent_manual_message_generated", childId, row.draftId, row.lifecycle);
  return {
    text: enrollmentManualMessage({
      child: {
        childName: row.childName,
        academicYearLabel: row.academicYearLabel,
        offeringLabel: row.offeringLabel,
        classLabel: row.classLabel,
        paidAmountMnt: 0,
        remainingAmountMnt: 0,
        remainingPaymentDueAt: null,
        referralCode: row.referralCode,
      },
      referralPolicy: await getDiscountPolicySetting(env),
    }),
  };
}
