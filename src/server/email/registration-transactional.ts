import type { WorkerEnv } from "../env";
import { resolveDeliveryAddress } from "./delivery-policy";
import type { EmailProvider } from "./provider";
import { createResendProvider } from "./resend";
import { deliverQueuedEmail } from "./service";
import { paymentConfirmedTemplate, type PaymentConfirmedChild } from "./templates/payment-confirmed";
import { registrationReceiptTemplate, type RegistrationReceiptItem } from "./templates/registration-receipt";
import { effectiveInstallmentsForRows, getDiscountPolicySetting } from "../services/discounts";
import { sendParentAccessEmail } from "../auth/email-verification";
import { enrollmentConfirmationTemplate, type EnrollmentConfirmationChild } from "./templates/enrollment-confirmation";
import { internalEnrollmentConfirmationTemplate } from "./templates/internal-enrollment-confirmation";
import { internalEnrollmentNoticeRecipients } from "./archive-policy";

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

interface PaymentConfirmationSnapshot {
  version: 1;
  paymentConfirmationId: string;
  eventReceivedAmountMnt: number;
  children: PaymentConfirmedChild[];
  centerFacebookUrl: string | null;
}

interface EnrollmentEmailRow {
  email: string; childId: string; childName: string; academicYearLabel: string; offeringLabel: string; stageCode: string | null; classLabel: string;
  installmentId: string; installmentNumber: number; amountMnt: number; allocatedAmountMnt: number;
  remainingPaymentDueAt: string | null; referralCode: string | null;
}

interface ConditionalSeatRow {
  email: string; normalizedEmail: string; isTest: number; testRunId: string | null; registrationDraftId: string;
  childName: string; classLabel: string; awardAmountMnt: number; quoteState: string;
}

function enabled(env: WorkerEnv): boolean { return env.EMAIL_ENABLED === "true" && Boolean(env.RESEND_API_KEY); }

function emailProvider(env: WorkerEnv, provider?: EmailProvider): EmailProvider {
  if (provider) return provider;
  if (!env.RESEND_API_KEY) throw new Error("resend_api_key_missing");
  return createResendProvider(env.RESEND_API_KEY);
}

function escapeEmailText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function mnt(value: number): string { return `${new Intl.NumberFormat("mn-MN").format(value)} ₮`; }

// A conditional approval is intentionally a different event from financial
// settlement. It has no access capability and is safe for the configured
// operational archive copies.
export async function sendConditionalSeatConfirmationEmail(env: WorkerEnv, childId: string, quoteId: string, provider?: EmailProvider): Promise<boolean> {
  if (!enabled(env)) return false;
  const row = await env.DB.prepare(`SELECT registration_draft.email, registration_draft.normalized_email AS normalizedEmail,
      registration_draft.is_test AS isTest, registration_draft.test_run_id AS testRunId,
      registration_draft.id AS registrationDraftId,
      trim(registration_draft_child.surname || ' ' || registration_draft_child.given_name) AS childName,
      COALESCE(class_session.display_label, class_session.stage_code) || ' · ' || class_session.weekday || ' ' || class_session.start_time || '–' || class_session.end_time AS classLabel,
      conditional_family_discount_quote.award_amount_mnt AS awardAmountMnt, conditional_family_discount_quote.state AS quoteState
    FROM conditional_family_discount_quote
    INNER JOIN registration_draft_child ON registration_draft_child.id = conditional_family_discount_quote.registration_draft_child_id
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    INNER JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id
    WHERE conditional_family_discount_quote.id = ? AND registration_draft_child.id = ?
      AND conditional_family_discount_quote.state IN ('quoted_pending', 'cash_coverage_ready', 'conditionally_confirmed')`)
    .bind(quoteId, childId).first<ConditionalSeatRow>();
  if (!row) return false;
  const delivery = resolveDeliveryAddress(env.APP_ENV, row.normalizedEmail, env.STAGING_EMAIL_OVERRIDE_TO);
  const now = new Date().toISOString();
  const id = `${quoteId}:conditional-seat-parent`;
  await env.DB.prepare(`INSERT OR IGNORE INTO outbound_email (
    id, event_type, template_key, intended_to_email, actual_delivery_email, delivery_mode, status, attempt_count,
    queued_at, context_json, idempotency_key, is_test, test_run_id, created_at, updated_at, registration_draft_id
  ) SELECT ?, 'conditional_seat_confirmed', 'conditional_seat_confirmation_v1', ?, ?, ?, 'queued', 0,
    ?, ?, ?, ?, ?, ?, ?, registration_draft_child.registration_draft_id
    FROM registration_draft_child WHERE id = ?`)
    .bind(id, row.email, delivery.actualEmail, delivery.deliveryMode, now,
      JSON.stringify({ childId, quoteId, conditionalSeat: true }), `conditional-seat/${quoteId}`,
      row.isTest, row.testRunId, now, now, childId).run();
  await queueConditionalSeatInternalNotice(env, row, childId, quoteId, now);
  const queued = await env.DB.prepare(`SELECT status, actual_delivery_email AS actualDeliveryEmail FROM outbound_email WHERE id = ?`)
    .bind(id).first<{ status: string; actualDeliveryEmail: string }>();
  if (!queued) return false;
  if (queued.status === "sent") {
    await deliverConditionalSeatInternalNotice(env, row, quoteId, provider);
    return true;
  }
  const conditional = `Суудал баталгаажсан боловч гэр бүлийн хөнгөлөлтийн нөхцөл шийдэгдээгүй байна. Нөхцөл биелэхгүй бол ${mnt(Number(row.awardAmountMnt))}-ийн зөрүүг сургалтын төвтэй тохиролцоно уу.`;
  const subject = "Наран Эрдэм — Нөхцөлтэй суудал баталгаажлаа";
  const text = `${subject}\n\n${row.childName}\nАнги: ${row.classLabel}\n\n${conditional}\n\nНаран Эрдэм`;
  const html = `<!doctype html><html lang="mn"><body><h1>${escapeEmailText(subject)}</h1><p><strong>${escapeEmailText(row.childName)}</strong><br>Анги: ${escapeEmailText(row.classLabel)}</p><p>${escapeEmailText(conditional)}</p><p>Наран Эрдэм</p></body></html>`;
  await deliverQueuedEmail(env, emailProvider(env, provider), {
    id, idempotencyKey: `conditional-seat/${quoteId}`, templateKey: "conditional_seat_confirmation_v1",
    message: { from: env.EMAIL_FROM, to: queued.actualDeliveryEmail, subject, html, text },
  });
  await deliverConditionalSeatInternalNotice(env, row, quoteId, provider);
  return true;
}

function conditionalSeatInternalNoticeId(quoteId: string): string {
  return `${quoteId}:conditional-seat-internal`;
}

async function queueConditionalSeatInternalNotice(env: WorkerEnv, row: ConditionalSeatRow, childId: string, quoteId: string, now: string): Promise<void> {
  const recipients = await internalEnrollmentNoticeRecipients(env);
  if (!recipients.length) return;
  const id = conditionalSeatInternalNoticeId(quoteId);
  await env.DB.prepare(`INSERT OR IGNORE INTO outbound_email (
    id, event_type, template_key, intended_to_email, actual_delivery_email, delivery_mode,
    status, attempt_count, queued_at, context_json, idempotency_key, is_test, test_run_id,
    created_at, updated_at, registration_draft_id, email_sensitivity, bcc_recipients_json
  ) VALUES (?, 'internal_conditional_seat_confirmed', 'internal_conditional_seat_confirmation_v1', ?, ?, ?,
    'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?, 'archive_bcc_safe', ?)`)
    .bind(id, recipients[0], recipients[0], env.APP_ENV === "staging" ? "staging_override" : "production",
      now, JSON.stringify({ childId, quoteId, conditionalSeat: true }),
      `internal-conditional-seat/${quoteId}`, row.isTest, row.testRunId, now, now, row.registrationDraftId,
      JSON.stringify(recipients.slice(1))).run();
}

async function deliverConditionalSeatInternalNotice(env: WorkerEnv, row: ConditionalSeatRow, quoteId: string, provider?: EmailProvider): Promise<boolean> {
  const id = conditionalSeatInternalNoticeId(quoteId);
  const queued = await env.DB.prepare(`SELECT status, actual_delivery_email AS actualDeliveryEmail,
    bcc_recipients_json AS bccRecipientsJson FROM outbound_email WHERE id = ?`).bind(id)
    .first<{ status: string; actualDeliveryEmail: string | null; bccRecipientsJson: string | null }>();
  if (!queued || queued.status === "sent" || !queued.actualDeliveryEmail) return Boolean(queued);
  let bcc: string[] = [];
  try { bcc = queued.bccRecipientsJson ? JSON.parse(queued.bccRecipientsJson) as string[] : []; } catch { bcc = []; }
  const subject = "Наран Эрдэм — Нөхцөлтэй суудал баталгаажлаа";
  const text = `${subject}\n\n${row.childName}\nАнги: ${row.classLabel}\n\nСуудал баталгаажсан боловч гэр бүлийн хөнгөлөлтийн нөхцөл шийдэгдээгүй байна. Нөхцөл биелэхгүй бол ${mnt(Number(row.awardAmountMnt))}-ийн зөрүүг ажилтан хянана.`;
  const html = `<!doctype html><html lang="mn"><body><h1>${escapeEmailText(subject)}</h1><p><strong>${escapeEmailText(row.childName)}</strong><br>Анги: ${escapeEmailText(row.classLabel)}</p><p>Суудал баталгаажсан боловч гэр бүлийн хөнгөлөлтийн нөхцөл шийдэгдээгүй байна. Нөхцөл биелэхгүй бол ${escapeEmailText(mnt(Number(row.awardAmountMnt)))}-ийн зөрүүг ажилтан хянана.</p></body></html>`;
  await deliverQueuedEmail(env, emailProvider(env, provider), {
    id, idempotencyKey: `internal-conditional-seat/${quoteId}`, templateKey: "internal_conditional_seat_confirmation_v1",
    message: { from: env.EMAIL_FROM, to: queued.actualDeliveryEmail, subject, html, text, bcc },
  });
  return true;
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
  const targetConfirmation = paymentConfirmationId ?? (await env.DB.prepare(`SELECT payment_confirmation.id
    FROM payment_confirmation INNER JOIN payment_request ON payment_request.id = payment_confirmation.payment_request_id
    WHERE payment_request.registration_draft_id = ? AND payment_confirmation.status = 'finalized'
    ORDER BY payment_confirmation.finalized_at DESC, payment_confirmation.id DESC LIMIT 1`).bind(registrationDraftId)
    .first<{ id: string }>())?.id;
  if (!targetConfirmation) return false;
  const existing = await env.DB.prepare(`SELECT id, status, actual_delivery_email AS actualDeliveryEmail,
    context_json AS contextJson FROM outbound_email
    WHERE registration_draft_id = ? AND event_type = 'registration_payment_confirmed'
      AND json_extract(context_json, '$.paymentConfirmationId') = ?`)
    .bind(registrationDraftId, targetConfirmation)
    .first<{ id: string; status: string; actualDeliveryEmail: string; contextJson: string | null }>();
  if (existing?.status === "sent") return true;
  const delivery = resolveDeliveryAddress(env.APP_ENV, draft.normalizedEmail, env.STAGING_EMAIL_OVERRIDE_TO);
  const now = new Date().toISOString();
  let snapshot: PaymentConfirmationSnapshot | null = null;
  let snapshotFromOutbox = false;
  if (existing?.contextJson) {
    try {
      const parsed = JSON.parse(existing.contextJson) as Partial<PaymentConfirmationSnapshot>;
      if (parsed.version === 1 && parsed.paymentConfirmationId === targetConfirmation
        && typeof parsed.eventReceivedAmountMnt === "number" && Array.isArray(parsed.children)) {
        snapshot = parsed as PaymentConfirmationSnapshot;
        snapshotFromOutbox = true;
      }
    } catch { /* rebuild a legacy queued row below */ }
  }
  const id = existing?.id ?? `${targetConfirmation}:payment-confirmation`;
  if (!snapshot) {
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
      .bind(registrationDraftId, targetConfirmation, targetConfirmation).all<PaymentReceiptInstallmentRow>();
    if (!rows.results.length) return false;
    const effective = new Map((await effectiveInstallmentsForRows(env.DB, rows.results.map((row) => ({
    id: row.installmentId, registrationDraftChildId: row.childId, installmentNumber: Number(row.installmentNumber),
    amountMnt: Number(row.amountMnt), allocatedAmountMnt: Number(row.allocatedAmountMnt),
    })))).map((row) => [row.id, row]));
    const childrenById = new Map<string, PaymentConfirmedChild>();
    for (const row of rows.results) {
    const effectiveAmount = effective.get(row.installmentId)?.effectiveAmountMnt ?? Number(row.amountMnt);
    const child = childrenById.get(row.childId) ?? {
      childName: row.childName, classLabel: row.classLabel, eventAllocatedAmountMnt: 0, totalPaidAmountMnt: 0,
      remainingAmountMnt: 0, nextPaymentAmountMnt: null, nextPaymentDueAt: null,
      seatConfirmed: row.enrollmentStatus === "confirmed", facebookGroupUrl: row.facebookGroupUrl,
    };
    child.eventAllocatedAmountMnt += Number(row.receivedAmountMnt);
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
    const receipt = await env.DB.prepare(`SELECT received_payment.received_amount_mnt AS receivedAmountMnt
      FROM payment_confirmation INNER JOIN received_payment ON received_payment.id = payment_confirmation.received_payment_id
      WHERE payment_confirmation.id = ? AND payment_confirmation.status = 'finalized'`).bind(targetConfirmation)
      .first<{ receivedAmountMnt: number }>();
    if (!receipt) return false;
    snapshot = {
      version: 1,
      paymentConfirmationId: targetConfirmation,
      eventReceivedAmountMnt: Number(receipt.receivedAmountMnt),
      children: [...childrenById.values()],
      centerFacebookUrl: center?.facebookUrl ?? null,
    };
  }
  if (!existing) await env.DB.prepare(`INSERT OR IGNORE INTO outbound_email (
    id, event_type, template_key, intended_to_email, actual_delivery_email, delivery_mode, status, attempt_count,
    queued_at, context_json, idempotency_key, is_test, test_run_id, created_at, updated_at, registration_draft_id
  ) VALUES (?, 'registration_payment_confirmed', 'payment_confirmed_v1', ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, draft.email, delivery.actualEmail, delivery.deliveryMode, now, JSON.stringify(snapshot), `payment-confirmed/${targetConfirmation}`,
      draft.isTest, draft.testRunId, now, now, registrationDraftId).run();
  else if (!snapshotFromOutbox) await env.DB.prepare(`UPDATE outbound_email SET context_json = ?, updated_at = ?
    WHERE id = ? AND status IN ('queued', 'failed')`).bind(JSON.stringify(snapshot), now, id).run();
  const queued = await env.DB.prepare(`SELECT status, actual_delivery_email AS actualDeliveryEmail FROM outbound_email WHERE id = ?`)
    .bind(id).first<{ status: string; actualDeliveryEmail: string }>();
  if (!queued || queued.status === "sent") return Boolean(queued);
  if (!snapshot) return false;
  const template = paymentConfirmedTemplate(snapshot);
  await deliverQueuedEmail(env, emailProvider(env, provider), {
    id, idempotencyKey: `payment-confirmed/${targetConfirmation}`, templateKey: "payment_confirmed_v1",
    message: { from: env.EMAIL_FROM, to: queued.actualDeliveryEmail, subject: template.subject, html: template.html, text: template.text },
  });
  return true;
}

export async function sendEnrollmentConfirmationEmail(
  env: WorkerEnv,
  registrationDraftId: string,
  options: { resend?: boolean; registrationDraftChildId?: string } = {},
): Promise<boolean> {
  if (!enabled(env)) return false;
  const childId = options.registrationDraftChildId ?? null;
  const scope = childId ? `child:${childId}` : "registration";
  let existingParent: { status: string } | null = null;
  let existingInternal: { status: string } | null = null;
  if (!options.resend) {
    // A released registration-level confirmation is durable evidence for a
    // child only when the child was already confirmed when that event was
    // queued. This prevents a post-deploy scheduler pass from backfilling new
    // child events, while still allowing a sibling promoted later to notify.
    if (childId) {
      const legacyParent = await env.DB.prepare(`SELECT outbound_email.status AS status
        FROM outbound_email
        INNER JOIN registration_draft_child ON registration_draft_child.registration_draft_id = outbound_email.registration_draft_id
        INNER JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
        WHERE outbound_email.registration_draft_id = ? AND registration_draft_child.id = ?
          AND outbound_email.event_type = 'enrollment_confirmed'
          AND COALESCE(json_extract(outbound_email.context_json, '$.enrollmentConfirmationScope'), 'registration') = 'registration'
          AND enrollment.status = 'confirmed' AND enrollment.confirmed_at <= outbound_email.created_at
        ORDER BY outbound_email.created_at DESC LIMIT 1`)
        .bind(registrationDraftId, childId).first<{ status: string }>();
      if (legacyParent) return legacyParent.status === "sent";
    }
    existingParent = await env.DB.prepare(`SELECT status FROM outbound_email
      WHERE registration_draft_id = ? AND event_type = 'enrollment_confirmed'
        AND COALESCE(json_extract(context_json, '$.enrollmentConfirmationScope'), 'registration') = ?
      ORDER BY created_at DESC LIMIT 1`)
      .bind(registrationDraftId, scope).first<{ status: string }>();
    existingInternal = await env.DB.prepare(`SELECT status FROM outbound_email
      WHERE id = ? AND event_type = 'internal_enrollment_confirmed'`)
      .bind(internalEnrollmentNoticeId(registrationDraftId, childId)).first<{ status: string }>();
    // Do not backfill historical confirmations. A pre-release parent event
    // without its paired internal event remains untouched.
    if (existingParent && !existingInternal) return existingParent.status === "sent";
  }
  const rows = await env.DB.prepare(`SELECT registration_draft.email,
    registration_draft_child.id AS childId,
    trim(registration_draft_child.surname || ' ' || registration_draft_child.given_name) AS childName,
    academic_year.public_label AS academicYearLabel,
    COALESCE(activity_offering.title, class_session.stage_code) AS offeringLabel,
    class_session.stage_code AS stageCode,
    COALESCE(class_meeting_rule.weekly_weekday, class_session.weekday) || ' ' || COALESCE(class_meeting_rule.start_time, class_session.start_time) || '–' || COALESCE(class_meeting_rule.end_time, class_session.end_time) AS classLabel,
    payment_installment.id AS installmentId, payment_installment.installment_number AS installmentNumber,
    payment_installment.amount_mnt AS amountMnt,
    COALESCE(SUM(CASE WHEN payment_confirmation.status = 'undone' THEN 0 ELSE payment_allocation.allocated_amount_mnt END), 0)
      + COALESCE((SELECT SUM(-credit_entry.amount_mnt) FROM child_credit_entry AS credit_entry
        WHERE credit_entry.payment_installment_id = payment_installment.id AND credit_entry.entry_kind = 'credit_application'), 0) AS allocatedAmountMnt,
    (SELECT confirmation.remaining_payment_due_at FROM payment_confirmation AS confirmation
      INNER JOIN received_payment AS receipt ON receipt.id = confirmation.received_payment_id
      INNER JOIN payment_allocation AS allocation ON allocation.received_payment_id = receipt.id
      WHERE allocation.payment_installment_id = payment_installment.id
        AND confirmation.status = 'finalized' AND confirmation.remaining_payment_due_at IS NOT NULL
      ORDER BY confirmation.created_at DESC, confirmation.id DESC LIMIT 1) AS remainingPaymentDueAt,
    COALESCE(
      enrollment_referral_code.code,
      (SELECT shared_code.code FROM enrollment_referral_code AS shared_code
        INNER JOIN enrollment AS shared_enrollment ON shared_enrollment.id = shared_code.enrollment_id
        WHERE shared_code.student_id = enrollment.student_id AND shared_code.status = 'active'
          AND shared_enrollment.status = 'confirmed' AND shared_enrollment.transferred_out_at IS NULL
        ORDER BY shared_code.activated_at ASC, shared_code.id ASC LIMIT 1)
    ) AS referralCode
    FROM registration_draft
    INNER JOIN registration_draft_child ON registration_draft_child.registration_draft_id = registration_draft.id
    INNER JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id AND enrollment.status = 'confirmed'
    INNER JOIN academic_year ON academic_year.id = enrollment.academic_year_id
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
      ${childId ? "AND registration_draft_child.id = ?" : ""}
    GROUP BY payment_installment.id
    ORDER BY registration_draft_child.position, payment_installment.installment_number`)
    .bind(registrationDraftId, ...(childId ? [childId] : [])).all<EnrollmentEmailRow>();
  if (!rows.results.length) return false;
  const effective = new Map((await effectiveInstallmentsForRows(env.DB, rows.results.map((row) => ({
    id: row.installmentId, registrationDraftChildId: row.childId, installmentNumber: Number(row.installmentNumber),
    amountMnt: Number(row.amountMnt), allocatedAmountMnt: Number(row.allocatedAmountMnt),
  })))).map((row) => [row.id, row]));
  const byChild = new Map<string, EnrollmentConfirmationChild>();
  for (const row of rows.results) {
    const amount = effective.get(row.installmentId)?.effectiveAmountMnt ?? Number(row.amountMnt);
    const current = byChild.get(row.childId) ?? {
      childName: row.childName, academicYearLabel: row.academicYearLabel, offeringLabel: row.offeringLabel,
      stageLabel: ({ stage_1: "1-р шат", stage_2: "2-р шат", stage_3: "3-р шат" })[row.stageCode || ""] || null, classLabel: row.classLabel,
      paidAmountMnt: 0, remainingAmountMnt: 0, remainingPaymentDueAt: null, referralCode: row.referralCode,
    };
    current.paidAmountMnt += Number(row.allocatedAmountMnt);
    current.remainingAmountMnt += Math.max(0, amount - Number(row.allocatedAmountMnt));
    current.remainingPaymentDueAt ??= row.remainingPaymentDueAt;
    byChild.set(row.childId, current);
  }
  const children = [...byChild.values()];
  const referralPolicy = await getDiscountPolicySetting(env);
  const preparedInternal = !options.resend && !existingInternal
    ? await prepareInternalEnrollmentConfirmationNotice(env, registrationDraftId, children, childId)
    : null;
  let parentSent = existingParent?.status === "sent";
  if (!existingParent) {
    try {
      await sendParentAccessEmail(env, rows.results[0].email, registrationDraftId, {
        eventType: options.resend ? "parent_enrollment_resend" : "enrollment_confirmed",
        templateKey: options.resend ? "parent_enrollment_resend_v1" : "enrollment_confirmation_v1",
        context: { childCount: children.length, enrollmentConfirmation: true, enrollmentConfirmationScope: scope, registrationDraftChildId: childId },
        invalidatePrevious: !childId,
        template: (accessUrl) => enrollmentConfirmationTemplate({ children, accessUrl, referralPolicy }),
        additionalOutboundStatements: preparedInternal ? [preparedInternal.statement] : undefined,
      });
      parentSent = true;
    } catch {
      // Canonical promotion is already durable. The parent outbox row is retained
      // for staff visibility and a deliberate resend can issue a fresh link.
    }
  }
  if (!options.resend && (preparedInternal || existingInternal)) {
    try { await deliverInternalEnrollmentConfirmationNotice(env, registrationDraftId, children, referralPolicy, childId); } catch { /* durable retry */ }
  }
  return parentSent;
}

function internalEnrollmentNoticeId(registrationDraftId: string, childId: string | null = null): string {
  return childId ? `${registrationDraftId}:${childId}:internal-enrollment-confirmation` : `${registrationDraftId}:internal-enrollment-confirmation`;
}

async function prepareInternalEnrollmentConfirmationNotice(
  env: WorkerEnv,
  registrationDraftId: string,
  children: EnrollmentConfirmationChild[],
  childId: string | null,
): Promise<{ statement: ReturnType<WorkerEnv["DB"]["prepare"]> } | null> {
  const recipients = await internalEnrollmentNoticeRecipients(env);
  if (!recipients.length) return null;
  const provenance = await env.DB.prepare(`SELECT is_test AS isTest, test_run_id AS testRunId
    FROM registration_draft WHERE id = ?`).bind(registrationDraftId)
    .first<{ isTest: number; testRunId: string | null }>();
  if (!provenance) return null;
  const now = new Date().toISOString();
  const id = internalEnrollmentNoticeId(registrationDraftId, childId);
  return {
    statement: env.DB.prepare(`INSERT OR IGNORE INTO outbound_email (
      id, event_type, template_key, intended_to_email, actual_delivery_email, delivery_mode,
      status, attempt_count, queued_at, context_json, idempotency_key, is_test, test_run_id,
      created_at, updated_at, registration_draft_id, email_sensitivity, bcc_recipients_json
    ) VALUES (?, 'internal_enrollment_confirmed', 'internal_enrollment_confirmation_v1', ?, ?, ?,
      'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?, 'archive_bcc_safe', ?)`)
      .bind(id, recipients[0], recipients[0], env.APP_ENV === "staging" ? "staging_override" : "production",
      now, JSON.stringify({ registrationDraftId, registrationDraftChildId: childId, childCount: children.length, internalNotice: true }),
        `internal-enrollment-confirmation/${registrationDraftId}/${childId ?? "registration"}`, provenance.isTest, provenance.testRunId,
        now, now, registrationDraftId, JSON.stringify(recipients.slice(1))),
  };
}

export async function sendInternalEnrollmentConfirmationNotice(
  env: WorkerEnv,
  registrationDraftId: string,
  children: EnrollmentConfirmationChild[],
  referralPolicy: { referrerBasisPoints: number; referredChildBasisPoints: number },
  childIdOrProvider: string | null | EmailProvider = null,
  provider?: EmailProvider,
): Promise<boolean> {
  const childId = typeof childIdOrProvider === "string" ? childIdOrProvider : null;
  provider ??= childIdOrProvider && typeof childIdOrProvider === "object" ? childIdOrProvider : undefined;
  const prepared = await prepareInternalEnrollmentConfirmationNotice(env, registrationDraftId, children, childId);
  if (prepared) await prepared.statement.run();
  return deliverInternalEnrollmentConfirmationNotice(env, registrationDraftId, children, referralPolicy, childId, provider);
}

async function deliverInternalEnrollmentConfirmationNotice(
  env: WorkerEnv,
  registrationDraftId: string,
  children: EnrollmentConfirmationChild[],
  referralPolicy: { referrerBasisPoints: number; referredChildBasisPoints: number },
  childId: string | null,
  provider?: EmailProvider,
): Promise<boolean> {
  const id = internalEnrollmentNoticeId(registrationDraftId, childId);
  const queued = await env.DB.prepare(`SELECT status, actual_delivery_email AS actualDeliveryEmail,
    bcc_recipients_json AS bccRecipientsJson FROM outbound_email WHERE id = ?`).bind(id)
    .first<{ status: string; actualDeliveryEmail: string | null; bccRecipientsJson: string | null }>();
  if (!queued || queued.status === "sent" || !queued.actualDeliveryEmail) return Boolean(queued);
  let bcc: string[] = [];
  try { bcc = queued.bccRecipientsJson ? JSON.parse(queued.bccRecipientsJson) as string[] : []; } catch { bcc = []; }
  const template = internalEnrollmentConfirmationTemplate({ children, referralPolicy });
  await deliverQueuedEmail(env, emailProvider(env, provider), {
    id, idempotencyKey: `internal-enrollment-confirmation/${registrationDraftId}/${childId ?? "registration"}`,
    templateKey: "internal_enrollment_confirmation_v1",
    message: { from: env.EMAIL_FROM, to: queued.actualDeliveryEmail, subject: template.subject, html: template.html, text: template.text, bcc },
  });
  return true;
}

export async function reconcileInternalEnrollmentConfirmationNotices(env: WorkerEnv, nowDate = new Date()): Promise<number> {
  if (!enabled(env)) return 0;
  const candidates = await env.DB.prepare(`SELECT internal.registration_draft_id AS registrationDraftId,
      json_extract(internal.context_json, '$.registrationDraftChildId') AS registrationDraftChildId
    FROM outbound_email AS internal
    WHERE internal.event_type = 'internal_enrollment_confirmed' AND internal.status IN ('queued', 'failed')
      AND internal.created_at <= ?
      AND EXISTS (SELECT 1 FROM outbound_email AS parent
        WHERE parent.registration_draft_id = internal.registration_draft_id AND parent.event_type = 'enrollment_confirmed')
    ORDER BY internal.created_at ASC LIMIT 20`).bind(nowDate.toISOString())
    .all<{ registrationDraftId: string; registrationDraftChildId: string | null }>();
  let recovered = 0;
  for (const candidate of candidates.results) {
    try {
      await sendEnrollmentConfirmationEmail(env, candidate.registrationDraftId,
        candidate.registrationDraftChildId ? { registrationDraftChildId: candidate.registrationDraftChildId } : {});
      recovered += 1;
    } catch { /* retain the failed durable outbox event for the next run */ }
  }
  return recovered;
}
