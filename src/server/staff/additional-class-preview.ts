import type { WorkerEnv } from "../env";
import { discountAmountMnt, effectiveInstallmentsForRows, getDiscountPolicySetting } from "../services/discounts";
import { childCreditSummaryForChild } from "../services/child-credit-ledger";
import { getClassCapacityProjections } from "../services/class-capacity";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

export class AdditionalClassPreviewError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "ineligible" | "invalid" | "policy_unavailable") {
    super("Additional class preview is unavailable.");
  }
}

type Source = {
  childId: string; enrollmentId: string; studentId: string; academicYearId: string; childName: string; isTest: number;
  sourceClassIsTest: number; sourceOfferingIsTest: number; sourceYearIsTest: number;
};

type TargetRow = {
  classSessionId: string; offeringTitle: string | null; displayLabel: string | null; stageCode: string;
  weekday: string; startTime: string; endTime: string; oneTimeAmountMnt: number | null;
  classStatus?: string;
  twoInstallmentEnabled: number | null; firstInstallmentAmountMnt: number | null;
  secondInstallmentAmountMnt: number | null; secondInstallmentDueOn: string | null;
};

function integer(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isInteger(number) ? number : 0;
}

function classLabel(row: Pick<TargetRow, "offeringTitle" | "displayLabel" | "stageCode" | "weekday" | "startTime" | "endTime">): string {
  return `${row.offeringTitle || row.displayLabel || row.stageCode} · ${row.weekday} ${row.startTime}–${row.endTime}`;
}

async function sourceForChild(env: WorkerEnv, actor: StaffPrincipal, childId: string): Promise<Source> {
  if (!hasStaffCapability(actor, "registration.manage")) throw new AdditionalClassPreviewError("forbidden");
  const row = await env.DB.prepare(`SELECT registration_draft_child.id AS childId, enrollment.id AS enrollmentId,
      enrollment.student_id AS studentId, enrollment.academic_year_id AS academicYearId,
      registration_draft_child.surname || ' ' || registration_draft_child.given_name AS childName,
      registration_draft_child.is_test AS isTest, class_session.is_test AS sourceClassIsTest,
      activity_offering.is_test AS sourceOfferingIsTest, academic_year.is_test AS sourceYearIsTest,
      registration_draft_child.payment_plan_code AS sourcePaymentPlanCode
    FROM registration_draft_child
    INNER JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
    INNER JOIN class_session ON class_session.id = enrollment.class_session_id
    INNER JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
    INNER JOIN academic_year ON academic_year.id = enrollment.academic_year_id
    WHERE registration_draft_child.id = ? AND registration_draft_child.status != 'cancelled'
      AND enrollment.status = 'confirmed' AND enrollment.transferred_out_at IS NULL
      AND academic_year.registration_status != 'archived'`).bind(childId).first<Source>();
  if (!row) throw new AdditionalClassPreviewError("not_found");
  return { ...row, isTest: integer(row.isTest), sourceClassIsTest: integer(row.sourceClassIsTest),
    sourceOfferingIsTest: integer(row.sourceOfferingIsTest), sourceYearIsTest: integer(row.sourceYearIsTest) };
}

async function currentClasses(env: WorkerEnv, source: Source) {
  const classes = await env.DB.prepare(`SELECT enrollment.id AS enrollmentId,
      registration_draft_child.id AS registrationDraftChildId, class_session.id AS classSessionId, activity_offering.title AS offeringTitle,
      class_session.display_label AS displayLabel, class_session.stage_code AS stageCode,
      class_session.weekday AS weekday, class_session.start_time AS startTime, class_session.end_time AS endTime
    FROM enrollment
    INNER JOIN class_session ON class_session.id = enrollment.class_session_id
    INNER JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
    LEFT JOIN registration_draft_child ON registration_draft_child.canonical_enrollment_id = enrollment.id
    WHERE enrollment.student_id = ? AND enrollment.academic_year_id = ? AND enrollment.status = 'confirmed'
      AND enrollment.transferred_out_at IS NULL
    ORDER BY class_session.weekday, class_session.start_time, enrollment.id`).bind(source.studentId, source.academicYearId).all<{
      enrollmentId: string; registrationDraftChildId: string | null;
    } & TargetRow>();
  const ids = classes.results.flatMap((row) => row.registrationDraftChildId ? [row.registrationDraftChildId] : []);
  const installments = ids.length ? await env.DB.prepare(`SELECT id, registration_draft_child_id AS registrationDraftChildId,
      installment_number AS installmentNumber, amount_mnt AS amountMnt
    FROM payment_installment WHERE registration_draft_child_id IN (${ids.map(() => "?").join(", ")})
    ORDER BY installment_number, id`).bind(...ids).all<{ id: string; registrationDraftChildId: string; installmentNumber: number; amountMnt: number }>() : { results: [] };
  const effective = await effectiveInstallmentsForRows(env.DB, installments.results.map((row) => ({ ...row, amountMnt: integer(row.amountMnt) })));
  const byChild = new Map<string, typeof effective>();
  for (const item of effective) byChild.set(item.registrationDraftChildId, [...(byChild.get(item.registrationDraftChildId) ?? []), item]);
  const paid = ids.length ? await env.DB.prepare(`SELECT payment_installment.registration_draft_child_id AS registrationDraftChildId,
      COALESCE(SUM(CASE WHEN payment_confirmation.status = 'undone' THEN 0 ELSE payment_allocation.allocated_amount_mnt END), 0) AS paidMnt,
      COALESCE(SUM((SELECT -credit_entry.amount_mnt FROM child_credit_entry AS credit_entry
        WHERE credit_entry.payment_installment_id = payment_installment.id
          AND credit_entry.entry_kind = 'credit_application')), 0) AS creditAppliedMnt
    FROM payment_installment LEFT JOIN payment_allocation ON payment_allocation.payment_installment_id = payment_installment.id
    LEFT JOIN payment_confirmation ON payment_confirmation.received_payment_id = payment_allocation.received_payment_id
    WHERE payment_installment.registration_draft_child_id IN (${ids.map(() => "?").join(", ")})
    GROUP BY payment_installment.registration_draft_child_id`).bind(...ids).all<{ registrationDraftChildId: string; paidMnt: number; creditAppliedMnt: number }>() : { results: [] };
  const paidByChild = new Map(paid.results.map((row) => [row.registrationDraftChildId, {
    paidMnt: integer(row.paidMnt), creditAppliedMnt: integer(row.creditAppliedMnt),
  }]));
  return classes.results.map((row) => {
    const obligations = row.registrationDraftChildId ? byChild.get(row.registrationDraftChildId) ?? [] : [];
    const originalTotalMnt = obligations.reduce((sum, item) => sum + integer(item.amountMnt), 0);
    const discountMnt = obligations.reduce((sum, item) => sum + integer(item.discountAmountMnt), 0);
    const effectiveTotalMnt = obligations.reduce((sum, item) => sum + integer(item.effectiveAmountMnt), 0);
    const settlement = row.registrationDraftChildId ? paidByChild.get(row.registrationDraftChildId) ?? { paidMnt: 0, creditAppliedMnt: 0 } : { paidMnt: 0, creditAppliedMnt: 0 };
    return { enrollmentId: row.enrollmentId, registrationDraftChildId: row.registrationDraftChildId,
      classSessionId: row.classSessionId, label: classLabel(row),
      originalTotalMnt, discountMnt, effectiveTotalMnt, paidMnt: settlement.paidMnt,
      creditAppliedMnt: settlement.creditAppliedMnt,
      remainingMnt: Math.max(0, effectiveTotalMnt - settlement.paidMnt - settlement.creditAppliedMnt) };
  });
}

function selectedPlan(row: TargetRow, paymentPlanCode: string | null, basisPoints: number) {
  if (!paymentPlanCode) return null;
  const two = paymentPlanCode === "two_installment" && integer(row.twoInstallmentEnabled) === 1
    && integer(row.firstInstallmentAmountMnt) > 0 && integer(row.secondInstallmentAmountMnt) > 0;
  if (paymentPlanCode !== "single" && !two) throw new AdditionalClassPreviewError("invalid");
  const originalTotalMnt = two ? integer(row.firstInstallmentAmountMnt) + integer(row.secondInstallmentAmountMnt) : integer(row.oneTimeAmountMnt);
  if (originalTotalMnt <= 0) throw new AdditionalClassPreviewError("invalid");
  const baseDiscountMnt = discountAmountMnt(originalTotalMnt, basisPoints);
  // This is an agreed preview rule for a newly proposed two-installment agreement.
  // Existing settled installments remain projected by effectiveInstallmentsForRows above.
  const firstInstallmentMnt = two ? integer(row.firstInstallmentAmountMnt) : originalTotalMnt - baseDiscountMnt;
  const secondInstallmentMnt = two ? Math.max(0, integer(row.secondInstallmentAmountMnt) - baseDiscountMnt) : null;
  const unresolved = two && baseDiscountMnt > integer(row.secondInstallmentAmountMnt)
    ? ["Хөнгөлөлт хоёр дахь төлбөрөөс давж байна. Шийдвэр шаардлагатай."] : [];
  return {
    paymentPlanCode: two ? "two_installment" : "single", originalTotalMnt, baseDiscountMnt,
    totalAfterDiscountMnt: originalTotalMnt - baseDiscountMnt, firstInstallmentMnt,
    secondInstallmentMnt, secondInstallmentDueOn: two ? row.secondInstallmentDueOn : null, unresolved,
  };
}

export async function getAdditionalClassPreview(env: WorkerEnv, actor: StaffPrincipal, input: {
  registrationDraftChildId: string; targetClassSessionId?: string; paymentPlanCode?: string;
  useExistingCredit?: boolean; useSourceAwardCredit?: boolean;
}, nowDate = new Date()) {
  const source = await sourceForChild(env, actor, input.registrationDraftChildId);
  const [current, policy, childCredit] = await Promise.all([currentClasses(env, source), getDiscountPolicySetting(env).catch(() => {
    throw new AdditionalClassPreviewError("policy_unavailable");
  }), childCreditSummaryForChild(env.DB, source.childId)]);
  const sourceProvenanceConsistent = [source.sourceClassIsTest, source.sourceOfferingIsTest, source.sourceYearIsTest]
    .every((value) => value === source.isTest);
  const currentClassIds = new Set(current.map((row) => row.classSessionId));
  const pending = await env.DB.prepare(`SELECT selected_class_session_id AS classSessionId FROM registration_draft_child
    INNER JOIN registration_capacity_hold ON registration_capacity_hold.registration_draft_child_id = registration_draft_child.id
    WHERE registration_draft_child.canonical_student_id = ? AND registration_draft_child.canonical_enrollment_id IS NULL
      AND registration_draft_child.status != 'cancelled' AND registration_capacity_hold.status = 'active'`).bind(source.studentId)
    .all<{ classSessionId: string | null }>();
  const pendingClassIds = new Set(pending.results.flatMap((row) => row.classSessionId ? [row.classSessionId] : []));
  const candidates = await env.DB.prepare(`SELECT class_session.id AS classSessionId, activity_offering.title AS offeringTitle,
      class_session.display_label AS displayLabel, class_session.stage_code AS stageCode, class_session.weekday AS weekday,
      class_session.start_time AS startTime, class_session.end_time AS endTime, class_session.status AS classStatus,
      class_session.is_test AS classIsTest, activity_offering.is_test AS offeringIsTest, academic_year.is_test AS yearIsTest,
      offering_course_pricing.one_time_amount_mnt AS oneTimeAmountMnt,
      offering_course_pricing.two_installment_enabled AS twoInstallmentEnabled,
      offering_course_pricing.first_installment_amount_mnt AS firstInstallmentAmountMnt,
      offering_course_pricing.second_installment_amount_mnt AS secondInstallmentAmountMnt,
      offering_course_pricing.second_installment_due_on AS secondInstallmentDueOn
    FROM class_session INNER JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
    INNER JOIN academic_year ON academic_year.id = class_session.academic_year_id
    LEFT JOIN offering_course_pricing ON offering_course_pricing.activity_offering_id = activity_offering.id
    WHERE class_session.academic_year_id = ? AND class_session.status IN ('available', 'full') AND activity_offering.status = 'active'
      AND activity_offering.kind IN ('annual_course', 'summer_course') AND academic_year.registration_status != 'archived'
    ORDER BY CASE class_session.stage_code WHEN 'stage_1' THEN 1 WHEN 'stage_2' THEN 2 WHEN 'stage_3' THEN 3 ELSE 9 END,
      CASE class_session.weekday WHEN 'Даваа' THEN 1 WHEN 'Мягмар' THEN 2 WHEN 'Лхагва' THEN 3 WHEN 'Пүрэв' THEN 4 WHEN 'Баасан' THEN 5 WHEN 'Бямба' THEN 6 WHEN 'Ням' THEN 7 ELSE 9 END,
      class_session.start_time, class_session.id`).bind(source.academicYearId).all<TargetRow & { classIsTest: number; offeringIsTest: number; yearIsTest: number }>();
  const provenanceCandidates = candidates.results.filter((row) => integer(row.classIsTest) === source.isTest
    && integer(row.offeringIsTest) === source.isTest && integer(row.yearIsTest) === source.isTest);
  const pricedCandidates = provenanceCandidates.filter((row) => integer(row.oneTimeAmountMnt) > 0
    || (integer(row.twoInstallmentEnabled) === 1 && integer(row.firstInstallmentAmountMnt) > 0 && integer(row.secondInstallmentAmountMnt) > 0));
  const capacity = new Map((await getClassCapacityProjections(env.DB, env.APP_ENV, nowDate, pricedCandidates.map((row) => row.classSessionId)))
    .map((row) => [row.classSessionId, row]));
  const candidateTargets = pricedCandidates.filter((row) => !currentClassIds.has(row.classSessionId));
  const targetRows = candidateTargets.map((row) => {
    const projection = capacity.get(row.classSessionId);
    const pendingConflict = pendingClassIds.has(row.classSessionId);
    return { id: row.classSessionId, label: classLabel(row), stageCode: row.stageCode,
      freeSeats: projection?.freeSeats ?? 0, pendingConflict,
      selectable: row.classStatus === 'available' && !pendingConflict && (projection?.freeSeats ?? 0) > 0,
      paymentOptions: [
        ...(integer(row.oneTimeAmountMnt) > 0 ? [{ code: "single", totalAmountMnt: integer(row.oneTimeAmountMnt), initialAmountMnt: integer(row.oneTimeAmountMnt) }] : []),
        ...(integer(row.twoInstallmentEnabled) === 1 && integer(row.firstInstallmentAmountMnt) > 0 && integer(row.secondInstallmentAmountMnt) > 0
          ? [{ code: "two_installment", totalAmountMnt: integer(row.firstInstallmentAmountMnt) + integer(row.secondInstallmentAmountMnt), initialAmountMnt: integer(row.firstInstallmentAmountMnt), secondAmountMnt: integer(row.secondInstallmentAmountMnt), secondDueOn: row.secondInstallmentDueOn }]
          : [])] };
  });
  const selectedRow = input.targetClassSessionId ? pricedCandidates.find((row) => row.classSessionId === input.targetClassSessionId) : null;
  if (input.targetClassSessionId && !selectedRow) throw new AdditionalClassPreviewError("invalid");
  const existingBaseAward = await env.DB.prepare(`SELECT award_amount_mnt AS amountMnt, basis_points AS basisPoints
    FROM discount_award WHERE registration_draft_child_id = ?
      AND award_type = 'family_multi_child' AND status = 'active' ORDER BY awarded_at DESC LIMIT 1`)
    .bind(source.childId).first<{ amountMnt: number; basisPoints: number }>();
  const policyEnabled = policy.familyMultiChildBasisPoints > 0;
  // The target agreement may still need its one base award even when the
  // source agreement already earned one.  Duplication is prevented per
  // beneficiary at activation, not by hiding the target's promised preview.
  const proposal = selectedRow && policyEnabled
    ? selectedPlan(selectedRow, input.paymentPlanCode ?? null, policy.familyMultiChildBasisPoints) : null;
  const sourceCurrent = current.find((row) => row.registrationDraftChildId === source.childId);
  const sourceAwardMnt = policyEnabled && !existingBaseAward && sourceCurrent
    ? discountAmountMnt(sourceCurrent.originalTotalMnt, policy.familyMultiChildBasisPoints) : 0;
  const sourceAwardAppliedMnt = Math.min(sourceAwardMnt, sourceCurrent?.remainingMnt ?? 0);
  const sourceAwardCreditMnt = sourceAwardMnt - sourceAwardAppliedMnt;
  // Only a one-payment target has a final installment at admission
  // confirmation. A two-installment target's first payment remains cash-only;
  // available and contingent credit are offered against its later payment only
  // after ordinary confirmation.
  const creditEligibleNow = proposal?.paymentPlanCode === "single";
  const effectiveTargetAmountMnt = proposal?.paymentPlanCode === "single"
    ? Number(proposal.totalAfterDiscountMnt) : Number(proposal?.firstInstallmentMnt ?? 0);
  const useExistingCredit = input.useExistingCredit !== false;
  const useSourceAwardCredit = input.useSourceAwardCredit !== false;
  const proposedExistingCreditMnt = creditEligibleNow && useExistingCredit
    ? Math.min(childCredit.availableAmountMnt, effectiveTargetAmountMnt) : 0;
  const proposedSourceAwardCreditMnt = creditEligibleNow && useSourceAwardCredit
    ? Math.min(sourceAwardCreditMnt, Math.max(0, effectiveTargetAmountMnt - proposedExistingCreditMnt)) : 0;
  const cashRequiredMnt = Math.max(0, effectiveTargetAmountMnt - proposedExistingCreditMnt - proposedSourceAwardCreditMnt);
  const candidateProvenance = candidates.results.reduce((counts, row) => ({
    classMismatch: counts.classMismatch + Number(integer(row.classIsTest) !== source.isTest),
    programMismatch: counts.programMismatch + Number(integer(row.offeringIsTest) !== source.isTest),
    yearMismatch: counts.yearMismatch + Number(integer(row.yearIsTest) !== source.isTest),
  }), { classMismatch: 0, programMismatch: 0, yearMismatch: 0 });
  const targetAvailability = !sourceProvenanceConsistent ? "source_provenance_mismatch"
    : candidates.results.length === 0 ? "no_operational_candidates"
    : provenanceCandidates.length === 0 ? "candidate_provenance_mismatch"
      : pricedCandidates.length === 0 ? "pricing_unavailable"
        : candidateTargets.length === 0 ? "already_enrolled"
          : candidateTargets.every((row) => pendingClassIds.has(row.classSessionId)) ? "pending_admission"
            : targetRows.some((row) => row.selectable) ? "available" : "full";
  return {
    readOnly: true, child: { id: source.childId, name: source.childName },
    currentClasses: current.map(({ registrationDraftChildId: _registrationDraftChildId, ...row }) => row),
    targets: targetRows, targetAvailability, targetAvailabilityDetail: !sourceProvenanceConsistent
      ? "source_record" : provenanceCandidates.length === 0 && candidates.results.length
        ? candidateProvenance.classMismatch === candidates.results.length ? "class" : candidateProvenance.programMismatch === candidates.results.length ? "program" : "year"
        : null, selectedTargetId: selectedRow?.classSessionId ?? null, proposal,
    baseDiscount: { basisPoints: policy.familyMultiChildBasisPoints, enabled: policyEnabled, policyUpdatedAt: policy.updatedAt,
      existingAwardMnt: integer(existingBaseAward?.amountMnt), existingAwardBasisPoints: integer(existingBaseAward?.basisPoints) },
    sourceEffect: { awardMnt: sourceAwardMnt, reducesUnpaidMnt: sourceAwardAppliedMnt, createsCreditMnt: sourceAwardCreditMnt },
    creditProposal: proposal ? {
      eligibleNow: creditEligibleNow, targetInstallmentNumber: creditEligibleNow ? 1 : 2,
      availableChildCreditMnt: childCredit.availableAmountMnt,
      useExistingCredit, proposedExistingCreditMnt,
      useSourceAwardCredit, proposedSourceAwardCreditMnt,
      cashRequiredMnt,
      remainingChildCreditMnt: Math.max(0, childCredit.availableAmountMnt - proposedExistingCreditMnt),
      note: creditEligibleNow ? null : "Хоёр хувааж төлөх сонголтын эхний төлбөрт кредит хэрэглэхгүй. Кредитийг хоёр дахь төлбөрт тусад нь тооцно.",
    } : null,
    admissionEligibility: "eligible",
    publicRegistrationWindowIsNotRequired: true,
  };
}
