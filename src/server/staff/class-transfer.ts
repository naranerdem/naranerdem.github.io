import type { D1PreparedStatement, WorkerEnv } from "../env";
import { classCapacityConsumedSql, getClassCapacityProjections } from "../services/class-capacity";
import { allocateWaitlistOffers } from "../services/waitlist-offers";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

export class ClassTransferError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "ineligible" | "invalid" | "conflict" | "capacity" | "source_year_archived" | "target_ineligible" | "target_pricing" | "cross_year" | "stale") { super("Class transfer is unavailable."); }
}

type Source = { childId: string; enrollmentId: string; applicationChildId: string; guardianId: string; studentId: string; academicYearId: string; academicYearStatus: string; classSessionId: string; paymentPlanCode: string | null; currentSchool: string | null; currentGrade: number; returningStatus: string; previousStageCode: string | null; isTest: number; testRunId: string | null; version: string; paymentRequestId: string | null };
type Pricing = { oneTime: number; twoEnabled: number; first: number | null; second: number | null; dueOn: string | null };
type Transfer = { id: string; sourceEnrollmentId: string; sourceClassSessionId: string; targetClassSessionId: string; status: string; version: number; isTest: number; testRunId: string | null; childId: string; paymentRequestId: string | null; sourcePaymentPlanCode: string | null; targetPaymentPlanCode: string | null; targetPricingSnapshotJson: string; targetEffectiveChargeMnt: number; resultingCreditMnt: number };
type Target = Pricing & { classSessionId: string; label: string; stageCode: string; eligibilityVersion: string; classUpdatedAt: string; offeringUpdatedAt: string; pricingUpdatedAt: string; academicYearUpdatedAt: string };

const iso = (date: Date) => date.toISOString();
const clean = (value: unknown, max = 500) => typeof value === "string" ? value.normalize("NFKC").trim().slice(0, max) : "";
const changed = (result: { meta?: { changes?: number } } | undefined) => result?.meta?.changes ?? 0;

function audit(env: WorkerEnv, actor: StaffPrincipal, action: string, transferId: string, metadata: Record<string, unknown>, source: Pick<Source, "isTest" | "testRunId">, now: string): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id, metadata_json, environment, is_test, test_run_id, created_at)
    VALUES (?, ?, 'staff', ?, ?, 'class_transfer', ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, action, transferId, JSON.stringify(metadata), env.APP_ENV, source.isTest, source.testRunId, now);
}

async function sourceForChild(env: WorkerEnv, actor: StaffPrincipal, childId: string): Promise<Source> {
  if (!hasStaffCapability(actor, "registration.manage")) throw new ClassTransferError("forbidden");
  const row = await env.DB.prepare(`SELECT registration_draft_child.id AS childId, enrollment.id AS enrollmentId, enrollment.application_child_id AS applicationChildId,
      pre_registration.guardian_id AS guardianId, enrollment.student_id AS studentId, enrollment.academic_year_id AS academicYearId, academic_year.registration_status AS academicYearStatus,
      enrollment.class_session_id AS classSessionId, application_child.selected_payment_plan_code AS paymentPlanCode,
      application_child.current_school AS currentSchool, application_child.current_grade AS currentGrade, application_child.returning_status AS returningStatus,
      application_child.previous_stage_code AS previousStageCode, registration_draft_child.is_test AS isTest, registration_draft_child.test_run_id AS testRunId,
      enrollment.updated_at AS version, payment_request.id AS paymentRequestId
    FROM registration_draft_child INNER JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
    INNER JOIN academic_year ON academic_year.id = enrollment.academic_year_id
    INNER JOIN application_child ON application_child.id = enrollment.application_child_id
    INNER JOIN pre_registration ON pre_registration.id = application_child.pre_registration_id
    LEFT JOIN payment_request ON payment_request.registration_draft_id = registration_draft_child.registration_draft_id
    WHERE registration_draft_child.id = ? AND registration_draft_child.status != 'cancelled'
      AND enrollment.status = 'confirmed' AND enrollment.transferred_out_at IS NULL`).bind(childId).first<Source>();
  if (!row) {
    const child = await env.DB.prepare(`SELECT canonical_enrollment_id AS canonicalEnrollmentId FROM registration_draft_child WHERE id = ? AND status != 'cancelled'`).bind(childId).first<{ canonicalEnrollmentId: string | null }>();
    if (child?.canonicalEnrollmentId) throw new ClassTransferError("ineligible");
    throw new ClassTransferError("not_found");
  }
  return { ...row, isTest: Number(row.isTest), currentGrade: Number(row.currentGrade) };
}

async function targetForTransfer(env: WorkerEnv, source: Source, classSessionId: string): Promise<Target> {
  const row = await env.DB.prepare(`SELECT class_session.id AS classSessionId, class_session.academic_year_id AS academicYearId,
      COALESCE(activity_offering.title, class_session.stage_code) || ' · ' || class_session.weekday || ' ' || class_session.start_time AS label,
      class_session.stage_code AS stageCode, offering_course_pricing.one_time_amount_mnt AS oneTime,
      offering_course_pricing.two_installment_enabled AS twoEnabled, offering_course_pricing.first_installment_amount_mnt AS first,
      offering_course_pricing.second_installment_amount_mnt AS second, offering_course_pricing.second_installment_due_on AS dueOn,
      class_session.status AS classStatus, activity_offering.status AS offeringStatus, academic_year.registration_status AS academicYearStatus,
      class_session.updated_at AS classUpdatedAt, activity_offering.updated_at AS offeringUpdatedAt,
      offering_course_pricing.updated_at AS pricingUpdatedAt, academic_year.updated_at AS academicYearUpdatedAt
    FROM class_session INNER JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
    INNER JOIN academic_year ON academic_year.id = class_session.academic_year_id
    LEFT JOIN offering_course_pricing ON offering_course_pricing.activity_offering_id = activity_offering.id
    WHERE class_session.id = ?`).bind(classSessionId).first<Target & { academicYearId: string; classStatus: string; offeringStatus: string; academicYearStatus: string }>();
  if (!row) throw new ClassTransferError("target_ineligible");
  if (row.academicYearId !== source.academicYearId) throw new ClassTransferError("cross_year");
  if (source.academicYearStatus === "archived" || row.academicYearStatus === "archived") throw new ClassTransferError("source_year_archived");
  if (row.classStatus !== "available" || row.offeringStatus !== "active") throw new ClassTransferError("target_ineligible");
  if (row.oneTime == null || row.twoEnabled == null || !row.pricingUpdatedAt) throw new ClassTransferError("target_pricing");
  const target = { ...row, oneTime: Number(row.oneTime), twoEnabled: Number(row.twoEnabled), first: row.first == null ? null : Number(row.first), second: row.second == null ? null : Number(row.second) };
  try { targetMoney(target, source.paymentPlanCode); } catch { throw new ClassTransferError("target_pricing"); }
  return { ...target, eligibilityVersion: [target.classUpdatedAt, target.offeringUpdatedAt, target.pricingUpdatedAt, target.academicYearUpdatedAt].join(":") };
}

async function sourceMoney(env: WorkerEnv, enrollmentId: string) {
  const row = await env.DB.prepare(`SELECT COALESCE(SUM(payment_installment.amount_mnt), 0) AS charge,
      COALESCE(SUM(CASE WHEN payment_confirmation.status = 'undone' THEN 0 ELSE payment_allocation.allocated_amount_mnt END), 0) AS paid
    FROM payment_installment LEFT JOIN payment_allocation ON payment_allocation.payment_installment_id = payment_installment.id
    LEFT JOIN payment_confirmation ON payment_confirmation.received_payment_id = payment_allocation.received_payment_id
    WHERE payment_installment.canonical_enrollment_id = ?`).bind(enrollmentId).first<{ charge: number; paid: number }>();
  const charge = Number(row?.charge ?? 0); const paid = Number(row?.paid ?? 0);
  if (!Number.isInteger(charge) || charge <= 0 || !Number.isInteger(paid) || paid < 0) throw new ClassTransferError("invalid");
  return { charge, paid };
}

function targetMoney(pricing: Pricing, plan: string | null) {
  const two = plan === "two_installment" && pricing.twoEnabled === 1 && pricing.first != null && pricing.second != null;
  const charge = two ? Number(pricing.first) + Number(pricing.second) : pricing.oneTime;
  if (!Number.isInteger(charge) || charge <= 0) throw new ClassTransferError("invalid");
  return { charge, plan: two ? "two_installment" : "single", snapshot: { paymentPlanCode: two ? "two_installment" : "single", oneTimeAmountMnt: pricing.oneTime, firstInstallmentAmountMnt: pricing.first, secondInstallmentAmountMnt: pricing.second, secondInstallmentDueOn: pricing.dueOn } };
}

async function transferForId(env: WorkerEnv, transferId: string): Promise<Transfer> {
  const row = await env.DB.prepare(`SELECT class_transfer.id, class_transfer.source_enrollment_id AS sourceEnrollmentId, class_transfer.source_class_session_id AS sourceClassSessionId,
      class_transfer.target_class_session_id AS targetClassSessionId, class_transfer.status, class_transfer.version, class_transfer.is_test AS isTest,
      class_transfer.test_run_id AS testRunId, class_transfer.source_payment_plan_code AS sourcePaymentPlanCode, class_transfer.resulting_credit_mnt AS resultingCreditMnt,
      registration_draft_child.id AS childId, payment_request.id AS paymentRequestId, class_transfer.target_payment_plan_code AS targetPaymentPlanCode,
      class_transfer.target_pricing_snapshot_json AS targetPricingSnapshotJson, class_transfer.target_effective_charge_mnt AS targetEffectiveChargeMnt
    FROM class_transfer INNER JOIN enrollment ON enrollment.id = class_transfer.source_enrollment_id
    INNER JOIN registration_draft_child ON registration_draft_child.canonical_enrollment_id = enrollment.id OR registration_draft_child.canonical_application_child_id = enrollment.application_child_id
    LEFT JOIN payment_request ON payment_request.registration_draft_id = registration_draft_child.registration_draft_id WHERE class_transfer.id = ?`).bind(transferId).first<Transfer>();
  if (!row) throw new ClassTransferError("not_found");
  return { ...row, version: Number(row.version), isTest: Number(row.isTest), targetEffectiveChargeMnt: Number(row.targetEffectiveChargeMnt), resultingCreditMnt: Number(row.resultingCreditMnt) };
}

export async function listClassTransferTargets(env: WorkerEnv, actor: StaffPrincipal, childId: string, nowDate = new Date()) {
  const source = await sourceForChild(env, actor, childId);
  const current = await env.DB.prepare(`SELECT class_transfer.id, class_transfer.status, class_transfer.version,
      class_transfer.target_class_session_id AS targetClassSessionId, class_transfer.required_difference_mnt AS requiredDifferenceMnt,
      class_transfer.resulting_credit_mnt AS creditMnt, COALESCE(class_transfer_payment_obligation.received_amount_mnt, 0) AS receivedDifferenceMnt,
      class_session.display_label AS targetClassLabel, class_session.weekday AS targetWeekday,
      class_session.start_time AS targetStartTime, class_session.end_time AS targetEndTime
    FROM class_transfer INNER JOIN class_session ON class_session.id = class_transfer.target_class_session_id
    LEFT JOIN class_transfer_payment_obligation ON class_transfer_payment_obligation.class_transfer_id = class_transfer.id
    WHERE class_transfer.source_enrollment_id = ? AND class_transfer.status IN ('pending_difference', 'ready_to_complete')
    ORDER BY class_transfer.created_at DESC LIMIT 1`).bind(source.enrollmentId).first<Record<string, unknown>>();
  const currentProjection = current ? { ...current, version: Number(current.version), requiredDifferenceMnt: Number(current.requiredDifferenceMnt), creditMnt: Number(current.creditMnt), receivedDifferenceMnt: Number(current.receivedDifferenceMnt) } : null;
  if (source.academicYearStatus === "archived") return { targets: [], current: currentProjection, targetAvailability: "source_year_archived" as const };
  const rows = await env.DB.prepare(`SELECT class_session.id AS classSessionId FROM class_session
    INNER JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
    WHERE class_session.id != ? AND class_session.academic_year_id = ? AND class_session.status = 'available' AND activity_offering.status = 'active'
    ORDER BY CASE class_session.stage_code WHEN 'stage_1' THEN 1 WHEN 'stage_2' THEN 2 WHEN 'stage_3' THEN 3 ELSE 9 END,
      CASE class_session.weekday WHEN 'Даваа' THEN 1 WHEN 'Мягмар' THEN 2 WHEN 'Лхагва' THEN 3 WHEN 'Пүрэв' THEN 4 WHEN 'Баасан' THEN 5 WHEN 'Бямба' THEN 6 WHEN 'Ням' THEN 7 ELSE 9 END, class_session.start_time, class_session.id`).bind(source.classSessionId, source.academicYearId).all<{ classSessionId: string }>();
  // The capacity projection intentionally treats an empty ID list as an
  // all-classes request. A transfer preview must keep an empty target set empty.
  if (!rows.results.length) return { targets: [], current: currentProjection, targetAvailability: "none_eligible" as const };
  const evaluated = await Promise.all(rows.results.map(async (row) => {
    try { return { target: await targetForTransfer(env, source, row.classSessionId), error: null }; }
    catch (error) { return { target: null, error: error instanceof ClassTransferError ? error.code : "target_ineligible" }; }
  }));
  const eligible = evaluated.flatMap((row) => row.target ? [row.target] : []);
  if (!eligible.length) return { targets: [], current: currentProjection, targetAvailability: evaluated.some((row) => row.error === "target_pricing") ? "pricing_unavailable" as const : "none_eligible" as const };
  const capacity = await getClassCapacityProjections(env.DB, env.APP_ENV, nowDate, eligible.map((row) => row.classSessionId));
  const targets = capacity.map((row) => {
    const target = eligible.find((candidate) => candidate.classSessionId === row.classSessionId)!;
    const financial = targetMoney(target, source.paymentPlanCode);
    return { ...row, label: target.label, stageCode: target.stageCode, targetEffectiveChargeMnt: financial.charge, targetPaymentPlanCode: financial.plan, eligibilityVersion: target.eligibilityVersion, selectable: row.freeSeats > 0 };
  });
  return { targets, current: currentProjection, targetAvailability: targets.some((target) => target.selectable) ? "available" as const : "full" as const };
}

export async function initiateClassTransfer(env: WorkerEnv, actor: StaffPrincipal, input: { registrationDraftChildId: string; targetClassSessionId: string; reason: string; idempotencyKey: string; expectedSourceVersion: string; expectedTargetVersion: string }, nowDate = new Date()) {
  const source = await sourceForChild(env, actor, input.registrationDraftChildId); const reason = clean(input.reason); const key = clean(input.idempotencyKey, 160);
  if (!reason || !key || source.classSessionId === input.targetClassSessionId || source.version !== input.expectedSourceVersion) throw new ClassTransferError("invalid");
  const replay = await env.DB.prepare(`SELECT id, status, required_difference_mnt AS differenceMnt, resulting_credit_mnt AS creditMnt, version FROM class_transfer WHERE idempotency_key = ?`).bind(key).first<{ id: string; status: string; differenceMnt: number; creditMnt: number; version: number }>();
  if (replay) return { transferId: replay.id, state: replay.status, differenceMnt: Number(replay.differenceMnt), creditMnt: Number(replay.creditMnt), version: Number(replay.version), idempotent: true };
  const [targetConfig, original] = await Promise.all([targetForTransfer(env, source, input.targetClassSessionId), sourceMoney(env, source.enrollmentId)]);
  if (!input.expectedTargetVersion || input.expectedTargetVersion !== targetConfig.eligibilityVersion) throw new ClassTransferError("stale");
  const target = targetMoney(targetConfig, source.paymentPlanCode); const difference = Math.max(0, target.charge - original.charge); const credit = Math.max(0, original.charge - target.charge); const status = difference ? "pending_difference" : "ready_to_complete";
  const now = iso(nowDate); const transferId = crypto.randomUUID(); const reservationId = crypto.randomUUID(); const obligationId = difference ? crypto.randomUUID() : null;
  const capacitySql = classCapacityConsumedSql(env.APP_ENV, "class_session.id");
  const insert = env.DB.prepare(`INSERT INTO class_transfer (id, source_enrollment_id, source_application_child_id, source_class_session_id, target_class_session_id, status, reason, created_by_staff_account_id, idempotency_key, source_payment_plan_code, target_payment_plan_code, source_pricing_snapshot_json, target_pricing_snapshot_json, source_effective_charge_mnt, target_effective_charge_mnt, recognized_paid_mnt, required_difference_mnt, resulting_credit_mnt, ready_at, is_test, test_run_id, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM enrollment WHERE id = ? AND status = 'confirmed' AND transferred_out_at IS NULL AND updated_at = ?)
      AND EXISTS (SELECT 1 FROM class_session
        INNER JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
        INNER JOIN academic_year ON academic_year.id = class_session.academic_year_id
        INNER JOIN offering_course_pricing ON offering_course_pricing.activity_offering_id = activity_offering.id
        WHERE class_session.id = ? AND class_session.academic_year_id = ? AND class_session.status = 'available'
          AND activity_offering.status = 'active' AND academic_year.registration_status != 'archived'
          AND class_session.updated_at = ? AND activity_offering.updated_at = ? AND offering_course_pricing.updated_at = ? AND academic_year.updated_at = ?
          AND class_session.capacity > ${capacitySql})
      AND NOT EXISTS (SELECT 1 FROM class_transfer WHERE source_enrollment_id = ? AND status IN ('pending_difference', 'ready_to_complete'))`).bind(transferId, source.enrollmentId, source.applicationChildId, source.classSessionId, input.targetClassSessionId, status, reason, actor.staffAccountId, key, source.paymentPlanCode, target.plan, JSON.stringify({ paymentPlanCode: source.paymentPlanCode, effectiveChargeMnt: original.charge, recognizedPaidMnt: original.paid }), JSON.stringify(target.snapshot), original.charge, target.charge, original.paid, difference, credit, status === "ready_to_complete" ? now : null, source.isTest, source.testRunId, now, now, source.enrollmentId, source.version, input.targetClassSessionId, source.academicYearId, targetConfig.classUpdatedAt, targetConfig.offeringUpdatedAt, targetConfig.pricingUpdatedAt, targetConfig.academicYearUpdatedAt, now, source.enrollmentId);
  const createdAudit = (action: string, metadata: Record<string, unknown>) => env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id, metadata_json, environment, is_test, test_run_id, created_at)
    SELECT ?, ?, 'staff', ?, ?, 'class_transfer', ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM class_transfer WHERE id = ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, action, transferId, JSON.stringify(metadata), env.APP_ENV, source.isTest, source.testRunId, now, transferId);
  const statements: D1PreparedStatement[] = [insert,
    env.DB.prepare(`INSERT INTO class_transfer_target_reservation (id, class_transfer_id, class_session_id, status, is_test, test_run_id, created_at, updated_at) SELECT ?, ?, ?, 'active', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM class_transfer WHERE id = ?)` ).bind(reservationId, transferId, input.targetClassSessionId, source.isTest, source.testRunId, now, now, transferId),
    createdAudit("class_transfer_initiated", { sourceEnrollmentId: source.enrollmentId, targetClassSessionId: input.targetClassSessionId, differenceMnt: difference, creditMnt: credit }),
    createdAudit("class_transfer_target_reserved", { reservationId, targetClassSessionId: input.targetClassSessionId })];
  if (obligationId) statements.push(env.DB.prepare(`INSERT INTO class_transfer_payment_obligation (id, class_transfer_id, amount_mnt, status, is_test, test_run_id, created_at, updated_at) SELECT ?, ?, ?, 'pending', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM class_transfer WHERE id = ?)` ).bind(obligationId, transferId, difference, source.isTest, source.testRunId, now, now, transferId), createdAudit("class_transfer_difference_required", { obligationId, amountMnt: difference }));
  const result = await env.DB.batch(statements);
  if (changed(result[0]) !== 1) {
    const refreshed = await targetForTransfer(env, source, input.targetClassSessionId);
    if (refreshed.eligibilityVersion !== input.expectedTargetVersion) throw new ClassTransferError("stale");
    throw new ClassTransferError("capacity");
  }
  return { transferId, state: status, differenceMnt: difference, creditMnt: credit, version: 1, idempotent: false };
}

export async function recordClassTransferDifference(env: WorkerEnv, actor: StaffPrincipal, input: { transferId: string; amountMnt: number; source: "staff_manual_bank" | "staff_manual_cash"; idempotencyKey: string; expectedVersion: number }, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "registration.manage")) throw new ClassTransferError("forbidden");
  const transfer = await transferForId(env, input.transferId); const amount = Number(input.amountMnt); const key = clean(input.idempotencyKey, 160); const now = iso(nowDate);
  if (transfer.status !== "pending_difference" || transfer.version !== input.expectedVersion || !Number.isInteger(amount) || amount <= 0 || !key || !transfer.paymentRequestId) throw new ClassTransferError("invalid");
  const existing = await env.DB.prepare(`SELECT id FROM received_payment WHERE idempotency_key = ?`).bind(key).first<{ id: string }>(); if (existing) return { receivedPaymentId: existing.id, idempotent: true };
  const obligation = await env.DB.prepare(`SELECT id, amount_mnt AS amountMnt, received_amount_mnt AS receivedMnt FROM class_transfer_payment_obligation WHERE class_transfer_id = ? AND status IN ('pending', 'partially_paid')`).bind(transfer.id).first<{ id: string; amountMnt: number; receivedMnt: number }>();
  if (!obligation || Number(obligation.receivedMnt) + amount > Number(obligation.amountMnt)) throw new ClassTransferError("invalid");
  const paymentId = crypto.randomUUID(); const paid = Number(obligation.receivedMnt) + amount === Number(obligation.amountMnt); const source: Pick<Source, "isTest" | "testRunId"> = transfer;
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO received_payment (id, payment_request_id, received_amount_mnt, received_at, payment_source, reconciliation_status, confirmed_at, confirmed_by_staff_account_id, idempotency_key, created_at, updated_at, is_test, test_run_id) VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?)` ).bind(paymentId, transfer.paymentRequestId, amount, now, input.source, now, actor.staffAccountId, key, now, now, transfer.isTest, transfer.testRunId),
    env.DB.prepare(`INSERT INTO class_transfer_payment (id, class_transfer_payment_obligation_id, received_payment_id, allocated_amount_mnt, allocated_at, allocated_by_staff_account_id, is_test, test_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)` ).bind(crypto.randomUUID(), obligation.id, paymentId, amount, now, actor.staffAccountId, transfer.isTest, transfer.testRunId, now),
    env.DB.prepare(`UPDATE class_transfer_payment_obligation SET received_amount_mnt = received_amount_mnt + ?, status = ?, paid_at = CASE WHEN ? THEN ? ELSE paid_at END, updated_at = ? WHERE id = ? AND received_amount_mnt + ? <= amount_mnt`).bind(amount, paid ? "paid" : "partially_paid", paid ? 1 : 0, now, now, obligation.id, amount),
    env.DB.prepare(`UPDATE class_transfer SET status = CASE WHEN ? THEN 'ready_to_complete' ELSE status END, ready_at = CASE WHEN ? THEN ? ELSE ready_at END, version = version + 1, updated_at = ? WHERE id = ? AND status = 'pending_difference' AND version = ?`).bind(paid ? 1 : 0, paid ? 1 : 0, now, now, transfer.id, transfer.version),
    audit(env, actor, "class_transfer_difference_payment_recorded", transfer.id, { amountMnt: amount, paidInFull: paid }, source, now),
  ]); if (changed(result[3]) !== 1) throw new ClassTransferError("conflict"); return { receivedPaymentId: paymentId, ready: paid, idempotent: false };
}

export async function completeClassTransfer(env: WorkerEnv, actor: StaffPrincipal, input: { transferId: string; expectedVersion: number }, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "registration.manage")) throw new ClassTransferError("forbidden"); const transfer = await transferForId(env, input.transferId);
  if (transfer.status === "completed") return { completed: false, idempotent: true }; if (transfer.status !== "ready_to_complete" || transfer.version !== input.expectedVersion) throw new ClassTransferError("conflict");
  const source = await sourceForChild(env, actor, transfer.childId); if (source.enrollmentId !== transfer.sourceEnrollmentId) throw new ClassTransferError("conflict");
  const targetConfig = await targetForTransfer(env, source, transfer.targetClassSessionId);
  const currentTargetMoney = targetMoney(targetConfig, source.paymentPlanCode);
  if (transfer.targetPaymentPlanCode !== currentTargetMoney.plan || transfer.targetEffectiveChargeMnt !== currentTargetMoney.charge || transfer.targetPricingSnapshotJson !== JSON.stringify(currentTargetMoney.snapshot)) throw new ClassTransferError("stale");
  const now = iso(nowDate); const preId = crypto.randomUUID(); const appId = crypto.randomUUID(); const enrollmentId = crypto.randomUUID();
  const completedAudit = (action: string, metadata: Record<string, unknown>) => env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id, metadata_json, environment, is_test, test_run_id, created_at) SELECT ?, ?, 'staff', ?, ?, 'class_transfer', ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM class_transfer WHERE id = ? AND status = 'completed')`).bind(crypto.randomUUID(), now, actor.staffAccountId, action, transfer.id, JSON.stringify(metadata), env.APP_ENV, source.isTest, source.testRunId, now, transfer.id);
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE enrollment SET transferred_out_at = ?, superseded_by_transfer_id = ?, updated_at = ? WHERE id = ? AND status = 'confirmed' AND transferred_out_at IS NULL AND updated_at = ?`).bind(now, transfer.id, now, source.enrollmentId, source.version),
    env.DB.prepare(`INSERT INTO pre_registration (id, guardian_id, academic_year_id, status, submitted_at, is_test, test_run_id, created_at, updated_at) SELECT ?, ?, ?, 'completed', ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM enrollment WHERE id = ? AND transferred_out_at = ?)` ).bind(preId, source.guardianId, source.academicYearId, now, source.isTest, source.testRunId, now, now, source.enrollmentId, now),
    env.DB.prepare(`INSERT INTO application_child (id, pre_registration_id, student_id, current_school, current_grade, returning_status, previous_stage_code, selected_payment_plan_code, status, is_test, test_run_id, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'enrolled', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM pre_registration WHERE id = ?)` ).bind(appId, preId, source.studentId, source.currentSchool, source.currentGrade, source.returningStatus, source.previousStageCode, transfer.sourcePaymentPlanCode, source.isTest, source.testRunId, now, now, preId),
    env.DB.prepare(`INSERT INTO enrollment (id, application_child_id, student_id, academic_year_id, class_session_id, status, confirmed_at, is_test, test_run_id, created_at, updated_at) SELECT ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM application_child WHERE id = ?)` ).bind(enrollmentId, appId, source.studentId, source.academicYearId, transfer.targetClassSessionId, now, source.isTest, source.testRunId, now, now, appId),
    env.DB.prepare(`UPDATE registration_draft_child SET canonical_application_child_id = ?, canonical_enrollment_id = ?, selected_class_session_id = ?, updated_at = ? WHERE id = ? AND canonical_enrollment_id = ?`).bind(appId, enrollmentId, transfer.targetClassSessionId, now, source.childId, source.enrollmentId),
    env.DB.prepare(`UPDATE class_transfer_target_reservation SET status = 'completed', resolved_at = ?, updated_at = ? WHERE class_transfer_id = ? AND status = 'active'`).bind(now, now, transfer.id),
    env.DB.prepare(`UPDATE class_transfer SET status = 'completed', target_application_child_id = ?, target_enrollment_id = ?, completed_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND status = 'ready_to_complete' AND version = ?`).bind(appId, enrollmentId, now, now, transfer.id, transfer.version),
    env.DB.prepare(`INSERT INTO class_transfer_credit (id, class_transfer_id, available_amount_mnt, status, is_test, test_run_id, created_at, updated_at) SELECT ?, ?, ?, 'available', ?, ?, ?, ? WHERE ? > 0 AND EXISTS (SELECT 1 FROM class_transfer WHERE id = ? AND status = 'completed')`).bind(crypto.randomUUID(), transfer.id, transfer.resultingCreditMnt, source.isTest, source.testRunId, now, now, transfer.resultingCreditMnt, transfer.id),
    completedAudit("class_transfer_completed", { sourceEnrollmentId: source.enrollmentId, targetEnrollmentId: enrollmentId, targetClassSessionId: transfer.targetClassSessionId, creditMnt: transfer.resultingCreditMnt }),
  ]); if (changed(result[0]) !== 1 || changed(result[6]) !== 1) throw new ClassTransferError("conflict"); await allocateWaitlistOffers(env, transfer.sourceClassSessionId, nowDate); return { completed: true, idempotent: false, targetEnrollmentId: enrollmentId };
}

export async function closeClassTransfer(env: WorkerEnv, actor: StaffPrincipal, input: { transferId: string; reason: string; expectedVersion: number }, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "registration.manage")) throw new ClassTransferError("forbidden"); const reason = clean(input.reason); if (!reason || !Number.isInteger(input.expectedVersion)) throw new ClassTransferError("invalid");
  const transfer = await transferForId(env, input.transferId); if (["closed", "declined"].includes(transfer.status)) return { closed: false, idempotent: true }; if (!["pending_difference", "ready_to_complete"].includes(transfer.status) || transfer.version !== input.expectedVersion) throw new ClassTransferError("conflict");
  const now = iso(nowDate); const source: Pick<Source, "isTest" | "testRunId"> = transfer; const result = await env.DB.batch([
    env.DB.prepare(`UPDATE class_transfer SET status = 'closed', closed_at = ?, close_reason = ?, version = version + 1, updated_at = ? WHERE id = ? AND status IN ('pending_difference', 'ready_to_complete') AND version = ?`).bind(now, reason, now, transfer.id, transfer.version),
    env.DB.prepare(`UPDATE class_transfer_target_reservation SET status = 'released', released_at = ?, release_reason = 'transfer_closed', updated_at = ? WHERE class_transfer_id = ? AND status = 'active'`).bind(now, now, transfer.id),
    env.DB.prepare(`UPDATE class_transfer_payment_obligation SET status = 'released', released_at = ?, updated_at = ? WHERE class_transfer_id = ? AND status IN ('pending', 'partially_paid')`).bind(now, now, transfer.id),
    audit(env, actor, "class_transfer_closed", transfer.id, { reason }, source, now),
  ]); if (changed(result[0]) !== 1) throw new ClassTransferError("conflict"); return { closed: true, idempotent: false };
}
