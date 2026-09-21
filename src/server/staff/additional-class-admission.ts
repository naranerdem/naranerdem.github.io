import { rulesContent } from "../../content/rules";
import { createRegistrationDraft, RegistrationSubmissionError } from "../services/registration-submission";
import { activeDiscountAwardsForChildren, discountAmountMnt, effectiveInstallments, effectiveInstallmentsForRows, getDiscountPolicySettingFromDatabase } from "../services/discounts";
import { childCreditSummaryForChild } from "../services/child-credit-ledger";
import type { WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";
import { getAdditionalClassPreview } from "./additional-class-preview";

export class AdditionalClassAdmissionError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "invalid" | "unsupported" | "conflict" | "stale") {
    super("Additional class admission failed.");
  }
}

type SourceRow = {
  childId: string; enrollmentId: string; studentId: string; guardianId: string; academicYearId: string; isTest: number;
  testRunId: string | null; surname: string; givenName: string; gender: "female" | "male" | "not_specified";
  dateOfBirth: string; currentGrade: string; currentSchool: string | null; returningStatus: "new" | "returning";
  previousStageCode: "stage_1" | "stage_2" | "stage_3" | "unknown" | null; guardianFullName: string;
  guardianRelationship: string; primaryPhone: string; secondaryPhone: string | null; email: string;
  facebookName: string | null; homeAddress: string;
  sourceUpdatedAt: string;
};

type TargetRow = {
  classSessionId: string; stageCode: "stage_1" | "stage_2" | "stage_3"; classIsTest: number;
  offeringIsTest: number; yearIsTest: number; status: string; oneTimeAmountMnt: number | null; twoEnabled: number | null;
  firstAmountMnt: number | null; secondAmountMnt: number | null; secondDueOn: string | null;
};

function number(value: unknown): number { return Number.isFinite(Number(value)) ? Number(value) : 0; }

async function sourceForMutation(env: WorkerEnv, childId: string): Promise<SourceRow> {
  const row = await env.DB.prepare(`SELECT registration_draft_child.id AS childId, enrollment.id AS enrollmentId,
      enrollment.student_id AS studentId, registration_draft.canonical_guardian_account_id AS guardianId,
      enrollment.academic_year_id AS academicYearId, registration_draft_child.is_test AS isTest,
      registration_draft_child.test_run_id AS testRunId, registration_draft_child.surname,
      registration_draft_child.given_name AS givenName, registration_draft_child.gender,
      registration_draft_child.date_of_birth AS dateOfBirth, registration_draft_child.current_grade AS currentGrade,
      registration_draft_child.current_school AS currentSchool, registration_draft_child.returning_status AS returningStatus,
      registration_draft_child.previous_stage_code AS previousStageCode, guardian_account.full_name AS guardianFullName,
      guardian_account.primary_phone AS primaryPhone, guardian_account.secondary_phone AS secondaryPhone,
      guardian_account.email, guardian_account.facebook_name AS facebookName, guardian_account.home_address AS homeAddress,
      registration_draft_child.updated_at AS sourceUpdatedAt,
      guardian_student_relationship.relationship_label AS guardianRelationship
    FROM registration_draft_child
    INNER JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    INNER JOIN guardian_account ON guardian_account.id = registration_draft.canonical_guardian_account_id
    INNER JOIN guardian_student_relationship ON guardian_student_relationship.guardian_id = guardian_account.id
      AND guardian_student_relationship.student_id = enrollment.student_id AND guardian_student_relationship.status = 'active'
    WHERE registration_draft_child.id = ? AND registration_draft_child.status != 'cancelled'
      AND enrollment.status = 'confirmed' AND enrollment.transferred_out_at IS NULL
      AND guardian_account.status = 'active'`).bind(childId).first<SourceRow>();
  if (!row) throw new AdditionalClassAdmissionError("not_found");
  return { ...row, isTest: number(row.isTest) };
}

type ExistingIncomingRow = {
  childId: string; draftId: string; classSessionId: string; paymentPlanCode: "single" | "two_installment" | null;
  initialAmountMnt: number | null; secondAmountMnt: number | null; childUpdatedAt: string; draftUpdatedAt: string;
  holdUpdatedAt: string | null; hasActiveHold: number; cashMnt: number; creditMnt: number;
  childName: string; dateOfBirth: string; guardianName: string; guardianEmail: string; guardianPhone: string; classLabel: string;
  hasEarnedFamilyAward: number; referralAwardMnt: number; hasReferral: number; hasAdmission: number; hasCanonicalIdentity: number;
  referralReferringStudentId: string | null; referralReferringGuardianId: string | null; referralUpdatedAt: string | null;
  pendingQuoteAwardMnt: number; hasPendingQuote: number;
  classIsTest: number; offeringIsTest: number; yearIsTest: number; childStatus: string; draftStatus: string;
};

async function existingIncomingForMutation(env: WorkerEnv, source: SourceRow, incomingChildId: string): Promise<ExistingIncomingRow> {
  const row = await env.DB.prepare(`SELECT registration_draft_child.id AS childId,
      registration_draft_child.registration_draft_id AS draftId,
      registration_draft_child.selected_class_session_id AS classSessionId,
      registration_draft_child.payment_plan_code AS paymentPlanCode,
      registration_draft_child.initial_payment_amount_mnt AS initialAmountMnt,
      registration_draft_child.second_payment_amount_mnt AS secondAmountMnt,
      trim(registration_draft_child.surname || ' ' || registration_draft_child.given_name) AS childName,
      registration_draft_child.date_of_birth AS dateOfBirth, registration_draft.guardian_full_name AS guardianName,
      registration_draft.email AS guardianEmail, registration_draft.primary_phone AS guardianPhone,
      class_session.display_label AS classLabel,
      registration_draft_child.updated_at AS childUpdatedAt, registration_draft.updated_at AS draftUpdatedAt,
      registration_capacity_hold.updated_at AS holdUpdatedAt,
      CASE WHEN registration_capacity_hold.id IS NULL THEN 0 ELSE 1 END AS hasActiveHold,
      COALESCE((SELECT SUM(payment_allocation.allocated_amount_mnt) FROM payment_installment
        INNER JOIN payment_allocation ON payment_allocation.payment_installment_id = payment_installment.id
        LEFT JOIN payment_confirmation ON payment_confirmation.received_payment_id = payment_allocation.received_payment_id
        WHERE payment_installment.registration_draft_child_id = registration_draft_child.id
          AND (payment_confirmation.status IS NULL OR payment_confirmation.status != 'undone')), 0) AS cashMnt,
      COALESCE((SELECT SUM(-child_credit_entry.amount_mnt) FROM child_credit_entry
        WHERE child_credit_entry.registration_draft_child_id = registration_draft_child.id
          AND child_credit_entry.amount_mnt < 0), 0) AS creditMnt,
      EXISTS(SELECT 1 FROM discount_award WHERE registration_draft_child_id = registration_draft_child.id
        AND award_type = 'family_multi_child' AND status = 'active' AND qualification_state = 'earned') AS hasEarnedFamilyAward,
      COALESCE((SELECT SUM(award_amount_mnt) FROM discount_award
        WHERE registration_draft_child_id = registration_draft_child.id
          AND award_type IN ('referral_referred', 'referral_referrer')
          AND status = 'active' AND qualification_state = 'earned'), 0) AS referralAwardMnt,
      EXISTS(SELECT 1 FROM registration_draft_referral WHERE registration_draft_child_id = registration_draft_child.id) AS hasReferral,
      (SELECT enrollment_referral_code.student_id FROM registration_draft_referral
        INNER JOIN enrollment_referral_code ON enrollment_referral_code.id = registration_draft_referral.referral_code_id
        WHERE registration_draft_referral.registration_draft_child_id = registration_draft_child.id
          AND registration_draft_referral.status = 'captured'
        ORDER BY registration_draft_referral.created_at DESC, registration_draft_referral.rowid DESC LIMIT 1) AS referralReferringStudentId,
      (SELECT pre_registration.guardian_id FROM registration_draft_referral
        INNER JOIN enrollment ON enrollment.id = registration_draft_referral.referring_enrollment_id
        INNER JOIN application_child ON application_child.id = enrollment.application_child_id
        INNER JOIN pre_registration ON pre_registration.id = application_child.pre_registration_id
        WHERE registration_draft_referral.registration_draft_child_id = registration_draft_child.id
          AND registration_draft_referral.status = 'captured'
        ORDER BY registration_draft_referral.created_at DESC, registration_draft_referral.rowid DESC LIMIT 1) AS referralReferringGuardianId,
      (SELECT updated_at FROM registration_draft_referral
        WHERE registration_draft_child_id = registration_draft_child.id AND status = 'captured'
        ORDER BY created_at DESC, rowid DESC LIMIT 1) AS referralUpdatedAt,
      EXISTS(SELECT 1 FROM additional_class_admission WHERE target_registration_draft_child_id = registration_draft_child.id) AS hasAdmission,
      CASE WHEN registration_draft_child.canonical_student_id IS NOT NULL
          OR registration_draft_child.canonical_enrollment_id IS NOT NULL THEN 1 ELSE 0 END AS hasCanonicalIdentity,
      COALESCE((SELECT MAX(award_amount_mnt) FROM conditional_family_discount_quote WHERE registration_draft_child_id = registration_draft_child.id
        AND state IN ('quoted_pending', 'cash_coverage_ready', 'conditionally_confirmed')), 0) AS pendingQuoteAwardMnt,
      EXISTS(SELECT 1 FROM conditional_family_discount_quote WHERE registration_draft_child_id = registration_draft_child.id
        AND state IN ('quoted_pending', 'cash_coverage_ready', 'conditionally_confirmed')) AS hasPendingQuote,
      class_session.is_test AS classIsTest, activity_offering.is_test AS offeringIsTest, academic_year.is_test AS yearIsTest,
      registration_draft_child.status AS childStatus, registration_draft.status AS draftStatus
    FROM registration_draft_child
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    INNER JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id
    INNER JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
    INNER JOIN academic_year ON academic_year.id = class_session.academic_year_id
    LEFT JOIN registration_capacity_hold ON registration_capacity_hold.registration_draft_child_id = registration_draft_child.id
      AND registration_capacity_hold.hold_type = 'initial_payment' AND registration_capacity_hold.status = 'active'
    WHERE registration_draft_child.id = ? AND registration_draft_child.id != ?
      AND registration_draft.academic_year_id = ? AND registration_draft.status NOT IN ('cancelled', 'expired')
      AND registration_draft_child.status != 'cancelled'`).bind(incomingChildId, source.childId, source.academicYearId)
    .first<ExistingIncomingRow>();
  if (!row || !row.classSessionId || !row.paymentPlanCode
    || number(row.classIsTest) !== source.isTest || number(row.offeringIsTest) !== source.isTest || number(row.yearIsTest) !== source.isTest) {
    throw new AdditionalClassAdmissionError("not_found");
  }
  return row;
}

function incomingUnsupportedReason(row: ExistingIncomingRow) {
  if (number(row.hasCanonicalIdentity) || number(row.hasAdmission)) return "already_linked";
  if (!number(row.hasActiveHold)) return "missing_hold";
  if (number(row.cashMnt) || number(row.creditMnt)) return "financial_history";
  // A referral captured by the incoming ordinary registration is preserved
  // and stacks under the existing allocation rules. An earned family award is
  // not safe to replace with a second additional-class family entitlement.
  if (number(row.hasEarnedFamilyAward)) return "existing_family_award";
  return null;
}

function sameFamilyIncomingReferral(row: ExistingIncomingRow, source: SourceRow) {
  return Boolean(row.referralReferringStudentId && row.referralReferringStudentId === source.studentId)
    || Boolean(row.referralReferringGuardianId && row.referralReferringGuardianId === source.guardianId);
}

async function reviewFingerprint(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

export async function previewExistingAdditionalClassIncorporation(env: WorkerEnv, actor: StaffPrincipal, input: {
  registrationDraftChildId: string; incomingRegistrationDraftChildId: string;
}) {
  if (!hasStaffCapability(actor, "registration.manage")) throw new AdditionalClassAdmissionError("forbidden");
  const source = await sourceForMutation(env, input.registrationDraftChildId);
  const incoming = await existingIncomingForMutation(env, source, input.incomingRegistrationDraftChildId);
  const sameFamilyReferral = sameFamilyIncomingReferral(incoming, source);
  const normalPreview = await getAdditionalClassPreview(env, actor, {
    registrationDraftChildId: source.childId, targetClassSessionId: incoming.classSessionId,
    paymentPlanCode: incoming.paymentPlanCode!,
  });
  const rawTotalMnt = number(incoming.initialAmountMnt) + number(incoming.secondAmountMnt);
  const incomingInstallments = await env.DB.prepare(`SELECT id, installment_number AS installmentNumber, amount_mnt AS amountMnt
    FROM payment_installment WHERE registration_draft_child_id = ? ORDER BY installment_number, id`)
    .bind(incoming.childId).all<{ id: string; installmentNumber: number; amountMnt: number }>();
  const earnedAwards = ((await activeDiscountAwardsForChildren(env.DB, [incoming.childId])).get(incoming.childId) ?? [])
    .filter((award) => !(sameFamilyReferral && award.awardType === "referral_referred"));
  const replacementAwardMnt = Number(normalPreview.proposal?.baseDiscountMnt ?? 0);
  const projectedAwards = new Map([[incoming.childId, [...earnedAwards, {
    id: "preview:additional-family", registrationDraftChildId: incoming.childId, beneficiaryEnrollmentId: null,
    awardType: "family_multi_child" as const, sourceRegistrationDraftChildId: source.childId, sourceReferralId: null,
    basisPoints: Number(normalPreview.baseDiscount.basisPoints), baseAmountMnt: rawTotalMnt, awardAmountMnt: replacementAwardMnt,
    appliedAmountMnt: 0, creditAmountMnt: 0, status: "active" as const, reason: "additional_class_canonical_confirmation",
    awardedAt: "", reversedAt: null, reversalReason: null,
  }]]]);
  const projectedInstallments = effectiveInstallments(incomingInstallments.results.map((item) => ({
    ...item, registrationDraftChildId: incoming.childId, installmentNumber: Number(item.installmentNumber), amountMnt: Number(item.amountMnt), allocatedAmountMnt: 0,
  })), projectedAwards);
  const projectedAwardMnt = earnedAwards.reduce((sum, award) => sum + Number(award.awardAmountMnt), 0) + replacementAwardMnt;
  const duplicate = await env.DB.prepare(`SELECT 1 AS value FROM enrollment
    WHERE student_id = ? AND class_session_id = ? AND status = 'confirmed' AND transferred_out_at IS NULL`)
    .bind(source.studentId, incoming.classSessionId).first();
  const unsupported = incomingUnsupportedReason(incoming)
    || (duplicate ? "duplicate_class" : null)
    || (!normalPreview.proposal || Number(normalPreview.proposal.originalTotalMnt) !== rawTotalMnt ? "pricing_changed" : null)
    || (incoming.hasPendingQuote && Number(incoming.pendingQuoteAwardMnt) !== replacementAwardMnt ? "quote_conflict" : null)
    || (!incomingInstallments.results.length ? "pricing_changed" : null);
  const fingerprint = await reviewFingerprint({ source: [source.childId, source.enrollmentId, source.sourceUpdatedAt],
    incoming: [incoming.childId, incoming.draftId, incoming.childUpdatedAt, incoming.draftUpdatedAt, incoming.holdUpdatedAt,
      incoming.classSessionId, incoming.paymentPlanCode, rawTotalMnt, incoming.cashMnt, incoming.creditMnt,
      incoming.hasEarnedFamilyAward, incoming.referralAwardMnt, incoming.hasReferral, incoming.hasActiveHold,
      incoming.referralReferringStudentId, incoming.referralReferringGuardianId, incoming.referralUpdatedAt,
      incoming.hasAdmission, incoming.hasCanonicalIdentity, incoming.pendingQuoteAwardMnt, incoming.hasPendingQuote],
    policyUpdatedAt: normalPreview.baseDiscount.policyUpdatedAt });
  return {
    supported: !unsupported, unsupportedReason: unsupported, reviewFingerprint: fingerprint,
    source: { id: source.childId, name: `${source.surname} ${source.givenName}`, currentClasses: normalPreview.currentClasses },
    incoming: { id: incoming.childId, childName: incoming.childName, dateOfBirth: incoming.dateOfBirth,
      guardianName: incoming.guardianName, guardianEmail: incoming.guardianEmail, guardianPhone: incoming.guardianPhone,
      classLabel: incoming.classLabel, classSessionId: incoming.classSessionId, paymentPlanCode: incoming.paymentPlanCode,
      rawTotalMnt, cashPaidMnt: number(incoming.cashMnt), creditAppliedMnt: number(incoming.creditMnt),
      hasPendingConditionalQuote: Boolean(incoming.hasPendingQuote), referralAwardMnt: number(incoming.referralAwardMnt) },
    proposal: normalPreview.proposal, sourceEffect: normalPreview.sourceEffect,
    creditProposal: normalPreview.creditProposal,
    awardEffect: { existingReferralAwardMnt: earnedAwards.filter((award) => award.awardType === "referral_referred")
      .reduce((sum, award) => sum + Number(award.awardAmountMnt), 0), replacedConditionalAwardMnt: number(incoming.pendingQuoteAwardMnt),
      sameFamilyReferral,
      additionalFamilyAwardMnt: replacementAwardMnt, totalAwardMnt: projectedAwardMnt,
      payableTotalMnt: projectedInstallments.reduce((sum, installment) => sum + Number(installment.effectiveAmountMnt), 0),
      installments: projectedInstallments.map((installment) => ({ installmentNumber: Number(installment.installmentNumber),
        originalAmountMnt: Number(installment.amountMnt), payableAmountMnt: Number(installment.effectiveAmountMnt) })), },
    policyUpdatedAt: normalPreview.baseDiscount.policyUpdatedAt,
    disposition: "Хүсэлтийн анхны бүртгэл, суудал болон үнийн snapshot хадгалагдана. Сонгосон хүүхэд л одоогийн хүүхдийн нэмэлт ангийн баталгаажуулалтад холбогдоно; бусад ах, дүүгийн мөр өөрчлөгдөхгүй.",
  };
}

async function targetForMutation(env: WorkerEnv, source: SourceRow, targetClassSessionId: string): Promise<TargetRow> {
  const row = await env.DB.prepare(`SELECT class_session.id AS classSessionId, class_session.stage_code AS stageCode,
      class_session.is_test AS classIsTest, activity_offering.is_test AS offeringIsTest,
      academic_year.is_test AS yearIsTest, class_session.status, pricing.one_time_amount_mnt AS oneTimeAmountMnt,
      pricing.two_installment_enabled AS twoEnabled,
      pricing.first_installment_amount_mnt AS firstAmountMnt, pricing.second_installment_amount_mnt AS secondAmountMnt,
      pricing.second_installment_due_on AS secondDueOn
    FROM class_session
    INNER JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
    INNER JOIN academic_year ON academic_year.id = class_session.academic_year_id
    INNER JOIN offering_course_pricing AS pricing ON pricing.activity_offering_id = activity_offering.id
    WHERE class_session.id = ? AND class_session.academic_year_id = ?
      AND class_session.schedule_state = 'active' AND class_session.status = 'available' AND activity_offering.status = 'active'
      AND activity_offering.kind IN ('annual_course', 'summer_course') AND academic_year.registration_status != 'archived'`)
    .bind(targetClassSessionId, source.academicYearId).first<TargetRow>();
  if (!row || number(row.classIsTest) !== source.isTest || number(row.offeringIsTest) !== source.isTest || number(row.yearIsTest) !== source.isTest) {
    throw new AdditionalClassAdmissionError("invalid");
  }
  return row;
}

async function sourceFinancialSupport(env: WorkerEnv, source: SourceRow, basisPoints: number) {
  const installments = await env.DB.prepare(`SELECT payment_installment.id, payment_installment.registration_draft_child_id AS registrationDraftChildId,
      payment_installment.installment_number AS installmentNumber, payment_installment.amount_mnt AS amountMnt,
      COALESCE(SUM(CASE WHEN payment_confirmation.status = 'undone' THEN 0 ELSE payment_allocation.allocated_amount_mnt END), 0)
      + COALESCE((SELECT SUM(-credit_entry.amount_mnt) FROM child_credit_entry AS credit_entry
        WHERE credit_entry.payment_installment_id = payment_installment.id
          AND credit_entry.entry_kind = 'credit_application'), 0) AS allocatedAmountMnt
    FROM payment_installment LEFT JOIN payment_allocation ON payment_allocation.payment_installment_id = payment_installment.id
    LEFT JOIN received_payment ON received_payment.id = payment_allocation.received_payment_id
    LEFT JOIN payment_confirmation ON payment_confirmation.received_payment_id = received_payment.id
    WHERE payment_installment.registration_draft_child_id = ?
    GROUP BY payment_installment.id ORDER BY payment_installment.installment_number, payment_installment.id`).bind(source.childId)
    .all<{ id: string; registrationDraftChildId: string; installmentNumber: number; amountMnt: number; allocatedAmountMnt: number }>();
  if (!installments.results.length) throw new AdditionalClassAdmissionError("unsupported");
  const awards = await activeDiscountAwardsForChildren(env.DB, [source.childId]);
  const hasBaseAward = (awards.get(source.childId) ?? []).some((award) => award.awardType === "family_multi_child");
  const sourceTotal = installments.results.reduce((sum, item) => sum + number(item.amountMnt), 0);
  const proposed = hasBaseAward ? 0 : discountAmountMnt(sourceTotal, basisPoints);
  return { sourceTotal, sourceAwardMnt: proposed };
}

async function sourceOutstanding(env: WorkerEnv, childId: string): Promise<number> {
  const rows = await env.DB.prepare(`SELECT payment_installment.id,
      payment_installment.registration_draft_child_id AS registrationDraftChildId,
      payment_installment.installment_number AS installmentNumber, payment_installment.amount_mnt AS amountMnt,
      COALESCE(SUM(CASE WHEN payment_confirmation.status = 'undone' THEN 0 ELSE payment_allocation.allocated_amount_mnt END), 0)
        + COALESCE((SELECT SUM(-credit_entry.amount_mnt) FROM child_credit_entry AS credit_entry
          WHERE credit_entry.payment_installment_id = payment_installment.id AND credit_entry.entry_kind = 'credit_application'), 0) AS allocatedAmountMnt
    FROM payment_installment
    LEFT JOIN payment_allocation ON payment_allocation.payment_installment_id = payment_installment.id
    LEFT JOIN received_payment ON received_payment.id = payment_allocation.received_payment_id
    LEFT JOIN payment_confirmation ON payment_confirmation.received_payment_id = received_payment.id
    WHERE payment_installment.registration_draft_child_id = ? GROUP BY payment_installment.id`)
    .bind(childId).all<{ id: string; registrationDraftChildId: string; installmentNumber: number; amountMnt: number; allocatedAmountMnt: number }>();
  const effective = await effectiveInstallmentsForRows(env.DB, rows.results.map((row) => ({
    ...row, installmentNumber: number(row.installmentNumber), amountMnt: number(row.amountMnt), allocatedAmountMnt: number(row.allocatedAmountMnt),
  })));
  return effective.reduce((sum, row) => sum + Math.max(0, number(row.effectiveAmountMnt) - number(row.allocatedAmountMnt)), 0);
}

function reserveRoots(roots: Array<{ id: string; availableAmountMnt: number }>, amountMnt: number) {
  let remaining = amountMnt;
  const reservations: Array<{ sourceCreditEntryId: string; amountMnt: number }> = [];
  for (const root of roots) {
    if (!remaining) break;
    const amount = Math.min(Math.max(0, number(root.availableAmountMnt)), remaining);
    if (amount) reservations.push({ sourceCreditEntryId: root.id, amountMnt: amount });
    remaining -= amount;
  }
  if (remaining) throw new AdditionalClassAdmissionError("stale");
  return reservations;
}

export async function createAdditionalClassAdmission(env: WorkerEnv, actor: StaffPrincipal, input: {
  registrationDraftChildId: string; targetClassSessionId: string; paymentPlanCode: string; parentAcknowledged: boolean;
  childAcknowledged: boolean; idempotencyKey: string; policyUpdatedAt: string;
  proposedSourceAwardMnt: number; proposedTargetAwardMnt: number;
  proposedExistingCreditMnt: number; proposedSourceAwardCreditMnt: number;
  useExistingCredit: boolean; useSourceAwardCredit: boolean;
}, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "registration.manage")) throw new AdditionalClassAdmissionError("forbidden");
  if (!input.parentAcknowledged || !input.childAcknowledged || !["single", "two_installment"].includes(input.paymentPlanCode) || !input.idempotencyKey) {
    throw new AdditionalClassAdmissionError("invalid");
  }
  // Resolve the operation key before deriving a new target. A replay remains
  // meaningful after its hold converts to an enrollment or reaches a terminal
  // state, but it may never be reused for another child or class.
  const replay = await env.DB.prepare(`SELECT additional_class_admission.id AS admissionId,
      additional_class_admission.target_registration_draft_id AS draftId,
      additional_class_admission.target_registration_draft_child_id AS registrationDraftChildId,
      additional_class_admission.source_registration_draft_child_id AS sourceChildId,
      additional_class_admission.created_by_staff_account_id AS staffAccountId,
      additional_class_admission.status, registration_draft.email,
      registration_draft_child.selected_class_session_id AS targetClassSessionId,
      registration_draft_child.payment_plan_code AS paymentPlanCode,
      registration_capacity_hold.deadline_at AS paymentDeadlineAt
    FROM additional_class_admission
    INNER JOIN registration_draft ON registration_draft.id = additional_class_admission.target_registration_draft_id
    INNER JOIN registration_draft_child ON registration_draft_child.id = additional_class_admission.target_registration_draft_child_id
    LEFT JOIN registration_capacity_hold ON registration_capacity_hold.registration_draft_child_id = additional_class_admission.target_registration_draft_child_id
      AND registration_capacity_hold.hold_type = 'initial_payment' AND registration_capacity_hold.status = 'active'
    WHERE additional_class_admission.idempotency_key = ?`).bind(input.idempotencyKey).first<{
      admissionId: string; draftId: string; registrationDraftChildId: string; sourceChildId: string; staffAccountId: string;
      status: "pending_confirmation" | "confirmed" | "cancelled" | "expired"; email: string; targetClassSessionId: string; paymentPlanCode: string;
      paymentDeadlineAt: string | null;
  }>();
  if (replay) {
    if (replay.sourceChildId !== input.registrationDraftChildId || replay.staffAccountId !== actor.staffAccountId
      || replay.targetClassSessionId !== input.targetClassSessionId || replay.paymentPlanCode !== input.paymentPlanCode) {
      throw new AdditionalClassAdmissionError("conflict");
    }
    return { draftId: replay.draftId, registrationDraftChildId: replay.registrationDraftChildId,
      email: replay.email, hasPaymentHold: Boolean(replay.paymentDeadlineAt), paymentDeadlineAt: replay.paymentDeadlineAt,
      paymentReference: null, accessCookie: null, created: false, replayed: true, lifecycleStatus: replay.status,
      admissionId: replay.admissionId, sourceAwardMnt: 0, targetAwardMnt: 0 };
  }
  const source = await sourceForMutation(env, input.registrationDraftChildId);
  const target = await targetForMutation(env, source, input.targetClassSessionId);
  const targetIsTwoInstallment = input.paymentPlanCode === "two_installment";
  if (target.classSessionId === (await env.DB.prepare(`SELECT class_session_id AS id FROM enrollment WHERE id = ?`).bind(source.enrollmentId).first<{ id: string }>())?.id
    || (targetIsTwoInstallment
      ? number(target.twoEnabled) !== 1 || number(target.firstAmountMnt) < 1 || number(target.secondAmountMnt) < 1 || !target.secondDueOn
      : number(target.oneTimeAmountMnt) < 1)) {
    throw new AdditionalClassAdmissionError("unsupported");
  }
  const pending = await env.DB.prepare(`SELECT 1 AS value FROM additional_class_admission
    WHERE canonical_student_id = ? AND status = 'pending_confirmation'
      AND target_registration_draft_child_id IN (SELECT id FROM registration_draft_child WHERE selected_class_session_id = ?)`)
    .bind(source.studentId, target.classSessionId).first();
  const duplicate = await env.DB.prepare(`SELECT 1 AS value FROM enrollment WHERE student_id = ? AND class_session_id = ?
    AND status = 'confirmed' AND transferred_out_at IS NULL`).bind(source.studentId, target.classSessionId).first();
  if (pending || duplicate) throw new AdditionalClassAdmissionError("conflict");
  const policy = await getDiscountPolicySettingFromDatabase(env.DB);
  if (policy.familyMultiChildBasisPoints <= 0) throw new AdditionalClassAdmissionError("unsupported");
  const [sourceFinancial, creditSummary] = await Promise.all([
    sourceFinancialSupport(env, source, policy.familyMultiChildBasisPoints),
    childCreditSummaryForChild(env.DB, source.childId),
  ]);
  const targetTotal = targetIsTwoInstallment ? number(target.firstAmountMnt) + number(target.secondAmountMnt) : number(target.oneTimeAmountMnt);
  const targetAwardMnt = discountAmountMnt(targetTotal, policy.familyMultiChildBasisPoints);
  if (targetAwardMnt <= 0 || (targetIsTwoInstallment && targetAwardMnt > number(target.secondAmountMnt))) throw new AdditionalClassAdmissionError("unsupported");
  if (policy.updatedAt !== input.policyUpdatedAt || sourceFinancial.sourceAwardMnt !== input.proposedSourceAwardMnt
    || targetAwardMnt !== input.proposedTargetAwardMnt) throw new AdditionalClassAdmissionError("stale");
  const targetEffectiveAmountMnt = targetIsTwoInstallment ? number(target.firstAmountMnt) : targetTotal - targetAwardMnt;
  const sourceAwardCreditMnt = Math.max(0, sourceFinancial.sourceAwardMnt - Math.min(sourceFinancial.sourceAwardMnt, await sourceOutstanding(env, source.childId)));
  const creditEligibleNow = !targetIsTwoInstallment;
  const existingCreditMnt = creditEligibleNow && input.useExistingCredit ? Math.min(creditSummary.availableAmountMnt, targetEffectiveAmountMnt) : 0;
  const contingentCreditMnt = creditEligibleNow && input.useSourceAwardCredit
    ? Math.min(sourceAwardCreditMnt, Math.max(0, targetEffectiveAmountMnt - existingCreditMnt)) : 0;
  const requestedExistingCreditMnt = input.proposedExistingCreditMnt == null ? 0 : Number(input.proposedExistingCreditMnt);
  const requestedSourceAwardCreditMnt = input.proposedSourceAwardCreditMnt == null ? 0 : Number(input.proposedSourceAwardCreditMnt);
  if (requestedExistingCreditMnt !== existingCreditMnt || requestedSourceAwardCreditMnt !== contingentCreditMnt) {
    throw new AdditionalClassAdmissionError("stale");
  }
  const existingCreditReservations = reserveRoots(creditSummary.roots, existingCreditMnt);
  const admissionId = crypto.randomUUID();
  try {
    const created = await createRegistrationDraft(env, {
      guardian: { fullName: source.guardianFullName, relationship: source.guardianRelationship, primaryPhone: source.primaryPhone,
        secondaryPhone: source.secondaryPhone ?? undefined, email: source.email, facebookName: source.facebookName ?? undefined, homeAddress: source.homeAddress },
      children: [{ surname: source.surname, givenName: source.givenName, gender: source.gender, dateOfBirth: source.dateOfBirth,
        currentGrade: source.currentGrade, currentSchool: source.currentSchool ?? undefined, returningStatus: source.returningStatus,
        previousStageCode: source.previousStageCode ?? undefined, selectedStageCode: target.stageCode,
        selectedClassSessionId: target.classSessionId, paymentPlanCode: input.paymentPlanCode as "single" | "two_installment" }],
      parentRulesAcknowledged: true, studentRulesAcknowledged: true, parentRulesVersion: rulesContent.parent.version,
      studentRulesVersion: rulesContent.student.version, turnstileToken: "",
    }, nowDate, {
      idempotencyKey: input.idempotencyKey,
      staffAssisted: { staffAccountId: actor.staffAccountId, intakeChannel: "in_person", parentAcknowledged: true, studentAcknowledged: true, receiptRequested: false },
      additionalClassAdmission: { id: admissionId, sourceRegistrationDraftChildId: source.childId, sourceEnrollmentId: source.enrollmentId,
        canonicalStudentId: source.studentId, canonicalGuardianAccountId: source.guardianId, staffAccountId: actor.staffAccountId,
        policyUpdatedAt: policy.updatedAt, familyBasisPoints: policy.familyMultiChildBasisPoints,
        sourceBaseAmountMnt: sourceFinancial.sourceTotal, sourceAwardAmountMnt: sourceFinancial.sourceAwardMnt,
        targetBaseAmountMnt: targetTotal, targetAwardAmountMnt: targetAwardMnt,
        proposedExistingCreditMnt: existingCreditMnt, proposedSourceAwardCreditMnt: contingentCreditMnt,
        proposedCreditInstallmentNumber: creditEligibleNow && (existingCreditMnt || contingentCreditMnt) ? 1 : null,
        existingCreditReservations },
    });
    if (!created.hasPaymentHold) throw new AdditionalClassAdmissionError("conflict");
    return { ...created, admissionId, sourceAwardMnt: sourceFinancial.sourceAwardMnt, targetAwardMnt };
  } catch (error) {
    if (error instanceof RegistrationSubmissionError) {
      if (error.code === "capacity_changed") {
        await env.DB.prepare(`UPDATE additional_class_admission SET status = 'cancelled', updated_at = ?
          WHERE id = ? AND status = 'pending_confirmation'`).bind(nowDate.toISOString(), admissionId).run();
        throw new AdditionalClassAdmissionError("conflict");
      }
      throw new AdditionalClassAdmissionError("invalid");
    }
    throw error;
  }
}

export async function incorporateExistingAdditionalClass(env: WorkerEnv, actor: StaffPrincipal, input: {
  registrationDraftChildId: string; incomingRegistrationDraftChildId: string; reviewFingerprint: string;
  parentAcknowledged: boolean; childAcknowledged: boolean; idempotencyKey: string;
}, nowDate = new Date()) {
  if (!hasStaffCapability(actor, "registration.manage")) throw new AdditionalClassAdmissionError("forbidden");
  if (!input.parentAcknowledged || !input.childAcknowledged || !input.idempotencyKey
    || !/^[0-9a-f]{64}$/i.test(input.reviewFingerprint)) throw new AdditionalClassAdmissionError("invalid");
  const replay = await env.DB.prepare(`SELECT id AS admissionId, target_registration_draft_id AS draftId,
      target_registration_draft_child_id AS registrationDraftChildId, source_registration_draft_child_id AS sourceChildId,
      status FROM additional_class_admission WHERE idempotency_key = ?`).bind(input.idempotencyKey)
    .first<{ admissionId: string; draftId: string; registrationDraftChildId: string; sourceChildId: string; status: string }>();
  if (replay) {
    if (replay.sourceChildId !== input.registrationDraftChildId || replay.registrationDraftChildId !== input.incomingRegistrationDraftChildId) {
      throw new AdditionalClassAdmissionError("conflict");
    }
    return { ...replay, created: false, replayed: true };
  }
  const preview = await previewExistingAdditionalClassIncorporation(env, actor, input);
  if (!preview.supported) throw new AdditionalClassAdmissionError(preview.unsupportedReason === "duplicate_class" ? "conflict" : "unsupported");
  if (preview.reviewFingerprint !== input.reviewFingerprint || !preview.proposal) throw new AdditionalClassAdmissionError("stale");
  const source = await sourceForMutation(env, input.registrationDraftChildId);
  const incoming = await existingIncomingForMutation(env, source, input.incomingRegistrationDraftChildId);
  const sameFamilyReferral = sameFamilyIncomingReferral(incoming, source);
  const refreshed = await previewExistingAdditionalClassIncorporation(env, actor, input);
  if (!refreshed.supported || refreshed.reviewFingerprint !== input.reviewFingerprint || !refreshed.proposal) {
    throw new AdditionalClassAdmissionError("stale");
  }
  const policy = await getDiscountPolicySettingFromDatabase(env.DB);
  if (policy.updatedAt !== refreshed.policyUpdatedAt) throw new AdditionalClassAdmissionError("stale");
  const sourceFinancial = await sourceFinancialSupport(env, source, policy.familyMultiChildBasisPoints);
  const targetAwardMnt = Number(refreshed.proposal.baseDiscountMnt);
  const targetBaseMnt = number(incoming.initialAmountMnt) + number(incoming.secondAmountMnt);
  if (targetAwardMnt < 1 || targetBaseMnt !== Number(refreshed.proposal.originalTotalMnt)) throw new AdditionalClassAdmissionError("stale");
  const admissionId = crypto.randomUUID();
  const now = nowDate.toISOString();
  const results = await env.DB.batch([
    // Cancel only this incoming child's provisional quote. Siblings retain their
    // own quotes and can continue their ordinary lifecycle unchanged.
    env.DB.prepare(`UPDATE conditional_family_discount_quote SET state = 'cancelled', resolution_reason = 'incorporated_into_existing_child',
      resolved_at = ?, updated_at = ?, revision = revision + 1
      WHERE registration_draft_child_id = ? AND state IN ('quoted_pending', 'cash_coverage_ready', 'conditionally_confirmed')`)
      .bind(now, now, incoming.childId),
    env.DB.prepare(`UPDATE registration_draft_child SET canonical_student_id = ?, identity_resolution_status = 'auto_resolved',
      promotion_status = 'pending', updated_at = ?
      WHERE id = ? AND updated_at = ? AND canonical_student_id IS NULL AND canonical_enrollment_id IS NULL`)
      .bind(source.studentId, now, incoming.childId, incoming.childUpdatedAt),
    env.DB.prepare(`INSERT INTO additional_class_admission (
      id, source_registration_draft_child_id, source_enrollment_id, target_registration_draft_id,
      target_registration_draft_child_id, canonical_student_id, canonical_guardian_account_id,
      created_by_staff_account_id, idempotency_key, policy_updated_at, family_basis_points,
      source_base_amount_mnt, source_award_amount_mnt, target_base_amount_mnt, target_award_amount_mnt,
      proposed_existing_credit_mnt, proposed_source_award_credit_mnt, proposed_credit_installment_number,
      origin_kind, status, is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, 'existing_registration', 'pending_confirmation', ?, ?, ?, ?)`)
      .bind(admissionId, source.childId, source.enrollmentId, incoming.draftId, incoming.childId, source.studentId,
        source.guardianId, actor.staffAccountId, input.idempotencyKey, policy.updatedAt, policy.familyMultiChildBasisPoints,
        sourceFinancial.sourceTotal, sourceFinancial.sourceAwardMnt, targetBaseMnt, targetAwardMnt,
        source.isTest, source.testRunId, now, now),
    env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
      metadata_json, environment, is_test, test_run_id, created_at)
      VALUES (?, ?, 'staff', ?, 'additional_class_existing_registration_incorporated', 'additional_class_admission', ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), now, actor.staffAccountId, admissionId, JSON.stringify({
        sourceChildId: source.childId, incomingChildId: incoming.childId, incomingDraftId: incoming.draftId,
        targetClassSessionId: incoming.classSessionId, reviewFingerprint: input.reviewFingerprint,
        sourceAwardMnt: sourceFinancial.sourceAwardMnt, targetAwardMnt, targetBaseMnt,
      }), env.APP_ENV, source.isTest, source.testRunId, now),
    ...(sameFamilyReferral ? [
      env.DB.prepare(`UPDATE registration_draft_referral SET status = 'disqualified', disqualification_reason = 'same_family', updated_at = ?
        WHERE registration_draft_child_id = ? AND status = 'captured'`).bind(now, incoming.childId),
      env.DB.prepare(`UPDATE discount_award SET status = 'reversed', reversed_at = ?, reversal_reason = 'same_family_referral_disqualified', updated_at = ?
        WHERE registration_draft_child_id = ? AND award_type = 'referral_referred' AND status = 'active'`).bind(now, now, incoming.childId),
    ] : []),
  ]);
  if ((results[1]?.meta?.changes ?? 0) !== 1 || (results[2]?.meta?.changes ?? 0) !== 1 || (results[3]?.meta?.changes ?? 0) !== 1) {
    throw new AdditionalClassAdmissionError("stale");
  }
  return { admissionId, draftId: incoming.draftId, registrationDraftChildId: incoming.childId,
    created: true, replayed: false, lifecycleStatus: "pending_confirmation" as const };
}
