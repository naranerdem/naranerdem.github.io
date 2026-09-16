import type { D1PreparedStatement, WorkerEnv } from "../env";
import { ensureDiscountAwardCredit } from "./child-credit-ledger";
import { discountAmountMnt, getDiscountPolicySettingFromDatabase, recalculateDiscountAwardBalances } from "./discounts";
import { cashReceiptProjectionsForChildren } from "./cash-receipt-projection";
import { hasStaffCapability, type StaffPrincipal } from "../staff/authorization";

export type ConditionalFamilyQuoteState = "quoted_pending" | "cash_coverage_ready" | "conditionally_confirmed" | "qualified" | "qualification_failed" | "cancelled" | "expired" | "reconciliation_review";

interface QuoteRow {
  id: string; childId: string; draftId: string; plan: string | null; initialAmountMnt: number | null; secondAmountMnt: number | null;
  baseAmountMnt: number; awardAmountMnt: number; state: ConditionalFamilyQuoteState; revision: number; claimFence: number;
  canonicalStudentId: string | null; classSessionId: string | null; isTest: number; testRunId: string | null;
  contingentSourceQuoteId: string | null; contingentPaymentInstallmentId: string | null; contingentCreditAmountMnt: number | null;
  contingentOperationId: string | null; contingentSourceRevision: number | null; contingentActorId: string | null;
}

const CLAIM_MS = 2 * 60 * 1000;

export class ConditionalFamilyDiscountError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "invalid" | "conflict") {
    super("Conditional family discount operation failed.");
  }
}

export async function historicalAdoptionChildIdsForDraft(env: WorkerEnv, actor: StaffPrincipal, registrationDraftId: string) {
  if (!hasStaffCapability(actor, "admin.settings.manage")) throw new ConditionalFamilyDiscountError("forbidden");
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(registrationDraftId)) throw new ConditionalFamilyDiscountError("invalid");
  const rows = await env.DB.prepare(`SELECT id FROM registration_draft_child WHERE registration_draft_id = ? ORDER BY position, id`)
    .bind(registrationDraftId).all<{ id: string }>();
  if (!rows.results.length) throw new ConditionalFamilyDiscountError("not_found");
  return rows.results.map((row) => row.id);
}

function cashRequirement(row: QuoteRow): number {
  return row.plan === "two_installment" ? Number(row.initialAmountMnt ?? 0) : Number(row.baseAmountMnt) - Number(row.awardAmountMnt);
}

async function fundedQuotesForKey(env: WorkerEnv, relationshipBasis: string, relationshipKey: string): Promise<Array<QuoteRow & { cashMnt: number; initialCashMnt: number; appliedCreditMnt: number }>> {
  const rows = await env.DB.prepare(`SELECT quote.id, quote.registration_draft_child_id AS childId,
      registration_draft_child.registration_draft_id AS draftId, registration_draft_child.payment_plan_code AS plan,
      registration_draft_child.initial_payment_amount_mnt AS initialAmountMnt,
      registration_draft_child.second_payment_amount_mnt AS secondAmountMnt,
      registration_draft_child.canonical_student_id AS canonicalStudentId,
      registration_draft_child.selected_class_session_id AS classSessionId,
      quote.base_amount_mnt AS baseAmountMnt, quote.award_amount_mnt AS awardAmountMnt,
      quote.state, quote.revision, quote.claim_fence AS claimFence,
      quote.is_test AS isTest, quote.test_run_id AS testRunId,
      quote.contingent_source_quote_id AS contingentSourceQuoteId,
      quote.contingent_payment_installment_id AS contingentPaymentInstallmentId,
      quote.contingent_credit_amount_mnt AS contingentCreditAmountMnt,
      quote.contingent_operation_id AS contingentOperationId,
      quote.contingent_source_revision AS contingentSourceRevision,
      quote.contingent_created_by_staff_account_id AS contingentActorId,
      COALESCE((SELECT SUM(payment_allocation.allocated_amount_mnt)
        FROM payment_allocation INNER JOIN received_payment ON received_payment.id = payment_allocation.received_payment_id
        LEFT JOIN payment_confirmation ON payment_confirmation.received_payment_id = received_payment.id
        INNER JOIN payment_installment ON payment_installment.id = payment_allocation.payment_installment_id
        WHERE payment_installment.registration_draft_child_id = registration_draft_child.id
          AND (payment_confirmation.status IS NULL OR payment_confirmation.status != 'undone')
      ), 0) AS cashMnt
      , COALESCE((SELECT SUM(payment_allocation.allocated_amount_mnt)
        FROM payment_allocation INNER JOIN received_payment ON received_payment.id = payment_allocation.received_payment_id
        LEFT JOIN payment_confirmation ON payment_confirmation.received_payment_id = received_payment.id
        INNER JOIN payment_installment ON payment_installment.id = payment_allocation.payment_installment_id
        WHERE payment_installment.registration_draft_child_id = registration_draft_child.id
          AND payment_installment.installment_kind = 'initial'
          AND (payment_confirmation.status IS NULL OR payment_confirmation.status != 'undone')
      ), 0) AS initialCashMnt
      , COALESCE((SELECT SUM(-entry.amount_mnt) FROM child_credit_entry AS entry
        WHERE entry.registration_draft_child_id = registration_draft_child.id
          AND entry.entry_kind = 'credit_application'), 0) AS appliedCreditMnt
    FROM conditional_family_discount_quote AS quote
    INNER JOIN registration_draft_child ON registration_draft_child.id = quote.registration_draft_child_id
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    WHERE quote.relationship_basis = ? AND quote.relationship_key = ?
      AND quote.state IN ('quoted_pending', 'cash_coverage_ready', 'conditionally_confirmed')
      AND registration_draft.status != 'cancelled' AND registration_draft.status != 'expired'
      AND registration_draft_child.status != 'cancelled'`).bind(relationshipBasis, relationshipKey).all<QuoteRow & { cashMnt: number; initialCashMnt: number; appliedCreditMnt: number }>();
  return rows.results.map((row) => ({ ...row, initialAmountMnt: row.initialAmountMnt == null ? null : Number(row.initialAmountMnt),
    secondAmountMnt: row.secondAmountMnt == null ? null : Number(row.secondAmountMnt), baseAmountMnt: Number(row.baseAmountMnt),
    awardAmountMnt: Number(row.awardAmountMnt), claimFence: Number(row.claimFence), isTest: Number(row.isTest), cashMnt: Number(row.cashMnt),
    initialCashMnt: Number(row.initialCashMnt), appliedCreditMnt: Number(row.appliedCreditMnt) }))
    .filter((row) => row.plan === "two_installment"
      ? row.initialCashMnt >= Number(row.initialAmountMnt ?? 0)
      : row.cashMnt + row.appliedCreditMnt + Number(row.contingentCreditAmountMnt ?? 0) >= cashRequirement(row));
}

interface EligibleAgreementRow {
  childId: string; academicYearId: string; studentId: string; classSessionId: string;
  initialAmountMnt: number | null; secondAmountMnt: number | null; isTest: number; testRunId: string | null;
}

async function createRelationshipQuotes(env: WorkerEnv, input: {
  relationshipBasis: "guardian" | "family_group" | "same_child_distinct_class";
  relationshipKey: string; rows: EligibleAgreementRow[]; now: string;
}) {
  const policy = await getDiscountPolicySettingFromDatabase(env.DB);
  if (policy.familyMultiChildBasisPoints <= 0) return { created: 0, qualified: 0 };
  const occurrences = new Set(input.rows.map((row) => `${row.studentId}:${row.classSessionId}`));
  if (occurrences.size < 2) return { created: 0, qualified: 0 };
  const statements: D1PreparedStatement[] = [];
  for (const row of input.rows) {
    const baseAmountMnt = Number(row.initialAmountMnt ?? 0) + Number(row.secondAmountMnt ?? 0);
    if (baseAmountMnt <= 0) continue;
    const id = crypto.randomUUID();
    const awardAmountMnt = discountAmountMnt(baseAmountMnt, policy.familyMultiChildBasisPoints);
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO conditional_family_discount_quote (
      id, registration_draft_child_id, academic_year_id, relationship_basis, relationship_key,
      basis_points, base_amount_mnt, award_amount_mnt, installment_strategy, state,
      created_at, updated_at, is_test, test_run_id
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'quoted_pending', ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM discount_award WHERE registration_draft_child_id = ?
        AND award_type = 'family_multi_child' AND status = 'active' AND qualification_state = 'earned')`)
      .bind(id, row.childId, row.academicYearId, input.relationshipBasis, input.relationshipKey,
        policy.familyMultiChildBasisPoints, baseAmountMnt, awardAmountMnt,
        Number(row.secondAmountMnt ?? 0) > 0 ? 'final_installment_first' : 'one_payment',
        input.now, input.now, row.isTest, row.testRunId, row.childId));
  }
  if (statements.length) await env.DB.batch(statements);
  const result = await finalizeFundedConditionalFamilyQuotes(env, input.relationshipBasis, input.relationshipKey, new Date(input.now));
  return { created: statements.length, qualified: result.awarded };
}

async function qualifyingRowsForStudents(env: WorkerEnv, studentIds: string[], academicYearId: string): Promise<EligibleAgreementRow[]> {
  if (!studentIds.length) return [];
  const rows = await env.DB.prepare(`SELECT registration_draft_child.id AS childId, class_session.academic_year_id AS academicYearId,
      registration_draft_child.canonical_student_id AS studentId, registration_draft_child.selected_class_session_id AS classSessionId,
      registration_draft_child.initial_payment_amount_mnt AS initialAmountMnt, registration_draft_child.second_payment_amount_mnt AS secondAmountMnt,
      registration_draft_child.is_test AS isTest, registration_draft_child.test_run_id AS testRunId
    FROM registration_draft_child INNER JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
      AND enrollment.status = 'confirmed' AND enrollment.transferred_out_at IS NULL
    INNER JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id
    WHERE registration_draft_child.canonical_student_id IN (${studentIds.map(() => '?').join(',')})
      AND class_session.academic_year_id = ? AND registration_draft_child.status != 'cancelled'
    ORDER BY registration_draft_child.id`).bind(...studentIds, academicYearId).all<EligibleAgreementRow>();
  return rows.results.map((row) => ({ ...row, initialAmountMnt: row.initialAmountMnt == null ? null : Number(row.initialAmountMnt),
    secondAmountMnt: row.secondAmountMnt == null ? null : Number(row.secondAmountMnt), isTest: Number(row.isTest) }));
}

export async function quoteConditionalFamilyDiscountsForGuardian(env: WorkerEnv, guardianId: string, triggerChildId: string, now = new Date().toISOString()) {
  const trigger = await env.DB.prepare(`SELECT class_session.academic_year_id AS academicYearId FROM registration_draft_child
    INNER JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id WHERE registration_draft_child.id = ?`)
    .bind(triggerChildId).first<{ academicYearId: string }>();
  if (!trigger) return { created: 0, qualified: 0 };
  const members = await env.DB.prepare(`SELECT student_id AS studentId FROM guardian_student_relationship WHERE guardian_id = ? AND status = 'active'`)
    .bind(guardianId).all<{ studentId: string }>();
  return createRelationshipQuotes(env, { relationshipBasis: 'guardian', relationshipKey: `guardian:${guardianId}:${trigger.academicYearId}`,
    rows: await qualifyingRowsForStudents(env, members.results.map((row) => row.studentId), trigger.academicYearId), now });
}

// An independently submitted child may use the already verified canonical
// guardian as relationship evidence without merging children or granting a new
// parent session. The pending agreement keeps its own draft identity until the
// normal guarded promotion path resolves it.
export async function quoteConditionalFamilyDiscountsForPendingGuardianDraft(env: WorkerEnv, draftId: string, now = new Date().toISOString()) {
  const draft = await env.DB.prepare(`SELECT registration_draft.normalized_email AS normalizedEmail, registration_draft.is_test AS isTest,
      class_session.academic_year_id AS academicYearId FROM registration_draft
    INNER JOIN registration_draft_child ON registration_draft_child.registration_draft_id = registration_draft.id
    INNER JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id
    WHERE registration_draft.id = ? AND registration_draft_child.status = 'awaiting_initial_payment' LIMIT 1`)
    .bind(draftId).first<{ normalizedEmail: string; isTest: number; academicYearId: string }>();
  if (!draft) return { created: 0, qualified: 0 };
  const guardian = await env.DB.prepare(`SELECT id FROM guardian_account WHERE email_normalized = ? AND status = 'active' AND is_test = ?`)
    .bind(draft.normalizedEmail, Number(draft.isTest)).first<{ id: string }>();
  if (!guardian) return { created: 0, qualified: 0 };
  const confirmed = await qualifyingRowsForStudents(env, (await env.DB.prepare(`SELECT student_id AS studentId FROM guardian_student_relationship
    WHERE guardian_id = ? AND status = 'active'`).bind(guardian.id).all<{ studentId: string }>()).results.map((row) => row.studentId), draft.academicYearId);
  const pending = await env.DB.prepare(`SELECT registration_draft_child.id AS childId, class_session.academic_year_id AS academicYearId,
      'draft:' || registration_draft_child.id AS studentId, registration_draft_child.selected_class_session_id AS classSessionId,
      registration_draft_child.initial_payment_amount_mnt AS initialAmountMnt, registration_draft_child.second_payment_amount_mnt AS secondAmountMnt,
      registration_draft_child.is_test AS isTest, registration_draft_child.test_run_id AS testRunId
    FROM registration_draft_child INNER JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id
    WHERE registration_draft_child.registration_draft_id = ? AND registration_draft_child.status = 'awaiting_initial_payment'`)
    .bind(draftId).all<EligibleAgreementRow>();
  return createRelationshipQuotes(env, { relationshipBasis: 'guardian', relationshipKey: `guardian:${guardian.id}:${draft.academicYearId}`,
    rows: [...confirmed, ...pending.results.map((row) => ({ ...row, initialAmountMnt: row.initialAmountMnt == null ? null : Number(row.initialAmountMnt), secondAmountMnt: row.secondAmountMnt == null ? null : Number(row.secondAmountMnt), isTest: Number(row.isTest) }))], now });
}

export async function quoteConditionalFamilyDiscountsForGroup(env: WorkerEnv, familyGroupId: string, triggerChildId: string, now = new Date().toISOString()) {
  const trigger = await env.DB.prepare(`SELECT class_session.academic_year_id AS academicYearId FROM registration_draft_child
    INNER JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id WHERE registration_draft_child.id = ?`)
    .bind(triggerChildId).first<{ academicYearId: string }>();
  if (!trigger) return { created: 0, qualified: 0 };
  const members = await env.DB.prepare(`SELECT student_id AS studentId FROM family_group_member WHERE family_group_id = ? AND status = 'active'`)
    .bind(familyGroupId).all<{ studentId: string }>();
  return createRelationshipQuotes(env, { relationshipBasis: 'family_group', relationshipKey: `family:${familyGroupId}:${trigger.academicYearId}`,
    rows: await qualifyingRowsForStudents(env, members.results.map((row) => row.studentId), trigger.academicYearId), now });
}

export async function quoteConditionalFamilyDiscountsForSameStudent(env: WorkerEnv, studentId: string, triggerChildId: string, now = new Date().toISOString()) {
  const trigger = await env.DB.prepare(`SELECT class_session.academic_year_id AS academicYearId FROM registration_draft_child
    INNER JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id WHERE registration_draft_child.id = ?`)
    .bind(triggerChildId).first<{ academicYearId: string }>();
  if (!trigger) return { created: 0, qualified: 0 };
  return createRelationshipQuotes(env, { relationshipBasis: 'same_child_distinct_class', relationshipKey: `student:${studentId}:${trigger.academicYearId}`,
    rows: await qualifyingRowsForStudents(env, [studentId], trigger.academicYearId), now });
}

// This is only a reviewed promise. It neither creates a child-credit root nor
// changes a payment allocation. The finalizer consumes it only while both
// quote revisions and the target installment still match this snapshot.
export async function authorizeContingentFamilyCredit(env: WorkerEnv, actor: StaffPrincipal, input: {
  donorQuoteId: string; recipientQuoteId: string; recipientQuoteRevision: number; paymentInstallmentId: string;
  amountMnt: number; reason: string; operationId: string;
}, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "payment.manage")) throw new ConditionalFamilyDiscountError("forbidden");
  const reason = input.reason.normalize("NFKC").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.operationId)
    || !Number.isInteger(input.amountMnt) || input.amountMnt <= 0 || !reason || reason.length > 500 || !Number.isInteger(input.recipientQuoteRevision)) {
    throw new ConditionalFamilyDiscountError("invalid");
  }
  const rows = await env.DB.prepare(`SELECT conditional_family_discount_quote.id AS id,
      registration_draft_child_id AS childId, relationship_basis AS relationshipBasis,
      relationship_key AS relationshipKey, state, revision, base_amount_mnt AS baseAmountMnt, award_amount_mnt AS awardAmountMnt,
      registration_draft_child.payment_plan_code AS plan,
      COALESCE((SELECT SUM(payment_allocation.allocated_amount_mnt) FROM payment_allocation
        INNER JOIN received_payment ON received_payment.id = payment_allocation.received_payment_id
        LEFT JOIN payment_confirmation ON payment_confirmation.received_payment_id = received_payment.id
        INNER JOIN payment_installment ON payment_installment.id = payment_allocation.payment_installment_id
        WHERE payment_installment.registration_draft_child_id = registration_draft_child.id
          AND (payment_confirmation.status IS NULL OR payment_confirmation.status != 'undone')), 0) AS cashMnt
    FROM conditional_family_discount_quote INNER JOIN registration_draft_child
      ON registration_draft_child.id = conditional_family_discount_quote.registration_draft_child_id
    WHERE conditional_family_discount_quote.id IN (?, ?)`)
    .bind(input.donorQuoteId, input.recipientQuoteId).all<{
      id: string; childId: string; relationshipBasis: string; relationshipKey: string; state: ConditionalFamilyQuoteState;
      revision: number; baseAmountMnt: number; awardAmountMnt: number; plan: string | null; cashMnt: number;
    }>();
  const donor = rows.results.find((row) => row.id === input.donorQuoteId);
  const recipient = rows.results.find((row) => row.id === input.recipientQuoteId);
  if (!donor || !recipient || donor.id === recipient.id || donor.relationshipBasis !== recipient.relationshipBasis
    || donor.relationshipKey !== recipient.relationshipKey || recipient.state !== "quoted_pending"
    || donor.state !== "quoted_pending" || donor.plan === "two_installment" || Number(donor.cashMnt) < Number(donor.baseAmountMnt)
    || Number(recipient.revision) !== input.recipientQuoteRevision
    || input.amountMnt > Number(donor.awardAmountMnt) || input.amountMnt > Number(recipient.awardAmountMnt)) {
    throw new ConditionalFamilyDiscountError("conflict");
  }
  const installment = await env.DB.prepare(`SELECT installment_kind AS installmentKind, registration_draft_child_id AS childId, status
    FROM payment_installment WHERE id = ?`).bind(input.paymentInstallmentId)
    .first<{ installmentKind: string; childId: string; status: string }>();
  const allowedInstallment = recipient.plan === "two_installment" ? "later" : "initial";
  if (!installment || installment.childId !== recipient.childId || installment.status === "released" || installment.installmentKind !== allowedInstallment) {
    throw new ConditionalFamilyDiscountError("invalid");
  }
  const existing = await env.DB.prepare(`SELECT metadata_json AS metadataJson
    FROM audit_event WHERE action = 'conditional_family_contingent_credit_authorized'
      AND json_extract(metadata_json, '$.operationId') = ? LIMIT 1`).bind(input.operationId)
    .first<{ metadataJson: string }>();
  const fingerprint = JSON.stringify([input.donorQuoteId, input.recipientQuoteId, input.recipientQuoteRevision, input.paymentInstallmentId, input.amountMnt, reason]);
  if (existing) {
    const prior = JSON.parse(existing.metadataJson) as { donorQuoteId?: string; recipientQuoteId?: string; recipientQuoteRevision?: number; paymentInstallmentId?: string; amountMnt?: number; reason?: string };
    const priorFingerprint = JSON.stringify([prior.donorQuoteId, prior.recipientQuoteId, prior.recipientQuoteRevision, prior.paymentInstallmentId, prior.amountMnt, prior.reason]);
    if (priorFingerprint !== fingerprint) throw new ConditionalFamilyDiscountError("conflict");
    return { operationId: input.operationId, idempotent: true };
  }
  const now = nowDate.toISOString();
  const changed = await env.DB.prepare(`UPDATE conditional_family_discount_quote
    SET contingent_source_quote_id = ?, contingent_payment_installment_id = ?, contingent_credit_amount_mnt = ?,
      contingent_reason = ?, contingent_operation_id = ?, contingent_source_revision = ?,
      contingent_created_by_staff_account_id = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND revision = ? AND state = 'quoted_pending'
      AND contingent_operation_id IS NULL
      AND EXISTS (SELECT 1 FROM conditional_family_discount_quote AS source
        WHERE source.id = ? AND source.revision = ? AND source.state = 'quoted_pending'
          AND source.relationship_basis = conditional_family_discount_quote.relationship_basis
          AND source.relationship_key = conditional_family_discount_quote.relationship_key)`)
    .bind(input.donorQuoteId, input.paymentInstallmentId, input.amountMnt, reason, input.operationId, Number(donor.revision),
      actor.staffAccountId, now, input.recipientQuoteId, input.recipientQuoteRevision, input.donorQuoteId, Number(donor.revision)).run();
  if ((changed.meta?.changes ?? 0) !== 1) throw new ConditionalFamilyDiscountError("conflict");
  await env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at)
    SELECT ?, ?, 'staff', ?, 'conditional_family_contingent_credit_authorized', 'conditional_family_discount_quote', ?, ?, ?, is_test, test_run_id, ?
    FROM conditional_family_discount_quote WHERE id = ?`).bind(crypto.randomUUID(), now, actor.staffAccountId, input.recipientQuoteId,
    JSON.stringify({ operationId: input.operationId, donorQuoteId: input.donorQuoteId, recipientQuoteId: input.recipientQuoteId,
      recipientQuoteRevision: input.recipientQuoteRevision, paymentInstallmentId: input.paymentInstallmentId, amountMnt: input.amountMnt, reason }),
    env.APP_ENV, now, input.recipientQuoteId).run();
  return { operationId: input.operationId, idempotent: false, recipientQuoteRevision: input.recipientQuoteRevision + 1 };
}

export type HistoricalConditionalAdoptionClassification = "earned" | "provisional" | "qualification_failed" | "reconciliation_review" | "already_adopted";

interface HistoricalAdoptionRow {
  awardId: string; childId: string; draftId: string; draftStatus: string; childStatus: string;
  childName: string; classLabel: string;
  basisPoints: number; baseAmountMnt: number; awardAmountMnt: number; qualificationState: string;
  plan: string | null; initialAmountMnt: number | null; secondAmountMnt: number | null; academicYearId: string;
  cashMnt: number; initialCashMnt: number; cashReceivedMnt: number; attributableCashExcessMnt: number;
  appliedCreditMnt: number; hasComplexCredit: number;
  isTest: number; testRunId: string | null; adopted: number;
}

async function adoptionFingerprint(rows: Array<Record<string, unknown>>) {
  const source = JSON.stringify(rows.map((row) => ({
    awardId: row.awardId, childId: row.childId, classification: row.classification, draftStatus: row.draftStatus,
    childStatus: row.childStatus, cashMnt: row.cashMnt, initialCashMnt: row.initialCashMnt,
    cashReceivedMnt: row.cashReceivedMnt, attributableCashExcessMnt: row.attributableCashExcessMnt,
    appliedCreditMnt: row.appliedCreditMnt, complexCredit: row.hasComplexCredit,
  })));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function historicalFundingSatisfied(row: HistoricalAdoptionRow) {
  return row.plan === "two_installment"
    ? row.initialCashMnt >= Number(row.initialAmountMnt ?? 0)
    : row.cashMnt + row.appliedCreditMnt >= Number(row.baseAmountMnt) - Number(row.awardAmountMnt);
}

function historicalQuoteState(classification: HistoricalConditionalAdoptionClassification): ConditionalFamilyQuoteState {
  if (classification === "earned") return "qualified";
  if (classification === "qualification_failed") return "qualification_failed";
  if (classification === "reconciliation_review") return "reconciliation_review";
  return "quoted_pending";
}

function historicalAwardState(classification: HistoricalConditionalAdoptionClassification) {
  if (classification === "earned") return "earned";
  if (classification === "qualification_failed") return "failed";
  if (classification === "reconciliation_review") return "reconciliation_review";
  return "provisional";
}

// Dry-run classification is deliberately separate from the migration. Existing
// released awards keep their effect until a staff member reviews this exact
// financial/relationship snapshot and explicitly adopts it.
export async function previewHistoricalConditionalFamilyAdoption(env: WorkerEnv, actor: StaffPrincipal, childIds?: string[]) {
  if (!hasStaffCapability(actor, "admin.settings.manage")) throw new ConditionalFamilyDiscountError("forbidden");
  const filter = childIds?.length ? `AND award.registration_draft_child_id IN (${childIds.map(() => "?").join(",")})` : "";
  const result = await env.DB.prepare(`SELECT award.id AS awardId, award.registration_draft_child_id AS childId,
      child.registration_draft_id AS draftId, draft.status AS draftStatus, child.status AS childStatus,
      child.given_name AS childName, class_session.display_label AS classLabel,
      award.basis_points AS basisPoints, award.base_amount_mnt AS baseAmountMnt, award.award_amount_mnt AS awardAmountMnt,
      award.qualification_state AS qualificationState, child.payment_plan_code AS plan,
      child.initial_payment_amount_mnt AS initialAmountMnt, child.second_payment_amount_mnt AS secondAmountMnt,
      class_session.academic_year_id AS academicYearId, child.is_test AS isTest, child.test_run_id AS testRunId,
      COALESCE((SELECT SUM(allocation.allocated_amount_mnt) FROM payment_allocation AS allocation
        INNER JOIN received_payment ON received_payment.id = allocation.received_payment_id
        LEFT JOIN payment_confirmation ON payment_confirmation.received_payment_id = received_payment.id
        INNER JOIN payment_installment ON payment_installment.id = allocation.payment_installment_id
        WHERE payment_installment.registration_draft_child_id = child.id
          AND (payment_confirmation.status IS NULL OR payment_confirmation.status != 'undone')), 0) AS cashMnt,
      COALESCE((SELECT SUM(allocation.allocated_amount_mnt) FROM payment_allocation AS allocation
        INNER JOIN received_payment ON received_payment.id = allocation.received_payment_id
        LEFT JOIN payment_confirmation ON payment_confirmation.received_payment_id = received_payment.id
        INNER JOIN payment_installment ON payment_installment.id = allocation.payment_installment_id
        WHERE payment_installment.registration_draft_child_id = child.id AND payment_installment.installment_kind = 'initial'
          AND (payment_confirmation.status IS NULL OR payment_confirmation.status != 'undone')), 0) AS initialCashMnt,
      COALESCE((SELECT SUM(-entry.amount_mnt) FROM child_credit_entry AS entry
        WHERE entry.registration_draft_child_id = child.id AND entry.entry_kind = 'credit_application'), 0) AS appliedCreditMnt,
      EXISTS (SELECT 1 FROM child_credit_entry AS root LEFT JOIN child_credit_entry AS debit ON debit.origin_entry_id = root.id
        WHERE root.source_discount_award_id = award.id
        GROUP BY root.id HAVING root.reserved_amount_mnt > 0 OR COALESCE(SUM(debit.amount_mnt), 0) <> 0) AS hasComplexCredit,
      CASE WHEN award.conditional_quote_id IS NULL THEN 0 ELSE 1 END AS adopted
    FROM discount_award AS award
    INNER JOIN registration_draft_child AS child ON child.id = award.registration_draft_child_id
    INNER JOIN registration_draft AS draft ON draft.id = child.registration_draft_id
    INNER JOIN class_session ON class_session.id = child.selected_class_session_id
    WHERE award.award_type = 'family_multi_child' AND award.status = 'active'
      AND award.reason = 'same_registration_guardian_multiple_children' ${filter}
    ORDER BY award.awarded_at, award.id`).bind(...(childIds ?? [])).all<HistoricalAdoptionRow>();
  const cashReceipts = await cashReceiptProjectionsForChildren(env.DB, result.results.map((row) => row.childId));
  const rows = result.results.map((row) => ({ ...row, basisPoints: Number(row.basisPoints), baseAmountMnt: Number(row.baseAmountMnt),
    awardAmountMnt: Number(row.awardAmountMnt), initialAmountMnt: row.initialAmountMnt == null ? null : Number(row.initialAmountMnt),
    secondAmountMnt: row.secondAmountMnt == null ? null : Number(row.secondAmountMnt), cashMnt: Number(row.cashMnt),
    initialCashMnt: Number(row.initialCashMnt),
    cashReceivedMnt: cashReceipts.get(row.childId)?.cashReceivedMnt ?? Number(row.cashMnt),
    attributableCashExcessMnt: cashReceipts.get(row.childId)?.attributableExcessMnt ?? 0,
    appliedCreditMnt: Number(row.appliedCreditMnt), isTest: Number(row.isTest) }));
  const groups = new Map<string, HistoricalAdoptionRow[]>();
  for (const row of rows) groups.set(`${row.draftId}:${row.academicYearId}`, [...(groups.get(`${row.draftId}:${row.academicYearId}`) ?? []), row]);
  const classified = rows.map((row) => {
    if (Number(row.adopted)) return { ...row, classification: "already_adopted" as const };
    if (Number(row.hasComplexCredit)) return { ...row, classification: "reconciliation_review" as const };
    const active = (groups.get(`${row.draftId}:${row.academicYearId}`) ?? []).filter((candidate) => !Number(candidate.adopted)
      && !Number(candidate.hasComplexCredit) && candidate.childStatus !== "cancelled" && !["cancelled", "expired"].includes(candidate.draftStatus));
    if (active.length < 2) return { ...row, classification: "qualification_failed" as const };
    const funded = active.filter(historicalFundingSatisfied);
    return { ...row, classification: funded.length >= 2 && funded.some((candidate) => candidate.awardId === row.awardId)
      ? "earned" as const : "provisional" as const };
  });
  return { rows: classified.map((row) => ({ ...row,
    currentRequestedMnt: Math.max(0, row.baseAmountMnt - row.cashMnt - row.appliedCreditMnt
      - (row.classification === "earned" || row.classification === "already_adopted" ? row.awardAmountMnt : row.awardAmountMnt)),
    failureShortfallMnt: Math.max(0, row.baseAmountMnt - row.cashMnt - row.appliedCreditMnt),
  })), reviewFingerprint: await adoptionFingerprint(classified) };
}

async function recoverHistoricalConditionalAdoption(env: WorkerEnv, awardIds: string[], now: string) {
  if (!awardIds.length) return;
  const rows = await env.DB.prepare(`SELECT award.id AS awardId, award.registration_draft_child_id AS childId,
      child.registration_draft_id AS draftId, class_session.academic_year_id AS academicYearId,
      award.basis_points AS basisPoints, award.base_amount_mnt AS baseAmountMnt, award.award_amount_mnt AS awardAmountMnt,
      award.qualification_state AS qualificationState, child.payment_plan_code AS plan,
      award.conditional_quote_id AS quoteId, child.is_test AS isTest, child.test_run_id AS testRunId
    FROM discount_award AS award INNER JOIN registration_draft_child AS child ON child.id = award.registration_draft_child_id
    INNER JOIN class_session ON class_session.id = child.selected_class_session_id
    WHERE award.id IN (${awardIds.map(() => "?").join(",")})`).bind(...awardIds).all<{
      awardId: string; childId: string; draftId: string; academicYearId: string; basisPoints: number; baseAmountMnt: number;
      awardAmountMnt: number; qualificationState: HistoricalConditionalAdoptionClassification; plan: string | null;
      quoteId: string | null; isTest: number; testRunId: string | null;
    }>();
  for (const row of rows.results) {
    if (!row.quoteId) continue;
    await env.DB.prepare(`INSERT OR IGNORE INTO conditional_family_discount_quote (
      id, registration_draft_child_id, academic_year_id, relationship_basis, relationship_key,
      basis_points, base_amount_mnt, award_amount_mnt, installment_strategy, state, linked_discount_award_id,
      resolution_reason, created_at, updated_at, is_test, test_run_id
    ) VALUES (?, ?, ?, 'same_submission', ?, ?, ?, ?, ?, ?, ?, 'historical_adoption', ?, ?, ?, ?)`)
      .bind(row.quoteId, row.childId, row.academicYearId, `historical:${row.draftId}:${row.academicYearId}`,
        Number(row.basisPoints), Number(row.baseAmountMnt), Number(row.awardAmountMnt),
        row.plan === "two_installment" ? "final_installment_first" : "one_payment", historicalQuoteState(row.qualificationState),
        row.awardId, now, now, Number(row.isTest), row.testRunId).run();
    if (row.qualificationState === "earned") {
      await recalculateDiscountAwardBalances(env.DB, row.childId, now);
      await materializeConditionalFamilyAwardCredit(env, row.childId, now);
    }
  }
}

export async function adoptHistoricalConditionalFamilyAwards(env: WorkerEnv, actor: StaffPrincipal, input: {
  operationId: string; childIds?: string[]; reason: string; reviewFingerprint: string;
}, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "admin.settings.manage")) throw new ConditionalFamilyDiscountError("forbidden");
  const reason = input.reason.normalize("NFKC").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(input.operationId) || !reason || !/^[0-9a-f]{64}$/i.test(input.reviewFingerprint)) {
    throw new ConditionalFamilyDiscountError("invalid");
  }
  const existing = await env.DB.prepare(`SELECT metadata_json AS metadataJson FROM audit_event
    WHERE action = 'conditional_family_historical_adoption_completed' AND json_extract(metadata_json, '$.operationId') = ? LIMIT 1`)
    .bind(input.operationId).first<{ metadataJson: string }>();
  if (existing) {
    const prior = JSON.parse(existing.metadataJson) as { reviewFingerprint?: string; awardIds?: string[]; adopted?: number; reconciliationReview?: number };
    if (prior.reviewFingerprint !== input.reviewFingerprint) throw new ConditionalFamilyDiscountError("conflict");
    await recoverHistoricalConditionalAdoption(env, prior.awardIds ?? [], nowDate.toISOString());
    return { operationId: input.operationId, adopted: Number(prior.adopted ?? 0), reconciliationReview: Number(prior.reconciliationReview ?? 0), idempotent: true };
  }
  const preview = await previewHistoricalConditionalFamilyAdoption(env, actor, input.childIds);
  if (preview.reviewFingerprint !== input.reviewFingerprint) throw new ConditionalFamilyDiscountError("conflict");
  const pending = preview.rows.filter((row) => row.classification !== "already_adopted");
  const now = nowDate.toISOString();
  for (const row of pending) {
    const quoteId = `${row.awardId}:historical-quote`;
    // The quote is written first because discount_award.conditional_quote_id
    // is a foreign key. A crash between these writes leaves the legacy award
    // untouched and a deterministic recovery marker, never a dangling link.
    await env.DB.prepare(`INSERT OR IGNORE INTO conditional_family_discount_quote (
      id, registration_draft_child_id, academic_year_id, relationship_basis, relationship_key,
      basis_points, base_amount_mnt, award_amount_mnt, installment_strategy, state, linked_discount_award_id,
      resolution_reason, created_at, updated_at, is_test, test_run_id
    ) VALUES (?, ?, ?, 'same_submission', ?, ?, ?, ?, ?, ?, ?, 'historical_adoption', ?, ?, ?, ?)`)
      .bind(quoteId, row.childId, row.academicYearId, `historical:${row.draftId}:${row.academicYearId}`,
        row.basisPoints, row.baseAmountMnt, row.awardAmountMnt,
        row.plan === "two_installment" ? "final_installment_first" : "one_payment", historicalQuoteState(row.classification),
        row.awardId, now, now, Number(row.isTest), row.testRunId).run();
    const changed = await env.DB.prepare(`UPDATE discount_award SET qualification_state = ?, conditional_quote_id = ?, updated_at = ?
      WHERE id = ? AND conditional_quote_id IS NULL AND status = 'active'`).bind(historicalAwardState(row.classification), quoteId, now, row.awardId).run();
    if ((changed.meta?.changes ?? 0) !== 1) throw new ConditionalFamilyDiscountError("conflict");
  }
  await recoverHistoricalConditionalAdoption(env, pending.map((row) => row.awardId), now);
  await env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at) VALUES (?, ?, 'staff', ?, 'conditional_family_historical_adoption_completed',
    'conditional_family_historical_adoption', ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, input.operationId, JSON.stringify({ operationId: input.operationId,
      reviewFingerprint: input.reviewFingerprint, reason, awardIds: pending.map((row) => row.awardId),
      adopted: pending.filter((row) => row.classification !== "reconciliation_review").length,
      reconciliationReview: pending.filter((row) => row.classification === "reconciliation_review").length }),
      env.APP_ENV, pending.every((row) => Number(row.isTest)) ? 1 : 0, pending[0]?.testRunId ?? null, now).run();
  return { operationId: input.operationId, adopted: pending.filter((row) => row.classification !== "reconciliation_review").length,
    reconciliationReview: pending.filter((row) => row.classification === "reconciliation_review").length, idempotent: false };
}

export async function conditionalFamilyQuoteForChild(env: WorkerEnv, childId: string) {
  return env.DB.prepare(`SELECT id, state, revision, base_amount_mnt AS baseAmountMnt, award_amount_mnt AS awardAmountMnt,
      conditional_failure_due_at AS conditionalFailureDueAt, linked_discount_award_id AS linkedDiscountAwardId
    FROM conditional_family_discount_quote WHERE registration_draft_child_id = ?
      AND state NOT IN ('cancelled', 'expired') ORDER BY created_at DESC LIMIT 1`).bind(childId)
    .first<{ id: string; state: ConditionalFamilyQuoteState; revision: number; baseAmountMnt: number; awardAmountMnt: number; conditionalFailureDueAt: string | null; linkedDiscountAwardId: string | null }>();
}

// Cancellation before an award is earned is a qualification fact, not a
// financial reversal. A remaining pair can still qualify; a lone pending quote
// becomes a visible staff-review case with no invented due date.
export async function invalidatePendingConditionalFamilyQuotesForChild(env: WorkerEnv, childId: string, nowDate = new Date()) {
  const now = nowDate.toISOString();
  const quotes = await env.DB.prepare(`SELECT id, relationship_basis AS relationshipBasis, relationship_key AS relationshipKey
    FROM conditional_family_discount_quote WHERE registration_draft_child_id = ?
      AND state IN ('quoted_pending', 'cash_coverage_ready', 'conditionally_confirmed')`).bind(childId)
    .all<{ id: string; relationshipBasis: string; relationshipKey: string }>();
  for (const quote of quotes.results) {
    await env.DB.prepare(`UPDATE conditional_family_discount_quote
      SET state = 'cancelled', claim_id = NULL, claim_expires_at = NULL, revision = revision + 1,
        resolution_reason = 'registration_cancelled_before_qualification', resolved_at = ?, updated_at = ?
      WHERE id = ? AND state IN ('quoted_pending', 'cash_coverage_ready', 'conditionally_confirmed')`)
      .bind(now, now, quote.id).run();
    // A root created for a provisional quote is retained as recovery evidence,
    // but it is not an earned credit and must not keep a reservation after the
    // quote is terminal. The ledger projection excludes provisional roots.
    await env.DB.prepare(`UPDATE child_credit_entry SET reserved_amount_mnt = 0
      WHERE source_discount_award_id = (SELECT linked_discount_award_id FROM conditional_family_discount_quote WHERE id = ?)
        AND NOT EXISTS (SELECT 1 FROM child_credit_entry AS debit
          WHERE debit.origin_entry_id = child_credit_entry.id)`)
      .bind(quote.id).run();
    const remaining = await env.DB.prepare(`SELECT COUNT(*) AS count FROM conditional_family_discount_quote AS quote
      INNER JOIN registration_draft_child AS child ON child.id = quote.registration_draft_child_id
      INNER JOIN registration_draft AS draft ON draft.id = child.registration_draft_id
      WHERE quote.relationship_basis = ? AND quote.relationship_key = ?
        AND quote.state IN ('quoted_pending', 'cash_coverage_ready', 'conditionally_confirmed')
        AND draft.status NOT IN ('cancelled', 'expired') AND child.status != 'cancelled'`)
      .bind(quote.relationshipBasis, quote.relationshipKey).first<{ count: number }>();
    if (Number(remaining?.count ?? 0) < 2) {
      await env.DB.prepare(`UPDATE conditional_family_discount_quote
        SET state = 'qualification_failed', claim_id = NULL, claim_expires_at = NULL, revision = revision + 1,
          resolution_reason = 'insufficient_remaining_qualifiers', resolved_at = ?, updated_at = ?
        WHERE relationship_basis = ? AND relationship_key = ?
          AND state IN ('quoted_pending', 'cash_coverage_ready', 'conditionally_confirmed')
          -- A relationship can disappear while this agreement still has a
          -- live same-year relationship with another candidate. In that case
          -- the agreement remains pending for the alternate basis instead of
          -- receiving a premature failure-review state.
          AND NOT EXISTS (
            SELECT 1 FROM conditional_family_discount_quote AS alternative
            WHERE alternative.registration_draft_child_id = conditional_family_discount_quote.registration_draft_child_id
              AND alternative.academic_year_id = conditional_family_discount_quote.academic_year_id
              AND (alternative.relationship_basis != conditional_family_discount_quote.relationship_basis
                OR alternative.relationship_key != conditional_family_discount_quote.relationship_key)
              AND alternative.state IN ('quoted_pending', 'cash_coverage_ready', 'conditionally_confirmed')
              AND 2 <= (
                SELECT COUNT(DISTINCT candidate.registration_draft_child_id)
                FROM conditional_family_discount_quote AS candidate
                INNER JOIN registration_draft_child AS candidate_child
                  ON candidate_child.id = candidate.registration_draft_child_id
                INNER JOIN registration_draft AS candidate_draft
                  ON candidate_draft.id = candidate_child.registration_draft_id
                WHERE candidate.relationship_basis = alternative.relationship_basis
                  AND candidate.relationship_key = alternative.relationship_key
                  AND candidate.academic_year_id = alternative.academic_year_id
                  AND candidate.state IN ('quoted_pending', 'cash_coverage_ready', 'conditionally_confirmed')
                  AND candidate_child.status != 'cancelled'
                  AND candidate_draft.status NOT IN ('cancelled', 'expired')
              )
          )`)
        .bind(now, now, quote.relationshipBasis, quote.relationshipKey).run();
    }
  }
}

// A later funded agreement may join a relationship whose earlier agreements
// already earned their awards through this same quote lineage. Those awards
// remain valid qualifiers, but must never be claimed or awarded a second time.
async function qualifiedOccurrencesForKey(env: WorkerEnv, relationshipBasis: string, relationshipKey: string) {
  const rows = await env.DB.prepare(`SELECT registration_draft_child.canonical_student_id AS studentId,
      registration_draft_child.selected_class_session_id AS classSessionId,
      registration_draft_child.id AS childId
    FROM conditional_family_discount_quote
    INNER JOIN discount_award ON discount_award.id = conditional_family_discount_quote.linked_discount_award_id
      AND discount_award.status = 'active' AND COALESCE(discount_award.qualification_state, 'earned') = 'earned'
    INNER JOIN registration_draft_child ON registration_draft_child.id = conditional_family_discount_quote.registration_draft_child_id
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    INNER JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
      AND enrollment.status = 'confirmed' AND enrollment.transferred_out_at IS NULL
    WHERE conditional_family_discount_quote.relationship_basis = ?
      AND conditional_family_discount_quote.relationship_key = ?
      AND conditional_family_discount_quote.state = 'qualified'
      AND registration_draft.status NOT IN ('cancelled', 'expired')
      AND registration_draft_child.status != 'cancelled'`)
    .bind(relationshipBasis, relationshipKey)
    .all<{ studentId: string | null; classSessionId: string | null; childId: string }>();
  return new Set(rows.results.map((row) => `${row.studentId ?? row.childId}:${row.classSessionId ?? row.childId}`));
}

// A relationship can be confirmed after one of its members already earned the
// same non-stacking family award through another valid basis. That agreement
// still proves a qualified relationship for the new member; it must not be
// awarded again just because the relationship key changed.
async function earnedOccurrencesAcrossRelationshipBases(env: WorkerEnv, relationshipBasis: string, relationshipKey: string) {
  const parts = relationshipKey.split(":");
  let memberPredicate: string;
  let bindings: string[];
  if (relationshipBasis === "guardian" && parts.length === 3 && parts[0] === "guardian") {
    memberPredicate = `registration_draft_child.canonical_student_id IN (
      SELECT student_id FROM guardian_student_relationship WHERE guardian_id = ? AND status = 'active'
    )`;
    bindings = [parts[1], parts[2]];
  } else if (relationshipBasis === "family_group" && parts.length === 3 && parts[0] === "family") {
    memberPredicate = `registration_draft_child.canonical_student_id IN (
      SELECT student_id FROM family_group_member WHERE family_group_id = ? AND status = 'active'
    )`;
    bindings = [parts[1], parts[2]];
  } else if (relationshipBasis === "same_child_distinct_class" && parts.length === 3 && parts[0] === "student") {
    memberPredicate = "registration_draft_child.canonical_student_id = ?";
    bindings = [parts[1], parts[2]];
  } else {
    return new Set<string>();
  }
  const rows = await env.DB.prepare(`SELECT registration_draft_child.canonical_student_id AS studentId,
      registration_draft_child.selected_class_session_id AS classSessionId,
      registration_draft_child.id AS childId
    FROM registration_draft_child
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    INNER JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
      AND enrollment.status = 'confirmed' AND enrollment.transferred_out_at IS NULL
    INNER JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id
    INNER JOIN discount_award ON discount_award.registration_draft_child_id = registration_draft_child.id
      AND discount_award.award_type = 'family_multi_child' AND discount_award.status = 'active'
      AND COALESCE(discount_award.qualification_state, 'earned') = 'earned'
    WHERE ${memberPredicate} AND class_session.academic_year_id = ?
      AND registration_draft.status NOT IN ('cancelled', 'expired')
      AND registration_draft_child.status != 'cancelled'`)
    .bind(...bindings).all<{ studentId: string | null; classSessionId: string | null; childId: string }>();
  return new Set(rows.results.map((row) => `${row.studentId ?? row.childId}:${row.classSessionId ?? row.childId}`));
}

// Claims only the funded subset. An unfunded third agreement remains quoted
// pending and is never awarded merely because it shares a relationship key.
// Every relationship basis uses this exact agreement-level claim protocol.
export async function finalizeFundedConditionalFamilyQuotes(env: WorkerEnv, relationshipBasis: string, relationshipKey: string, nowDate = new Date()) {
  const funded = await fundedQuotesForKey(env, relationshipBasis, relationshipKey);
  const occurrences = new Set([
    ...await qualifiedOccurrencesForKey(env, relationshipBasis, relationshipKey),
    ...await earnedOccurrencesAcrossRelationshipBases(env, relationshipBasis, relationshipKey),
    ...funded.map((quote) => `${quote.canonicalStudentId ?? quote.childId}:${quote.classSessionId ?? quote.childId}`),
  ]);
  if (occurrences.size < 2) return { state: "unresolved" as const, awarded: 0, childIds: [] as string[] };
  if (!funded.length) return { state: "qualified" as const, awarded: 0, childIds: [] as string[] };
  const now = nowDate.toISOString();
  const expiresAt = new Date(nowDate.getTime() + CLAIM_MS).toISOString();
  const claimId = crypto.randomUUID();
  const claimed: Array<QuoteRow & { fence: number }> = [];
  for (const quote of funded.sort((left, right) => left.id.localeCompare(right.id))) {
    const result = await env.DB.prepare(`UPDATE conditional_family_discount_quote
      SET claim_id = ?, claim_expires_at = ?, claim_fence = claim_fence + 1, last_error_code = NULL, last_error_at = NULL, updated_at = ?
      WHERE id = ? AND revision = ? AND state IN ('quoted_pending', 'cash_coverage_ready', 'conditionally_confirmed')
        AND (claim_expires_at IS NULL OR claim_expires_at <= ?)`)
      .bind(claimId, expiresAt, now, quote.id, quote.revision, now).run();
    if ((result.meta?.changes ?? 0) !== 1) {
      if (claimed.length) await env.DB.batch(claimed.map((item) => env.DB.prepare(`UPDATE conditional_family_discount_quote
        SET claim_id = NULL, claim_expires_at = NULL, updated_at = ? WHERE id = ? AND claim_id = ? AND claim_fence = ?`)
        .bind(now, item.id, claimId, item.fence)));
      return { state: "busy" as const, awarded: 0, childIds: [] as string[] };
    }
    claimed.push({ ...quote, fence: quote.claimFence + 1 });
  }
  const statements: D1PreparedStatement[] = [];
  const hasContingentSettlement = claimed.some((quote) => quote.contingentSourceQuoteId && quote.contingentPaymentInstallmentId
    && quote.contingentCreditAmountMnt && quote.contingentOperationId);
  for (const quote of claimed) {
    const awardId = `${quote.childId}:discount:family`;
    // A contingent settlement has a second protected ledger phase. Keep its
    // award provisional until that phase has consumed the reserved donor value;
    // otherwise a failed transfer could expose a spendable residual credit.
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO discount_award (
      id, registration_draft_child_id, award_type, basis_points, base_amount_mnt, award_amount_mnt,
      status, qualification_state, conditional_quote_id, reason, awarded_at, is_test, test_run_id, created_at, updated_at
    ) SELECT ?, ?, 'family_multi_child', basis_points, ?, ?,
      'active', ?, ?, 'conditional_family_discount_quote', ?, ?, ?, ?, ?
      FROM conditional_family_discount_quote
      WHERE id = ? AND claim_id = ? AND claim_fence = ? AND claim_expires_at > ?
        AND state IN ('quoted_pending', 'cash_coverage_ready', 'conditionally_confirmed')`)
      .bind(awardId, quote.childId, quote.baseAmountMnt, quote.awardAmountMnt,
        hasContingentSettlement ? "provisional" : "earned", quote.id, now, quote.isTest, quote.testRunId, now, now,
        quote.id, claimId, quote.fence, now));
    statements.push(env.DB.prepare(`UPDATE conditional_family_discount_quote
      SET linked_discount_award_id = ?, updated_at = ? WHERE id = ? AND claim_id = ? AND claim_fence = ? AND claim_expires_at > ?
        AND state IN ('quoted_pending', 'cash_coverage_ready', 'conditionally_confirmed')`)
      .bind(awardId, now, quote.id, claimId, quote.fence, now));
  }
  try {
    await env.DB.batch(statements);

    // A contingent donor promise is consumed inside this same claim-owned
    // settlement. D1 batches do not provide a safe dependency chain from a
    // newly inserted award to a newly inserted root, so materialize a reserved
    // donor root first. It cannot be spent except by the fenced batch below.
    for (const recipient of claimed.filter((quote) => quote.contingentSourceQuoteId && quote.contingentPaymentInstallmentId && quote.contingentCreditAmountMnt && quote.contingentOperationId)) {
    const donor = claimed.find((quote) => quote.id === recipient.contingentSourceQuoteId);
    if (!donor || Number(recipient.contingentSourceRevision) !== donor.revision || !donor.canonicalStudentId) {
      throw new Error("conditional family contingent-credit source changed");
    }
    const amountMnt = Number(recipient.contingentCreditAmountMnt);
    const donorAwardId = `${donor.childId}:discount:family`;
    const donorRootId = `child-credit:award:${donorAwardId}`;
    const transferEntryId = `child-credit:conditional-family:${recipient.contingentOperationId}`;
    const debitId = `${transferEntryId}:debit`;
    const applicationId = `${transferEntryId}:application`;
    const requestFingerprint = JSON.stringify(["conditional-family-contingent", donor.id, recipient.id,
      recipient.contingentPaymentInstallmentId, amountMnt]);
    const existing = await env.DB.prepare(`SELECT request_fingerprint AS requestFingerprint
      FROM child_credit_operation WHERE id = ?`).bind(recipient.contingentOperationId)
      .first<{ requestFingerprint: string }>();
    const fence = `EXISTS (SELECT 1 FROM conditional_family_discount_quote AS donor
      INNER JOIN conditional_family_discount_quote AS recipient ON recipient.contingent_source_quote_id = donor.id
      WHERE donor.id = ? AND donor.claim_id = ? AND donor.claim_fence = ? AND donor.claim_expires_at > ?
        AND recipient.id = ? AND recipient.claim_id = ? AND recipient.claim_fence = ? AND recipient.claim_expires_at > ?
        AND recipient.contingent_operation_id = ? AND recipient.contingent_credit_amount_mnt = ?)`;
    const fenceBindings = [donor.id, claimId, donor.fence, now, recipient.id, claimId, recipient.fence, now,
      recipient.contingentOperationId, amountMnt];

    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) throw new Error("conditional family contingent-credit replay conflict");
    } else {
      // Family awards are applied before other active awards. This reproduces
      // the authoritative award-balance projection without briefly making a
      // provisional award effective for ordinary collection or promotion.
      const donorBalance = await env.DB.prepare(`SELECT
        COALESCE(child.initial_payment_amount_mnt, 0) + COALESCE(child.second_payment_amount_mnt, 0)
          - COALESCE((SELECT SUM(CASE WHEN confirmation.status = 'undone' THEN 0 ELSE allocation.allocated_amount_mnt END)
            FROM payment_installment AS installment
            LEFT JOIN payment_allocation AS allocation ON allocation.payment_installment_id = installment.id
            LEFT JOIN payment_confirmation AS confirmation ON confirmation.received_payment_id = allocation.received_payment_id
            WHERE installment.registration_draft_child_id = child.id), 0)
          - COALESCE((SELECT SUM(-entry.amount_mnt) FROM child_credit_entry AS entry
            WHERE entry.registration_draft_child_id = child.id AND entry.entry_kind = 'credit_application'), 0) AS unpaidAmountMnt
        FROM registration_draft_child AS child WHERE child.id = ?`).bind(donor.childId)
        .first<{ unpaidAmountMnt: number }>();
      const residualMnt = Math.max(0, amountMnt - Math.max(0, Number(donorBalance?.unpaidAmountMnt ?? 0)));
      if (residualMnt < amountMnt) throw new Error("conditional family contingent-credit donor residual changed");
      const creditUpdated = await env.DB.prepare(`UPDATE discount_award
        SET credit_amount_mnt = ?, updated_at = ? WHERE id = ? AND registration_draft_child_id = ?
          AND qualification_state = 'provisional' AND ${fence}`)
        .bind(residualMnt, now, donorAwardId, donor.childId, ...fenceBindings).run();
      if ((creditUpdated.meta?.changes ?? 0) !== 1) throw new Error("conditional family contingent-credit award claim lost");
      await ensureDiscountAwardCredit(env, { awardId: donorAwardId, registrationDraftChildId: donor.childId,
        reason: "Conditional family award credit", now, reservedAmountMnt: amountMnt });

      // The first statement in the batch is a deliberate zero-value CHECK
      // failure if the pre-debit balance or fenced reservation changed. The
      // later statements must not repeat that mutable balance check: after
      // the authorized debit it is expected to be lower. They retain only
      // stable ownership/reservation conditions, so either every financial
      // write commits or the batch rolls back.
      const reservationPrecondition = `${fence} AND EXISTS (
        SELECT 1 FROM child_credit_entry AS root
        WHERE root.id = ? AND root.registration_draft_child_id = ? AND root.source_discount_award_id = ?
          AND root.reserved_amount_mnt >= ? AND root.amount_mnt + COALESCE((SELECT SUM(debit.amount_mnt)
            FROM child_credit_entry AS debit WHERE debit.origin_entry_id = root.id), 0) >= ?
      ) AND EXISTS (SELECT 1 FROM payment_installment
        WHERE id = ? AND registration_draft_child_id = ? AND status != 'released')`;
      const reservationPreconditionBindings = [...fenceBindings, donorRootId, donor.childId, donorAwardId, amountMnt, amountMnt,
        recipient.contingentPaymentInstallmentId, recipient.childId];
      const settlementPredicate = `${fence} AND EXISTS (
        SELECT 1 FROM child_credit_entry AS root
        WHERE root.id = ? AND root.registration_draft_child_id = ? AND root.source_discount_award_id = ?
          AND root.reserved_amount_mnt >= ?
      ) AND EXISTS (SELECT 1 FROM payment_installment
        WHERE id = ? AND registration_draft_child_id = ? AND status != 'released')`;
      const settlementBindings = [...fenceBindings, donorRootId, donor.childId, donorAwardId, amountMnt,
        recipient.contingentPaymentInstallmentId, recipient.childId];
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO child_credit_entry (
          id, canonical_student_id, registration_draft_child_id, entry_kind, amount_mnt,
          reason, is_test, test_run_id, created_at
        ) SELECT ?, ?, ?, 'credit_application', 0, 'Conditional family contingent settlement guard', ?, ?, ?
          WHERE NOT (${reservationPrecondition})`)
          .bind(crypto.randomUUID(), donor.canonicalStudentId, donor.childId, donor.isTest, donor.testRunId, now,
            ...reservationPreconditionBindings),
        env.DB.prepare(`INSERT INTO child_credit_operation (
        id, operation_type, source_student_id, source_registration_draft_child_id, target_registration_draft_child_id,
        amount_mnt, reason, request_fingerprint, created_by_staff_account_id, is_test, test_run_id, created_at
      ) SELECT ?, 'transfer', ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${settlementPredicate}`)
        .bind(recipient.contingentOperationId, donor.canonicalStudentId, donor.childId, recipient.childId, amountMnt,
          recipient.contingentOperationId, requestFingerprint, recipient.contingentActorId, donor.isTest, donor.testRunId, now,
          ...settlementBindings),
        env.DB.prepare(`INSERT INTO child_credit_entry (
        id, canonical_student_id, registration_draft_child_id, operation_id, entry_kind, amount_mnt, origin_entry_id,
        reason, is_test, test_run_id, created_at
      ) SELECT ?, ?, ?, ?, 'credit_transfer_debit', -?, ?, 'Conditional family contingent transfer', ?, ?, ?
        WHERE ${settlementPredicate}`)
        .bind(debitId, donor.canonicalStudentId, donor.childId, recipient.contingentOperationId, amountMnt, donorRootId,
          donor.isTest, donor.testRunId, now, ...settlementBindings),
        env.DB.prepare(`INSERT INTO child_credit_entry (
        id, canonical_student_id, registration_draft_child_id, operation_id, entry_kind, amount_mnt,
        reason, is_test, test_run_id, created_at
      ) SELECT ?, ?, ?, ?, 'credit_transfer_credit', ?, 'Conditional family contingent transfer', ?, ?, ?
        WHERE ${settlementPredicate}`)
          .bind(transferEntryId, recipient.canonicalStudentId, recipient.childId, recipient.contingentOperationId, amountMnt,
            recipient.isTest, recipient.testRunId, now, ...settlementBindings),
        env.DB.prepare(`INSERT INTO child_credit_entry (
        id, canonical_student_id, registration_draft_child_id, operation_id, entry_kind, amount_mnt, origin_entry_id,
        payment_installment_id, reason, is_test, test_run_id, created_at
      ) SELECT ?, ?, ?, ?, 'credit_application', -?, ?, ?, 'Conditional family contingent settlement', ?, ?, ?
        WHERE ${settlementPredicate}`)
          .bind(applicationId, recipient.canonicalStudentId, recipient.childId, recipient.contingentOperationId, amountMnt, transferEntryId,
            recipient.contingentPaymentInstallmentId, recipient.isTest, recipient.testRunId, now, ...settlementBindings),
        env.DB.prepare(`UPDATE child_credit_entry SET reserved_amount_mnt = reserved_amount_mnt - ?
          WHERE id = ? AND reserved_amount_mnt >= ? AND ${settlementPredicate}`)
          .bind(amountMnt, donorRootId, amountMnt, ...settlementBindings),
        env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
          metadata_json, environment, is_test, test_run_id, created_at)
          SELECT ?, ?, 'staff', ?, 'conditional_family_contingent_credit_settled', 'child_credit_operation', ?, ?, ?, ?, ?, ?
          WHERE ${settlementPredicate}`)
          .bind(crypto.randomUUID(), now, recipient.contingentActorId, recipient.contingentOperationId,
            JSON.stringify({ donorQuoteId: donor.id, recipientQuoteId: recipient.id, amountMnt,
              paymentInstallmentId: recipient.contingentPaymentInstallmentId }), env.APP_ENV, donor.isTest, donor.testRunId, now,
            ...settlementBindings),
      ]);
      const settled = await env.DB.prepare(`SELECT COUNT(*) AS count FROM child_credit_entry
        WHERE operation_id = ? AND entry_kind IN ('credit_transfer_debit', 'credit_transfer_credit', 'credit_application')`)
        .bind(recipient.contingentOperationId).first<{ count: number }>();
      if (Number(settled?.count ?? 0) !== 3) throw new Error("conditional family contingent-credit settlement guard rejected");
    }
  }

    const resolution: D1PreparedStatement[] = [];
    for (const quote of claimed) {
      resolution.push(
        env.DB.prepare(`UPDATE discount_award SET qualification_state = 'earned', updated_at = ?
          WHERE id = ? AND registration_draft_child_id = ? AND qualification_state = 'provisional'
            AND EXISTS (SELECT 1 FROM conditional_family_discount_quote
              WHERE id = ? AND claim_id = ? AND claim_fence = ? AND claim_expires_at > ?
                AND state IN ('quoted_pending', 'cash_coverage_ready', 'conditionally_confirmed'))`)
          .bind(now, `${quote.childId}:discount:family`, quote.childId, quote.id, claimId, quote.fence, now),
        env.DB.prepare(`UPDATE conditional_family_discount_quote
          SET state = 'qualified', claim_id = NULL, claim_expires_at = NULL, resolved_at = ?, updated_at = ?
          WHERE id = ? AND claim_id = ? AND claim_fence = ?
            AND claim_expires_at > ?
            AND state IN ('quoted_pending', 'cash_coverage_ready', 'conditionally_confirmed')`)
          .bind(now, now, quote.id, claimId, quote.fence, now),
      );
    }
    await env.DB.batch(resolution);
    const resolved = await env.DB.prepare(`SELECT COUNT(*) AS count FROM conditional_family_discount_quote
      WHERE id IN (${claimed.map(() => "?").join(",")}) AND state = 'qualified'`).bind(...claimed.map((item) => item.id)).first<{ count: number }>();
    if (Number(resolved?.count ?? 0) !== claimed.length) throw new Error("conditional family quote finalization conflict");
  // A conditional approval can have promoted a fully paid child before this
  // funded subset earns its award. Re-run the residual-root calculation here,
  // rather than relying on a second promotion that will never occur.
    await Promise.all(claimed.map(async (quote) => {
      await recalculateDiscountAwardBalances(env.DB, quote.childId, now);
      await materializeConditionalFamilyAwardCredit(env, quote.childId, now);
    }));
    return { state: "qualified" as const, awarded: claimed.length, childIds: claimed.map((quote) => quote.childId) };
  } catch (error) {
    await env.DB.batch(claimed.map((quote) => env.DB.prepare(`UPDATE conditional_family_discount_quote
      SET claim_id = NULL, claim_expires_at = NULL, last_error_code = 'settlement_retryable', last_error_at = ?, updated_at = ?
      WHERE id = ? AND claim_id = ? AND claim_fence = ?`).bind(now, now, quote.id, claimId, quote.fence)));
    throw error;
  }
}

export async function finalizeFundedSameSubmissionQuotes(env: WorkerEnv, relationshipKey: string, nowDate = new Date()) {
  return finalizeFundedConditionalFamilyQuotes(env, "same_submission", relationshipKey, nowDate);
}

// Payment confirmations are immutable once their normal grace period has
// elapsed. If a later conditional settlement batch fails, scan the durable
// quote state on the next scheduler pass instead of depending on a second
// receipt or silently stranding the provisional award/reserved root.
export async function recoverFundedConditionalFamilyQuotes(env: WorkerEnv, nowDate = new Date()) {
  const now = nowDate.toISOString();
  const rows = await env.DB.prepare(`SELECT DISTINCT relationship_basis AS relationshipBasis, relationship_key AS relationshipKey
    FROM conditional_family_discount_quote
    WHERE state IN ('quoted_pending', 'cash_coverage_ready', 'conditionally_confirmed')
      AND (claim_expires_at IS NULL OR claim_expires_at <= ?)
    ORDER BY relationship_basis, relationship_key LIMIT 100`).bind(now)
    .all<{ relationshipBasis: string; relationshipKey: string }>();
  let recovered = 0;
  for (const row of rows.results) {
    try {
      const result = await finalizeFundedConditionalFamilyQuotes(env, row.relationshipBasis, row.relationshipKey, nowDate);
      recovered += result.awarded;
    } catch {
      // The quote already contains the bounded retryable error and its claim
      // was released by the finalizer. A later schedule pass can retry it.
    }
  }
  return recovered;
}

export async function materializeConditionalFamilyAwardCredit(env: WorkerEnv, childId: string, now: string) {
  const row = await env.DB.prepare(`SELECT discount_award.id AS awardId FROM discount_award
    INNER JOIN conditional_family_discount_quote ON conditional_family_discount_quote.id = discount_award.conditional_quote_id
    WHERE discount_award.registration_draft_child_id = ? AND discount_award.status = 'active'
      AND discount_award.qualification_state = 'earned' AND conditional_family_discount_quote.state = 'qualified'
    ORDER BY discount_award.awarded_at DESC LIMIT 1`).bind(childId).first<{ awardId: string }>();
  if (!row) return { created: false, amountMnt: 0 };
  return ensureDiscountAwardCredit(env, { awardId: row.awardId, registrationDraftChildId: childId,
    reason: "Conditional family discount residual credit", now });
}

// A definitive failure does not invent a new debt clock. A staff member must
// acknowledge the current quote revision and set the replacement deadline
// before ordinary overdue milestones can resume.
export async function setConditionalFamilyFailureDeadline(env: WorkerEnv, actor: StaffPrincipal, input: {
  quoteId: string; quoteRevision: number; dueAt: string; reason: string;
}, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "payment.manage")) throw new ConditionalFamilyDiscountError("forbidden");
  const due = new Date(input.dueAt);
  const reason = input.reason.normalize("NFKC").trim();
  if (!input.quoteId || !Number.isInteger(input.quoteRevision) || Number.isNaN(due.getTime()) || due <= nowDate || !reason || reason.length > 500) {
    throw new ConditionalFamilyDiscountError("invalid");
  }
  const row = await env.DB.prepare(`SELECT conditional_family_discount_quote.registration_draft_child_id AS childId,
      conditional_family_discount_quote.academic_year_id AS academicYearId,
      registration_draft.is_test AS isTest, registration_draft.test_run_id AS testRunId
    FROM conditional_family_discount_quote
    INNER JOIN registration_draft_child ON registration_draft_child.id = conditional_family_discount_quote.registration_draft_child_id
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    WHERE conditional_family_discount_quote.id = ? AND conditional_family_discount_quote.revision = ?
      AND conditional_family_discount_quote.state = 'qualification_failed'`)
    .bind(input.quoteId, input.quoteRevision).first<{ childId: string; academicYearId: string; isTest: number; testRunId: string | null }>();
  if (!row) throw new ConditionalFamilyDiscountError("not_found");
  const now = nowDate.toISOString();
  const dueAt = due.toISOString();
  const result = await env.DB.prepare(`UPDATE conditional_family_discount_quote
    SET conditional_failure_due_at = ?, resolution_reason = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND revision = ? AND state = 'qualification_failed'`)
    .bind(dueAt, reason, now, input.quoteId, input.quoteRevision).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new ConditionalFamilyDiscountError("conflict");
  const reminder = await env.DB.prepare(`SELECT initial_reminder_lead_minutes AS leadMinutes FROM payment_reminder_setting WHERE singleton = 1`)
    .first<{ leadMinutes: number }>();
  const lead = Math.max(0, Number(reminder?.leadMinutes ?? 0));
  const reminderAt = new Date(due.getTime() - lead * 60_000).toISOString();
  // Existing milestones keep their identities and delivery history. Only the
  // still-unsent milestones move to the staff-approved failure deadline.
  await env.DB.batch([
    env.DB.prepare(`UPDATE payment_notification_milestone SET scheduled_at = ?, status = 'pending', processing_started_at = NULL, updated_at = ?
      WHERE registration_draft_child_id = ? AND milestone_type = 'initial_reminder' AND status IN ('pending', 'failed', 'cancelled')`)
      .bind(reminderAt, now, row.childId),
    env.DB.prepare(`UPDATE payment_notification_milestone SET scheduled_at = ?, status = 'pending', processing_started_at = NULL, updated_at = ?
      WHERE registration_draft_child_id = ? AND milestone_type = 'initial_overdue' AND status IN ('pending', 'failed', 'cancelled')`)
      .bind(dueAt, now, row.childId),
    env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
      metadata_json, environment, is_test, test_run_id, created_at)
      VALUES (?, ?, 'staff', ?, 'conditional_family_failure_deadline_set', 'conditional_family_discount_quote', ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), now, actor.staffAccountId, input.quoteId, JSON.stringify({ quoteRevision: input.quoteRevision, dueAt, reason }),
        env.APP_ENV, row.isTest, row.testRunId, now),
  ]);
  return { quoteId: input.quoteId, dueAt, revision: input.quoteRevision + 1 };
}
