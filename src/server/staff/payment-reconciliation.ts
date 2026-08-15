import type { D1PreparedStatement, D1Result, WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

type PaymentSource = "staff_manual_bank" | "staff_manual_cash";
type PaymentErrorCode = "forbidden" | "not_found" | "invalid" | "conflict" | "not_due" | "already_paid";

export class PaymentReconciliationError extends Error {
  constructor(public readonly code: PaymentErrorCode) {
    super("Payment reconciliation failed.");
  }
}

interface PaymentRequestRow {
  id: string;
  registrationDraftId: string;
  paymentReference: string;
  isTest: number;
  testRunId: string | null;
}

interface InstallmentRow {
  id: string;
  paymentRequestId: string;
  registrationDraftChildId: string;
  installmentKind: "initial" | "later";
  amountMnt: number;
  effectiveDueAt: string;
  status: "pending" | "partially_paid" | "paid" | "released";
  allocatedAmountMnt: number;
}

function changes(result: D1Result<unknown> | undefined): number { return result?.meta?.changes ?? 0; }
function iso(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
function positive(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}
function audit(env: WorkerEnv, actor: StaffPrincipal, action: string, subjectType: string, subjectId: string,
  metadata: Record<string, unknown>, request: PaymentRequestRow, now: string): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO audit_event (
    id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at
  ) VALUES (?, ?, 'staff', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, action, subjectType, subjectId,
      JSON.stringify(metadata), env.APP_ENV, request.isTest, request.testRunId, now);
}

async function requestForId(env: WorkerEnv, requestId: string): Promise<PaymentRequestRow> {
  const row = await env.DB.prepare(`SELECT id, registration_draft_id AS registrationDraftId,
    payment_reference AS paymentReference, is_test AS isTest, test_run_id AS testRunId
    FROM payment_request WHERE id = ?`).bind(requestId).first<PaymentRequestRow>();
  if (!row) throw new PaymentReconciliationError("not_found");
  return row;
}

async function installmentsForRequest(env: WorkerEnv, paymentRequestId: string): Promise<InstallmentRow[]> {
  const result = await env.DB.prepare(`SELECT payment_installment.id, payment_installment.payment_request_id AS paymentRequestId,
    payment_installment.registration_draft_child_id AS registrationDraftChildId,
    payment_installment.installment_kind AS installmentKind, payment_installment.amount_mnt AS amountMnt,
    payment_installment.effective_due_at AS effectiveDueAt, payment_installment.status,
    COALESCE(SUM(payment_allocation.allocated_amount_mnt), 0) AS allocatedAmountMnt
    FROM payment_installment
    LEFT JOIN payment_allocation ON payment_allocation.payment_installment_id = payment_installment.id
    WHERE payment_installment.payment_request_id = ?
    GROUP BY payment_installment.id
    ORDER BY payment_installment.registration_draft_child_id, payment_installment.installment_number`).bind(paymentRequestId).all<InstallmentRow>();
  return result.results.map((row) => ({ ...row, amountMnt: Number(row.amountMnt), allocatedAmountMnt: Number(row.allocatedAmountMnt) }));
}

async function refreshInstallmentsAndDraft(env: WorkerEnv, request: PaymentRequestRow, now: string) {
  const installments = await installmentsForRequest(env, request.id);
  const statements: D1PreparedStatement[] = [];
  for (const installment of installments) {
    const next = installment.allocatedAmountMnt >= installment.amountMnt ? "paid"
      : installment.allocatedAmountMnt > 0 ? "partially_paid" : "pending";
    if (next !== installment.status) {
      statements.push(env.DB.prepare(`UPDATE payment_installment SET status = ?, paid_at = ?, updated_at = ? WHERE id = ?`)
        .bind(next, next === "paid" ? now : null, now, installment.id));
    }
  }
  const initial = installments.filter((item) => item.installmentKind === "initial");
  const allInitialPaid = initial.length > 0 && initial.every((item) => item.allocatedAmountMnt >= item.amountMnt);
  if (allInitialPaid) {
    statements.push(env.DB.prepare(`UPDATE registration_draft_child SET initial_payment_reconciled_at = ?, updated_at = ?
      WHERE registration_draft_id = ? AND id IN (SELECT registration_draft_child_id FROM payment_installment
        WHERE payment_request_id = ? AND installment_kind = 'initial') AND initial_payment_reconciled_at IS NULL`)
      .bind(now, now, request.registrationDraftId, request.id));
    statements.push(env.DB.prepare(`UPDATE registration_draft SET initial_payment_reconciled_at = ?, updated_at = ?
      WHERE id = ? AND initial_payment_reconciled_at IS NULL`).bind(now, now, request.registrationDraftId));
  }
  if (statements.length) await env.DB.batch(statements);
  return { installments, allInitialPaid };
}

export async function getInitialPaymentQueue(env: WorkerEnv, actor: StaffPrincipal, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "payment.view")) throw new PaymentReconciliationError("forbidden");
  const now = nowDate.toISOString();
  const result = await env.DB.prepare(`SELECT
    payment_request.id AS paymentRequestId, payment_request.payment_reference AS paymentReference,
    payment_installment.id AS installmentId, payment_installment.amount_mnt AS expectedAmountMnt,
    payment_installment.effective_due_at AS paymentDueAt, payment_installment.status AS installmentStatus,
    COALESCE(SUM(payment_allocation.allocated_amount_mnt), 0) AS allocatedAmountMnt,
    registration_draft_child.surname || ' ' || registration_draft_child.given_name AS childName,
    class_session.display_label AS classLabel, class_session.weekday AS weekday,
    class_session.start_time AS startTime, class_session.end_time AS endTime,
    EXISTS(SELECT 1 FROM payment_evidence AS claim WHERE claim.payment_request_id = payment_request.id
      AND claim.evidence_type = 'parent_claim') AS parentClaimed,
    (SELECT MAX(recorded_at) FROM payment_evidence AS checked WHERE checked.payment_request_id = payment_request.id
      AND checked.evidence_type = 'staff_checked_not_found') AS lastCheckedAt
    FROM payment_installment
    INNER JOIN payment_request ON payment_request.id = payment_installment.payment_request_id
    INNER JOIN registration_draft_child ON registration_draft_child.id = payment_installment.registration_draft_child_id
    INNER JOIN registration_capacity_hold ON registration_capacity_hold.registration_draft_child_id = registration_draft_child.id
      AND registration_capacity_hold.hold_type = 'initial_payment' AND registration_capacity_hold.status = 'active'
    INNER JOIN class_session ON class_session.id = registration_capacity_hold.class_session_id
    LEFT JOIN payment_allocation ON payment_allocation.payment_installment_id = payment_installment.id
    WHERE payment_installment.installment_kind = 'initial'
      AND payment_installment.status IN ('pending', 'partially_paid')
    GROUP BY payment_installment.id
    ORDER BY parentClaimed DESC, payment_installment.effective_due_at < ? DESC,
      payment_installment.effective_due_at ASC, payment_request.created_at ASC`).bind(now).all<Record<string, unknown>>();
  return { now, items: result.results.map((item) => ({ ...item,
    expectedAmountMnt: Number(item.expectedAmountMnt), allocatedAmountMnt: Number(item.allocatedAmountMnt),
    parentClaimed: Boolean(item.parentClaimed),
  })) };
}

export async function recordManualPayment(env: WorkerEnv, actor: StaffPrincipal, input: {
  paymentRequestId: string; allocations: Array<{ installmentId: string; amountMnt: number }>;
  source: PaymentSource; receivedAt?: string; receivedAmountMnt?: number; idempotencyKey: string;
}, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "payment.manage")) throw new PaymentReconciliationError("forbidden");
  if (!input.idempotencyKey || input.idempotencyKey.length > 160 || !["staff_manual_bank", "staff_manual_cash"].includes(input.source)) {
    throw new PaymentReconciliationError("invalid");
  }
  const request = await requestForId(env, input.paymentRequestId);
  const existing = await env.DB.prepare(`SELECT id FROM received_payment WHERE idempotency_key = ?`).bind(input.idempotencyKey).first<{ id: string }>();
  if (existing) return { id: existing.id, idempotent: true };
  const receivedAt = iso(input.receivedAt) ?? nowDate.toISOString();
  const allocations = input.allocations.map((item) => ({ installmentId: String(item.installmentId ?? ""), amountMnt: positive(item.amountMnt) }));
  if (!allocations.length || allocations.some((item) => !item.installmentId || !item.amountMnt)) throw new PaymentReconciliationError("invalid");
  const installments = await installmentsForRequest(env, request.id);
  let total = 0;
  const allocatedByInstallment = new Map<string, number>();
  for (const allocation of allocations) {
    allocatedByInstallment.set(allocation.installmentId, (allocatedByInstallment.get(allocation.installmentId) ?? 0) + (allocation.amountMnt ?? 0));
  }
  for (const [installmentId, allocatedAmount] of allocatedByInstallment) {
    const installment = installments.find((item) => item.id === installmentId);
    if (!installment || installment.status === "released" || installment.allocatedAmountMnt + allocatedAmount > installment.amountMnt) {
      throw new PaymentReconciliationError("invalid");
    }
    total += allocatedAmount;
  }
  const receivedAmount = input.receivedAmountMnt == null ? total : positive(input.receivedAmountMnt);
  if (!receivedAmount || total > receivedAmount) throw new PaymentReconciliationError("invalid");
  const now = nowDate.toISOString();
  const paymentId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [env.DB.prepare(`INSERT INTO received_payment (
    id, payment_request_id, received_amount_mnt, received_at, payment_source, reconciliation_status,
    confirmed_at, confirmed_by_staff_account_id, idempotency_key, created_at, updated_at, is_test, test_run_id
  ) VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?)`)
    .bind(paymentId, request.id, receivedAmount, receivedAt, input.source, now, actor.staffAccountId, input.idempotencyKey,
      now, now, request.isTest, request.testRunId)];
  for (const allocation of allocations) {
    statements.push(env.DB.prepare(`INSERT INTO payment_allocation (
      id, received_payment_id, payment_installment_id, allocated_amount_mnt, allocated_at,
      allocated_by_staff_account_id, created_at, is_test, test_run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), paymentId, allocation.installmentId, allocation.amountMnt, now,
        actor.staffAccountId, now, request.isTest, request.testRunId));
  }
  statements.push(env.DB.prepare(`INSERT INTO payment_evidence (
    id, payment_request_id, received_payment_id, registration_draft_id, evidence_type, recorded_at,
    recorded_by_staff_account_id, metadata_json, created_at, is_test, test_run_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), request.id, paymentId, request.registrationDraftId, input.source, now,
      actor.staffAccountId, JSON.stringify({ allocationCount: allocations.length }), now, request.isTest, request.testRunId));
  statements.push(audit(env, actor, "payment_recorded", "received_payment", paymentId,
    { source: input.source, receivedAt, amountMnt: receivedAmount, allocatedAmountMnt: total, allocationCount: allocations.length }, request, now));
  await env.DB.batch(statements);
  const state = await refreshInstallmentsAndDraft(env, request, now);
  return { id: paymentId, idempotent: false, initialPaymentReconciled: state.allInitialPaid };
}

export async function recordCheckedNotFound(env: WorkerEnv, actor: StaffPrincipal, paymentRequestId: string, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "payment.manage")) throw new PaymentReconciliationError("forbidden");
  const request = await requestForId(env, paymentRequestId);
  const now = nowDate.toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO payment_evidence (id, payment_request_id, registration_draft_id, evidence_type,
      recorded_at, recorded_by_staff_account_id, created_at, is_test, test_run_id)
      VALUES (?, ?, ?, 'staff_checked_not_found', ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), request.id, request.registrationDraftId, now, actor.staffAccountId, now, request.isTest, request.testRunId),
    audit(env, actor, "payment_checked_not_found", "payment_request", request.id, {}, request, now),
  ]);
}

export async function releaseUnpaidSeat(env: WorkerEnv, actor: StaffPrincipal, paymentRequestId: string, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "payment.manage")) throw new PaymentReconciliationError("forbidden");
  const request = await requestForId(env, paymentRequestId);
  const now = nowDate.toISOString();
  const installments = await installmentsForRequest(env, request.id);
  const initial = installments.filter((item) => item.installmentKind === "initial");
  if (!initial.length || initial.every((item) => item.allocatedAmountMnt >= item.amountMnt)) throw new PaymentReconciliationError("already_paid");
  if (initial.some((item) => item.effectiveDueAt > now)) throw new PaymentReconciliationError("not_due");
  const claim = await env.DB.prepare(`SELECT 1 AS value FROM payment_evidence WHERE payment_request_id = ? AND evidence_type = 'parent_claim'`)
    .bind(request.id).first<{ value: number }>();
  const hold = await env.DB.prepare(`UPDATE registration_capacity_hold SET status = 'released', released_at = ?,
    release_reason = 'staff_unpaid_release', updated_at = ?
    WHERE status = 'active' AND hold_type = 'initial_payment' AND registration_draft_child_id IN (
      SELECT registration_draft_child_id FROM payment_installment WHERE payment_request_id = ? AND installment_kind = 'initial'
    )`).bind(now, now, request.id).run();
  if (!changes(hold)) return { released: false, parentClaimed: Boolean(claim) };
  await env.DB.batch([
    env.DB.prepare(`UPDATE payment_installment SET status = 'released', updated_at = ? WHERE payment_request_id = ?
      AND installment_kind = 'initial' AND status != 'paid'`).bind(now, request.id),
    env.DB.prepare(`UPDATE registration_draft_child SET status = 'seat_unavailable', updated_at = ? WHERE registration_draft_id = ?
      AND id IN (SELECT registration_draft_child_id FROM payment_installment WHERE payment_request_id = ? AND installment_kind = 'initial')`)
      .bind(now, request.registrationDraftId, request.id),
    env.DB.prepare(`UPDATE registration_draft SET status = 'seat_unavailable', updated_at = ? WHERE id = ?`).bind(now, request.registrationDraftId),
    audit(env, actor, "initial_payment_seat_released", "payment_request", request.id,
      { parentClaimed: Boolean(claim) }, request, now),
  ]);
  return { released: true, parentClaimed: Boolean(claim) };
}

export async function claimParentPayment(database: WorkerEnv["DB"], paymentRequestId: string, registrationDraftId: string,
  rawSessionToken: string, nowDate = new Date()) {
  const { sessionOwnsDraft } = await import("../services/registration-submission");
  if (!await sessionOwnsDraft(database, rawSessionToken, registrationDraftId, nowDate)) throw new PaymentReconciliationError("forbidden");
  const request = await database.prepare(`SELECT id, registration_draft_id AS registrationDraftId,
    payment_reference AS paymentReference, is_test AS isTest, test_run_id AS testRunId FROM payment_request
    WHERE id = ? AND registration_draft_id = ?`).bind(paymentRequestId, registrationDraftId).first<PaymentRequestRow>();
  if (!request) throw new PaymentReconciliationError("not_found");
  const now = nowDate.toISOString();
  await database.prepare(`INSERT OR IGNORE INTO payment_evidence (id, payment_request_id, registration_draft_id,
    evidence_type, recorded_at, created_at, is_test, test_run_id) VALUES (?, ?, ?, 'parent_claim', ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), request.id, request.registrationDraftId, now, now, request.isTest, request.testRunId).run();
  return { claimed: true };
}
