import type { D1PreparedStatement, D1Result, WorkerEnv } from "../env";
import { resolveDeliveryAddress } from "../email/delivery-policy";
import { createResendProvider } from "../email/resend";
import type { EmailProvider } from "../email/provider";
import { deliverQueuedEmail } from "../email/service";
import { paymentReminderTemplate } from "../email/templates/payment-reminder";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

export interface PaymentReminderSetting {
  initialReminderLeadMinutes: number;
  laterReminderLeadMinutes: number;
  updatedAt: string;
}

export class PaymentReminderError extends Error {
  constructor(public readonly code: "forbidden" | "invalid" | "conflict") { super("Payment reminder operation failed."); }
}

type MilestoneType = "initial_reminder" | "initial_overdue" | "later_reminder" | "partial_balance_reminder";
interface MilestoneRow {
  id: string; milestoneKey: string; milestoneType: MilestoneType; registrationDraftId: string;
  registrationDraftChildId: string; paymentInstallmentId: string | null; paymentConfirmationId: string | null;
  status: string; outboundEmailId: string | null; scheduledAt: string; isTest: number; testRunId: string | null;
}
interface ReminderContext {
  email: string; normalizedEmail: string; childName: string; classLabel: string | null;
  amountMnt: number; dueAt: string; installmentStatus: string; holdStatus: string | null;
  enrollmentStatus: string | null; confirmationStatus: string | null; seatConfirmationApproved: number | null;
  parentClaimed: number; bankName: string | null; accountHolderName: string | null; accountNumber: string | null;
  iban: string | null; transferInstruction: string | null;
}

function changes(result: D1Result<unknown> | undefined): number { return result?.meta?.changes ?? 0; }

function audit(env: WorkerEnv, actor: StaffPrincipal, value: PaymentReminderSetting, now: string): D1PreparedStatement {
  const isTest = env.APP_ENV === "staging" ? 1 : 0;
  return env.DB.prepare(`INSERT INTO audit_event (
    id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at
  ) VALUES (?, ?, 'staff', ?, 'payment_reminder_setting_changed',
    'payment_reminder_setting', '1', ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, JSON.stringify(value), env.APP_ENV,
      isTest, isTest ? "staff-settings" : null, now);
}

export async function getPaymentReminderSetting(env: WorkerEnv): Promise<PaymentReminderSetting> {
  const row = await env.DB.prepare(`SELECT initial_reminder_lead_minutes AS initialReminderLeadMinutes,
    later_reminder_lead_minutes AS laterReminderLeadMinutes, updated_at AS updatedAt
    FROM payment_reminder_setting WHERE singleton = 1`).first<PaymentReminderSetting>();
  if (!row) throw new PaymentReminderError("invalid");
  return row;
}

export async function updatePaymentReminderSetting(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { initialReminderLeadMinutes: number; laterReminderLeadMinutes: number; expectedUpdatedAt: string },
): Promise<PaymentReminderSetting> {
  if (!hasStaffCapability(actor, "admin.settings.manage")) throw new PaymentReminderError("forbidden");
  if (!Number.isInteger(input.initialReminderLeadMinutes) || !Number.isInteger(input.laterReminderLeadMinutes)
    || input.initialReminderLeadMinutes < 1 || input.initialReminderLeadMinutes > 10080
    || input.laterReminderLeadMinutes < 1 || input.laterReminderLeadMinutes > 43200 || !input.expectedUpdatedAt) {
    throw new PaymentReminderError("invalid");
  }
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE payment_reminder_setting
    SET initial_reminder_lead_minutes = ?, later_reminder_lead_minutes = ?, updated_at = ?
    WHERE singleton = 1 AND updated_at = ?`).bind(
    input.initialReminderLeadMinutes, input.laterReminderLeadMinutes, now, input.expectedUpdatedAt,
  ).run();
  if (changes(result) !== 1) throw new PaymentReminderError("conflict");
  const value = { initialReminderLeadMinutes: input.initialReminderLeadMinutes, laterReminderLeadMinutes: input.laterReminderLeadMinutes, updatedAt: now };
  await audit(env, actor, value, now).run();
  return value;
}

async function ensureMilestones(env: WorkerEnv, now: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO payment_notification_milestone (
      id, milestone_key, registration_draft_id, registration_draft_child_id, payment_installment_id,
      channel, milestone_type, scheduled_at, status, created_at, updated_at, is_test, test_run_id
    ) SELECT payment_installment.id || ':initial-reminder:email', payment_installment.id || ':initial-reminder:email',
      payment_request.registration_draft_id, payment_installment.registration_draft_child_id, payment_installment.id,
      'email', 'initial_reminder', payment_installment.reminder_at, 'pending', ?, ?, payment_installment.is_test, payment_installment.test_run_id
    FROM payment_installment INNER JOIN payment_request ON payment_request.id = payment_installment.payment_request_id
    WHERE payment_installment.installment_kind = 'initial' AND payment_installment.reminder_at IS NOT NULL`).bind(now, now),
    env.DB.prepare(`INSERT OR IGNORE INTO payment_notification_milestone (
      id, milestone_key, registration_draft_id, registration_draft_child_id, payment_installment_id,
      channel, milestone_type, scheduled_at, status, created_at, updated_at, is_test, test_run_id
    ) SELECT payment_installment.id || ':initial-overdue:email', payment_installment.id || ':initial-overdue:email',
      payment_request.registration_draft_id, payment_installment.registration_draft_child_id, payment_installment.id,
      'email', 'initial_overdue', payment_installment.effective_due_at, 'pending', ?, ?, payment_installment.is_test, payment_installment.test_run_id
    FROM payment_installment INNER JOIN payment_request ON payment_request.id = payment_installment.payment_request_id
    WHERE payment_installment.installment_kind = 'initial'`).bind(now, now),
    env.DB.prepare(`INSERT OR IGNORE INTO payment_notification_milestone (
      id, milestone_key, registration_draft_id, registration_draft_child_id, payment_installment_id,
      channel, milestone_type, scheduled_at, status, created_at, updated_at, is_test, test_run_id
    ) SELECT payment_installment.id || ':later-reminder:email', payment_installment.id || ':later-reminder:email',
      payment_request.registration_draft_id, payment_installment.registration_draft_child_id, payment_installment.id,
      'email', 'later_reminder', payment_installment.reminder_at, 'pending', ?, ?, payment_installment.is_test, payment_installment.test_run_id
    FROM payment_installment INNER JOIN payment_request ON payment_request.id = payment_installment.payment_request_id
    WHERE payment_installment.installment_kind = 'later' AND payment_installment.reminder_at IS NOT NULL`).bind(now, now),
    env.DB.prepare(`INSERT OR IGNORE INTO payment_notification_milestone (
      id, milestone_key, registration_draft_id, registration_draft_child_id, payment_confirmation_id,
      channel, milestone_type, scheduled_at, status, created_at, updated_at, is_test, test_run_id
    ) SELECT payment_confirmation.id || ':partial-reminder:email', payment_confirmation.id || ':partial-reminder:email',
      payment_request.registration_draft_id, payment_installment.registration_draft_child_id, payment_confirmation.id,
      'email', 'partial_balance_reminder', payment_confirmation.remaining_reminder_at, 'pending', ?, ?, payment_confirmation.is_test, payment_confirmation.test_run_id
    FROM payment_confirmation
    INNER JOIN payment_request ON payment_request.id = payment_confirmation.payment_request_id
    INNER JOIN payment_installment ON payment_installment.payment_request_id = payment_request.id AND payment_installment.installment_kind = 'initial'
    WHERE payment_confirmation.status = 'finalized' AND payment_confirmation.seat_confirmation_approved = 1
      AND payment_confirmation.remaining_payment_due_at IS NOT NULL AND payment_confirmation.remaining_reminder_at IS NOT NULL`).bind(now, now),
  ]);
}

async function contextForMilestone(env: WorkerEnv, milestone: MilestoneRow): Promise<ReminderContext | null> {
  return env.DB.prepare(`SELECT registration_draft.email, registration_draft.normalized_email AS normalizedEmail,
    registration_draft_child.surname || ' ' || registration_draft_child.given_name AS childName,
    class_session.display_label AS classLabel,
    COALESCE(payment_confirmation.remaining_payment_due_at, payment_installment.effective_due_at) AS dueAt,
    payment_installment.amount_mnt - COALESCE(SUM(CASE WHEN allocated_confirmation.status = 'undone' THEN 0 ELSE payment_allocation.allocated_amount_mnt END), 0) AS amountMnt,
    payment_installment.status AS installmentStatus, registration_capacity_hold.status AS holdStatus,
    enrollment.status AS enrollmentStatus, payment_confirmation.status AS confirmationStatus,
    payment_confirmation.seat_confirmation_approved AS seatConfirmationApproved,
    EXISTS(SELECT 1 FROM payment_evidence WHERE payment_evidence.payment_request_id = payment_request.id AND payment_evidence.evidence_type = 'parent_claim') AS parentClaimed,
    payment_collection_settings.bank_name AS bankName, payment_collection_settings.account_holder_name AS accountHolderName,
    payment_collection_settings.account_number AS accountNumber, payment_collection_settings.iban,
    payment_collection_settings.transfer_instruction AS transferInstruction
    FROM registration_draft_child
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    INNER JOIN payment_installment ON payment_installment.id = ? OR (payment_installment.payment_request_id = (
      SELECT payment_request_id FROM payment_confirmation WHERE id = ?
    ) AND payment_installment.registration_draft_child_id = registration_draft_child.id AND payment_installment.installment_kind = 'initial')
    LEFT JOIN payment_confirmation ON payment_confirmation.id = ?
    LEFT JOIN payment_request ON payment_request.id = payment_installment.payment_request_id
    LEFT JOIN registration_capacity_hold ON registration_capacity_hold.registration_draft_child_id = registration_draft_child.id
      AND registration_capacity_hold.hold_type = 'initial_payment'
    LEFT JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id
    LEFT JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
    LEFT JOIN payment_allocation ON payment_allocation.payment_installment_id = payment_installment.id
    LEFT JOIN received_payment ON received_payment.id = payment_allocation.received_payment_id
    LEFT JOIN payment_confirmation allocated_confirmation ON allocated_confirmation.received_payment_id = received_payment.id
    LEFT JOIN payment_collection_settings ON payment_collection_settings.singleton = 1
    WHERE registration_draft_child.id = ?
    GROUP BY registration_draft_child.id, payment_installment.id, payment_confirmation.id`).bind(
    milestone.paymentInstallmentId, milestone.paymentConfirmationId, milestone.paymentConfirmationId, milestone.registrationDraftChildId,
  ).first<ReminderContext>();
}

function eligible(milestone: MilestoneRow, context: ReminderContext | null): boolean {
  if (!context || !context.email || !context.amountMnt || context.amountMnt <= 0) return false;
  if (milestone.milestoneType === "initial_reminder" || milestone.milestoneType === "initial_overdue") {
    return context.holdStatus === "active" && ["pending", "partially_paid"].includes(context.installmentStatus);
  }
  if (milestone.milestoneType === "later_reminder") {
    return context.enrollmentStatus === "confirmed" && ["pending", "partially_paid"].includes(context.installmentStatus);
  }
  return context.confirmationStatus === "finalized" && Boolean(context.seatConfirmationApproved)
    && context.enrollmentStatus === "confirmed" && ["pending", "partially_paid"].includes(context.installmentStatus);
}

export async function processDuePaymentReminders(env: WorkerEnv, nowDate = new Date(), provider?: EmailProvider): Promise<number> {
  if (env.EMAIL_ENABLED !== "true" || !env.RESEND_API_KEY) return 0;
  const emailProvider = provider ?? createResendProvider(env.RESEND_API_KEY);
  const now = nowDate.toISOString();
  await ensureMilestones(env, now);
  const due = await env.DB.prepare(`SELECT id, milestone_key AS milestoneKey, milestone_type AS milestoneType,
    registration_draft_id AS registrationDraftId, registration_draft_child_id AS registrationDraftChildId,
    payment_installment_id AS paymentInstallmentId, payment_confirmation_id AS paymentConfirmationId,
    status, outbound_email_id AS outboundEmailId, scheduled_at AS scheduledAt, is_test AS isTest, test_run_id AS testRunId
    FROM payment_notification_milestone
    WHERE channel = 'email' AND scheduled_at <= ? AND (
      status IN ('pending', 'failed') OR (status = 'sending' AND processing_started_at < ?)
    ) ORDER BY scheduled_at LIMIT 100`).bind(now, new Date(nowDate.getTime() - 5 * 60_000).toISOString()).all<MilestoneRow>();
  let sent = 0;
  for (const milestone of due.results) {
    const claimed = await env.DB.prepare(`UPDATE payment_notification_milestone
      SET status = 'sending', processing_started_at = ?, attempt_count = attempt_count + 1, updated_at = ?
      WHERE id = ? AND (status IN ('pending', 'failed') OR (status = 'sending' AND processing_started_at < ?))`).bind(
      now, now, milestone.id, new Date(nowDate.getTime() - 5 * 60_000).toISOString(),
    ).run();
    if (changes(claimed) !== 1) continue;
    const context = await contextForMilestone(env, milestone);
    if (!eligible(milestone, context)) {
      await env.DB.prepare(`UPDATE payment_notification_milestone SET status = 'cancelled', updated_at = ? WHERE id = ?`).bind(now, milestone.id).run();
      continue;
    }
    if (!context) continue;
    const reminderContext = context;
    try {
      const delivery = resolveDeliveryAddress(env.APP_ENV, reminderContext.normalizedEmail, env.STAGING_EMAIL_OVERRIDE_TO);
      const emailId = milestone.outboundEmailId ?? `${milestone.id}:email`;
      const existing = await env.DB.prepare(`SELECT id, status, actual_delivery_email AS actualDeliveryEmail FROM outbound_email WHERE id = ?`).bind(emailId)
        .first<{ id: string; status: string; actualDeliveryEmail: string }>();
      if (existing?.status === "sent") {
        await env.DB.prepare(`UPDATE payment_notification_milestone SET status = 'sent', sent_at = ?, outbound_email_id = ?, updated_at = ? WHERE id = ?`)
          .bind(now, emailId, now, milestone.id).run();
        sent += 1; continue;
      }
      if (!existing) {
        await env.DB.prepare(`INSERT INTO outbound_email (
          id, event_type, template_key, intended_to_email, actual_delivery_email, delivery_mode, status,
          attempt_count, queued_at, context_json, idempotency_key, is_test, test_run_id, created_at, updated_at, registration_draft_id
        ) VALUES (?, ?, 'payment_reminder_v1', ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(emailId, `payment_${milestone.milestoneType}`, reminderContext.normalizedEmail, delivery.actualEmail, delivery.deliveryMode,
            now, JSON.stringify({ milestoneType: milestone.milestoneType, dueAt: reminderContext.dueAt }), `payment-reminder/${milestone.milestoneKey}`,
            milestone.isTest, milestone.testRunId, now, now, milestone.registrationDraftId).run();
      }
      const template = paymentReminderTemplate({
        milestoneType: milestone.milestoneType, childName: reminderContext.childName, classLabel: reminderContext.classLabel || "Сонгосон анги",
        amountMnt: Number(reminderContext.amountMnt), dueAt: reminderContext.dueAt, parentClaimed: Boolean(reminderContext.parentClaimed),
        bankName: reminderContext.bankName, accountHolderName: reminderContext.accountHolderName, accountNumber: reminderContext.accountNumber,
        iban: reminderContext.iban, transferInstruction: reminderContext.transferInstruction,
      });
      await deliverQueuedEmail(env, emailProvider, {
        id: emailId, idempotencyKey: `payment-reminder/${milestone.milestoneKey}`,
        message: { from: env.EMAIL_FROM, to: existing?.actualDeliveryEmail ?? delivery.actualEmail, subject: template.subject, html: template.html, text: template.text },
      });
      await env.DB.prepare(`UPDATE payment_notification_milestone SET status = 'sent', sent_at = ?, outbound_email_id = ?, last_error_code = NULL, updated_at = ? WHERE id = ?`)
        .bind(now, emailId, now, milestone.id).run();
      sent += 1;
    } catch (error) {
      const code = error instanceof Error ? error.name : "delivery_failed";
      await env.DB.prepare(`UPDATE payment_notification_milestone SET status = 'failed', last_error_code = ?, updated_at = ? WHERE id = ?`)
        .bind(code, now, milestone.id).run();
    }
  }
  return sent;
}
