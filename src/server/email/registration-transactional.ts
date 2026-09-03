import type { WorkerEnv } from "../env";
import { resolveDeliveryAddress } from "./delivery-policy";
import type { EmailProvider } from "./provider";
import { createResendProvider } from "./resend";
import { deliverQueuedEmail } from "./service";
import { paymentConfirmedTemplate } from "./templates/payment-confirmed";
import { registrationReceiptTemplate, type RegistrationReceiptItem } from "./templates/registration-receipt";
import { effectiveInstallmentsForRows } from "../services/discounts";

interface ReceiptRow {
  email: string; normalizedEmail: string; transferDescription: string | null;
  bankName: string | null; accountHolderName: string | null; accountNumber: string | null;
  iban: string | null; transferInstruction: string | null; childName: string; classLabel: string;
  childId: string; initialInstallmentId: string; initialAmountMnt: number; laterInstallmentId: string | null; laterAmountMnt: number | null;
  paymentDeadlineAt: string; isTest: number; testRunId: string | null;
}

interface PaymentConfirmedRow { email: string; normalizedEmail: string; isTest: number; testRunId: string | null; }

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

export async function sendPaymentConfirmedEmail(env: WorkerEnv, registrationDraftId: string, provider?: EmailProvider): Promise<boolean> {
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
  const onboarding = await env.DB.prepare(`SELECT activity_offering.facebook_group_url AS facebookGroupUrl
    FROM registration_draft_child INNER JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id
    INNER JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id AND enrollment.status = 'confirmed'
    INNER JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
    WHERE registration_draft_child.registration_draft_id = ?
    ORDER BY registration_draft_child.position LIMIT 1`).bind(registrationDraftId).first<{ facebookGroupUrl: string | null }>();
  const center = await env.DB.prepare(`SELECT facebook_page_url AS facebookUrl FROM public_center_information WHERE singleton = 1`)
    .first<{ facebookUrl: string | null }>();
  const template = paymentConfirmedTemplate({ facebookGroupUrl: onboarding?.facebookGroupUrl, centerFacebookUrl: center?.facebookUrl });
  await deliverQueuedEmail(env, emailProvider(env, provider), {
    id, idempotencyKey: `payment-confirmed/${registrationDraftId}`, templateKey: "payment_confirmed_v1",
    message: { from: env.EMAIL_FROM, to: queued.actualDeliveryEmail, subject: template.subject, html: template.html, text: template.text },
  });
  return true;
}
