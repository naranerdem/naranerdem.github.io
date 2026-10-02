import type { D1Database, D1PreparedStatement, WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";
import { discountAmountMnt, getDiscountPolicySettingFromDatabase } from "../services/discounts";
import { enrollmentHasQualifyingPayment, normalizeReferralCode } from "../services/referral-codes";

type BenefitType = "referred_child" | "referrer";
type RefundMethod = "cash" | "bank_transfer" | "other";
type LateReferralErrorCode = "forbidden" | "not_found" | "invalid" | "conflict" | "stale";

export class LateReferralExternalSettlementError extends Error {
  constructor(public readonly code: LateReferralErrorCode) {
    super("Late referral external settlement failed.");
  }
}

interface ReferralSnapshot {
  referredChildId: string;
  referredEnrollmentId: string;
  referredApplicationChildId: string;
  referredStudentId: string;
  referredChildName: string;
  referredGuardianId: string | null;
  referredBaseMnt: number;
  referredUpdatedAt: string;
  referredEnrollmentUpdatedAt: string;
  referrerChildId: string;
  referrerEnrollmentId: string;
  referrerStudentId: string;
  referrerChildName: string;
  referrerGuardianId: string | null;
  referrerBaseMnt: number;
  referrerUpdatedAt: string;
  referrerEnrollmentUpdatedAt: string;
  referralCodeId: string;
  referralCode: string;
  referralCodeUpdatedAt: string;
  policyUpdatedAt: string;
  referredBasisPoints: number;
  referrerBasisPoints: number;
  isTest: number;
  testRunId: string | null;
}

export interface ExternalRefundInput {
  amountMnt: number;
  paidOn: string;
  method: RefundMethod;
  paidByNote?: string;
  externalReference?: string;
  reason: string;
}

interface ReviewedRefund extends ExternalRefundInput {
  benefitType: BenefitType;
  beneficiaryRegistrationDraftChildId: string;
  entitlementBaseMnt: number;
  entitlementBasisPoints: number;
  entitlementAmountMnt: number;
  differsFromEntitlement: boolean;
}

function integer(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function text(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maximum ? value.trim() : null;
}

function optionalText(value: unknown, maximum: number): string | null {
  if (value == null || value === "") return null;
  return text(value, maximum);
}

function paidOn(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T12:00:00Z`).getTime()) ? value : null;
}

function method(value: unknown): RefundMethod | null {
  return value === "cash" || value === "bank_transfer" || value === "other" ? value : null;
}

function operationId(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase() : null;
}

async function fingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

async function snapshotForReferral(env: WorkerEnv, referredChildId: string, rawCode: string): Promise<ReferralSnapshot> {
  const code = normalizeReferralCode(rawCode);
  if (!referredChildId || !code) throw new LateReferralExternalSettlementError("invalid");
  const referred = await env.DB.prepare(`SELECT child.id AS referredChildId,
      child.canonical_enrollment_id AS referredEnrollmentId,
      child.canonical_application_child_id AS referredApplicationChildId,
      child.canonical_student_id AS referredStudentId,
      trim(child.surname || ' ' || child.given_name) AS referredChildName,
      registration.guardian_id AS referredGuardianId,
      COALESCE(child.initial_payment_amount_mnt, 0) + COALESCE(child.second_payment_amount_mnt, 0) AS referredBaseMnt,
      child.updated_at AS referredUpdatedAt, enrollment.updated_at AS referredEnrollmentUpdatedAt,
      child.is_test AS isTest, child.test_run_id AS testRunId
    FROM registration_draft_child AS child
    INNER JOIN enrollment ON enrollment.id = child.canonical_enrollment_id
      AND enrollment.status = 'confirmed' AND enrollment.transferred_out_at IS NULL
    INNER JOIN application_child ON application_child.id = child.canonical_application_child_id
    INNER JOIN pre_registration AS registration ON registration.id = application_child.pre_registration_id
    WHERE child.id = ? AND child.status != 'cancelled'`).bind(referredChildId).first<{
      referredChildId: string; referredEnrollmentId: string; referredApplicationChildId: string; referredStudentId: string; referredChildName: string;
      referredGuardianId: string | null; referredBaseMnt: number; referredUpdatedAt: string; referredEnrollmentUpdatedAt: string;
      isTest: number; testRunId: string | null;
    }>();
  if (!referred || Number(referred.referredBaseMnt) <= 0) throw new LateReferralExternalSettlementError("not_found");

  const referrer = await env.DB.prepare(`SELECT code.id AS referralCodeId, code.code AS referralCode,
      code.updated_at AS referralCodeUpdatedAt, referrer.id AS referrerChildId,
      referrer.canonical_enrollment_id AS referrerEnrollmentId, referrer.canonical_student_id AS referrerStudentId,
      trim(referrer.surname || ' ' || referrer.given_name) AS referrerChildName,
      registration.guardian_id AS referrerGuardianId,
      COALESCE(referrer.initial_payment_amount_mnt, 0) + COALESCE(referrer.second_payment_amount_mnt, 0) AS referrerBaseMnt,
      referrer.updated_at AS referrerUpdatedAt, enrollment.updated_at AS referrerEnrollmentUpdatedAt
    FROM enrollment_referral_code AS code
    INNER JOIN enrollment ON enrollment.id = code.enrollment_id
      AND enrollment.status = 'confirmed' AND enrollment.transferred_out_at IS NULL
    INNER JOIN registration_draft_child AS referrer ON referrer.canonical_enrollment_id = enrollment.id
      AND referrer.status != 'cancelled'
    INNER JOIN application_child ON application_child.id = referrer.canonical_application_child_id
    INNER JOIN pre_registration AS registration ON registration.id = application_child.pre_registration_id
    WHERE code.code = ? AND code.status = 'active' AND code.is_test = ? AND enrollment.is_test = ?
    ORDER BY referrer.updated_at DESC, referrer.id DESC LIMIT 1`).bind(code, referred.isTest, referred.isTest).first<{
      referralCodeId: string; referralCode: string; referralCodeUpdatedAt: string; referrerChildId: string;
      referrerEnrollmentId: string; referrerStudentId: string; referrerChildName: string; referrerGuardianId: string | null;
      referrerBaseMnt: number; referrerUpdatedAt: string; referrerEnrollmentUpdatedAt: string;
    }>();
  if (!referrer || Number(referrer.referrerBaseMnt) <= 0) throw new LateReferralExternalSettlementError("not_found");

  const [referredQualified, referrerQualified, existing] = await Promise.all([
    enrollmentHasQualifyingPayment(env.DB, referred.referredEnrollmentId),
    enrollmentHasQualifyingPayment(env.DB, referrer.referrerEnrollmentId),
    env.DB.prepare(`SELECT
      EXISTS(SELECT 1 FROM registration_draft_referral WHERE registration_draft_child_id = ?) AS captured,
      EXISTS(SELECT 1 FROM referral WHERE referred_application_child_id = ?) AS canonical,
      EXISTS(SELECT 1 FROM late_referral_external_settlement_operation WHERE referred_registration_draft_child_id = ?) AS settled,
      EXISTS(SELECT 1 FROM discount_award WHERE registration_draft_child_id = ? AND award_type = 'referral_referred') AS referredAward,
      EXISTS(SELECT 1 FROM guardian_student_relationship AS a
        INNER JOIN guardian_student_relationship AS b ON b.guardian_id = a.guardian_id
        WHERE a.student_id = ? AND b.student_id = ? AND a.status = 'active' AND b.status = 'active') AS sharedGuardian
    `).bind(referred.referredChildId, referred.referredApplicationChildId, referred.referredChildId,
      referred.referredChildId, referred.referredStudentId, referrer.referrerStudentId).first<{
        captured: number; canonical: number; settled: number; referredAward: number; sharedGuardian: number;
      }>(),
  ]);
  if (!referredQualified || !referrerQualified) throw new LateReferralExternalSettlementError("not_found");
  if (referred.referredStudentId === referrer.referrerStudentId || (referred.referredGuardianId && referred.referredGuardianId === referrer.referrerGuardianId)
    || Number(existing?.sharedGuardian ?? 0)) throw new LateReferralExternalSettlementError("invalid");
  if (Number(existing?.captured ?? 0) || Number(existing?.canonical ?? 0) || Number(existing?.settled ?? 0) || Number(existing?.referredAward ?? 0)) {
    throw new LateReferralExternalSettlementError("conflict");
  }
  const policy = await getDiscountPolicySettingFromDatabase(env.DB);
  if (policy.referredChildBasisPoints <= 0 || policy.referrerBasisPoints <= 0) throw new LateReferralExternalSettlementError("invalid");
  return {
    ...referred, ...referrer, referredBaseMnt: Number(referred.referredBaseMnt), referrerBaseMnt: Number(referrer.referrerBaseMnt),
    referredBasisPoints: policy.referredChildBasisPoints, referrerBasisPoints: policy.referrerBasisPoints, policyUpdatedAt: policy.updatedAt,
  };
}

function reviewedRefunds(snapshot: ReferralSnapshot, input: { referredChild: ExternalRefundInput; referrer: ExternalRefundInput }): ReviewedRefund[] {
  const values: Array<[BenefitType, string, number, number, ExternalRefundInput]> = [
    ["referred_child", snapshot.referredChildId, snapshot.referredBaseMnt, snapshot.referredBasisPoints, input.referredChild],
    ["referrer", snapshot.referrerChildId, snapshot.referrerBaseMnt, snapshot.referrerBasisPoints, input.referrer],
  ];
  return values.map(([benefitType, beneficiaryRegistrationDraftChildId, entitlementBaseMnt, entitlementBasisPoints, value]) => {
    const amountMnt = integer(value.amountMnt); const refundDate = paidOn(value.paidOn); const refundMethod = method(value.method);
    const reason = text(value.reason, 500); const paidByNote = optionalText(value.paidByNote, 160); const externalReference = optionalText(value.externalReference, 160);
    if (!amountMnt || !refundDate || !refundMethod || !reason
      || (typeof value.paidByNote === "string" && value.paidByNote.trim() !== "" && !paidByNote)
      || (typeof value.externalReference === "string" && value.externalReference.trim() !== "" && !externalReference)) {
      throw new LateReferralExternalSettlementError("invalid");
    }
    const entitlementAmountMnt = discountAmountMnt(entitlementBaseMnt, entitlementBasisPoints);
    return { benefitType, beneficiaryRegistrationDraftChildId, entitlementBaseMnt, entitlementBasisPoints, entitlementAmountMnt,
      amountMnt, paidOn: refundDate, method: refundMethod, paidByNote: paidByNote ?? undefined, externalReference: externalReference ?? undefined,
      reason, differsFromEntitlement: amountMnt !== entitlementAmountMnt };
  });
}

async function review(env: WorkerEnv, referredChildId: string, referralCode: string, refunds?: { referredChild: ExternalRefundInput; referrer: ExternalRefundInput }) {
  const snapshot = await snapshotForReferral(env, referredChildId, referralCode);
  const benefits = refunds ? reviewedRefunds(snapshot, refunds) : [
    { benefitType: "referred_child" as const, beneficiaryRegistrationDraftChildId: snapshot.referredChildId, entitlementBaseMnt: snapshot.referredBaseMnt,
      entitlementBasisPoints: snapshot.referredBasisPoints, entitlementAmountMnt: discountAmountMnt(snapshot.referredBaseMnt, snapshot.referredBasisPoints) },
    { benefitType: "referrer" as const, beneficiaryRegistrationDraftChildId: snapshot.referrerChildId, entitlementBaseMnt: snapshot.referrerBaseMnt,
      entitlementBasisPoints: snapshot.referrerBasisPoints, entitlementAmountMnt: discountAmountMnt(snapshot.referrerBaseMnt, snapshot.referrerBasisPoints) },
  ];
  const reviewFingerprint = await fingerprint({ snapshot, benefits });
  return { referralCode: snapshot.referralCode, referrerRegistrationDraftChildId: snapshot.referrerChildId,
    referrerChildName: snapshot.referrerChildName, referredRegistrationDraftChildId: snapshot.referredChildId,
    referredChildName: snapshot.referredChildName, benefits, reviewFingerprint };
}

export async function previewLateReferralExternalSettlement(env: WorkerEnv, actor: StaffPrincipal, input: {
  referredRegistrationDraftChildId: string; referralCode: string; refunds?: { referredChild: ExternalRefundInput; referrer: ExternalRefundInput };
}) {
  if (!hasStaffCapability(actor, "registration.manage")) throw new LateReferralExternalSettlementError("forbidden");
  return review(env, String(input.referredRegistrationDraftChildId ?? ""), String(input.referralCode ?? ""), input.refunds);
}

export async function recordLateReferralExternalSettlement(env: WorkerEnv, actor: StaffPrincipal, input: {
  referredRegistrationDraftChildId: string; referralCode: string; refunds: { referredChild: ExternalRefundInput; referrer: ExternalRefundInput };
  reviewFingerprint: string; operationId: string;
}, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "registration.manage")) throw new LateReferralExternalSettlementError("forbidden");
  const id = operationId(input.operationId);
  if (!id || !text(input.reviewFingerprint, 128)) throw new LateReferralExternalSettlementError("invalid");
  const prior = await env.DB.prepare(`SELECT review_fingerprint AS reviewFingerprint, referral_id AS referralId
    FROM late_referral_external_settlement_operation WHERE id = ?`).bind(id).first<{ reviewFingerprint: string; referralId: string }>();
  if (prior) {
    if (prior.reviewFingerprint !== input.reviewFingerprint) throw new LateReferralExternalSettlementError("conflict");
    return { referralId: prior.referralId, idempotent: true };
  }
  const result = await review(env, String(input.referredRegistrationDraftChildId ?? ""), String(input.referralCode ?? ""), input.refunds);
  if (result.reviewFingerprint !== input.reviewFingerprint) throw new LateReferralExternalSettlementError("stale");
  const snapshot = await snapshotForReferral(env, String(input.referredRegistrationDraftChildId ?? ""), String(input.referralCode ?? ""));
  const now = nowDate.toISOString();
  const referralId = `${id}:referral`;
  const benefits = result.benefits as ReviewedRefund[];
  const guard = env.DB.prepare(`INSERT INTO late_referral_external_settlement_operation (
      id, referred_registration_draft_child_id, referral_code_id, referring_enrollment_id, referral_id,
      review_fingerprint, recorded_by_staff_account_id, is_test, test_run_id, created_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM registration_draft_child AS child INNER JOIN enrollment ON enrollment.id = child.canonical_enrollment_id
      WHERE child.id = ? AND child.updated_at = ? AND child.canonical_enrollment_id = ? AND enrollment.updated_at = ?
        AND enrollment.status = 'confirmed' AND enrollment.transferred_out_at IS NULL)
      AND EXISTS (SELECT 1 FROM enrollment_referral_code AS code INNER JOIN enrollment ON enrollment.id = code.enrollment_id
        WHERE code.id = ? AND code.updated_at = ? AND code.status = 'active' AND enrollment.id = ?
          AND enrollment.updated_at = ? AND enrollment.status = 'confirmed' AND enrollment.transferred_out_at IS NULL)
      AND EXISTS (SELECT 1 FROM registration_draft_child AS child
        WHERE child.id = ? AND child.updated_at = ? AND child.canonical_enrollment_id = ?)
      AND EXISTS (SELECT 1 FROM discount_policy_setting WHERE singleton = 1 AND updated_at = ?)
      AND NOT EXISTS (SELECT 1 FROM registration_draft_referral WHERE registration_draft_child_id = ?)
      AND NOT EXISTS (SELECT 1 FROM referral WHERE referred_application_child_id = ?)
      AND NOT EXISTS (SELECT 1 FROM late_referral_external_settlement_operation WHERE referred_registration_draft_child_id = ?)
      AND NOT EXISTS (SELECT 1 FROM discount_award WHERE registration_draft_child_id = ? AND award_type = 'referral_referred')`)
    .bind(id, snapshot.referredChildId, snapshot.referralCodeId, snapshot.referrerEnrollmentId, referralId,
      result.reviewFingerprint, actor.staffAccountId, snapshot.isTest, snapshot.testRunId, now,
      snapshot.referredChildId, snapshot.referredUpdatedAt, snapshot.referredEnrollmentId, snapshot.referredEnrollmentUpdatedAt,
      snapshot.referralCodeId, snapshot.referralCodeUpdatedAt, snapshot.referrerEnrollmentId, snapshot.referrerEnrollmentUpdatedAt,
      snapshot.referrerChildId, snapshot.referrerUpdatedAt, snapshot.referrerEnrollmentId, snapshot.policyUpdatedAt,
      snapshot.referredChildId, snapshot.referredApplicationChildId, snapshot.referredChildId, snapshot.referredChildId);
  const referral = env.DB.prepare(`INSERT INTO referral (
      id, referral_code, referring_enrollment_id, referring_student_id, referred_application_child_id,
      status, qualification_reason, qualified_at, is_test, test_run_id, created_at, updated_at
    ) SELECT referral_id, ?, ?, ?, ?, 'qualified', 'staff_late_external_settlement', ?, ?, ?, ?, ?
    FROM late_referral_external_settlement_operation WHERE id = ?`)
    .bind(snapshot.referralCode, snapshot.referrerEnrollmentId, snapshot.referrerStudentId, snapshot.referredApplicationChildId,
      now, snapshot.isTest, snapshot.testRunId, now, now, id);
  const statements: D1PreparedStatement[] = [guard, referral];
  for (const benefit of benefits) {
    statements.push(env.DB.prepare(`INSERT INTO late_referral_external_settlement (
        id, operation_id, referral_id, beneficiary_registration_draft_child_id, benefit_type,
        entitlement_base_mnt, entitlement_basis_points, entitlement_amount_mnt, external_refund_amount_mnt,
        external_refunded_at, external_refund_method, external_paid_by_note, external_reference, reason,
        recorded_by_staff_account_id, is_test, test_run_id, created_at
      ) SELECT ?, operation.id, operation.referral_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, operation.is_test, operation.test_run_id, ?
      FROM late_referral_external_settlement_operation AS operation WHERE operation.id = ?`)
      .bind(`${id}:${benefit.benefitType}`, benefit.beneficiaryRegistrationDraftChildId, benefit.benefitType,
        benefit.entitlementBaseMnt, benefit.entitlementBasisPoints, benefit.entitlementAmountMnt, benefit.amountMnt,
        benefit.paidOn, benefit.method, benefit.paidByNote ?? null, benefit.externalReference ?? null, benefit.reason,
        actor.staffAccountId, now, id));
  }
  statements.push(env.DB.prepare(`INSERT INTO audit_event (
      id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id, metadata_json,
      environment, is_test, test_run_id, created_at
    ) SELECT ?, ?, 'staff', ?, 'late_referral_external_settlement_recorded', 'referral', operation.referral_id, ?, ?, operation.is_test, operation.test_run_id, ?
    FROM late_referral_external_settlement_operation AS operation WHERE operation.id = ?`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, JSON.stringify({ referralCode: snapshot.referralCode,
      referredRegistrationDraftChildId: snapshot.referredChildId, referrerRegistrationDraftChildId: snapshot.referrerChildId,
      benefits: benefits.map((benefit) => ({ type: benefit.benefitType, entitlementAmountMnt: benefit.entitlementAmountMnt,
        externalRefundAmountMnt: benefit.amountMnt })), }), env.APP_ENV, now, id));
  const changes = await env.DB.batch(statements);
  if ((changes[0]?.meta?.changes ?? 0) !== 1) {
    const raced = await env.DB.prepare(`SELECT referral_id AS referralId, review_fingerprint AS reviewFingerprint
      FROM late_referral_external_settlement_operation WHERE id = ?`).bind(id).first<{ referralId: string; reviewFingerprint: string }>();
    if (raced && raced.reviewFingerprint === input.reviewFingerprint) return { referralId: raced.referralId, idempotent: true };
    throw new LateReferralExternalSettlementError("stale");
  }
  return { referralId, idempotent: false };
}

export interface LateReferralExternalSettlementHistory {
  operationId: string;
  beneficiaryRegistrationDraftChildId: string;
  referredRegistrationDraftChildId: string;
  referrerRegistrationDraftChildId: string;
  referredChildName: string;
  referrerChildName: string;
  recordedByStaffName: string | null;
  benefitType: BenefitType;
  relationshipRole: "referred" | "referrer";
  referralCode: string;
  entitlementBaseMnt: number;
  entitlementBasisPoints: number;
  entitlementAmountMnt: number;
  externalRefundAmountMnt: number;
  externalRefundedAt: string;
  externalRefundMethod: RefundMethod;
  externalPaidByNote: string | null;
  externalReference: string | null;
  reason: string;
  createdAt: string;
}

export async function lateReferralExternalSettlementHistoryForChildren(database: D1Database, childIds: string[]) {
  const unique = [...new Set(childIds.filter(Boolean))];
  const result = new Map<string, LateReferralExternalSettlementHistory[]>();
  if (!unique.length) return result;
  const placeholders = unique.map(() => "?").join(", ");
  const rows = await database.prepare(`WITH participant AS (
      SELECT operation.referred_registration_draft_child_id AS childId, 'referred' AS relationshipRole, operation.id AS operationId
      FROM late_referral_external_settlement_operation AS operation
      WHERE operation.referred_registration_draft_child_id IN (${placeholders})
      UNION ALL
      SELECT settlement.beneficiary_registration_draft_child_id AS childId, 'referrer' AS relationshipRole, operation.id AS operationId
      FROM late_referral_external_settlement_operation AS operation
      INNER JOIN late_referral_external_settlement AS settlement ON settlement.operation_id = operation.id
        AND settlement.benefit_type = 'referrer'
      WHERE settlement.beneficiary_registration_draft_child_id IN (${placeholders})
    ) SELECT participant.childId, participant.relationshipRole, operation.id AS operationId,
      settlement.beneficiary_registration_draft_child_id AS beneficiaryRegistrationDraftChildId,
      operation.referred_registration_draft_child_id AS referredRegistrationDraftChildId,
      referrer_settlement.beneficiary_registration_draft_child_id AS referrerRegistrationDraftChildId,
      trim(referred_child.surname || ' ' || referred_child.given_name) AS referredChildName,
      trim(referrer_child.surname || ' ' || referrer_child.given_name) AS referrerChildName,
      staff_account.display_name AS recordedByStaffName,
      settlement.benefit_type AS benefitType, referral.referral_code AS referralCode,
      settlement.entitlement_base_mnt AS entitlementBaseMnt, settlement.entitlement_basis_points AS entitlementBasisPoints,
      settlement.entitlement_amount_mnt AS entitlementAmountMnt,
      settlement.external_refund_amount_mnt AS externalRefundAmountMnt, settlement.external_refunded_at AS externalRefundedAt,
      settlement.external_refund_method AS externalRefundMethod, settlement.external_paid_by_note AS externalPaidByNote,
      settlement.external_reference AS externalReference, settlement.reason, settlement.created_at AS createdAt
    FROM participant
    INNER JOIN late_referral_external_settlement_operation AS operation ON operation.id = participant.operationId
    INNER JOIN late_referral_external_settlement AS settlement ON settlement.operation_id = operation.id
    INNER JOIN late_referral_external_settlement AS referrer_settlement ON referrer_settlement.operation_id = operation.id
      AND referrer_settlement.benefit_type = 'referrer'
    INNER JOIN referral ON referral.id = settlement.referral_id
    INNER JOIN registration_draft_child AS referred_child ON referred_child.id = operation.referred_registration_draft_child_id
    INNER JOIN registration_draft_child AS referrer_child ON referrer_child.id = referrer_settlement.beneficiary_registration_draft_child_id
    LEFT JOIN staff_account ON staff_account.id = operation.recorded_by_staff_account_id
    ORDER BY settlement.created_at, settlement.benefit_type`).bind(...unique, ...unique).all<LateReferralExternalSettlementHistory & { childId: string }>();
  for (const row of rows.results) result.set(row.childId, [...(result.get(row.childId) ?? []), row]);
  return result;
}
