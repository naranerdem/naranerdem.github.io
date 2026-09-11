import type { D1Database, D1PreparedStatement, WorkerEnv } from "../env";
import { effectiveInstallmentsForRows } from "./discounts";
import { hasStaffCapability, type StaffPrincipal } from "../staff/authorization";

export type CreditOperationType = "manual_add" | "manual_correction" | "apply" | "transfer" | "refund" | "discount_award_credit";

export class ChildCreditError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "invalid" | "conflict" | "insufficient") {
    super("Child credit operation failed.");
  }
}

export interface ChildCreditRoot {
  id: string;
  canonicalStudentId: string | null;
  registrationDraftChildId: string | null;
  entryKind: string;
  amountMnt: number;
  availableAmountMnt: number;
  createdAt: string;
  reason: string;
  externalReference: string | null;
}

export interface ChildCreditSummary {
  canonicalStudentId: string | null;
  availableAmountMnt: number;
  roots: ChildCreditRoot[];
}

export interface CreditPaymentReviewState {
  availableCreditMnt: number;
  outstandingAmountMnt: number;
  reviewed: boolean;
  eligible: boolean;
  ineligibleReason: "two_installment_first" | null;
}

function positive(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function adjustment(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number !== 0 ? number : null;
}

function operationId(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase() : null;
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max ? value.trim() : null;
}

function nowIso(nowDate: Date): string { return nowDate.toISOString(); }

function fingerprint(type: CreditOperationType, sourceStudentId: string, targetStudentId: string | null, amountMnt: number, reason: string,
  relatedId: string | null, installmentId: string | null, externalReference: string | null): string {
  return JSON.stringify([type, sourceStudentId, targetStudentId, amountMnt, reason, relatedId, installmentId, externalReference]);
}

interface ChildCreditOwner {
  registrationDraftChildId: string;
  canonicalStudentId: string | null;
  isTest: number;
  testRunId: string | null;
}

async function creditOwnerForChild(database: D1Database, registrationDraftChildId: string): Promise<ChildCreditOwner> {
  const row = await database.prepare(`SELECT canonical_student_id AS canonicalStudentId, is_test AS isTest, test_run_id AS testRunId
    FROM registration_draft_child WHERE id = ?`).bind(registrationDraftChildId)
    .first<{ canonicalStudentId: string | null; isTest: number; testRunId: string | null }>();
  if (!row) throw new ChildCreditError("not_found");
  return { registrationDraftChildId, canonicalStudentId: row.canonicalStudentId, isTest: Number(row.isTest), testRunId: row.testRunId };
}

// Legacy payment/transfer credit remains the system of record for its own
// release/refund lifecycle. Mirror it into the child ledger before any credit
// projection or operation, using deterministic IDs so retries are harmless.
export async function syncLegacyChildCreditEntries(database: D1Database, canonicalStudentId?: string) {
  const paymentFilter = canonicalStudentId ? " AND child.canonical_student_id = ?" : "";
  const transferFilter = canonicalStudentId ? " AND enrollment.student_id = ?" : "";
  const roots = [
    database.prepare(`INSERT OR IGNORE INTO child_credit_entry (
      id, canonical_student_id, registration_draft_child_id, entry_kind, amount_mnt, source_payment_credit_id,
      reason, is_test, test_run_id, created_at
    ) SELECT 'child-credit:payment:' || payment_credit.id, child.canonical_student_id, child.id,
      'payment_release', payment_credit.available_amount_mnt, payment_credit.id,
      'Released payment credit', payment_credit.is_test, payment_credit.test_run_id, payment_credit.created_at
      FROM payment_credit
      INNER JOIN payment_request ON payment_request.id = payment_credit.payment_request_id
      INNER JOIN payment_installment ON payment_installment.payment_request_id = payment_request.id
        AND payment_installment.installment_kind = 'initial'
      INNER JOIN registration_draft_child AS child ON child.id = payment_installment.registration_draft_child_id
      WHERE child.canonical_student_id IS NOT NULL${paymentFilter}`)
      .bind(...(canonicalStudentId ? [canonicalStudentId] : [])),
    database.prepare(`INSERT OR IGNORE INTO child_credit_entry (
      id, canonical_student_id, entry_kind, amount_mnt, source_class_transfer_credit_id,
      reason, is_test, test_run_id, created_at
    ) SELECT 'child-credit:transfer:' || class_transfer_credit.id, enrollment.student_id,
      'transfer_difference', class_transfer_credit.available_amount_mnt, class_transfer_credit.id,
      'Class transfer price difference', class_transfer_credit.is_test, class_transfer_credit.test_run_id, class_transfer_credit.created_at
      FROM class_transfer_credit
      INNER JOIN class_transfer ON class_transfer.id = class_transfer_credit.class_transfer_id
      INNER JOIN enrollment ON enrollment.id = class_transfer.source_enrollment_id
      WHERE 1 = 1${transferFilter}`)
      .bind(...(canonicalStudentId ? [canonicalStudentId] : [])),
  ];
  const closes = [
    database.prepare(`INSERT OR IGNORE INTO child_credit_entry (
      id, canonical_student_id, entry_kind, amount_mnt, origin_entry_id, reason,
      is_test, test_run_id, created_at
    ) SELECT 'child-credit:payment-close:' || payment_credit.id || ':' || payment_credit.status,
      root.canonical_student_id,
      CASE WHEN payment_credit.status = 'refunded' THEN 'refund' ELSE 'credit_application' END,
      -(root.amount_mnt + COALESCE((SELECT SUM(debit.amount_mnt) FROM child_credit_entry AS debit
        WHERE debit.origin_entry_id = root.id), 0)), root.id,
      CASE WHEN payment_credit.status = 'refunded' THEN 'Marked refunded' ELSE 'Allocated by reinstatement' END,
      payment_credit.is_test, payment_credit.test_run_id, payment_credit.updated_at
      FROM payment_credit
      INNER JOIN child_credit_entry AS root ON root.source_payment_credit_id = payment_credit.id
      WHERE payment_credit.status IN ('refunded', 'allocated')${canonicalStudentId ? " AND root.canonical_student_id = ?" : ""}
        AND root.amount_mnt + COALESCE((SELECT SUM(debit.amount_mnt) FROM child_credit_entry AS debit
          WHERE debit.origin_entry_id = root.id), 0) > 0`)
      .bind(...(canonicalStudentId ? [canonicalStudentId] : [])),
    database.prepare(`INSERT OR IGNORE INTO child_credit_entry (
      id, canonical_student_id, entry_kind, amount_mnt, origin_entry_id, reason,
      is_test, test_run_id, created_at
    ) SELECT 'child-credit:transfer-close:' || class_transfer_credit.id || ':' || class_transfer_credit.status,
      root.canonical_student_id,
      CASE WHEN class_transfer_credit.status = 'refunded' THEN 'refund' ELSE 'credit_application' END,
      -(root.amount_mnt + COALESCE((SELECT SUM(debit.amount_mnt) FROM child_credit_entry AS debit
        WHERE debit.origin_entry_id = root.id), 0)), root.id,
      CASE WHEN class_transfer_credit.status = 'refunded' THEN 'Marked refunded' ELSE 'Allocated by reconciliation' END,
      class_transfer_credit.is_test, class_transfer_credit.test_run_id, class_transfer_credit.updated_at
      FROM class_transfer_credit
      INNER JOIN child_credit_entry AS root ON root.source_class_transfer_credit_id = class_transfer_credit.id
      WHERE class_transfer_credit.status IN ('refunded', 'allocated')${canonicalStudentId ? " AND root.canonical_student_id = ?" : ""}
        AND root.amount_mnt + COALESCE((SELECT SUM(debit.amount_mnt) FROM child_credit_entry AS debit
          WHERE debit.origin_entry_id = root.id), 0) > 0`)
      .bind(...(canonicalStudentId ? [canonicalStudentId] : [])),
  ];
  await database.batch([...roots, ...closes]);
}

export async function childCreditSummary(database: D1Database, canonicalStudentId: string): Promise<ChildCreditSummary> {
  await syncLegacyChildCreditEntries(database, canonicalStudentId);
  const result = await database.prepare(`SELECT root.id, root.canonical_student_id AS canonicalStudentId, root.entry_kind AS entryKind,
    root.registration_draft_child_id AS registrationDraftChildId,
    root.amount_mnt AS amountMnt, root.created_at AS createdAt, root.reason, root.external_reference AS externalReference,
    root.amount_mnt + COALESCE(SUM(debit.amount_mnt), 0) - root.reserved_amount_mnt AS availableAmountMnt
    FROM child_credit_entry AS root
    LEFT JOIN child_credit_entry AS debit ON debit.origin_entry_id = root.id
    WHERE root.canonical_student_id = ? AND root.amount_mnt > 0
    GROUP BY root.id HAVING root.amount_mnt + COALESCE(SUM(debit.amount_mnt), 0) > 0
    ORDER BY root.created_at, root.id`).bind(canonicalStudentId).all<ChildCreditRoot>();
  const roots = result.results.map((row) => ({ ...row, amountMnt: Number(row.amountMnt), availableAmountMnt: Number(row.availableAmountMnt) }));
  return { canonicalStudentId, roots, availableAmountMnt: roots.reduce((sum, row) => sum + row.availableAmountMnt, 0) };
}

async function childCreditSummaryForOwner(database: D1Database, owner: ChildCreditOwner): Promise<ChildCreditSummary> {
  if (owner.canonicalStudentId) return childCreditSummary(database, owner.canonicalStudentId);
  const result = await database.prepare(`SELECT root.id, root.canonical_student_id AS canonicalStudentId,
    root.registration_draft_child_id AS registrationDraftChildId, root.entry_kind AS entryKind,
    root.amount_mnt AS amountMnt, root.created_at AS createdAt, root.reason, root.external_reference AS externalReference,
    root.amount_mnt + COALESCE(SUM(debit.amount_mnt), 0) - root.reserved_amount_mnt AS availableAmountMnt
    FROM child_credit_entry AS root
    LEFT JOIN child_credit_entry AS debit ON debit.origin_entry_id = root.id
    WHERE root.registration_draft_child_id = ? AND root.amount_mnt > 0
    GROUP BY root.id HAVING root.amount_mnt + COALESCE(SUM(debit.amount_mnt), 0) > 0
    ORDER BY root.created_at, root.id`).bind(owner.registrationDraftChildId).all<ChildCreditRoot>();
  const roots = result.results.map((row) => ({ ...row, amountMnt: Number(row.amountMnt), availableAmountMnt: Number(row.availableAmountMnt) }));
  return { canonicalStudentId: null, roots, availableAmountMnt: roots.reduce((sum, row) => sum + row.availableAmountMnt, 0) };
}

export async function childCreditSummaryForChild(database: D1Database, registrationDraftChildId: string) {
  return childCreditSummaryForOwner(database, await creditOwnerForChild(database, registrationDraftChildId));
}

export async function childCreditSummaryForChildren(database: D1Database, childIds: string[]) {
  if (!childIds.length) return new Map<string, ChildCreditSummary>();
  const summaries = new Map<string, ChildCreditSummary>();
  await Promise.all(childIds.map(async (childId) => {
    try { summaries.set(childId, await childCreditSummaryForChild(database, childId)); } catch { /* Deleted rows are omitted. */ }
  }));
  return summaries;
}

async function installmentOutstanding(database: D1Database, registrationDraftChildId: string, paymentInstallmentId: string) {
  const rows = await database.prepare(`SELECT payment_installment.id, payment_installment.registration_draft_child_id AS registrationDraftChildId,
    payment_installment.installment_number AS installmentNumber, payment_installment.amount_mnt AS amountMnt,
    COALESCE(SUM(CASE WHEN payment_confirmation.status = 'undone' THEN 0 ELSE payment_allocation.allocated_amount_mnt END), 0)
      + COALESCE((SELECT SUM(-credit_entry.amount_mnt) FROM child_credit_entry AS credit_entry
        WHERE credit_entry.payment_installment_id = payment_installment.id AND credit_entry.entry_kind = 'credit_application'), 0) AS allocatedAmountMnt
    FROM payment_installment
    LEFT JOIN payment_allocation ON payment_allocation.payment_installment_id = payment_installment.id
    LEFT JOIN payment_confirmation ON payment_confirmation.received_payment_id = payment_allocation.received_payment_id
    WHERE payment_installment.registration_draft_child_id = ? GROUP BY payment_installment.id`)
    .bind(registrationDraftChildId).all<{ id: string; registrationDraftChildId: string; installmentNumber: number; amountMnt: number; allocatedAmountMnt: number }>();
  const effective = await effectiveInstallmentsForRows(database, rows.results.map((row) => ({
    ...row, installmentNumber: Number(row.installmentNumber), amountMnt: Number(row.amountMnt), allocatedAmountMnt: Number(row.allocatedAmountMnt),
  })));
  const installment = effective.find((row) => row.id === paymentInstallmentId);
  if (!installment) throw new ChildCreditError("not_found");
  return Math.max(0, installment.effectiveAmountMnt - Number(installment.allocatedAmountMnt ?? 0));
}

// Credit eligibility is a property of the immutable agreement snapshot and
// installment identity. It must never be inferred from the current balance or
// number of cash receipts: a two-installment first payment remains cash-only
// even when it is the only outstanding amount.
export async function creditInstallmentEligibility(database: D1Database, registrationDraftChildId: string, paymentInstallmentId: string) {
  const installment = await database.prepare(`SELECT payment_installment.id,
      payment_installment.installment_number AS installmentNumber,
      registration_draft_child.payment_plan_code AS paymentPlanCode,
      (SELECT MAX(later.installment_number) FROM payment_installment AS later
        WHERE later.registration_draft_child_id = payment_installment.registration_draft_child_id) AS finalInstallmentNumber
    FROM payment_installment
    INNER JOIN registration_draft_child ON registration_draft_child.id = payment_installment.registration_draft_child_id
    WHERE payment_installment.id = ? AND payment_installment.registration_draft_child_id = ?`)
    .bind(paymentInstallmentId, registrationDraftChildId)
    .first<{ id: string; installmentNumber: number; paymentPlanCode: string | null; finalInstallmentNumber: number | null }>();
  if (!installment) throw new ChildCreditError("not_found");
  const twoInstallment = installment.paymentPlanCode === "two_installment";
  const eligible = !twoInstallment || Number(installment.installmentNumber) === Number(installment.finalInstallmentNumber);
  return {
    eligible,
    paymentPlanCode: installment.paymentPlanCode,
    installmentNumber: Number(installment.installmentNumber),
    finalInstallmentNumber: Number(installment.finalInstallmentNumber),
    ineligibleReason: eligible ? null : "two_installment_first" as const,
  };
}

export async function creditPaymentReviewState(database: D1Database, registrationDraftChildId: string, paymentInstallmentId: string): Promise<CreditPaymentReviewState> {
  const child = await creditOwnerForChild(database, registrationDraftChildId);
  const [summary, outstandingAmountMnt, eligibility] = await Promise.all([
    childCreditSummaryForOwner(database, child), installmentOutstanding(database, registrationDraftChildId, paymentInstallmentId),
    creditInstallmentEligibility(database, registrationDraftChildId, paymentInstallmentId),
  ]);
  if (!eligibility.eligible || !summary.availableAmountMnt || !outstandingAmountMnt) {
    return { availableCreditMnt: summary.availableAmountMnt, outstandingAmountMnt, reviewed: false,
      eligible: eligibility.eligible, ineligibleReason: eligibility.ineligibleReason };
  }
  const review = await database.prepare(`SELECT 1 AS value FROM child_credit_payment_review
    WHERE registration_draft_child_id = ? AND payment_installment_id = ? AND decision = 'leave_unused'
      AND available_credit_mnt = ? AND outstanding_amount_mnt = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(registrationDraftChildId, paymentInstallmentId, summary.availableAmountMnt, outstandingAmountMnt).first();
  return { availableCreditMnt: summary.availableAmountMnt, outstandingAmountMnt, reviewed: Boolean(review),
    eligible: true, ineligibleReason: null };
}

export async function leaveChildCreditUnused(env: WorkerEnv, actor: StaffPrincipal, input: {
  registrationDraftChildId: string; paymentInstallmentId: string; reason: string; operationId: string;
}, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "payment.manage")) throw new ChildCreditError("forbidden");
  const reason = text(input.reason, 500); const id = operationId(input.operationId);
  if (!reason || !id || !input.paymentInstallmentId) throw new ChildCreditError("invalid");
  const child = await creditOwnerForChild(env.DB, input.registrationDraftChildId);
  const state = await creditPaymentReviewState(env.DB, input.registrationDraftChildId, input.paymentInstallmentId);
  if (!state.eligible || !state.availableCreditMnt || !state.outstandingAmountMnt) throw new ChildCreditError("invalid");
  const requestFingerprint = JSON.stringify(["leave_unused", child.registrationDraftChildId, input.paymentInstallmentId, state.availableCreditMnt, state.outstandingAmountMnt, reason]);
  const existing = await env.DB.prepare(`SELECT request_fingerprint AS requestFingerprint FROM child_credit_payment_review WHERE operation_id = ?`)
    .bind(id).first<{ requestFingerprint: string }>();
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) throw new ChildCreditError("conflict");
    return { operationId: id, idempotent: true, ...state, reviewed: true };
  }
  const now = nowIso(nowDate);
  let idempotent = false;
  try {
    await env.DB.batch([
    env.DB.prepare(`INSERT INTO child_credit_payment_review (
      id, operation_id, canonical_student_id, registration_draft_child_id, payment_installment_id, decision, available_credit_mnt,
      outstanding_amount_mnt, reason, created_by_staff_account_id, request_fingerprint, is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'leave_unused', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), id, child.canonicalStudentId, child.registrationDraftChildId, input.paymentInstallmentId, state.availableCreditMnt, state.outstandingAmountMnt,
        reason, actor.staffAccountId, requestFingerprint, child.isTest, child.testRunId, now, now),
    audit(env, actor, "child_credit_left_unused", id, { registrationDraftChildId: input.registrationDraftChildId, paymentInstallmentId: input.paymentInstallmentId,
      availableCreditMnt: state.availableCreditMnt, outstandingAmountMnt: state.outstandingAmountMnt }, child.isTest, child.testRunId, now),
    ]);
  } catch (error) {
    const replay = await env.DB.prepare(`SELECT request_fingerprint AS requestFingerprint FROM child_credit_payment_review WHERE operation_id = ?`)
      .bind(id).first<{ requestFingerprint: string }>();
    if (!replay || replay.requestFingerprint !== requestFingerprint) throw error;
    idempotent = true;
  }
  return { operationId: id, idempotent, ...state, reviewed: true };
}

async function existingOperation(database: D1Database, id: string) {
  return database.prepare(`SELECT id, operation_type AS operationType, source_student_id AS sourceStudentId,
    target_student_id AS targetStudentId, amount_mnt AS amountMnt, request_fingerprint AS requestFingerprint
    FROM child_credit_operation WHERE id = ?`).bind(id).first<{ id: string; operationType: CreditOperationType; sourceStudentId: string; targetStudentId: string | null; amountMnt: number; requestFingerprint: string }>();
}

async function assertNewOperation(database: D1Database, id: string, expected: string) {
  const existing = await existingOperation(database, id);
  if (!existing) return false;
  if (existing.requestFingerprint !== expected) throw new ChildCreditError("conflict");
  return true;
}

async function runOperationBatch(env: WorkerEnv, id: string, fingerprintValue: string, statements: D1PreparedStatement[], rejectInsufficient = false) {
  try {
    await env.DB.batch(statements);
    return false;
  } catch (error) {
    // D1 serializes the batch atomically. A concurrent identical retry may
    // reach the unique operation key after its preflight read; reconcile that
    // narrow race to the durable operation instead of creating a second entry.
    if (await assertNewOperation(env.DB, id, fingerprintValue)) return true;
    if (rejectInsufficient && /CHECK constraint failed/.test(String(error))) {
      throw new ChildCreditError("insufficient");
    }
    throw error;
  }
}

function operationInsert(env: WorkerEnv, actor: StaffPrincipal, id: string, type: CreditOperationType, source: ChildCreditOwner, target: ChildCreditOwner | null,
  amountMnt: number, reason: string, externalReference: string | null, requestFingerprint: string, isTest: number, testRunId: string | null, now: string): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO child_credit_operation (
    id, operation_type, source_student_id, source_registration_draft_child_id, target_student_id, target_registration_draft_child_id, amount_mnt, reason, external_reference,
    created_by_staff_account_id, request_fingerprint, is_test, test_run_id, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, type, source.canonicalStudentId, source.registrationDraftChildId, target?.canonicalStudentId ?? null, target?.registrationDraftChildId ?? null, amountMnt, reason, externalReference, actor.staffAccountId,
      requestFingerprint, isTest, testRunId, now);
}

function audit(env: WorkerEnv, actor: StaffPrincipal, action: string, subjectId: string, metadata: Record<string, unknown>, isTest: number, testRunId: string | null, now: string): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO audit_event (
    id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id, metadata_json,
    environment, is_test, test_run_id, created_at
  ) VALUES (?, ?, 'staff', ?, ?, 'child_credit_operation', ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, action, subjectId, JSON.stringify(metadata), env.APP_ENV, isTest, testRunId, now);
}

function entryInsert(env: WorkerEnv, input: {
  id?: string; owner: ChildCreditOwner; operationId: string; entryKind: string; amountMnt: number; originEntryId?: string | null;
  installmentId?: string | null; correctionOfEntryId?: string | null; sourceDiscountAwardId?: string | null; actor?: StaffPrincipal | null; reason: string; externalReference?: string | null;
  isTest: number; testRunId: string | null; now: string;
}): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO child_credit_entry (
    id, canonical_student_id, registration_draft_child_id, operation_id, entry_kind, amount_mnt, origin_entry_id, payment_installment_id,
    correction_of_entry_id, source_discount_award_id, created_by_staff_account_id, reason, external_reference, is_test, test_run_id, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(input.id ?? crypto.randomUUID(), input.owner.canonicalStudentId, input.owner.registrationDraftChildId, input.operationId, input.entryKind, input.amountMnt,
      input.originEntryId ?? null, input.installmentId ?? null, input.correctionOfEntryId ?? null, input.sourceDiscountAwardId ?? null,
      input.actor?.staffAccountId ?? null, input.reason, input.externalReference ?? null, input.isTest, input.testRunId, input.now);
}

// A discount award is not a received payment. When its immutable award exceeds
// the unpaid source agreement, the excess becomes an ordinary child-credit
// root, linked one-to-one to that award so it cannot be double-spent or minted
// again by a retrying additional-class finalizer.
export async function ensureDiscountAwardCredit(env: WorkerEnv, input: {
  awardId: string; registrationDraftChildId: string; reason: string; now: string; reservedAmountMnt?: number;
}): Promise<{ created: boolean; amountMnt: number }> {
  const row = await env.DB.prepare(`SELECT discount_award.credit_amount_mnt AS creditAmountMnt,
      registration_draft_child.canonical_student_id AS canonicalStudentId,
      registration_draft_child.is_test AS isTest, registration_draft_child.test_run_id AS testRunId
    FROM discount_award
    INNER JOIN registration_draft_child ON registration_draft_child.id = discount_award.registration_draft_child_id
    WHERE discount_award.id = ? AND discount_award.registration_draft_child_id = ?
      AND discount_award.status = 'active'`).bind(input.awardId, input.registrationDraftChildId)
    .first<{ creditAmountMnt: number; canonicalStudentId: string | null; isTest: number; testRunId: string | null }>();
  const amountMnt = Number(row?.creditAmountMnt ?? 0);
  if (!row || !row.canonicalStudentId || amountMnt <= 0) return { created: false, amountMnt: 0 };
  const reservedAmountMnt = Math.max(0, Number(input.reservedAmountMnt ?? 0));
  if (!Number.isInteger(reservedAmountMnt) || reservedAmountMnt > amountMnt) throw new ChildCreditError("invalid");
  const operationId = `${input.awardId}:credit`;
  const rootId = `child-credit:award:${input.awardId}`;
  const fingerprintValue = JSON.stringify(["discount_award_credit", input.awardId, input.registrationDraftChildId, amountMnt]);
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO child_credit_operation (
      id, operation_type, source_student_id, source_registration_draft_child_id, amount_mnt, reason,
      request_fingerprint, is_test, test_run_id, created_at
    ) VALUES (?, 'discount_award_credit', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(operationId, row.canonicalStudentId, input.registrationDraftChildId, amountMnt, input.reason,
        fingerprintValue, Number(row.isTest), row.testRunId, input.now),
    env.DB.prepare(`INSERT OR IGNORE INTO child_credit_entry (
      id, canonical_student_id, registration_draft_child_id, operation_id, entry_kind, amount_mnt,
      source_discount_award_id, reserved_amount_mnt, reason, is_test, test_run_id, created_at
    ) VALUES (?, ?, ?, ?, 'discount_award_credit', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(rootId, row.canonicalStudentId, input.registrationDraftChildId, operationId, amountMnt,
        input.awardId, reservedAmountMnt, input.reason, Number(row.isTest), row.testRunId, input.now),
  ]);
  if (reservedAmountMnt) {
    const root = await env.DB.prepare(`SELECT reserved_amount_mnt AS reservedAmountMnt FROM child_credit_entry WHERE id = ?`)
      .bind(rootId).first<{ reservedAmountMnt: number }>();
    if (!root || Number(root.reservedAmountMnt) < reservedAmountMnt) throw new ChildCreditError("conflict");
  }
  return { created: (result[1]?.meta?.changes ?? 0) === 1, amountMnt };
}

// Pending additional-class admissions reserve credit without changing any
// obligation. Terminal non-confirmation paths call this before releasing their
// hold so the reserved value becomes available again as one durable operation.
export async function releaseAdditionalAdmissionCreditReservations(database: D1Database, admissionId: string, now: string) {
  const rows = await database.prepare(`SELECT id, source_credit_entry_id AS sourceCreditEntryId, amount_mnt AS amountMnt
    FROM additional_class_credit_reservation WHERE admission_id = ? AND status = 'pending'`)
    .bind(admissionId).all<{ id: string; sourceCreditEntryId: string | null; amountMnt: number }>();
  if (!rows.results.length) return 0;
  const statements: D1PreparedStatement[] = [];
  for (const row of rows.results) {
    if (row.sourceCreditEntryId) {
      statements.push(database.prepare(`UPDATE child_credit_entry SET reserved_amount_mnt = reserved_amount_mnt - ?
        WHERE id = ? AND reserved_amount_mnt >= ?`).bind(Number(row.amountMnt), row.sourceCreditEntryId, Number(row.amountMnt)));
    }
    statements.push(database.prepare(`UPDATE additional_class_credit_reservation SET status = 'released', resolved_at = ?
      WHERE id = ? AND status = 'pending'`).bind(now, row.id));
  }
  await database.batch(statements);
  return rows.results.length;
}

export async function addManualChildCredit(env: WorkerEnv, actor: StaffPrincipal, input: {
  registrationDraftChildId: string; amountMnt: number; reason: string; operationId: string; externalReference?: string;
}, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "payment.manage")) throw new ChildCreditError("forbidden");
  const amountMnt = positive(input.amountMnt); const reason = text(input.reason, 500); const id = operationId(input.operationId);
  const externalReference = input.externalReference == null || input.externalReference === "" ? null : text(input.externalReference, 160);
  if (!amountMnt || !reason || !id || (input.externalReference && !externalReference)) throw new ChildCreditError("invalid");
  const child = await creditOwnerForChild(env.DB, input.registrationDraftChildId);
  const key = fingerprint("manual_add", child.registrationDraftChildId, null, amountMnt, reason, null, null, externalReference);
  if (await assertNewOperation(env.DB, id, key)) return { operationId: id, idempotent: true, ...(await childCreditSummaryForOwner(env.DB, child)) };
  const now = nowIso(nowDate);
  const idempotent = await runOperationBatch(env, id, key, [
    operationInsert(env, actor, id, "manual_add", child, null, amountMnt, reason, externalReference, key, child.isTest, child.testRunId, now),
    entryInsert(env, { owner: child, operationId: id, entryKind: "manual_addition", amountMnt, actor, reason, externalReference, isTest: child.isTest, testRunId: child.testRunId, now }),
    audit(env, actor, "child_credit_manual_added", id, { registrationDraftChildId: input.registrationDraftChildId, amountMnt, externalReference }, child.isTest, child.testRunId, now),
  ]);
  return { operationId: id, idempotent, ...(await childCreditSummaryForOwner(env.DB, child)) };
}

export async function correctChildCredit(env: WorkerEnv, actor: StaffPrincipal, input: {
  registrationDraftChildId: string; entryId: string; adjustmentMnt: number; reason: string; operationId: string; externalReference?: string;
}, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "payment.manage")) throw new ChildCreditError("forbidden");
  const amountMnt = adjustment(input.adjustmentMnt); const reason = text(input.reason, 500); const id = operationId(input.operationId);
  const externalReference = input.externalReference == null || input.externalReference === "" ? null : text(input.externalReference, 160);
  if (!amountMnt || !reason || !id || !input.entryId || (input.externalReference && !externalReference)) throw new ChildCreditError("invalid");
  const child = await creditOwnerForChild(env.DB, input.registrationDraftChildId);
  const summary = await childCreditSummaryForOwner(env.DB, child);
  const root = await env.DB.prepare(`SELECT id FROM child_credit_entry WHERE id = ? AND amount_mnt > 0
      AND (${child.canonicalStudentId ? "canonical_student_id = ?" : "registration_draft_child_id = ?"})`)
    .bind(input.entryId, child.canonicalStudentId ?? child.registrationDraftChildId).first<{ id: string }>();
  if (!root) throw new ChildCreditError("not_found");
  const key = fingerprint("manual_correction", child.registrationDraftChildId, null, amountMnt, reason, input.entryId, null, externalReference);
  if (await assertNewOperation(env.DB, id, key)) return { operationId: id, idempotent: true, ...(await childCreditSummaryForOwner(env.DB, child)) };
  if (amountMnt < 0) {
    const available = summary.roots.find((entry) => entry.id === root.id)?.availableAmountMnt ?? 0;
    if (available < -amountMnt) throw new ChildCreditError("insufficient");
  }
  const now = nowIso(nowDate);
  const guard = amountMnt < 0 ? [debitAdmissionGuard(env, child, [root.id], -amountMnt, child.isTest, child.testRunId, now)] : [];
  const idempotent = await runOperationBatch(env, id, key, [
    ...guard,
    operationInsert(env, actor, id, "manual_correction", child, null, Math.abs(amountMnt), reason, externalReference, key, child.isTest, child.testRunId, now),
    entryInsert(env, { owner: child, operationId: id, entryKind: "manual_correction", amountMnt,
      originEntryId: amountMnt < 0 ? root.id : null, correctionOfEntryId: root.id, actor, reason, externalReference, isTest: child.isTest, testRunId: child.testRunId, now }),
    audit(env, actor, "child_credit_corrected", id, { registrationDraftChildId: input.registrationDraftChildId, entryId: root.id, adjustmentMnt: amountMnt, externalReference }, child.isTest, child.testRunId, now),
  ], amountMnt < 0);
  return { operationId: id, idempotent, ...(await childCreditSummaryForOwner(env.DB, child)) };
}

function debitEntries(env: WorkerEnv, actor: StaffPrincipal, owner: ChildCreditOwner, operationId: string, amountMnt: number, entryKind: "credit_application" | "credit_transfer_debit" | "refund",
  roots: ChildCreditRoot[], reason: string, isTest: number, testRunId: string | null, now: string, installmentId: string | null = null) {
  let remaining = amountMnt;
  const statements: D1PreparedStatement[] = [];
  for (const root of roots) {
    if (!remaining) break;
    const debit = Math.min(root.availableAmountMnt, remaining);
    statements.push(entryInsert(env, { owner, operationId, entryKind, amountMnt: -debit, originEntryId: root.id, installmentId,
      actor, reason, isTest, testRunId, now }));
    remaining -= debit;
  }
  if (remaining) throw new ChildCreditError("insufficient");
  return statements;
}

// The guard deliberately performs no successful write. If the roots changed
// after the UI projection was read, it attempts an invalid zero-value entry,
// causing the entire D1 batch to roll back before the operation is recorded.
function debitAdmissionGuard(env: WorkerEnv, owner: ChildCreditOwner, rootIds: string[], amountMnt: number,
  isTest: number, testRunId: string | null, now: string): D1PreparedStatement {
  if (!rootIds.length) throw new ChildCreditError("insufficient");
  return env.DB.prepare(`INSERT INTO child_credit_entry (
    id, canonical_student_id, registration_draft_child_id, entry_kind, amount_mnt, reason, is_test, test_run_id, created_at
  ) SELECT ?, ?, ?, 'credit_application', 0, 'Credit debit guard', ?, ?, ?
    WHERE COALESCE((SELECT SUM(root.amount_mnt + COALESCE((SELECT SUM(debit.amount_mnt)
      FROM child_credit_entry AS debit WHERE debit.origin_entry_id = root.id), 0) - root.reserved_amount_mnt)
      FROM child_credit_entry AS root WHERE root.id IN (${rootIds.map(() => "?").join(", ")})
        AND ${owner.canonicalStudentId ? "root.canonical_student_id = ?" : "root.registration_draft_child_id = ?"}), 0) < ?`)
    .bind(crypto.randomUUID(), owner.canonicalStudentId, owner.registrationDraftChildId, isTest, testRunId, now, ...rootIds,
      owner.canonicalStudentId ?? owner.registrationDraftChildId, amountMnt);
}

export async function transferChildCredit(env: WorkerEnv, actor: StaffPrincipal, input: {
  sourceRegistrationDraftChildId: string; targetRegistrationDraftChildId: string; amountMnt: number; reason: string; operationId: string;
}, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "payment.manage")) throw new ChildCreditError("forbidden");
  const amountMnt = positive(input.amountMnt); const reason = text(input.reason, 500); const id = operationId(input.operationId);
  if (!amountMnt || !reason || !id) throw new ChildCreditError("invalid");
  const [source, target] = await Promise.all([creditOwnerForChild(env.DB, input.sourceRegistrationDraftChildId), creditOwnerForChild(env.DB, input.targetRegistrationDraftChildId)]);
  if (source.registrationDraftChildId === target.registrationDraftChildId || (source.canonicalStudentId && source.canonicalStudentId === target.canonicalStudentId)) throw new ChildCreditError("invalid");
  const key = fingerprint("transfer", source.registrationDraftChildId, target.registrationDraftChildId, amountMnt, reason, null, null, null);
  if (await assertNewOperation(env.DB, id, key)) return { operationId: id, idempotent: true, source: await childCreditSummaryForOwner(env.DB, source), target: await childCreditSummaryForOwner(env.DB, target) };
  const sourceSummary = await childCreditSummaryForOwner(env.DB, source);
  if (sourceSummary.availableAmountMnt < amountMnt) throw new ChildCreditError("insufficient");
  const now = nowIso(nowDate);
  const statements = [debitAdmissionGuard(env, source, sourceSummary.roots.map((root) => root.id), amountMnt, source.isTest, source.testRunId, now),
    operationInsert(env, actor, id, "transfer", source, target, amountMnt, reason, null, key, source.isTest, source.testRunId, now),
    ...debitEntries(env, actor, source, id, amountMnt, "credit_transfer_debit", sourceSummary.roots, reason, source.isTest, source.testRunId, now),
    entryInsert(env, { owner: target, operationId: id, entryKind: "credit_transfer_credit", amountMnt, actor, reason, isTest: target.isTest, testRunId: target.testRunId, now }),
    audit(env, actor, "child_credit_transferred", id, { sourceRegistrationDraftChildId: input.sourceRegistrationDraftChildId, targetRegistrationDraftChildId: input.targetRegistrationDraftChildId, amountMnt }, source.isTest, source.testRunId, now)];
  const idempotent = await runOperationBatch(env, id, key, statements, true);
  return { operationId: id, idempotent, source: await childCreditSummaryForOwner(env.DB, source), target: await childCreditSummaryForOwner(env.DB, target) };
}

export async function applyChildCredit(env: WorkerEnv, actor: StaffPrincipal, input: {
  registrationDraftChildId: string; paymentInstallmentId: string; amountMnt: number; reason: string; operationId: string;
}, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "payment.manage")) throw new ChildCreditError("forbidden");
  const amountMnt = positive(input.amountMnt); const reason = text(input.reason, 500); const id = operationId(input.operationId);
  if (!amountMnt || !reason || !id || !input.paymentInstallmentId) throw new ChildCreditError("invalid");
  const child = await creditOwnerForChild(env.DB, input.registrationDraftChildId);
  const installment = await env.DB.prepare(`SELECT payment_installment.id, payment_installment.payment_request_id AS paymentRequestId,
    payment_installment.registration_draft_child_id AS registrationDraftChildId, payment_installment.installment_number AS installmentNumber,
    payment_installment.amount_mnt AS amountMnt, payment_installment.status, registration_draft_child.canonical_student_id AS canonicalStudentId
    FROM payment_installment INNER JOIN registration_draft_child ON registration_draft_child.id = payment_installment.registration_draft_child_id
    WHERE payment_installment.id = ?`).bind(input.paymentInstallmentId).first<{ id: string; paymentRequestId: string; registrationDraftChildId: string; installmentNumber: number; amountMnt: number; status: string; canonicalStudentId: string | null }>();
  if (!installment || installment.registrationDraftChildId !== input.registrationDraftChildId || installment.status === "released") throw new ChildCreditError("not_found");
  if (!(await creditInstallmentEligibility(env.DB, input.registrationDraftChildId, installment.id)).eligible) throw new ChildCreditError("invalid");
  const key = fingerprint("apply", child.registrationDraftChildId, null, amountMnt, reason, null, installment.id, null);
  if (await assertNewOperation(env.DB, id, key)) return { operationId: id, idempotent: true, ...(await childCreditSummaryForOwner(env.DB, child)) };
  const rows = await env.DB.prepare(`SELECT payment_installment.id, payment_installment.registration_draft_child_id AS registrationDraftChildId,
    payment_installment.installment_number AS installmentNumber, payment_installment.amount_mnt AS amountMnt,
    COALESCE(SUM(CASE WHEN payment_confirmation.status = 'undone' THEN 0 ELSE payment_allocation.allocated_amount_mnt END), 0)
      + COALESCE((SELECT SUM(-entry.amount_mnt) FROM child_credit_entry AS entry WHERE entry.payment_installment_id = payment_installment.id AND entry.entry_kind = 'credit_application'), 0) AS allocatedAmountMnt
    FROM payment_installment LEFT JOIN payment_allocation ON payment_allocation.payment_installment_id = payment_installment.id
    LEFT JOIN payment_confirmation ON payment_confirmation.received_payment_id = payment_allocation.received_payment_id
    WHERE payment_installment.registration_draft_child_id = ? GROUP BY payment_installment.id`).bind(input.registrationDraftChildId)
    .all<{ id: string; registrationDraftChildId: string; installmentNumber: number; amountMnt: number; allocatedAmountMnt: number }>();
  const effective = await effectiveInstallmentsForRows(env.DB, rows.results.map((row) => ({ ...row, installmentNumber: Number(row.installmentNumber), amountMnt: Number(row.amountMnt), allocatedAmountMnt: Number(row.allocatedAmountMnt) })));
  const selected = effective.find((row) => row.id === installment.id);
  if (!selected || amountMnt > Math.max(0, selected.effectiveAmountMnt - Number(selected.allocatedAmountMnt ?? 0))) throw new ChildCreditError("invalid");
  const summary = await childCreditSummaryForOwner(env.DB, child);
  if (summary.availableAmountMnt < amountMnt) throw new ChildCreditError("insufficient");
  const now = nowIso(nowDate);
  const grace = await env.DB.prepare(`SELECT grace_minutes AS graceMinutes FROM payment_confirmation_grace_setting WHERE singleton = 1`)
    .first<{ graceMinutes: number }>();
  if (!grace) throw new ChildCreditError("invalid");
  const statements: D1PreparedStatement[] = [debitAdmissionGuard(env, child, summary.roots.map((root) => root.id), amountMnt, child.isTest, child.testRunId, now),
    operationInsert(env, actor, id, "apply", child, null, amountMnt, reason, null, key, child.isTest, child.testRunId, now),
    ...debitEntries(env, actor, child, id, amountMnt, "credit_application", summary.roots, reason, child.isTest, child.testRunId, now, installment.id),
    audit(env, actor, "child_credit_applied", id, { registrationDraftChildId: input.registrationDraftChildId, paymentInstallmentId: installment.id, amountMnt }, child.isTest, child.testRunId, now)];
  const initialRows = effective.filter((row) => row.installmentNumber === 1);
  const initialSatisfied = initialRows.length > 0 && initialRows.every((row) => row.id === installment.id
    ? Number(row.allocatedAmountMnt ?? 0) + amountMnt >= row.effectiveAmountMnt : Number(row.allocatedAmountMnt ?? 0) >= row.effectiveAmountMnt);
  if (initialSatisfied) statements.push(env.DB.prepare(`INSERT INTO credit_application_confirmation (
    id, child_credit_operation_id, payment_request_id, registration_draft_child_id, status, finalize_after,
    seat_confirmation_approved, created_at, updated_at, is_test, test_run_id
  ) VALUES (?, ?, ?, ?, 'tentative', ?, 1, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), id, installment.paymentRequestId, installment.registrationDraftChildId,
      new Date(nowDate.getTime() + Number(grace.graceMinutes) * 60_000).toISOString(), now, now, child.isTest, child.testRunId));
  const idempotent = await runOperationBatch(env, id, key, statements, true);
  // Keep the ordinary installment status projection authoritative. The
  // confirmation itself still waits for the normal grace/finalizer path.
  const { refreshInstallmentsAndDraft } = await import("../staff/payment-reconciliation");
  await refreshInstallmentsAndDraft(env, {
    id: installment.paymentRequestId, registrationDraftId: (await env.DB.prepare(`SELECT registration_draft_id AS registrationDraftId,
      payment_reference AS paymentReference, is_test AS isTest, test_run_id AS testRunId FROM payment_request WHERE id = ?`)
      .bind(installment.paymentRequestId).first<{ registrationDraftId: string; paymentReference: string; isTest: number; testRunId: string | null }>())!.registrationDraftId,
    paymentReference: "credit", isTest: child.isTest, testRunId: child.testRunId,
  }, now);
  return { operationId: id, idempotent, ...(await childCreditSummaryForOwner(env.DB, child)) };
}
