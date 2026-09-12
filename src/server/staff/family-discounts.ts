import type { WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";
import { awardFamilyDiscountsForGroup, discountAmountMnt, discountAwardsForChildren, getDiscountPolicySettingFromDatabase } from "../services/discounts";
import { ChildCreditError, childCreditSummaryForChild, creditPaymentReviewState, transferAndApplyFamilyChildCredit } from "../services/child-credit-ledger";

type FamilyDiscountErrorCode = "forbidden" | "not_found" | "invalid" | "conflict" | "processing";
export class FamilyDiscountError extends Error {
  constructor(public readonly code: FamilyDiscountErrorCode) {
    super("Family discount operation failed.");
  }
}

interface ConfirmedChild {
  childId: string;
  studentId: string;
  guardianId: string | null;
  guardianName: string;
  childName: string;
  classLabel: string;
  academicYearLabel: string;
  initialAmountMnt: number | null;
  secondAmountMnt: number | null;
  isTest: number;
  testRunId: string | null;
}

export interface FamilyCreditSuggestion {
  donorChildId: string;
  donorStudentId: string;
  donorName: string;
  recipientChildId: string;
  recipientName: string;
  recipientClassLabel: string;
  paymentInstallmentId: string;
  installmentLabel: string;
  donorAvailableMnt: number;
  recipientOutstandingMnt: number;
  proposedAmountMnt: number;
  recipientRemainingAfterMnt: number;
}

interface FamilyAwardCreditState {
  awardId: string;
  childId: string;
  childName: string;
  creditAmountMnt: number;
  rootAmountMnt: number | null;
  availableAmountMnt: number;
  reservedAmountMnt: number;
  usedAmountMnt: number;
  canonicalStudentId: string;
  isTest: number;
  testRunId: string | null;
}

function validOperationId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function validReason(value: string): boolean {
  return value.trim().length > 0 && value.trim().length <= 400;
}

async function fingerprint(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

async function confirmedChild(env: WorkerEnv, childId: string): Promise<ConfirmedChild> {
  const row = await env.DB.prepare(`SELECT registration_draft_child.id AS childId,
    registration_draft_child.canonical_student_id AS studentId,
    registration_draft.canonical_guardian_account_id AS guardianId,
    COALESCE(guardian_account.full_name, registration_draft.guardian_full_name) AS guardianName,
    trim(registration_draft_child.surname || ' ' || registration_draft_child.given_name) AS childName,
    class_session.display_label AS classLabel, academic_year.public_label AS academicYearLabel,
    registration_draft_child.initial_payment_amount_mnt AS initialAmountMnt,
    registration_draft_child.second_payment_amount_mnt AS secondAmountMnt,
    registration_draft_child.is_test AS isTest, registration_draft_child.test_run_id AS testRunId
    FROM registration_draft_child
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    LEFT JOIN guardian_account ON guardian_account.id = registration_draft.canonical_guardian_account_id
    INNER JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
      AND enrollment.status = 'confirmed' AND enrollment.transferred_out_at IS NULL
    INNER JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id
    INNER JOIN academic_year ON academic_year.id = class_session.academic_year_id
    WHERE registration_draft_child.id = ? AND registration_draft_child.status != 'cancelled'
      AND registration_draft_child.canonical_student_id IS NOT NULL`).bind(childId).first<ConfirmedChild>();
  if (!row) throw new FamilyDiscountError("not_found");
  return { ...row, initialAmountMnt: row.initialAmountMnt == null ? null : Number(row.initialAmountMnt),
    secondAmountMnt: row.secondAmountMnt == null ? null : Number(row.secondAmountMnt), isTest: Number(row.isTest) };
}

async function activeGroupForStudent(env: WorkerEnv, studentId: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT family_group_member.family_group_id AS familyGroupId
    FROM family_group_member INNER JOIN family_group ON family_group.id = family_group_member.family_group_id
    WHERE family_group_member.student_id = ? AND family_group_member.status = 'active' AND family_group.status = 'active'
    ORDER BY family_group_member.created_at LIMIT 1`).bind(studentId).first<{ familyGroupId: string }>();
  return row?.familyGroupId ?? null;
}

async function membersForGroup(env: WorkerEnv, familyGroupId: string) {
  return env.DB.prepare(`SELECT family_group_member.student_id AS studentId,
    MIN(registration_draft_child.id) AS childId,
    MIN(trim(registration_draft_child.surname || ' ' || registration_draft_child.given_name)) AS childName,
    GROUP_CONCAT(DISTINCT class_session.display_label) AS classLabel,
    GROUP_CONCAT(DISTINCT academic_year.public_label) AS academicYearLabel
    FROM family_group_member
    LEFT JOIN registration_draft_child ON registration_draft_child.canonical_student_id = family_group_member.student_id
      AND registration_draft_child.canonical_enrollment_id IS NOT NULL AND registration_draft_child.status != 'cancelled'
    LEFT JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
      AND enrollment.status = 'confirmed' AND enrollment.transferred_out_at IS NULL
    LEFT JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id
    LEFT JOIN academic_year ON academic_year.id = class_session.academic_year_id
    WHERE family_group_member.family_group_id = ? AND family_group_member.status = 'active'
    GROUP BY family_group_member.student_id
    ORDER BY childName COLLATE NOCASE, childId`).bind(familyGroupId).all<{
      studentId: string; childId: string | null; childName: string | null; classLabel: string | null; academicYearLabel: string | null;
    }>();
}

async function familyAwardCreditStates(env: WorkerEnv, familyGroupId: string): Promise<FamilyAwardCreditState[]> {
  const rows = await env.DB.prepare(`SELECT discount_award.id AS awardId,
      discount_award.registration_draft_child_id AS childId,
      trim(registration_draft_child.surname || ' ' || registration_draft_child.given_name) AS childName,
      discount_award.credit_amount_mnt AS creditAmountMnt,
      root.amount_mnt AS rootAmountMnt,
      COALESCE(root.reserved_amount_mnt, 0) AS reservedAmountMnt,
      COALESCE(SUM(CASE WHEN debit.amount_mnt < 0 THEN -debit.amount_mnt ELSE 0 END), 0) AS usedAmountMnt,
      COALESCE(root.amount_mnt + SUM(COALESCE(debit.amount_mnt, 0)) - root.reserved_amount_mnt, 0) AS availableAmountMnt,
      registration_draft_child.canonical_student_id AS canonicalStudentId,
      registration_draft_child.is_test AS isTest, registration_draft_child.test_run_id AS testRunId
    FROM discount_award
    INNER JOIN registration_draft_child ON registration_draft_child.id = discount_award.registration_draft_child_id
    LEFT JOIN child_credit_entry AS root ON root.source_discount_award_id = discount_award.id
    LEFT JOIN child_credit_entry AS debit ON debit.origin_entry_id = root.id
    WHERE discount_award.family_group_id = ? AND discount_award.award_type = 'family_multi_child'
      AND discount_award.status = 'active'
    GROUP BY discount_award.id, root.id
    ORDER BY discount_award.awarded_at, discount_award.id`).bind(familyGroupId).all<FamilyAwardCreditState>();
  return rows.results.map((row) => ({
    ...row,
    creditAmountMnt: Number(row.creditAmountMnt),
    rootAmountMnt: row.rootAmountMnt == null ? null : Number(row.rootAmountMnt),
    availableAmountMnt: Number(row.availableAmountMnt),
    reservedAmountMnt: Number(row.reservedAmountMnt),
    usedAmountMnt: Number(row.usedAmountMnt),
    isTest: Number(row.isTest),
  }));
}

async function expectedFamilyAwardChildIds(env: WorkerEnv, familyGroupId: string, triggerChildId: string): Promise<string[]> {
  const rows = await env.DB.prepare(`SELECT registration_draft_child.id AS childId,
      registration_draft_child.canonical_student_id AS studentId,
      registration_draft_child.selected_class_session_id AS classSessionId
    FROM registration_draft_child
    INNER JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
      AND enrollment.status = 'confirmed' AND enrollment.transferred_out_at IS NULL
    INNER JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id
    WHERE registration_draft_child.canonical_student_id IN (
      SELECT student_id FROM family_group_member WHERE family_group_id = ? AND status = 'active'
    ) AND registration_draft_child.status != 'cancelled'
      AND class_session.academic_year_id = (
        SELECT class_session.academic_year_id FROM registration_draft_child
        INNER JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id
        WHERE registration_draft_child.id = ?
      )`).bind(familyGroupId, triggerChildId).all<{ childId: string; studentId: string; classSessionId: string }>();
  const distinctStudents = new Set(rows.results.map((row) => row.studentId));
  const distinctClasses = new Set(rows.results.map((row) => `${row.studentId}:${row.classSessionId}`));
  return distinctStudents.size >= 2 || distinctClasses.size >= 2 ? rows.results.map((row) => row.childId) : [];
}

async function materializeFamilyAwardResidualCredits(env: WorkerEnv, familyGroupId: string, now = new Date().toISOString()) {
  const states = await familyAwardCreditStates(env, familyGroupId);
  const gaps = states.filter((state) => state.creditAmountMnt > 0 && state.rootAmountMnt == null);
  for (const state of gaps) {
    const operationId = `${state.awardId}:credit`;
    const rootId = `child-credit:award:${state.awardId}`;
    const fingerprint = JSON.stringify(["discount_award_credit", state.awardId, state.childId, state.creditAmountMnt]);
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO child_credit_operation (
        id, operation_type, source_student_id, source_registration_draft_child_id, amount_mnt, reason,
        request_fingerprint, is_test, test_run_id, created_at
      ) VALUES (?, 'discount_award_credit', ?, ?, ?, 'Family discount residual credit', ?, ?, ?, ?)`)
        .bind(operationId, state.canonicalStudentId, state.childId, state.creditAmountMnt,
          fingerprint, state.isTest, state.testRunId, now),
      env.DB.prepare(`INSERT OR IGNORE INTO child_credit_entry (
        id, canonical_student_id, registration_draft_child_id, operation_id, entry_kind, amount_mnt,
        source_discount_award_id, reason, is_test, test_run_id, created_at
      ) VALUES (?, ?, ?, ?, 'discount_award_credit', ?, ?, 'Family discount residual credit', ?, ?, ?)`)
        .bind(rootId, state.canonicalStudentId, state.childId, operationId, state.creditAmountMnt,
          state.awardId, state.isTest, state.testRunId, now),
    ]);
  }
  return familyAwardCreditStates(env, familyGroupId);
}

async function recoverFamilyDiscountProcessing(env: WorkerEnv, familyGroupId: string, triggerChildId: string, now = new Date().toISOString()) {
  const policy = await getDiscountPolicySettingFromDatabase(env.DB);
  await awardFamilyDiscountsForGroup(env, { familyGroupId, triggerChildId, policy, now });
  const states = await materializeFamilyAwardResidualCredits(env, familyGroupId, now);
  if (states.some((state) => state.creditAmountMnt > 0 && state.rootAmountMnt == null)) throw new FamilyDiscountError("processing");
  return states;
}

export async function familyDiscountDetail(env: WorkerEnv, actor: StaffPrincipal, childId: string) {
  if (!hasStaffCapability(actor, "registration.manage")) throw new FamilyDiscountError("forbidden");
  const child = await confirmedChild(env, childId);
  const familyGroupId = await activeGroupForStudent(env, child.studentId);
  const members = familyGroupId ? (await membersForGroup(env, familyGroupId)).results : [];
  const awards = (await discountAwardsForChildren(env.DB, [child.childId], true)).get(child.childId) ?? [];
  const policy = await getDiscountPolicySettingFromDatabase(env.DB);
  const awardCredits = familyGroupId ? await familyAwardCreditStates(env, familyGroupId) : [];
  const expectedAwardChildren = familyGroupId ? await expectedFamilyAwardChildIds(env, familyGroupId, child.childId) : [];
  const awardedChildren = new Set(awardCredits.map((state) => state.childId));
  const needsCreditRecovery = awardCredits.some((state) => state.creditAmountMnt > 0 && state.rootAmountMnt == null)
    || expectedAwardChildren.some((expectedChildId) => !awardedChildren.has(expectedChildId));
  const creditSuggestions = hasStaffCapability(actor, "payment.manage")
    ? await familyCreditSuggestionsForChild(env, childId) : [];
  return { child, familyGroupId, members, awards, awardCredits, creditSuggestions, needsCreditRecovery, familyDiscountBasisPoints: policy.familyMultiChildBasisPoints };
}

export async function findFamilyDiscountCandidates(env: WorkerEnv, actor: StaffPrincipal, input: { childId: string; query?: string }) {
  if (!hasStaffCapability(actor, "registration.manage")) throw new FamilyDiscountError("forbidden");
  const source = await confirmedChild(env, input.childId);
  const query = String(input.query ?? "").trim();
  if (query.length > 120) throw new FamilyDiscountError("invalid");
  const rows = await env.DB.prepare(`WITH eligible AS (
    SELECT registration_draft_child.id AS childId,
      registration_draft_child.canonical_student_id AS studentId,
      registration_draft.canonical_guardian_account_id AS guardianId,
      COALESCE(guardian_account.full_name, registration_draft.guardian_full_name) AS guardianName,
      trim(registration_draft_child.surname || ' ' || registration_draft_child.given_name) AS childName,
      class_session.display_label AS classLabel, academic_year.public_label AS academicYearLabel,
      registration_draft_child.initial_payment_amount_mnt AS initialAmountMnt,
      registration_draft_child.second_payment_amount_mnt AS secondAmountMnt,
      registration_draft_child.is_test AS isTest, registration_draft_child.test_run_id AS testRunId,
      ROW_NUMBER() OVER (PARTITION BY registration_draft_child.canonical_student_id
        ORDER BY registration_draft_child.updated_at DESC, registration_draft_child.id) AS identityRank
    FROM registration_draft_child
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    LEFT JOIN guardian_account ON guardian_account.id = registration_draft.canonical_guardian_account_id
    INNER JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
      AND enrollment.status = 'confirmed' AND enrollment.transferred_out_at IS NULL
    INNER JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id
    INNER JOIN academic_year ON academic_year.id = class_session.academic_year_id
    WHERE registration_draft_child.id != ? AND registration_draft_child.canonical_student_id != ?
      AND registration_draft_child.status != 'cancelled' AND registration_draft_child.is_test = ?
      AND class_session.academic_year_id = (SELECT source_class.academic_year_id FROM registration_draft_child AS source_child
        INNER JOIN class_session AS source_class ON source_class.id = source_child.selected_class_session_id WHERE source_child.id = ?)
      AND NOT EXISTS (SELECT 1 FROM family_group_member AS member
        INNER JOIN family_group AS family ON family.id = member.family_group_id AND family.status = 'active'
        WHERE member.student_id = registration_draft_child.canonical_student_id AND member.status = 'active')
      AND (? = '' OR registration_draft_child.given_name LIKE ? COLLATE NOCASE OR registration_draft_child.surname LIKE ? COLLATE NOCASE)
  ) SELECT * FROM eligible WHERE identityRank = 1 ORDER BY childName COLLATE NOCASE, classLabel COLLATE NOCASE, childId`)
    .bind(source.childId, source.studentId, source.isTest, source.childId, query, `%${query}%`, `%${query}%`).all<ConfirmedChild>();
  return { candidates: rows.results.map((row) => ({ ...row,
    initialAmountMnt: row.initialAmountMnt == null ? null : Number(row.initialAmountMnt),
    secondAmountMnt: row.secondAmountMnt == null ? null : Number(row.secondAmountMnt), isTest: Number(row.isTest) })) };
}

// A suggestion is deliberately a projection, not a reservation. A donor's
// available balance is budgeted once while composing this list so the same
// credit is never presented as funding two sibling obligations.
export async function familyCreditSuggestionsForChild(env: WorkerEnv, childId: string): Promise<FamilyCreditSuggestion[]> {
  let source: ConfirmedChild;
  try { source = await confirmedChild(env, childId); }
  catch (error) {
    if (error instanceof FamilyDiscountError && error.code === "not_found") return [];
    throw error;
  }
  const familyGroupId = await activeGroupForStudent(env, source.studentId);
  if (!familyGroupId) return [];
  const rows = await env.DB.prepare(`SELECT registration_draft_child.id AS childId,
      registration_draft_child.canonical_student_id AS studentId,
      trim(registration_draft_child.surname || ' ' || registration_draft_child.given_name) AS childName,
      class_session.display_label AS classLabel, registration_draft_child.payment_plan_code AS paymentPlanCode,
      payment_installment.id AS installmentId, payment_installment.installment_kind AS installmentKind
    FROM registration_draft_child
    INNER JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
      AND enrollment.status = 'confirmed' AND enrollment.transferred_out_at IS NULL
    INNER JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id
    INNER JOIN payment_installment ON payment_installment.registration_draft_child_id = registration_draft_child.id
      AND payment_installment.status != 'released'
    WHERE registration_draft_child.canonical_student_id IN (SELECT student_id FROM family_group_member
      WHERE family_group_id = ? AND status = 'active')
      AND registration_draft_child.status != 'cancelled'
      AND registration_draft_child.is_test = ?
      AND class_session.academic_year_id = (SELECT source_class.academic_year_id FROM registration_draft_child AS source_child
        INNER JOIN class_session AS source_class ON source_class.id = source_child.selected_class_session_id WHERE source_child.id = ?)
    ORDER BY childName COLLATE NOCASE, registration_draft_child.id, payment_installment.installment_number`)
    .bind(familyGroupId, source.isTest, source.childId).all<{
      childId: string; studentId: string; childName: string; classLabel: string; paymentPlanCode: string;
      installmentId: string; installmentKind: "initial" | "later";
    }>();
  const eligibleRows = rows.results.filter((row) => row.paymentPlanCode === "two_installment"
    ? row.installmentKind === "later" : row.installmentKind === "initial");
  const representativeByStudent = new Map<string, typeof eligibleRows[number]>();
  for (const row of eligibleRows) if (!representativeByStudent.has(row.studentId)) representativeByStudent.set(row.studentId, row);
  const donorBudget = new Map<string, number>();
  for (const row of representativeByStudent.values()) {
    const summary = await childCreditSummaryForChild(env.DB, row.childId);
    donorBudget.set(row.studentId, summary.availableAmountMnt);
  }
  const suggestions: FamilyCreditSuggestion[] = [];
  for (const recipient of eligibleRows) {
    const review = await creditPaymentReviewState(env.DB, recipient.childId, recipient.installmentId);
    if (!review.eligible || review.outstandingAmountMnt <= 0) continue;
    const donor = [...representativeByStudent.values()].find((candidate) => candidate.studentId !== recipient.studentId
      && Number(donorBudget.get(candidate.studentId) ?? 0) > 0);
    if (!donor) continue;
    const donorAvailableMnt = Number(donorBudget.get(donor.studentId) ?? 0);
    const proposedAmountMnt = Math.min(donorAvailableMnt, review.outstandingAmountMnt);
    donorBudget.set(donor.studentId, donorAvailableMnt - proposedAmountMnt);
    suggestions.push({ donorChildId: donor.childId, donorStudentId: donor.studentId, donorName: donor.childName,
      recipientChildId: recipient.childId, recipientName: recipient.childName, recipientClassLabel: recipient.classLabel,
      paymentInstallmentId: recipient.installmentId, installmentLabel: recipient.installmentKind === "later" ? "Хоёр дахь төлбөр" : "Төлбөр",
      donorAvailableMnt, recipientOutstandingMnt: review.outstandingAmountMnt, proposedAmountMnt,
      recipientRemainingAfterMnt: review.outstandingAmountMnt - proposedAmountMnt });
  }
  return suggestions;
}

export async function applyFamilyCreditSuggestion(env: WorkerEnv, actor: StaffPrincipal, input: {
  sourceChildId: string; recipientChildId: string; paymentInstallmentId: string; amountMnt: number; reason: string; operationId: string;
}) {
  if (!hasStaffCapability(actor, "payment.manage")) throw new FamilyDiscountError("forbidden");
  const suggestions = await familyCreditSuggestionsForChild(env, input.recipientChildId);
  const suggestion = suggestions.find((candidate) => candidate.donorChildId === input.sourceChildId
    && candidate.recipientChildId === input.recipientChildId && candidate.paymentInstallmentId === input.paymentInstallmentId);
  // Suggestions are a confirmation snapshot, never a free-form transfer
  // request. A changed cap or obligation must be reviewed again in the UI.
  if (!suggestion || Number(input.amountMnt) !== suggestion.proposedAmountMnt) throw new ChildCreditError("conflict");
  return transferAndApplyFamilyChildCredit(env, actor, {
    sourceRegistrationDraftChildId: suggestion.donorChildId,
    targetRegistrationDraftChildId: suggestion.recipientChildId,
    paymentInstallmentId: suggestion.paymentInstallmentId,
    amountMnt: suggestion.proposedAmountMnt,
    reason: input.reason,
    operationId: input.operationId,
  });
}

export async function previewFamilyDiscountMembership(env: WorkerEnv, actor: StaffPrincipal, input: { childId: string; relatedChildId: string }) {
  if (!hasStaffCapability(actor, "registration.manage")) throw new FamilyDiscountError("forbidden");
  const [primary, related, policy] = await Promise.all([
    confirmedChild(env, input.childId), confirmedChild(env, input.relatedChildId), getDiscountPolicySettingFromDatabase(env.DB),
  ]);
  if (primary.studentId === related.studentId || primary.isTest !== related.isTest) throw new FamilyDiscountError("invalid");
  const [primaryGroup, relatedGroup] = await Promise.all([activeGroupForStudent(env, primary.studentId), activeGroupForStudent(env, related.studentId)]);
  if (primaryGroup && relatedGroup && primaryGroup !== relatedGroup) throw new FamilyDiscountError("conflict");
  const groupId = primaryGroup ?? relatedGroup;
  const members = groupId ? (await membersForGroup(env, groupId)).results : [];
  const combinedStudents = new Set([...members.map((member) => member.studentId), primary.studentId, related.studentId]);
  const awardsByChild = await discountAwardsForChildren(env.DB, [primary.childId, related.childId]);
  const financialPreview = [primary, related].map((child) => {
    const originalTotalMnt = Number(child.initialAmountMnt ?? 0) + Number(child.secondAmountMnt ?? 0);
    const existingFamilyAwardMnt = (awardsByChild.get(child.childId) ?? [])
      .filter((award) => award.awardType === "family_multi_child")
      .reduce((sum, award) => sum + award.awardAmountMnt, 0);
    return {
      childId: child.childId,
      childName: child.childName,
      originalTotalMnt,
      existingFamilyAwardMnt,
      proposedFamilyAwardMnt: existingFamilyAwardMnt > 0 ? 0 : discountAmountMnt(originalTotalMnt, policy.familyMultiChildBasisPoints),
    };
  });
  return {
    primary, related, familyGroupId: groupId, existingMembers: members,
    willQualifyWhenConfirmedInSameYear: combinedStudents.size >= 2,
    familyDiscountBasisPoints: policy.familyMultiChildBasisPoints, financialPreview,
    note: "Гэр бүлийн гишүүнчлэл нь хүүхэд, асран хамгаалагчийн данс, төлбөр эсвэл кредитийг нэгтгэхгүй.",
  };
}

export async function confirmFamilyDiscountMembership(env: WorkerEnv, actor: StaffPrincipal, input: {
  childId: string; relatedChildId: string; reason: string; operationId: string;
}) {
  if (!hasStaffCapability(actor, "registration.manage")) throw new FamilyDiscountError("forbidden");
  if (!validOperationId(input.operationId) || !validReason(input.reason)) throw new FamilyDiscountError("invalid");
  const requestFingerprint = await fingerprint([input.childId, input.relatedChildId, input.reason.trim()].join("\n"));
  const existing = await env.DB.prepare(`SELECT family_group_id AS familyGroupId, request_fingerprint AS requestFingerprint
    FROM family_group_confirmation WHERE operation_id = ?`).bind(input.operationId).first<{ familyGroupId: string; requestFingerprint: string }>();
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) throw new FamilyDiscountError("conflict");
    await recoverFamilyDiscountProcessing(env, existing.familyGroupId, input.childId);
    return { familyGroupId: existing.familyGroupId, replayed: true };
  }
  const preview = await previewFamilyDiscountMembership(env, actor, input);
  const now = new Date().toISOString();
  const groupId = preview.familyGroupId ?? crypto.randomUUID();
  const statements = [];
  if (!preview.familyGroupId) {
    statements.push(env.DB.prepare(`INSERT INTO family_group (id, status, source, is_test, test_run_id, created_at, updated_at)
      VALUES (?, 'active', 'admin_confirmed', ?, ?, ?, ?)`).bind(groupId, preview.primary.isTest, preview.primary.testRunId, now, now));
  }
  for (const member of [preview.primary, preview.related]) {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO family_group_member (
      id, family_group_id, student_id, guardian_id, relationship_basis, status, is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'admin_confirmed', 'active', ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), groupId, member.studentId, member.guardianId, member.isTest, member.testRunId, now, now));
  }
  statements.push(env.DB.prepare(`INSERT INTO family_group_confirmation (
    id, operation_id, family_group_id, primary_student_id, related_student_id, created_by_staff_account_id,
    reason, request_fingerprint, is_test, test_run_id, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), input.operationId, groupId, preview.primary.studentId, preview.related.studentId,
      actor.staffAccountId, input.reason.trim(), requestFingerprint, preview.primary.isTest, preview.primary.testRunId, now));
  statements.push(env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at) VALUES (?, ?, 'staff', ?, 'family_group_confirmed',
    'family_group', ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, groupId,
      JSON.stringify({ primaryStudentId: preview.primary.studentId, relatedStudentId: preview.related.studentId, operationId: input.operationId }),
      env.APP_ENV, preview.primary.isTest, preview.primary.testRunId, now));
  try { await env.DB.batch(statements); } catch { throw new FamilyDiscountError("conflict"); }
  const states = await recoverFamilyDiscountProcessing(env, groupId, input.childId, now);
  const awarded = states.length;
  return { familyGroupId: groupId, awarded, replayed: false };
}

export async function recoverFamilyDiscountCredits(env: WorkerEnv, actor: StaffPrincipal, childId: string) {
  if (!hasStaffCapability(actor, "registration.manage")) throw new FamilyDiscountError("forbidden");
  const child = await confirmedChild(env, childId);
  const familyGroupId = await activeGroupForStudent(env, child.studentId);
  if (!familyGroupId) throw new FamilyDiscountError("not_found");
  const states = await recoverFamilyDiscountProcessing(env, familyGroupId, childId);
  await env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at)
    VALUES (?, ?, 'staff', ?, 'family_discount_credit_recovered', 'family_group', ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), new Date().toISOString(), actor.staffAccountId, familyGroupId,
      JSON.stringify({ registrationDraftChildId: childId, recoveredAwardCount: states.filter((state) => state.creditAmountMnt > 0).length }),
      env.APP_ENV, child.isTest, child.testRunId, new Date().toISOString()).run();
  return { familyGroupId, recovered: true };
}
