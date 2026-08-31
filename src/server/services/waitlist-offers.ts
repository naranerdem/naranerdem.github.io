import { randomToken, sha256 } from "../auth/crypto";
import { resolveDeliveryAddress } from "../email/delivery-policy";
import { createResendProvider } from "../email/resend";
import { deliverQueuedEmail } from "../email/service";
import { waitlistOfferTemplate, waitlistPaymentInstructionsTemplate } from "../email/templates/waitlist-offer";
import type { D1Database, D1PreparedStatement, D1Result, WorkerEnv } from "../env";
import { getClassCapacityProjections } from "./class-capacity";
import { getInitialPaymentDeadlineSettingFromDatabase } from "../staff/initial-payment-deadline";
import { getPaymentReminderSetting } from "../staff/payment-reminders";
import { hasStaffCapability, type StaffPrincipal } from "../staff/authorization";
import { getWaitlistOfferResponseSetting } from "../staff/waitlist-offer-response";
import { registrationStatusForDraftId } from "./registration-submission";

type OfferStatus = "active" | "awaiting_transfer" | "converted" | "declined" | "closed";
type DecisionSource = "parent_link" | "staff_phone" | "staff_messenger" | "staff_other";

interface WaitlistCandidate { entryId: string; childId: string; classSessionId: string; isTest: number; testRunId: string | null; }
interface OfferRow { id: string; waitlistEntryId: string; registrationDraftChildId: string; classSessionId: string; status: OfferStatus; respondByAt: string; }
interface OfferContext extends OfferRow { childName: string; guardianName: string; phone: string; email: string; classLabel: string; weekday: string; startTime: string; endTime: string; }
interface PreparedOffer { offerId: string; entryId: string; candidate: WaitlistCandidate; token: string; tokenHash: string; respondByAt: string; }

export interface PreparedWaitlistOffers {
  statements: D1PreparedStatement[];
  dispatch(): Promise<Array<{ offer: OfferContext; token: string }>>;
}

export class WaitlistOfferError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "invalid" | "conflict" | "pricing_unavailable") {
    super("Waitlist offer operation failed.");
  }
}

function changes(result: D1Result<unknown> | undefined): number { return result?.meta?.changes ?? 0; }
function nowPlus(now: Date, minutes: number): string { return new Date(now.getTime() + minutes * 60_000).toISOString(); }

function audit(env: WorkerEnv, actor: StaffPrincipal | null, action: string, subjectId: string, metadata: Record<string, unknown>, isTest: number, testRunId: string | null, now: string): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at) VALUES (?, ?, ?, ?, ?, 'waitlist_seat_offer', ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor ? "staff" : "system", actor?.staffAccountId ?? null, action, subjectId,
      JSON.stringify(metadata), env.APP_ENV, isTest, testRunId, now);
}

async function candidatesForClass(database: D1Database, classSessionId: string, limit: number): Promise<WaitlistCandidate[]> {
  if (limit < 1) return [];
  const rows = await database.prepare(`SELECT registration_draft_waitlist_entry.id AS entryId,
    registration_draft_waitlist_entry.registration_draft_child_id AS childId,
    registration_draft_waitlist_entry.class_session_id AS classSessionId,
    registration_draft_waitlist_entry.is_test AS isTest, registration_draft_waitlist_entry.test_run_id AS testRunId
    FROM registration_draft_waitlist_entry
    LEFT JOIN waitlist_seat_offer ON waitlist_seat_offer.waitlist_entry_id = registration_draft_waitlist_entry.id
    WHERE registration_draft_waitlist_entry.class_session_id = ? AND registration_draft_waitlist_entry.status = 'active'
      AND waitlist_seat_offer.id IS NULL
    ORDER BY registration_draft_waitlist_entry.created_at, registration_draft_waitlist_entry.id LIMIT ?`).bind(classSessionId, limit).all<WaitlistCandidate>();
  return rows.results;
}

async function queueOfferEmail(env: WorkerEnv, offer: OfferContext, rawToken: string): Promise<void> {
  if (env.EMAIL_ENABLED !== "true" || !env.RESEND_API_KEY) return;
  const delivery = resolveDeliveryAddress(env.APP_ENV, offer.email, env.STAGING_EMAIL_OVERRIDE_TO);
  const emailId = `${offer.id}:offer-email`;
  const url = `${env.APP_ORIGIN.replace(/\/$/, "")}/waitlist-offer/#token=${encodeURIComponent(rawToken)}`;
  const template = waitlistOfferTemplate({ childName: offer.childName, classLabel: offer.classLabel, respondByAt: offer.respondByAt, url });
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT OR IGNORE INTO outbound_email (id, event_type, template_key, intended_to_email,
    actual_delivery_email, delivery_mode, status, attempt_count, queued_at, context_json, idempotency_key,
    is_test, test_run_id, created_at, updated_at, registration_draft_id)
    SELECT ?, 'waitlist_offer', 'waitlist_offer_v1', ?, ?, ?, 'queued', 0, ?, ?, ?,
      registration_draft.is_test, registration_draft.test_run_id, ?, ?, registration_draft.id
    FROM registration_draft_child INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    WHERE registration_draft_child.id = ?`).bind(emailId, offer.email, delivery.actualEmail, delivery.deliveryMode,
      now, JSON.stringify({ offerId: offer.id, respondByAt: offer.respondByAt }), `waitlist-offer/${offer.id}`,
      now, now, offer.registrationDraftChildId).run();
  const queued = await env.DB.prepare(`SELECT status, actual_delivery_email AS actualDeliveryEmail
    FROM outbound_email WHERE id = ?`).bind(emailId).first<{ status: string; actualDeliveryEmail: string }>();
  if (!queued || queued.status === "sent") return;
  await deliverQueuedEmail(env, createResendProvider(env.RESEND_API_KEY), { id: emailId, idempotencyKey: `waitlist-offer/${offer.id}`,
    message: { from: env.EMAIL_FROM, to: queued.actualDeliveryEmail, subject: template.subject, html: template.html, text: template.text } });
}

async function queuePaymentInstructions(env: WorkerEnv, offer: OfferRow & { draftId: string }, deadline: string): Promise<void> {
  if (env.EMAIL_ENABLED !== "true" || !env.RESEND_API_KEY) return;
  const row = await env.DB.prepare(`SELECT registration_draft.email, registration_draft.normalized_email AS normalizedEmail,
    registration_draft_child.surname || ' ' || registration_draft_child.given_name AS childName,
    registration_draft_child.initial_payment_amount_mnt AS amountMnt, payment_request.transfer_description AS transferDescription,
    payment_collection_settings.bank_name AS bankName, payment_collection_settings.account_holder_name AS accountHolder,
    payment_collection_settings.account_number AS accountNumber, payment_collection_settings.iban,
    payment_collection_settings.transfer_instruction AS transferInstruction,
    registration_draft.is_test AS isTest, registration_draft.test_run_id AS testRunId
    FROM registration_draft_child INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    INNER JOIN payment_request ON payment_request.registration_draft_id = registration_draft.id
    INNER JOIN payment_collection_settings ON payment_collection_settings.singleton = 1
    WHERE registration_draft_child.id = ? ORDER BY payment_request.created_at LIMIT 1`).bind(offer.registrationDraftChildId)
    .first<{ email: string; normalizedEmail: string; childName: string; amountMnt: number; transferDescription: string; bankName: string; accountHolder: string; accountNumber: string; iban: string | null; transferInstruction: string | null; isTest: number; testRunId: string | null }>();
  if (!row || !row.amountMnt || !row.bankName || !row.accountHolder || !row.accountNumber) return;
  const delivery = resolveDeliveryAddress(env.APP_ENV, row.normalizedEmail, env.STAGING_EMAIL_OVERRIDE_TO); const id = `${offer.id}:payment-instructions`; const now = new Date().toISOString();
  await env.DB.prepare(`INSERT OR IGNORE INTO outbound_email (id, event_type, template_key, intended_to_email, actual_delivery_email, delivery_mode, status, attempt_count, queued_at, context_json, idempotency_key, is_test, test_run_id, created_at, updated_at, registration_draft_id)
    VALUES (?, 'waitlist_offer_converted', 'waitlist_payment_instructions_v1', ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, row.email, delivery.actualEmail, delivery.deliveryMode, now, JSON.stringify({ offerId: offer.id, deadline }), `waitlist-payment/${offer.id}`, row.isTest, row.testRunId, now, now, offer.draftId).run();
  const queued = await env.DB.prepare(`SELECT status, actual_delivery_email AS actualDeliveryEmail FROM outbound_email WHERE id = ?`).bind(id).first<{ status: string; actualDeliveryEmail: string }>();
  if (!queued || queued.status === "sent") return;
  const template = waitlistPaymentInstructionsTemplate({ childName: row.childName, amountMnt: Number(row.amountMnt), deadline, bankName: row.bankName, accountHolder: row.accountHolder, accountNumber: row.accountNumber, iban: row.iban, transferInstruction: row.transferInstruction, transferDescription: row.transferDescription });
  await deliverQueuedEmail(env, createResendProvider(env.RESEND_API_KEY), { id, idempotencyKey: `waitlist-payment/${offer.id}`, message: { from: env.EMAIL_FROM, to: queued.actualDeliveryEmail, subject: template.subject, html: template.html, text: template.text } });
}

async function contextForOffer(database: D1Database, id: string): Promise<OfferContext | null> {
  return database.prepare(`SELECT waitlist_seat_offer.id, waitlist_seat_offer.waitlist_entry_id AS waitlistEntryId,
    waitlist_seat_offer.registration_draft_child_id AS registrationDraftChildId, waitlist_seat_offer.class_session_id AS classSessionId,
    waitlist_seat_offer.status, waitlist_seat_offer.respond_by_at AS respondByAt,
    registration_draft_child.surname || ' ' || registration_draft_child.given_name AS childName,
    registration_draft.guardian_full_name AS guardianName, registration_draft.primary_phone AS phone, registration_draft.email,
    class_session.display_label AS classLabel, class_session.weekday, class_session.start_time AS startTime, class_session.end_time AS endTime
    FROM waitlist_seat_offer INNER JOIN registration_draft_child ON registration_draft_child.id = waitlist_seat_offer.registration_draft_child_id
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    INNER JOIN class_session ON class_session.id = waitlist_seat_offer.class_session_id WHERE waitlist_seat_offer.id = ?`).bind(id).first<OfferContext>();
}

function offerInsertStatement(env: WorkerEnv, offer: PreparedOffer, now: string, capacityOverride?: number, savedUpdatedAt?: string): D1PreparedStatement {
  const capacity = capacityOverride === undefined ? "class_session.capacity" : "?";
  const savedGuard = capacityOverride === undefined ? "" : "\n    AND EXISTS (SELECT 1 FROM class_session WHERE id = entry.class_session_id AND capacity = ? AND updated_at = ?)";
  const statement = env.DB.prepare(`INSERT INTO waitlist_seat_offer (
    id, waitlist_entry_id, registration_draft_child_id, class_session_id, status, response_token_hash,
    offered_at, respond_by_at, is_test, test_run_id, created_at, updated_at
  ) SELECT ?, entry.id, entry.registration_draft_child_id, entry.class_session_id, 'active', ?, ?, ?, entry.is_test, entry.test_run_id, ?, ?
  FROM registration_draft_waitlist_entry AS entry
  WHERE entry.id = ? AND entry.status = 'active'
    AND EXISTS (SELECT 1 FROM class_session WHERE id = entry.class_session_id AND status IN ('available', 'full'))
    AND NOT EXISTS (SELECT 1 FROM waitlist_seat_offer existing WHERE existing.waitlist_entry_id = entry.id)
    AND NOT EXISTS (SELECT 1 FROM registration_draft_waitlist_entry earlier
      LEFT JOIN waitlist_seat_offer earlier_offer ON earlier_offer.waitlist_entry_id = earlier.id
      WHERE earlier.class_session_id = entry.class_session_id AND earlier.status = 'active' AND earlier_offer.id IS NULL
        AND (earlier.created_at < entry.created_at OR (earlier.created_at = entry.created_at AND earlier.id < entry.id)))
    AND (SELECT ${capacity}
      - (SELECT COUNT(*) FROM enrollment INNER JOIN application_child ON application_child.id = enrollment.application_child_id
         INNER JOIN pre_registration ON pre_registration.id = application_child.pre_registration_id
         WHERE enrollment.class_session_id = entry.class_session_id AND enrollment.status = 'confirmed'
           AND application_child.status = 'enrolled' AND pre_registration.deleted_at IS NULL)
      - (SELECT COUNT(*) FROM enrollment INNER JOIN application_child ON application_child.id = enrollment.application_child_id
         INNER JOIN pre_registration ON pre_registration.id = application_child.pre_registration_id
         WHERE enrollment.class_session_id = entry.class_session_id AND enrollment.status = 'awaiting_initial_payment'
           AND application_child.status = 'hold_created' AND pre_registration.deleted_at IS NULL)
      - (SELECT COUNT(*) FROM registration_capacity_hold
         LEFT JOIN registration_draft_child AS held_child ON held_child.id = registration_capacity_hold.registration_draft_child_id
         WHERE registration_capacity_hold.class_session_id = entry.class_session_id AND registration_capacity_hold.status = 'active'
           AND (registration_capacity_hold.hold_type = 'initial_payment' OR registration_capacity_hold.deadline_at > ?)
           AND held_child.canonical_enrollment_id IS NULL)
      - (SELECT COUNT(*) FROM waitlist_seat_offer WHERE class_session_id = entry.class_session_id AND status IN ('active', 'awaiting_transfer'))
      FROM class_session WHERE class_session.id = entry.class_session_id) > 0${savedGuard}`);
  return capacityOverride === undefined
    ? statement.bind(offer.offerId, offer.tokenHash, now, offer.respondByAt, now, now, offer.entryId, now)
    : statement.bind(offer.offerId, offer.tokenHash, now, offer.respondByAt, now, now, offer.entryId, capacityOverride, now, capacityOverride, savedUpdatedAt ?? now);
}

function offerFollowupStatements(env: WorkerEnv, offer: PreparedOffer, now: string): D1PreparedStatement[] {
  return [
    env.DB.prepare(`UPDATE registration_draft_waitlist_entry SET status = 'offered', offered_at = ?, offer_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'active' AND EXISTS (SELECT 1 FROM waitlist_seat_offer WHERE id = ? AND status = 'active')`)
      .bind(now, offer.respondByAt, now, offer.entryId, offer.offerId),
    env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
      metadata_json, environment, is_test, test_run_id, created_at)
      SELECT ?, ?, 'system', NULL, 'waitlist_offer_created', 'waitlist_seat_offer', ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM waitlist_seat_offer WHERE id = ? AND status = 'active')`)
      .bind(crypto.randomUUID(), now, offer.offerId, JSON.stringify({ respondByAt: offer.respondByAt }), env.APP_ENV,
        offer.candidate.isTest, offer.candidate.testRunId, now, offer.offerId),
  ];
}

async function preparedOffers(
  env: WorkerEnv,
  classSessionId: string,
  freeSeats: number,
  nowDate: Date,
  capacityOverride?: number,
  savedUpdatedAt?: string,
): Promise<PreparedWaitlistOffers> {
  const candidates = await candidatesForClass(env.DB, classSessionId, freeSeats);
  const response = await getWaitlistOfferResponseSetting(env.DB);
  const now = nowDate.toISOString();
  const offers: PreparedOffer[] = [];
  for (const candidate of candidates) {
    const token = randomToken();
    offers.push({ offerId: crypto.randomUUID(), entryId: candidate.entryId, candidate, token,
      tokenHash: await sha256(token), respondByAt: nowPlus(nowDate, response.responseMinutes) });
  }
  return {
    statements: offers.flatMap((offer) => [offerInsertStatement(env, offer, now, capacityOverride, savedUpdatedAt), ...offerFollowupStatements(env, offer, now)]),
    async dispatch() {
      const created: Array<{ offer: OfferContext; token: string }> = [];
      for (const offer of offers) {
        const context = await contextForOffer(env.DB, offer.offerId);
        if (context?.status === "active") {
          created.push({ offer: context, token: offer.token });
          // The offer is already committed. Await delivery so Worker lifetime does
          // not discard it, while keeping email failure separate from seat state.
          await queueOfferEmail(env, context, offer.token).catch(() => undefined);
        }
      }
      return created;
    },
  };
}

// Used by the class-capacity save transaction. The capacity update and FIFO
// offers are one D1 batch, so a new public registration cannot claim the new
// seat between them.
export async function prepareWaitlistOffersForCapacityIncrease(
  env: WorkerEnv,
  classSessionId: string,
  requestedCapacity: number,
  nowDate = new Date(),
  savedUpdatedAt?: string,
): Promise<PreparedWaitlistOffers> {
  const projection = (await getClassCapacityProjections(env.DB, env.APP_ENV, nowDate, [classSessionId]))[0];
  if (!projection) return { statements: [], dispatch: async () => [] };
  const consumed = projection.confirmedCount + projection.reservedInitialPaymentCount
    + projection.legacyReservationCount + projection.offeredWaitlistCount;
  return preparedOffers(env, classSessionId, Math.max(requestedCapacity - consumed, 0), nowDate, requestedCapacity, savedUpdatedAt);
}

// Each INSERT independently rechecks capacity and its FIFO predecessor. SQLite
// executes the condition with the write, so repeated/concurrent callers cannot
// create two offers for one entry or overfill the class.
export async function allocateWaitlistOffers(env: WorkerEnv, classSessionId?: string, nowDate = new Date()): Promise<Array<{ offer: OfferContext; token: string }>> {
  const projections = await getClassCapacityProjections(env.DB, env.APP_ENV, nowDate, classSessionId ? [classSessionId] : undefined);
  const created: Array<{ offer: OfferContext; token: string }> = [];
  for (const projection of projections) {
    const prepared = await preparedOffers(env, projection.classSessionId, projection.freeSeats, nowDate);
    if (prepared.statements.length) await env.DB.batch(prepared.statements);
    created.push(...await prepared.dispatch());
  }
  return created;
}

async function offerForToken(database: D1Database, token: string): Promise<OfferContext | null> {
  if (!token || token.length > 256) return null;
  return database.prepare(`SELECT waitlist_seat_offer.id FROM waitlist_seat_offer WHERE response_token_hash = ?`).bind(await sha256(token))
    .first<{ id: string }>().then((row) => row ? contextForOffer(database, row.id) : null);
}

export async function publicWaitlistOffer(database: D1Database, token: string, nowDate = new Date()) {
  const offer = await offerForToken(database, token);
  if (!offer || !["active", "awaiting_transfer", "converted"].includes(offer.status)) throw new WaitlistOfferError("not_found");
  const row = await offerRow(database, offer.id);
  return { id: offer.id, childName: offer.childName, classLabel: offer.classLabel, weekday: offer.weekday, startTime: offer.startTime, endTime: offer.endTime,
    respondByAt: offer.respondByAt, overdue: offer.status === "active" && new Date(offer.respondByAt) < nowDate, awaitingTransfer: offer.status === "awaiting_transfer", converted: offer.status === "converted",
    paymentStatus: offer.status === "converted" ? await registrationStatusForDraftId(database, row.draftId, nowDate) : null };
}

async function backupEnrollmentExists(database: D1Database, childId: string): Promise<boolean> {
  return Boolean(await database.prepare(`SELECT 1 AS value FROM registration_draft_child
    WHERE id = ? AND canonical_enrollment_id IS NOT NULL`).bind(childId).first());
}

async function offerRow(database: D1Database, id: string): Promise<OfferRow & { draftId: string; academicYearId: string; isTest: number; testRunId: string | null }> {
  const row = await database.prepare(`SELECT waitlist_seat_offer.id, waitlist_seat_offer.waitlist_entry_id AS waitlistEntryId,
    waitlist_seat_offer.registration_draft_child_id AS registrationDraftChildId, waitlist_seat_offer.class_session_id AS classSessionId,
    waitlist_seat_offer.status, waitlist_seat_offer.respond_by_at AS respondByAt, registration_draft_child.registration_draft_id AS draftId,
    registration_draft.academic_year_id AS academicYearId, registration_draft.is_test AS isTest, registration_draft.test_run_id AS testRunId
    FROM waitlist_seat_offer INNER JOIN registration_draft_child ON registration_draft_child.id = waitlist_seat_offer.registration_draft_child_id
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id WHERE waitlist_seat_offer.id = ?`).bind(id)
    .first<OfferRow & { draftId: string; academicYearId: string; isTest: number; testRunId: string | null }>();
  if (!row) throw new WaitlistOfferError("not_found"); return row;
}

async function planForOffer(database: D1Database, classSessionId: string, code: "single" | "two_installment") {
  const row = await database.prepare(`SELECT pricing.one_time_amount_mnt AS oneTime, pricing.two_installment_enabled AS twoEnabled,
    pricing.first_installment_amount_mnt AS firstAmount, pricing.second_installment_amount_mnt AS secondAmount,
    pricing.second_installment_due_on AS secondDue, payment_collection_settings.bank_name AS bankName,
    payment_collection_settings.account_holder_name AS accountHolder, payment_collection_settings.account_number AS accountNumber
    FROM class_session INNER JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
    LEFT JOIN offering_course_pricing AS pricing ON pricing.activity_offering_id = activity_offering.id
    LEFT JOIN payment_collection_settings ON payment_collection_settings.singleton = 1 WHERE class_session.id = ?`).bind(classSessionId)
    .first<{ oneTime: number | null; twoEnabled: number | null; firstAmount: number | null; secondAmount: number | null; secondDue: string | null; bankName: string | null; accountHolder: string | null; accountNumber: string | null }>();
  if (!row?.oneTime || !row.bankName || !row.accountHolder || !row.accountNumber) throw new WaitlistOfferError("pricing_unavailable");
  if (code === "single") return { code, initial: Number(row.oneTime), second: null, secondDue: null };
  if (row.twoEnabled && row.firstAmount && row.secondAmount && row.secondDue) return { code, initial: Number(row.firstAmount), second: Number(row.secondAmount), secondDue: row.secondDue };
  throw new WaitlistOfferError("invalid");
}

async function convertNewEnrollmentOffer(env: WorkerEnv, offer: OfferRow & { draftId: string; academicYearId: string; isTest: number; testRunId: string | null }, planCode: "single" | "two_installment", source: DecisionSource, nowDate: Date) {
  const plan = await planForOffer(env.DB, offer.classSessionId, planCode); const deadlineSetting = await getInitialPaymentDeadlineSettingFromDatabase(env.DB);
  const reminder = await getPaymentReminderSetting(env); const now = nowDate.toISOString(); const deadline = nowPlus(nowDate, deadlineSetting.deadlineMinutes);
  const request = await env.DB.prepare(`SELECT id FROM payment_request WHERE registration_draft_id = ? ORDER BY created_at LIMIT 1`).bind(offer.draftId).first<{ id: string }>();
  const requestId = request?.id ?? crypto.randomUUID(); const reference = `NE-${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE waitlist_seat_offer SET status = 'converted', resolved_at = ?, decision_source = ?, updated_at = ?
      WHERE id = ? AND status = 'active'`).bind(now, source, now, offer.id),
    env.DB.prepare(`UPDATE registration_draft_waitlist_entry SET status = 'accepted', updated_at = ? WHERE id = ?`).bind(now, offer.waitlistEntryId),
    env.DB.prepare(`UPDATE registration_draft_child SET selected_class_session_id = ?, preferred_waitlist_class_session_id = NULL,
      payment_plan_code = ?, initial_payment_amount_mnt = ?, second_payment_amount_mnt = ?, second_payment_due_on = ?,
      status = 'awaiting_initial_payment', updated_at = ? WHERE id = ?`).bind(offer.classSessionId, plan.code, plan.initial, plan.second, plan.secondDue, now, offer.registrationDraftChildId),
    env.DB.prepare(`UPDATE registration_draft SET status = 'awaiting_initial_payment', updated_at = ? WHERE id = ?`).bind(now, offer.draftId),
    env.DB.prepare(`INSERT INTO registration_capacity_hold (id, registration_draft_child_id, class_session_id, hold_type, status, deadline_at, is_test, test_run_id, created_at, updated_at)
      SELECT registration_draft_child.id || ':hold', registration_draft_child.id, ?, 'initial_payment', 'active', ?, registration_draft_child.is_test, registration_draft_child.test_run_id, ?, ?
      FROM registration_draft_child WHERE registration_draft_child.id = ?`).bind(offer.classSessionId, deadline, now, now, offer.registrationDraftChildId),
    env.DB.prepare(`INSERT OR IGNORE INTO payment_request (id, registration_draft_id, payment_reference, transfer_description, created_at, updated_at, is_test, test_run_id)
      SELECT ?, registration_draft.id, ?, registration_draft_child.given_name || ' ' || registration_draft.primary_phone, ?, ?, registration_draft.is_test, registration_draft.test_run_id
      FROM registration_draft_child INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id WHERE registration_draft_child.id = ?`).bind(requestId, reference, now, now, offer.registrationDraftChildId),
    env.DB.prepare(`INSERT OR IGNORE INTO payment_installment (id, payment_request_id, registration_draft_child_id, installment_number, installment_kind, amount_mnt, original_due_at, effective_due_at, reminder_lead_minutes, reminder_at, status, created_at, updated_at, is_test, test_run_id)
      SELECT registration_draft_child.id || ':initial-installment', COALESCE((SELECT id FROM payment_request WHERE registration_draft_id = registration_draft_child.registration_draft_id ORDER BY created_at LIMIT 1), ?), registration_draft_child.id, 1, 'initial', ?, ?, ?, ?, ?, 'pending', ?, ?, registration_draft_child.is_test, registration_draft_child.test_run_id FROM registration_draft_child WHERE id = ?`).bind(requestId, plan.initial, deadline, deadline, reminder.initialReminderLeadMinutes, nowPlus(nowDate, Math.max(0, deadlineSetting.deadlineMinutes - reminder.initialReminderLeadMinutes)), now, now, offer.registrationDraftChildId),
    ...(plan.second ? [env.DB.prepare(`INSERT OR IGNORE INTO payment_installment (id, payment_request_id, registration_draft_child_id, installment_number, installment_kind, amount_mnt, original_due_at, effective_due_at, reminder_lead_minutes, reminder_at, status, created_at, updated_at, is_test, test_run_id)
      SELECT registration_draft_child.id || ':later-installment', COALESCE((SELECT id FROM payment_request WHERE registration_draft_id = registration_draft_child.registration_draft_id ORDER BY created_at LIMIT 1), ?), registration_draft_child.id, 2, 'later', ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', datetime(?, '-' || ? || ' minutes')), 'pending', ?, ?, registration_draft_child.is_test, registration_draft_child.test_run_id FROM registration_draft_child WHERE id = ?`).bind(requestId, plan.second, plan.secondDue, plan.secondDue, reminder.laterReminderLeadMinutes, plan.secondDue, reminder.laterReminderLeadMinutes, now, now, offer.registrationDraftChildId)] : []),
  ]);
  if (changes(result[0]) !== 1) throw new WaitlistOfferError("conflict");
  return { converted: true, paymentDeadlineAt: deadline };
}

export async function acceptWaitlistOffer(env: WorkerEnv, offerId: string, planCode: "single" | "two_installment", source: DecisionSource, actor: StaffPrincipal | null = null, nowDate = new Date()) {
  const offer = await offerRow(env.DB, offerId);
  if (offer.status === "converted") {
    const hold = await env.DB.prepare(`SELECT deadline_at AS deadlineAt FROM registration_capacity_hold WHERE registration_draft_child_id = ?
      AND hold_type = 'initial_payment' AND status = 'active'`).bind(offer.registrationDraftChildId).first<{ deadlineAt: string }>();
    if (hold) await queuePaymentInstructions(env, offer, hold.deadlineAt).catch(() => undefined);
    return { state: offer.status, idempotent: true, paymentStatus: await registrationStatusForDraftId(env.DB, offer.draftId, nowDate) };
  }
  if (offer.status === "awaiting_transfer") return { state: offer.status, idempotent: true };
  if (offer.status !== "active") throw new WaitlistOfferError("conflict");
  const now = nowDate.toISOString();
  if (await backupEnrollmentExists(env.DB, offer.registrationDraftChildId)) {
    const changed = await env.DB.batch([
      env.DB.prepare(`UPDATE waitlist_seat_offer SET status = 'awaiting_transfer', resolved_at = ?, decision_source = ?, updated_at = ? WHERE id = ? AND status = 'active'`).bind(now, source, now, offer.id),
      env.DB.prepare(`UPDATE registration_draft_waitlist_entry SET status = 'accepted', updated_at = ? WHERE id = ?`).bind(now, offer.waitlistEntryId),
      audit(env, actor, "waitlist_offer_accepted_awaiting_transfer", offer.id, {}, offer.isTest, offer.testRunId, now),
    ]);
    if (changes(changed[0]) !== 1) throw new WaitlistOfferError("conflict");
    return { state: "awaiting_transfer", idempotent: false };
  }
  const result = await convertNewEnrollmentOffer(env, offer, planCode, source, nowDate);
  await audit(env, actor, "waitlist_offer_converted", offer.id, { planCode }, offer.isTest, offer.testRunId, now).run();
  await queuePaymentInstructions(env, offer, result.paymentDeadlineAt).catch(() => undefined);
  return { state: "converted", idempotent: false, ...result,
    paymentStatus: await registrationStatusForDraftId(env.DB, offer.draftId, nowDate) };
}

export async function declineOrCloseWaitlistOffer(env: WorkerEnv, offerId: string, source: DecisionSource, closeReason: string | null, actor: StaffPrincipal | null = null, nowDate = new Date()) {
  const offer = await offerRow(env.DB, offerId); if (offer.status !== "active") throw new WaitlistOfferError("conflict");
  const now = nowDate.toISOString(); const target = closeReason ? "closed" : "declined";
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE waitlist_seat_offer SET status = ?, resolved_at = ?, decision_source = ?, close_reason = ?, updated_at = ? WHERE id = ? AND status = 'active'`)
      .bind(target, now, source, closeReason, now, offer.id),
    env.DB.prepare(`UPDATE registration_draft_waitlist_entry SET status = ?, updated_at = ? WHERE id = ?`).bind(closeReason ? "deactivated" : "cancelled", now, offer.waitlistEntryId),
    audit(env, actor, closeReason ? "waitlist_offer_closed" : "waitlist_offer_declined", offer.id, { closeReason }, offer.isTest, offer.testRunId, now),
  ]);
  if (changes(result[0]) !== 1) throw new WaitlistOfferError("conflict");
  await allocateWaitlistOffers(env, offer.classSessionId, nowDate);
  return { state: target };
}

export async function waitlistOfferForPublicToken(database: D1Database, token: string): Promise<OfferContext> {
  const offer = await offerForToken(database, token); if (!offer || !["active", "awaiting_transfer", "converted"].includes(offer.status)) throw new WaitlistOfferError("not_found"); return offer;
}

export async function recordWaitlistContact(env: WorkerEnv, actor: StaffPrincipal, offerId: string, channel: "phone" | "messenger" | "other", nowDate = new Date()) {
  if (!hasStaffCapability(actor, "payment.manage")) throw new WaitlistOfferError("forbidden");
  const now = nowDate.toISOString(); const result = await env.DB.prepare(`UPDATE waitlist_seat_offer SET contact_last_at = ?, contact_last_channel = ?, contact_last_by_staff_account_id = ?, updated_at = ? WHERE id = ? AND status = 'active'`)
    .bind(now, channel, actor.staffAccountId, now, offerId).run(); if (changes(result) !== 1) throw new WaitlistOfferError("conflict"); return { contactedAt: now };
}

export async function extendWaitlistOffer(env: WorkerEnv, actor: StaffPrincipal, offerId: string, respondByAt: string, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "payment.manage")) throw new WaitlistOfferError("forbidden");
  if (Number.isNaN(Date.parse(respondByAt)) || new Date(respondByAt) <= nowDate) throw new WaitlistOfferError("invalid");
  const offer = await offerRow(env.DB, offerId); if (offer.status !== "active") throw new WaitlistOfferError("conflict"); const now = nowDate.toISOString();
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE waitlist_seat_offer SET respond_by_at = ?, updated_at = ? WHERE id = ? AND status = 'active'`).bind(respondByAt, now, offerId),
    audit(env, actor, "waitlist_offer_extended", offerId, { previousRespondByAt: offer.respondByAt, respondByAt }, offer.isTest, offer.testRunId, now),
  ]); if (changes(result[0]) !== 1) throw new WaitlistOfferError("conflict"); return { respondByAt };
}

export async function reissueWaitlistOfferLink(env: WorkerEnv, actor: StaffPrincipal, offerId: string, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "payment.manage")) throw new WaitlistOfferError("forbidden");
  const offer = await offerRow(env.DB, offerId); if (offer.status !== "active") throw new WaitlistOfferError("conflict");
  const rawToken = randomToken(); const now = nowDate.toISOString(); const result = await env.DB.batch([
    env.DB.prepare(`UPDATE waitlist_seat_offer SET response_token_hash = ?, updated_at = ? WHERE id = ? AND status = 'active'`)
      .bind(await sha256(rawToken), now, offerId),
    audit(env, actor, "waitlist_offer_link_reissued", offerId, {}, offer.isTest, offer.testRunId, now),
  ]); if (changes(result[0]) !== 1) throw new WaitlistOfferError("conflict");
  const context = await contextForOffer(env.DB, offerId);
  if (context?.status === "active") await queueOfferEmail(env, context, rawToken).catch(() => undefined);
  return { url: `${env.APP_ORIGIN.replace(/\/$/, "")}/waitlist-offer/#token=${encodeURIComponent(rawToken)}` };
}

export async function reconcileWaitlistOffers(env: WorkerEnv, nowDate = new Date()) { return allocateWaitlistOffers(env, undefined, nowDate); }
