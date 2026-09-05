import type { WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";
import { sendEnrollmentConfirmationEmail } from "../email/registration-transactional";
import { enrollmentManualMessage } from "../email/templates/enrollment-confirmation";
import { getDiscountPolicySetting } from "../services/discounts";

export class ParentCommunicationError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "cooldown") {
    super("Parent communication is unavailable.");
  }
}

async function source(env: WorkerEnv, actor: StaffPrincipal, childId: string) {
  if (!hasStaffCapability(actor, "registration.manage")) throw new ParentCommunicationError("forbidden");
  const row = await env.DB.prepare(`SELECT registration_draft.id AS draftId, registration_draft.email,
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
    .bind(childId).first<{ draftId: string; email: string; childName: string; academicYearLabel: string; offeringLabel: string; classLabel: string; referralCode: string | null }>();
  if (!row) throw new ParentCommunicationError("not_found");
  return row;
}

async function audit(env: WorkerEnv, actor: StaffPrincipal, action: string, childId: string, draftId: string) {
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at)
    SELECT ?, ?, 'staff', ?, ?, 'registration_draft_child', ?, ?, ?, registration_draft.is_test, registration_draft.test_run_id, ?
    FROM registration_draft WHERE registration_draft.id = ?`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, action, childId, JSON.stringify({ registrationDraftId: draftId }), env.APP_ENV, now, draftId).run();
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
  await audit(env, actor, "parent_manual_message_generated", childId, row.draftId);
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
