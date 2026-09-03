import type { D1Database, D1PreparedStatement, WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "../staff/authorization";

export type DiscountAwardType = "family_multi_child" | "referral_referred" | "referral_referrer";

export interface DiscountPolicySetting {
  familyMultiChildBasisPoints: number;
  referrerBasisPoints: number;
  referredChildBasisPoints: number;
  updatedAt: string;
}

export interface DiscountAward {
  id: string;
  registrationDraftChildId: string;
  beneficiaryEnrollmentId: string | null;
  awardType: DiscountAwardType;
  sourceRegistrationDraftChildId: string | null;
  sourceReferralId: string | null;
  basisPoints: number;
  baseAmountMnt: number;
  awardAmountMnt: number;
  appliedAmountMnt: number;
  creditAmountMnt: number;
  status: "active" | "reversed";
  reason: string;
  awardedAt: string;
  reversedAt: string | null;
  reversalReason: string | null;
}

export interface EffectiveInstallmentInput {
  id: string;
  registrationDraftChildId: string;
  installmentNumber: number;
  amountMnt: number;
  allocatedAmountMnt?: number;
}

export interface EffectiveInstallment extends EffectiveInstallmentInput {
  discountAmountMnt: number;
  effectiveAmountMnt: number;
}

export class DiscountPolicyError extends Error {
  constructor(public readonly code: "forbidden" | "invalid" | "conflict") {
    super("Discount policy operation failed.");
  }
}

export function percentageFromBasisPoints(value: number): number {
  return value / 100;
}

export function discountAmountMnt(baseAmountMnt: number, basisPoints: number): number {
  return Math.floor((baseAmountMnt * basisPoints) / 10_000);
}

export async function getDiscountPolicySettingFromDatabase(database: D1Database): Promise<DiscountPolicySetting> {
  const row = await database.prepare(`SELECT family_multi_child_basis_points AS familyMultiChildBasisPoints,
    referrer_basis_points AS referrerBasisPoints, referred_child_basis_points AS referredChildBasisPoints,
    updated_at AS updatedAt FROM discount_policy_setting WHERE singleton = 1`).first<DiscountPolicySetting>();
  if (!row) throw new DiscountPolicyError("invalid");
  return {
    familyMultiChildBasisPoints: Number(row.familyMultiChildBasisPoints),
    referrerBasisPoints: Number(row.referrerBasisPoints),
    referredChildBasisPoints: Number(row.referredChildBasisPoints),
    updatedAt: row.updatedAt,
  };
}

export async function getDiscountPolicySetting(env: WorkerEnv): Promise<DiscountPolicySetting> {
  return getDiscountPolicySettingFromDatabase(env.DB);
}

export async function updateDiscountPolicySetting(env: WorkerEnv, actor: StaffPrincipal, input: {
  familyMultiChildBasisPoints: number; referrerBasisPoints: number; referredChildBasisPoints: number; expectedUpdatedAt: string;
}): Promise<DiscountPolicySetting> {
  if (!hasStaffCapability(actor, "admin.settings.manage")) throw new DiscountPolicyError("forbidden");
  const values = [input.familyMultiChildBasisPoints, input.referrerBasisPoints, input.referredChildBasisPoints];
  if (!input.expectedUpdatedAt || values.some((value) => !Number.isInteger(value) || value < 0 || value > 10000)) {
    throw new DiscountPolicyError("invalid");
  }
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE discount_policy_setting
    SET family_multi_child_basis_points = ?, referrer_basis_points = ?, referred_child_basis_points = ?, updated_at = ?
    WHERE singleton = 1 AND updated_at = ?`).bind(...values, now, input.expectedUpdatedAt).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new DiscountPolicyError("conflict");
  await env.DB.prepare(`INSERT INTO audit_event (
    id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at
  ) VALUES (?, ?, 'staff', ?, 'discount_policy_changed', 'discount_policy_setting', '1', ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, JSON.stringify({
      familyMultiChildBasisPoints: input.familyMultiChildBasisPoints,
      referrerBasisPoints: input.referrerBasisPoints,
      referredChildBasisPoints: input.referredChildBasisPoints,
    }), env.APP_ENV, env.APP_ENV === "staging" ? 1 : 0, env.APP_ENV === "staging" ? "staff-settings" : null, now).run();
  return {
    familyMultiChildBasisPoints: input.familyMultiChildBasisPoints,
    referrerBasisPoints: input.referrerBasisPoints,
    referredChildBasisPoints: input.referredChildBasisPoints,
    updatedAt: now,
  };
}

export async function discountAwardsForChildren(database: D1Database, childIds: string[], includeReversed = false): Promise<Map<string, DiscountAward[]>> {
  if (!childIds.length) return new Map();
  const rows = await database.prepare(`SELECT id, registration_draft_child_id AS registrationDraftChildId,
    beneficiary_enrollment_id AS beneficiaryEnrollmentId, award_type AS awardType,
    source_registration_draft_child_id AS sourceRegistrationDraftChildId, source_referral_id AS sourceReferralId,
    basis_points AS basisPoints, base_amount_mnt AS baseAmountMnt, award_amount_mnt AS awardAmountMnt,
    applied_amount_mnt AS appliedAmountMnt, credit_amount_mnt AS creditAmountMnt, status, reason,
    awarded_at AS awardedAt, reversed_at AS reversedAt, reversal_reason AS reversalReason
    FROM discount_award WHERE ${includeReversed ? "status IN ('active', 'reversed')" : "status = 'active'"} AND registration_draft_child_id IN (${childIds.map(() => "?").join(", ")})
    ORDER BY CASE award_type WHEN 'family_multi_child' THEN 1 WHEN 'referral_referred' THEN 2 ELSE 3 END, id`).bind(...childIds).all<DiscountAward>();
  const byChild = new Map<string, DiscountAward[]>();
  for (const row of rows.results) {
    const value = { ...row, basisPoints: Number(row.basisPoints), baseAmountMnt: Number(row.baseAmountMnt),
      awardAmountMnt: Number(row.awardAmountMnt), appliedAmountMnt: Number(row.appliedAmountMnt), creditAmountMnt: Number(row.creditAmountMnt) };
    byChild.set(value.registrationDraftChildId, [...(byChild.get(value.registrationDraftChildId) ?? []), value]);
  }
  return byChild;
}

export async function activeDiscountAwardsForChildren(database: D1Database, childIds: string[]): Promise<Map<string, DiscountAward[]>> {
  return discountAwardsForChildren(database, childIds);
}

export function effectiveInstallments(inputs: EffectiveInstallmentInput[], awardsByChild: Map<string, DiscountAward[]>): EffectiveInstallment[] {
  const byChild = new Map<string, EffectiveInstallmentInput[]>();
  for (const input of inputs) byChild.set(input.registrationDraftChildId, [...(byChild.get(input.registrationDraftChildId) ?? []), input]);
  const result: EffectiveInstallment[] = [];
  for (const [childId, installments] of byChild) {
    const ordered = [...installments].sort((left, right) => left.installmentNumber - right.installmentNumber || left.id.localeCompare(right.id));
    const unpaid = ordered.map((installment) => Math.max(0, installment.amountMnt - Math.min(installment.amountMnt, installment.allocatedAmountMnt ?? 0)));
    const totalUnpaid = unpaid.reduce((sum, value) => sum + value, 0);
    const totalAward = (awardsByChild.get(childId) ?? []).reduce((sum, award) => sum + award.awardAmountMnt, 0);
    const applicableAward = Math.min(totalAward, totalUnpaid);
    let allocatedDiscount = 0;
    for (let index = 0; index < ordered.length; index += 1) {
      const installment = ordered[index];
      const isLastUnpaid = unpaid.slice(index + 1).every((value) => value === 0);
      const discountAmount = unpaid[index] === 0 ? 0 : isLastUnpaid
        ? applicableAward - allocatedDiscount
        : Math.floor((applicableAward * unpaid[index]) / totalUnpaid);
      allocatedDiscount += discountAmount;
      result.push({ ...installment, discountAmountMnt: discountAmount, effectiveAmountMnt: installment.amountMnt - discountAmount });
    }
  }
  return result;
}

export async function effectiveInstallmentsForRows(database: D1Database, inputs: EffectiveInstallmentInput[]): Promise<EffectiveInstallment[]> {
  return effectiveInstallments(inputs, await activeDiscountAwardsForChildren(database, [...new Set(inputs.map((item) => item.registrationDraftChildId))]));
}

export async function recalculateDiscountAwardBalances(database: D1Database, childId: string, now: string): Promise<void> {
  const child = await database.prepare(`SELECT initial_payment_amount_mnt AS initialAmountMnt,
    second_payment_amount_mnt AS secondAmountMnt FROM registration_draft_child WHERE id = ?`).bind(childId)
    .first<{ initialAmountMnt: number | null; secondAmountMnt: number | null }>();
  if (!child?.initialAmountMnt) return;
  const awards = (await activeDiscountAwardsForChildren(database, [childId])).get(childId) ?? [];
  const paid = await database.prepare(`SELECT COALESCE(SUM(CASE WHEN payment_confirmation.status = 'undone' THEN 0
      ELSE payment_allocation.allocated_amount_mnt END), 0) AS amountMnt
    FROM payment_installment
    LEFT JOIN payment_allocation ON payment_allocation.payment_installment_id = payment_installment.id
    LEFT JOIN received_payment ON received_payment.id = payment_allocation.received_payment_id
    LEFT JOIN payment_confirmation ON payment_confirmation.received_payment_id = received_payment.id
    WHERE payment_installment.registration_draft_child_id = ?`).bind(childId).first<{ amountMnt: number }>();
  // Awards first reduce unpaid plan value. Any remainder is an explicit
  // discount credit because allocated money is immutable financial history.
  let remaining = Math.max(0, Number(child.initialAmountMnt) + Number(child.secondAmountMnt ?? 0) - Number(paid?.amountMnt ?? 0));
  const statements: D1PreparedStatement[] = [];
  for (const award of awards) {
    const appliedAmountMnt = Math.min(remaining, award.awardAmountMnt);
    remaining -= appliedAmountMnt;
    const creditAmountMnt = award.awardAmountMnt - appliedAmountMnt;
    statements.push(database.prepare(`UPDATE discount_award SET applied_amount_mnt = ?, credit_amount_mnt = ?, updated_at = ? WHERE id = ?`)
      .bind(appliedAmountMnt, creditAmountMnt, now, award.id));
  }
  if (statements.length) await database.batch(statements);
}

export async function reverseDiscountAward(env: WorkerEnv, actor: StaffPrincipal, input: { awardId: string; reason: string }) {
  if (!hasStaffCapability(actor, "admin.settings.manage")) throw new DiscountPolicyError("forbidden");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!input.awardId || !reason || reason.length > 400) throw new DiscountPolicyError("invalid");
  const row = await env.DB.prepare(`SELECT registration_draft_child_id AS childId, is_test AS isTest, test_run_id AS testRunId
    FROM discount_award WHERE id = ? AND status = 'active'`).bind(input.awardId).first<{ childId: string; isTest: number; testRunId: string | null }>();
  if (!row) throw new DiscountPolicyError("conflict");
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE discount_award SET status = 'reversed', reversed_at = ?,
    reversed_by_staff_account_id = ?, reversal_reason = ?, updated_at = ? WHERE id = ? AND status = 'active'`)
    .bind(now, actor.staffAccountId, reason, now, input.awardId).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new DiscountPolicyError("conflict");
  await recalculateDiscountAwardBalances(env.DB, row.childId, now);
  await env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at)
    VALUES (?, ?, 'staff', ?, 'discount_award_reversed', 'discount_award', ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, input.awardId, JSON.stringify({ reason }), env.APP_ENV, row.isTest, row.testRunId, now).run();
  return { reversed: true };
}

export function discountAwardInsert(database: D1Database, input: {
  id: string; childId: string; enrollmentId?: string | null; awardType: DiscountAwardType; sourceChildId?: string | null;
  sourceReferralId?: string | null; basisPoints: number; baseAmountMnt: number; reason: string; isTest: number; testRunId: string | null; now: string;
}): D1PreparedStatement | null {
  if (input.basisPoints <= 0 || input.baseAmountMnt <= 0) return null;
  const awardAmountMnt = discountAmountMnt(input.baseAmountMnt, input.basisPoints);
  if (awardAmountMnt <= 0) return null;
  return database.prepare(`INSERT OR IGNORE INTO discount_award (
    id, registration_draft_child_id, beneficiary_enrollment_id, award_type,
    source_registration_draft_child_id, source_referral_id, basis_points, base_amount_mnt,
    award_amount_mnt, status, reason, awarded_at, is_test, test_run_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`)
    .bind(input.id, input.childId, input.enrollmentId ?? null, input.awardType,
      input.sourceChildId ?? null, input.sourceReferralId ?? null, input.basisPoints, input.baseAmountMnt,
      awardAmountMnt, input.reason, input.now, input.isTest, input.testRunId, input.now, input.now);
}

export function discountAwardAudit(database: D1Database, input: {
  awardId: string; childId: string; awardType: DiscountAwardType; basisPoints: number; baseAmountMnt: number;
  isTest: number; testRunId: string | null; environment: WorkerEnv["APP_ENV"]; now: string;
}): D1PreparedStatement {
  return database.prepare(`INSERT INTO audit_event (
    id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at
  ) VALUES (?, ?, 'system', 'discount-engine', 'discount_awarded', 'discount_award', ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), input.now, input.awardId, JSON.stringify({
      childId: input.childId, awardType: input.awardType, basisPoints: input.basisPoints, baseAmountMnt: input.baseAmountMnt,
    }), input.environment, input.isTest, input.testRunId, input.now);
}

export async function awardDiscount(env: WorkerEnv, input: {
  id: string; childId: string; enrollmentId?: string | null; awardType: DiscountAwardType; sourceChildId?: string | null;
  sourceReferralId?: string | null; basisPoints: number; baseAmountMnt: number; reason: string;
  isTest: number; testRunId: string | null; now?: string;
}): Promise<boolean> {
  const now = input.now ?? new Date().toISOString();
  const statement = discountAwardInsert(env.DB, { ...input, now });
  if (!statement) return false;
  const result = await statement.run();
  if ((result.meta?.changes ?? 0) !== 1) return false;
  await recalculateDiscountAwardBalances(env.DB, input.childId, now);
  await discountAwardAudit(env.DB, { ...input, awardId: input.id, environment: env.APP_ENV, now }).run();
  return true;
}

export async function awardFamilyDiscountsForGuardian(env: WorkerEnv, input: {
  guardianId: string; policy: DiscountPolicySetting; now?: string;
}): Promise<number> {
  if (input.policy.familyMultiChildBasisPoints <= 0) return 0;
  const rows = await env.DB.prepare(`SELECT registration_draft_child.id AS childId,
    registration_draft_child.canonical_enrollment_id AS enrollmentId,
    registration_draft_child.initial_payment_amount_mnt AS initialAmountMnt,
    registration_draft_child.second_payment_amount_mnt AS secondAmountMnt,
    registration_draft_child.is_test AS isTest, registration_draft_child.test_run_id AS testRunId
    FROM guardian_student_relationship
    INNER JOIN registration_draft_child ON registration_draft_child.canonical_student_id = guardian_student_relationship.student_id
    INNER JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id AND enrollment.status = 'confirmed'
    WHERE guardian_student_relationship.guardian_id = ? AND guardian_student_relationship.status = 'active'
      AND registration_draft_child.selected_class_session_id IS NOT NULL
    ORDER BY registration_draft_child.id`).bind(input.guardianId).all<{
      childId: string; enrollmentId: string; initialAmountMnt: number | null; secondAmountMnt: number | null; isTest: number; testRunId: string | null;
    }>();
  if (rows.results.length < 2) return 0;
  const now = input.now ?? new Date().toISOString();
  let awarded = 0;
  for (const row of rows.results) {
    const baseAmountMnt = Number(row.initialAmountMnt ?? 0) + Number(row.secondAmountMnt ?? 0);
    if (await awardDiscount(env, {
      id: `${row.childId}:discount:family`, childId: row.childId, enrollmentId: row.enrollmentId,
      awardType: "family_multi_child", basisPoints: input.policy.familyMultiChildBasisPoints, baseAmountMnt,
      reason: "canonical_guardian_multiple_children", isTest: Number(row.isTest), testRunId: row.testRunId, now,
    })) awarded += 1;
  }
  return awarded;
}

export async function awardReferrerDiscountForReferral(env: WorkerEnv, input: {
  referralId: string; policy: DiscountPolicySetting; now?: string;
}): Promise<boolean> {
  if (input.policy.referrerBasisPoints <= 0) return false;
  const row = await env.DB.prepare(`SELECT referring_child.id AS childId,
    referring_child.canonical_enrollment_id AS enrollmentId,
    referring_child.initial_payment_amount_mnt AS initialAmountMnt,
    referring_child.second_payment_amount_mnt AS secondAmountMnt,
    referring_child.is_test AS isTest, referring_child.test_run_id AS testRunId
    FROM referral
    INNER JOIN registration_draft_child AS referring_child ON referring_child.canonical_enrollment_id = referral.referring_enrollment_id
    WHERE referral.id = ? AND referral.status = 'qualified'`).bind(input.referralId).first<{
      childId: string; enrollmentId: string; initialAmountMnt: number | null; secondAmountMnt: number | null; isTest: number; testRunId: string | null;
    }>();
  if (!row) return false;
  return awardDiscount(env, {
    id: `${input.referralId}:discount:referrer`, childId: row.childId, enrollmentId: row.enrollmentId,
    awardType: "referral_referrer", sourceReferralId: input.referralId, basisPoints: input.policy.referrerBasisPoints,
    baseAmountMnt: Number(row.initialAmountMnt ?? 0) + Number(row.secondAmountMnt ?? 0),
    reason: "referred_child_confirmed", isTest: Number(row.isTest), testRunId: row.testRunId, now: input.now,
  });
}

export async function reverseReferralAwardForSameFamily(env: WorkerEnv, childId: string, now = new Date().toISOString()): Promise<void> {
  const result = await env.DB.prepare(`UPDATE discount_award SET status = 'reversed', reversed_at = ?,
    reversal_reason = 'same_family_referral_disqualified', updated_at = ?
    WHERE registration_draft_child_id = ? AND award_type = 'referral_referred' AND status = 'active'`)
    .bind(now, now, childId).run();
  if ((result.meta?.changes ?? 0) === 1) await recalculateDiscountAwardBalances(env.DB, childId, now);
}
