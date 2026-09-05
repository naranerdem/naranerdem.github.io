import type { WorkerEnv } from "../env";
import { resolveDeliveryAddress } from "./delivery-policy";
import type { EmailProvider } from "./provider";
import { createResendProvider } from "./resend";
import { deliverQueuedEmail } from "./service";
import { paymentConfirmedTemplate, type PaymentConfirmedChild } from "./templates/payment-confirmed";
import { registrationReceiptTemplate, type RegistrationReceiptItem } from "./templates/registration-receipt";
import { effectiveInstallmentsForRows } from "../services/discounts";
import { sendParentAccessEmail } from "../auth/email-verification";
import { enrollmentConfirmationTemplate, type EnrollmentConfirmationChild } from "./templates/enrollment-confirmation";

interface ReceiptRow {
  email: string; normalizedEmail: string; transferDescription: string | null;
  bankName: string | null; accountHolderName: string | null; accountNumber: string | null;
  iban: string | null; transferInstruction: string | null; childName: string; classLabel: string;
  childId: string; initialInstallmentId: string; initialAmountMnt: number; laterInstallmentId: string | null; laterAmountMnt: number | null;
  paymentDeadlineAt: string; isTest: number; testRunId: string | null;
}

interface PaymentConfirmedRow { email: string; normalizedEmail: string; isTest: number; testRunId: string | null; }

interface PaymentReceiptInstallmentRow {
  childId: string; childName: string; classLabel: string; installmentId: string; installmentNumber: number;
  installmentKind: "initial" | "later"; amountMnt: number; allocatedAmountMnt: number; receivedAmountMnt: number;
  effectiveDueAt: string; enrollmentStatus: string | null; facebookGroupUrl: string | null;
}

interface EnrollmentEmailRow {
  email: string; childId: string; childName: string; offeringLabel: string; classLabel: string;
  installmentId: string; installmentNumber: number; amountMnt: number; allocatedAmountMnt: number;
  remainingPaymentDueAt: string | null; referralCode: string | null;
}

function enabled(env: WorkerEnv): boolean { return env.EMAIL_ENABLED === "true" && Boolean(env.RESEND_API_KEY); }

function emailProvider(env: WorkerEnv, provider?: EmailProvider): EmailProvider {
  if (provider) return provider;
  if (!env.RESEND_API_KEY) throw new Error("resend_api_key_missing");
  return createResendProvider(env.RESEND_API_KEY);
}

export async function sendRegistrationReceipt(env: WorkerEnv, registrationDraftId: string, provider?: EmailProvider): Promise<boolean> {
  if (!enabled(env)) return false;
  const rows = await env.DB.prepare(`SELECT registration_draft.email, registration_draft.normalized_email AS normalizedEmail,
    payment_request.transfer_description AS transferDescription, payment_collection_settings.bank_name AS bankName,
    payment_collection_settings.account_holder_name AS accountHolderName, payment_collection_settings.account_number AS accountNumber,
    payment_collection_settings.iban, payment_collection_settings.transfer_instruction,
    trim(registration_draft_child.surname || ' ' || registration_draft_child.given_name) AS childName,
    COALESCE(class_meeting_rule.weekly_weekday, class_session.weekday) || ' ' || COALESCE(class_meeting_rule.start_time, class_session.start_time) || '–' || COALESCE(class_meeting_rule.end_time, class_session.end_time) AS classLabel,
    registration_draft_child.id AS childId, payment_installment.id AS initialInstallmentId,
    payment_installment.amount_mnt AS initialAmountMnt, payment_installment.effective_due_at AS paymentDeadlineAt,
    (SELECT later.id FROM payment_installment AS later WHERE later.registration_draft_child_id = registration_draft_child.id
      AND later.installment_kind = 'later' ORDER BY later.installment_number LIMIT 1) AS laterInstallmentId,
    (SELECT later.amount_mnt FROM payment_installment AS later WHERE later.registration_draft_child_id = registration_draft_child.id
      AND later.installment_kind = 'later' ORDER BY later.installment_number LIMIT 1) AS laterAmountMnt,
    registration_draft.is_test AS isTest, registration_draft.test_run_id AS testRunId
    FROM registration_draft
    INNER JOIN registration_draft_child ON registration_draft_child.registration_draft_id = registration_draft.id
    INNER JOIN payment_request ON payment_request.registration_draft_id = registration_draft.id
    INNER JOIN payment_installment ON payment_installment.payment_request_id = payment_request.id
      AND payment_installment.registration_draft_child_id = registration_draft_child.id AND payment_installment.installment_kind = 'initial'
    INNER JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id
    LEFT JOIN class_meeting_rule ON class_meeting_rule.class_session_id = class_session.id
    LEFT JOIN payment_collection_settings ON payment_collection_settings.singleton = 1
    WHERE registration_draft.id = ? ORDER BY registration_draft_child.position`).bind(registrationDraftId).all<ReceiptRow>();
  if (!rows.results.length) return false;
  const context = rows.results[0];
  const delivery = resolveDeliveryAddress(env.APP_ENV, context.normalizedEmail, env.STAGING_EMAIL_OVERRIDE_TO);
  const id = `${registrationDraftId}:registration-receipt`;
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT OR IGNORE INTO outbound_email (
    id, event_type, template_key, intended_to_email, actual_delivery_email, delivery_mode, status, attempt_count,
    queued_at, context_json, idempotency_key, is_test, test_run_id, created_at, updated_at, registration_draft_id
  ) VALUES (?, 'registration_received', 'registration_receipt_v1', ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, context.email, delivery.actualEmail, delivery.deliveryMode, now, JSON.stringify({ registrationDraftId }),
      `registration-receipt/${registrationDraftId}`, context.isTest, context.testRunId, now, now, registrationDraftId).run();
  const queued = await env.DB.prepare(`SELECT status, actual_delivery_email AS actualDeliveryEmail FROM outbound_email WHERE id = ?`)
    .bind(id).first<{ status: string; actualDeliveryEmail: string }>();
  if (!queued || queued.status === "sent") return Boolean(queued);
  const effective = new Map((await effectiveInstallmentsForRows(env.DB, rows.results.flatMap((row) => [
    { id: row.initialInstallmentId, registrationDraftChildId: row.childId, installmentNumber: 1, amountMnt: Number(row.initialAmountMnt) },
    row.laterInstallmentId && row.laterAmountMnt != null ? { id: row.laterInstallmentId, registrationDraftChildId: row.childId, installmentNumber: 2, amountMnt: Number(row.laterAmountMnt) } : null,
  ].filter(Boolean) as Array<{ id: string; registrationDraftChildId: string; installmentNumber: number; amountMnt: number }>))).map((item) => [item.id, item]));
  const items: RegistrationReceiptItem[] = rows.results.map((row) => ({
    childName: row.childName, classLabel: row.classLabel,
    originalPlanAmountMnt: Number(row.initialAmountMnt) + Number(row.laterAmountMnt ?? 0),
    discountAmountMnt: (effective.get(row.initialInstallmentId)?.discountAmountMnt ?? 0) + (row.laterInstallmentId ? effective.get(row.laterInstallmentId)?.discountAmountMnt ?? 0 : 0),
    adjustedPlanAmountMnt: (effective.get(row.initialInstallmentId)?.effectiveAmountMnt ?? Number(row.initialAmountMnt)) + (row.laterInstallmentId ? effective.get(row.laterInstallmentId)?.effectiveAmountMnt ?? Number(row.laterAmountMnt ?? 0) : 0),
    initialAmountMnt: effective.get(row.initialInstallmentId)?.effectiveAmountMnt ?? Number(row.initialAmountMnt), paymentDeadlineAt: row.paymentDeadlineAt,
  }));
  const template = registrationReceiptTemplate({
    items, transferDescription: context.transferDescription, bankName: context.bankName, accountHolderName: context.accountHolderName,
    accountNumber: context.accountNumber, iban: context.iban, transferInstruction: context.transferInstruction,
  });
  await deliverQueuedEmail(env, emailProvider(env, provider), {
    id, idempotencyKey: `registration-receipt/${registrationDraftId}`, templateKey: "registration_receipt_v1",
    message: { from: env.EMAIL_FROM, to: queued.actualDeliveryEmail, subject: template.subject, html: template.html, text: template.text },
  });
  return true;
}

export async function sendPaymentConfirmedEmail(
  env: WorkerEnv,
  registrationDraftId: string,
  paymentConfirmationId?: string | EmailProvider,
  provider?: EmailProvider,
): Promise<boolean> {
  if (typeof paymentConfirmationId !== "string") {
    provider = paymentConfirmationId;
    paymentConfirmationId = undefined;
  }
  if (!enabled(env)) return false;
  const draft = await env.DB.prepare(`SELECT email, normalized_email AS normalizedEmail, is_test AS isTest, test_run_id AS testRunId
    FROM registration_draft WHERE id = ? AND status != 'cancelled'`).bind(registrationDraftId).first<PaymentConfirmedRow>();
  if (!draft) return false;
  const existing = await env.DB.prepare(`SELECT id, status, actual_delivery_email AS actualDeliveryEmail FROM outbound_email
    WHERE registration_draft_id = ? AND event_type = 'registration_initial_payment_confirmed'`).bind(registrationDraftId)
    .first<{ id: string; status: string; actualDeliveryEmail: string }>();
  if (existing?.status === "sent") return true;
  const delivery = resolveDeliveryAddress(env.APP_ENV, draft.normalizedEmail, env.STAGING_EMAIL_OVERRIDE_TO);
  const now = new Date().toISOString();
  const id = existing?.id ?? crypto.randomUUID();
  if (!existing) await env.DB.prepare(`INSERT OR IGNORE INTO outbound_email (
    id, event_type, template_key, intended_to_email, actual_delivery_email, delivery_mode, status, attempt_count,
    queued_at, context_json, idempotency_key, is_test, test_run_id, created_at, updated_at, registration_draft_id
  ) VALUES (?, 'registration_initial_payment_confirmed', 'payment_confirmed_v1', ?, ?, ?, 'queued', 0, ?, '{}', ?, ?, ?, ?, ?, ?)`)
    .bind(id, draft.email, delivery.actualEmail, delivery.deliveryMode, now, `payment-confirmed/${registrationDraftId}`,
      draft.isTest, draft.testRunId, now, now, registrationDraftId).run();
  const queued = await env.DB.prepare(`SELECT status, actual_delivery_email AS actualDeliveryEmail FROM outbound_email WHERE id = ?`)
    .bind(id).first<{ status: string; actualDeliveryEmail: string }>();
  if (!queued || queued.status === "sent") return Boolean(queued);
  const rows = await env.DB.prepare(`SELECT registration_draft_child.id AS childId,
    trim(registration_draft_child.surname || ' ' || registration_draft_child.given_name) AS childName,
    COALESCE(class_session.display_label, class_session.stage_code) || ' · ' || COALESCE(class_meeting_rule.weekly_weekday, class_session.weekday) || ' ' || COALESCE(class_meeting_rule.start_time, class_session.start_time) || '–' || COALESCE(class_meeting_rule.end_time, class_session.end_time) AS classLabel,
    payment_installment.id AS installmentId, payment_installment.installment_number AS installmentNumber,
    payment_installment.installment_kind AS installmentKind, payment_installment.amount_mnt AS amountMnt,
    payment_installment.effective_due_at AS effectiveDueAt,
    COALESCE(SUM(CASE WHEN allocated_confirmation.status = 'undone' THEN 0 ELSE payment_allocation.allocated_amount_mnt END), 0) AS allocatedAmountMnt,
    COALESCE(SUM(CASE WHEN payment_allocation.received_payment_id = payment_confirmation.received_payment_id THEN payment_allocation.allocated_amount_mnt ELSE 0 END), 0) AS receivedAmountMnt,
    enrollment.status AS enrollmentStatus, activity_offering.facebook_group_url AS facebookGroupUrl
    FROM payment_confirmation
    INNER JOIN payment_request ON payment_request.id = payment_confirmation.payment_request_id
    INNER JOIN payment_installment ON payment_installment.payment_request_id = payment_request.id AND payment_installment.status != 'released'
    INNER JOIN registration_draft_child ON registration_draft_child.id = payment_installment.registration_draft_child_id
    INNER JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id
    LEFT JOIN class_meeting_rule ON class_meeting_rule.class_session_id = class_session.id
    LEFT JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
    LEFT JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
    LEFT JOIN payment_allocation ON payment_allocation.payment_installment_id = payment_installment.id
    LEFT JOIN payment_confirmation AS allocated_confirmation ON allocated_confirmation.received_payment_id = payment_allocation.received_payment_id
    WHERE payment_request.registration_draft_id = ? AND payment_confirmation.status = 'finalized'
      AND (? IS NULL OR payment_confirmation.id = ?)
    GROUP BY payment_confirmation.id, payment_installment.id
    ORDER BY registration_draft_child.position, payment_installment.installment_number`)
    .bind(registrationDraftId, paymentConfirmationId ?? null, paymentConfirmationId ?? null).all<PaymentReceiptInstallmentRow>();
  if (!rows.results.length) return false;
  const effective = new Map((await effectiveInstallmentsForRows(env.DB, rows.results.map((row) => ({
    id: row.installmentId, registrationDraftChildId: row.childId, installmentNumber: Number(row.installmentNumber),
    amountMnt: Number(row.amountMnt), allocatedAmountMnt: Number(row.allocatedAmountMnt),
  })))).map((row) => [row.id, row]));
  const childrenById = new Map<string, PaymentConfirmedChild>();
  for (const row of rows.results) {
    const effectiveAmount = effective.get(row.installmentId)?.effectiveAmountMnt ?? Number(row.amountMnt);
    const child = childrenById.get(row.childId) ?? {
      childName: row.childName, classLabel: row.classLabel, receivedAmountMnt: 0, totalPaidAmountMnt: 0,
      remainingAmountMnt: 0, nextPaymentAmountMnt: null, nextPaymentDueAt: null,
      seatConfirmed: row.enrollmentStatus === "confirmed", facebookGroupUrl: row.facebookGroupUrl,
    };
    child.receivedAmountMnt += Number(row.receivedAmountMnt);
    child.totalPaidAmountMnt += Number(row.allocatedAmountMnt);
    child.remainingAmountMnt += Math.max(0, effectiveAmount - Number(row.allocatedAmountMnt));
    if (row.installmentKind === "later" && effectiveAmount > Number(row.allocatedAmountMnt) && child.nextPaymentDueAt == null) {
      child.nextPaymentAmountMnt = Math.max(0, effectiveAmount - Number(row.allocatedAmountMnt));
      child.nextPaymentDueAt = row.effectiveDueAt;
    }
    childrenById.set(row.childId, child);
  }
  const center = await env.DB.prepare(`SELECT facebook_page_url AS facebookUrl FROM public_center_information WHERE singleton = 1`)
    .first<{ facebookUrl: string | null }>();
  const template = paymentConfirmedTemplate({ children: [...childrenById.values()], centerFacebookUrl: center?.facebookUrl });
  await deliverQueuedEmail(env, emailProvider(env, provider), {
    id, idempotencyKey: `payment-confirmed/${registrationDraftId}`, templateKey: "payment_confirmed_v1",
    message: { from: env.EMAIL_FROM, to: queued.actualDeliveryEmail, subject: template.subject, html: template.html, text: template.text },
  });
  return true;
}

export async function sendEnrollmentConfirmationEmail(env: WorkerEnv, registrationDraftId: string, options: { resend?: boolean } = {}): Promise<boolean> {
  if (!enabled(env)) return false;
  if (!options.resend) {
    const existing = await env.DB.prepare(`SELECT status FROM outbound_email
      WHERE registration_draft_id = ? AND event_type = 'enrollment_confirmed' ORDER BY created_at DESC LIMIT 1`)
      .bind(registrationDraftId).first<{ status: string }>();
    if (existing) return existing.status === "sent";
  }
  const rows = await env.DB.prepare(`SELECT registration_draft.email,
    registration_draft_child.id AS childId,
    trim(registration_draft_child.surname || ' ' || registration_draft_child.given_name) AS childName,
    COALESCE(activity_offering.title, class_session.stage_code) AS offeringLabel,
    COALESCE(class_meeting_rule.weekly_weekday, class_session.weekday) || ' ' || COALESCE(class_meeting_rule.start_time, class_session.start_time) || '–' || COALESCE(class_meeting_rule.end_time, class_session.end_time) AS classLabel,
    payment_installment.id AS installmentId, payment_installment.installment_number AS installmentNumber,
    payment_installment.amount_mnt AS amountMnt,
    COALESCE(SUM(CASE WHEN payment_confirmation.status = 'undone' THEN 0 ELSE payment_allocation.allocated_amount_mnt END), 0) AS allocatedAmountMnt,
    (SELECT confirmation.remaining_payment_due_at FROM payment_confirmation AS confirmation
      INNER JOIN received_payment AS receipt ON receipt.id = confirmation.received_payment_id
      INNER JOIN payment_allocation AS allocation ON allocation.received_payment_id = receipt.id
      WHERE allocation.payment_installment_id = payment_installment.id
        AND confirmation.status = 'finalized' AND confirmation.remaining_payment_due_at IS NOT NULL
      ORDER BY confirmation.created_at DESC, confirmation.id DESC LIMIT 1) AS remainingPaymentDueAt,
    enrollment_referral_code.code AS referralCode
    FROM registration_draft
    INNER JOIN registration_draft_child ON registration_draft_child.registration_draft_id = registration_draft.id
    INNER JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id AND enrollment.status = 'confirmed'
    INNER JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id
    LEFT JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
    LEFT JOIN class_meeting_rule ON class_meeting_rule.class_session_id = class_session.id
    INNER JOIN payment_installment ON payment_installment.registration_draft_child_id = registration_draft_child.id
      AND payment_installment.status != 'released'
    LEFT JOIN payment_allocation ON payment_allocation.payment_installment_id = payment_installment.id
    LEFT JOIN received_payment ON received_payment.id = payment_allocation.received_payment_id
    LEFT JOIN payment_confirmation ON payment_confirmation.received_payment_id = received_payment.id
    LEFT JOIN enrollment_referral_code ON enrollment_referral_code.enrollment_id = enrollment.id AND enrollment_referral_code.status = 'active'
    WHERE registration_draft.id = ? AND registration_draft.status != 'cancelled'
    GROUP BY payment_installment.id
    ORDER BY registration_draft_child.position, payment_installment.installment_number`).bind(registrationDraftId).all<EnrollmentEmailRow>();
  if (!rows.results.length) return false;
  const effective = new Map((await effectiveInstallmentsForRows(env.DB, rows.results.map((row) => ({
    id: row.installmentId, registrationDraftChildId: row.childId, installmentNumber: Number(row.installmentNumber),
    amountMnt: Number(row.amountMnt), allocatedAmountMnt: Number(row.allocatedAmountMnt),
  })))).map((row) => [row.id, row]));
  const byChild = new Map<string, EnrollmentConfirmationChild>();
  for (const row of rows.results) {
    const amount = effective.get(row.installmentId)?.effectiveAmountMnt ?? Number(row.amountMnt);
    const current = byChild.get(row.childId) ?? {
      childName: row.childName, offeringLabel: row.offeringLabel, classLabel: row.classLabel,
      paidAmountMnt: 0, remainingAmountMnt: 0, remainingPaymentDueAt: null, referralCode: row.referralCode,
    };
    current.paidAmountMnt += Number(row.allocatedAmountMnt);
    current.remainingAmountMnt += Math.max(0, amount - Number(row.allocatedAmountMnt));
    current.remainingPaymentDueAt ??= row.remainingPaymentDueAt;
    byChild.set(row.childId, current);
  }
  const children = [...byChild.values()];
  try {
    await sendParentAccessEmail(env, rows.results[0].email, registrationDraftId, {
      eventType: options.resend ? "parent_enrollment_resend" : "enrollment_confirmed",
      templateKey: options.resend ? "parent_enrollment_resend_v1" : "enrollment_confirmation_v1",
      context: { childCount: children.length, enrollmentConfirmation: true },
      template: (accessUrl) => enrollmentConfirmationTemplate({ children, accessUrl }),
    });
    return true;
  } catch {
    // Canonical promotion is already durable. The failed outbox row is retained
    // for staff visibility and a deliberate resend can issue a fresh link.
    return false;
  }
}
