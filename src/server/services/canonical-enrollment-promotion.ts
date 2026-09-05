import { sha256 } from "../auth/crypto";
import type { D1Database, D1PreparedStatement, WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "../staff/authorization";
import { sendEnrollmentConfirmationEmail } from "../email/registration-transactional";
import { ensureEnrollmentReferralCode } from "./referral-codes";
import { awardFamilyDiscountsForGuardian, awardReferrerDiscountForReferral, getDiscountPolicySettingFromDatabase, reverseReferralAwardForSameFamily } from "./discounts";

type ResolutionStatus = "promoted" | "needs_identity_review" | "needs_guardian_review" | "not_eligible" | "failed";

export class CanonicalPromotionError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "invalid" | "not_eligible" | "conflict") {
    super("Canonical enrollment promotion failed.");
  }
}

interface PromotionRow {
  draftId: string;
  academicYearId: string;
  guardianFullName: string;
  guardianRelationship: string;
  primaryPhone: string;
  secondaryPhone: string | null;
  email: string;
  normalizedEmail: string;
  facebookName: string | null;
  homeAddress: string;
  parentRulesVersion: string;
  studentRulesVersion: string;
  verifiedAt: string | null;
  draftIsTest: number;
  draftTestRunId: string | null;
  canonicalGuardianId: string | null;
  canonicalPreRegistrationId: string | null;
  childId: string;
  position: number;
  surname: string;
  givenName: string;
  gender: "female" | "male" | "not_specified";
  dateOfBirth: string;
  currentGrade: string;
  currentSchool: string | null;
  returningStatus: "new" | "returning";
  previousStageCode: string | null;
  selectedClassSessionId: string | null;
  codeInput: string | null;
  paymentPlanCode: string | null;
  childIsTest: number;
  childTestRunId: string | null;
  canonicalStudentId: string | null;
  canonicalApplicationChildId: string | null;
  canonicalEnrollmentId: string | null;
  initialInstallmentPaid: number;
  laterInstallmentOutstanding: number;
  partialSeatApproved: number;
  activeInitialHold: number;
  draftStatus: string;
  childStatus: string;
  canonicalEnrollmentStatus: string | null;
}

interface GuardianRow {
  id: string;
  status: "active" | "needs_review" | "archived";
}

interface StudentRow {
  id: string;
  surname: string;
  givenName: string;
  gender: "female" | "male" | "not_specified";
  dateOfBirth: string;
}

interface DraftReferralRow {
  capturedCode: string;
  referringEnrollmentId: string;
  referringStudentId: string;
  referringGuardianId: string;
}

interface ReviewRow {
  childId: string;
  childName: string;
  dateOfBirth: string;
  gender: string;
  returningStatus: string;
  classLabel: string;
  weekday: string;
  startTime: string;
  endTime: string;
  guardianResolutionStatus: string;
  identityResolutionStatus: string;
}

// Canonical identity/enrollment work may begin after all required installments
// are finalized, or after a teacher has finalized an explicit seat approval.
// A later scheduled installment remains financial work after that approval.
function promotionPaymentEligibleSql(childIdExpression: string): string {
  return `((EXISTS (SELECT 1 FROM payment_installment
      WHERE payment_installment.registration_draft_child_id = ${childIdExpression}
        AND payment_installment.installment_kind = 'initial' AND payment_installment.status = 'paid')
    AND NOT EXISTS (SELECT 1 FROM payment_installment
      WHERE payment_installment.registration_draft_child_id = ${childIdExpression}
        AND payment_installment.installment_kind = 'later' AND payment_installment.status != 'paid'))
    OR EXISTS (SELECT 1 FROM payment_confirmation
      INNER JOIN payment_allocation ON payment_allocation.received_payment_id = payment_confirmation.received_payment_id
      INNER JOIN payment_installment ON payment_installment.id = payment_allocation.payment_installment_id
      WHERE payment_confirmation.status = 'finalized' AND payment_confirmation.seat_confirmation_approved = 1
        AND payment_installment.registration_draft_child_id = ${childIdExpression}
        AND payment_installment.installment_kind = 'initial'))`;
}

function promotionPaymentEligible(row: PromotionRow): boolean {
  return Boolean(row.partialSeatApproved || (row.initialInstallmentPaid && !row.laterInstallmentOutstanding));
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizedPhone(value: string): string {
  return value.normalize("NFKC").replace(/[^0-9+]/g, "");
}

function integerGrade(value: string): number {
  const grade = Number(value);
  if (!Number.isInteger(grade) || grade < 1 || grade > 12) throw new CanonicalPromotionError("invalid");
  return grade;
}

function audit(
  env: WorkerEnv,
  actor: StaffPrincipal,
  action: string,
  subjectType: string,
  subjectId: string,
  metadata: Record<string, unknown>,
  isTest: number,
  testRunId: string | null,
  now: string,
): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO audit_event (
    id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at
  ) VALUES (?, ?, 'staff', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, action, subjectType, subjectId,
      JSON.stringify(metadata), env.APP_ENV, isTest, testRunId, now);
}

async function rowForChild(database: D1Database, childId: string): Promise<PromotionRow | null> {
  return database.prepare(`SELECT
    registration_draft.id AS draftId, registration_draft.academic_year_id AS academicYearId,
    registration_draft.guardian_full_name AS guardianFullName,
    registration_draft.guardian_relationship AS guardianRelationship,
    registration_draft.primary_phone AS primaryPhone, registration_draft.secondary_phone AS secondaryPhone,
    registration_draft.email, registration_draft.normalized_email AS normalizedEmail,
    registration_draft.facebook_name AS facebookName, registration_draft.home_address AS homeAddress,
    registration_draft.parent_rules_version AS parentRulesVersion,
    registration_draft.student_rules_version AS studentRulesVersion,
    registration_draft.verified_at AS verifiedAt, registration_draft.is_test AS draftIsTest,
    registration_draft.test_run_id AS draftTestRunId,
    registration_draft.canonical_guardian_account_id AS canonicalGuardianId,
    registration_draft.canonical_pre_registration_id AS canonicalPreRegistrationId,
    registration_draft_child.id AS childId, registration_draft_child.position,
    registration_draft_child.surname, registration_draft_child.given_name AS givenName,
    registration_draft_child.gender, registration_draft_child.date_of_birth AS dateOfBirth,
    registration_draft_child.current_grade AS currentGrade,
    registration_draft_child.current_school AS currentSchool,
    registration_draft_child.returning_status AS returningStatus,
    registration_draft_child.previous_stage_code AS previousStageCode,
    registration_draft_child.selected_class_session_id AS selectedClassSessionId,
    registration_draft_child.code_input AS codeInput,
    registration_draft_child.payment_plan_code AS paymentPlanCode,
    registration_draft_child.is_test AS childIsTest, registration_draft_child.test_run_id AS childTestRunId,
    registration_draft_child.canonical_student_id AS canonicalStudentId,
    registration_draft_child.canonical_application_child_id AS canonicalApplicationChildId,
    registration_draft_child.canonical_enrollment_id AS canonicalEnrollmentId,
    registration_draft.status AS draftStatus, registration_draft_child.status AS childStatus,
    enrollment.status AS canonicalEnrollmentStatus,
    EXISTS(SELECT 1 FROM payment_installment WHERE payment_installment.registration_draft_child_id = registration_draft_child.id
      AND payment_installment.installment_kind = 'initial' AND payment_installment.status = 'paid') AS initialInstallmentPaid,
    EXISTS(SELECT 1 FROM payment_installment WHERE payment_installment.registration_draft_child_id = registration_draft_child.id
      AND payment_installment.installment_kind = 'later' AND payment_installment.status != 'paid') AS laterInstallmentOutstanding,
    EXISTS(SELECT 1 FROM payment_confirmation
      INNER JOIN payment_allocation ON payment_allocation.received_payment_id = payment_confirmation.received_payment_id
      INNER JOIN payment_installment AS approved_installment ON approved_installment.id = payment_allocation.payment_installment_id
      WHERE payment_confirmation.status = 'finalized' AND payment_confirmation.seat_confirmation_approved = 1
        AND approved_installment.registration_draft_child_id = registration_draft_child.id
        AND approved_installment.installment_kind = 'initial') AS partialSeatApproved,
    EXISTS(SELECT 1 FROM registration_capacity_hold WHERE registration_capacity_hold.registration_draft_child_id = registration_draft_child.id
      AND registration_capacity_hold.hold_type = 'initial_payment' AND registration_capacity_hold.status = 'active') AS activeInitialHold
    FROM registration_draft_child
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    LEFT JOIN enrollment ON enrollment.id = registration_draft_child.canonical_enrollment_id
    WHERE registration_draft_child.id = ?`).bind(childId).first<PromotionRow>();
}

async function linkedStudents(database: D1Database, guardianId: string, isTest: number): Promise<StudentRow[]> {
  const result = await database.prepare(`SELECT student.id, student.surname, student.given_name AS givenName,
    student.gender, student.date_of_birth AS dateOfBirth
    FROM guardian_student_relationship
    INNER JOIN student ON student.id = guardian_student_relationship.student_id
    WHERE guardian_student_relationship.guardian_id = ?
      AND guardian_student_relationship.status = 'active' AND student.status = 'active'
      AND guardian_student_relationship.is_test = ? AND student.is_test = ?`)
    .bind(guardianId, isTest, isTest).all<StudentRow>();
  return result.results;
}

function exactStudents(rows: StudentRow[], row: PromotionRow): StudentRow[] {
  const surname = normalizedText(row.surname);
  const givenName = normalizedText(row.givenName);
  return rows.filter((student) => student.dateOfBirth === row.dateOfBirth
    && student.gender === row.gender
    && normalizedText(student.surname) === surname
    && normalizedText(student.givenName) === givenName);
}

async function globalExactStudents(database: D1Database, row: PromotionRow): Promise<StudentRow[]> {
  const result = await database.prepare(`SELECT id, surname, given_name AS givenName, gender, date_of_birth AS dateOfBirth
    FROM student WHERE date_of_birth = ? AND gender = ? AND status = 'active' AND is_test = ?`)
    .bind(row.dateOfBirth, row.gender, row.childIsTest).all<StudentRow>();
  return exactStudents(result.results, row);
}

async function resolveGuardian(database: D1Database, row: PromotionRow): Promise<{ guardianId: string } | { needsReview: true }> {
  if (row.canonicalGuardianId) {
    const guardian = await database.prepare("SELECT id, status FROM guardian_account WHERE id = ? AND is_test = ?")
      .bind(row.canonicalGuardianId, row.draftIsTest).first<GuardianRow>();
    return guardian?.status === "active" ? { guardianId: guardian.id } : { needsReview: true };
  }
  // An unverified address is contact information, not identity authority. Keep
  // the paid enrollment on a distinct guardian record until a verified channel
  // can support a later reconciliation flow.
  if (!row.verifiedAt) return { guardianId: `${row.draftId}:unverified-guardian` };
  const guardians = (await database.prepare(`SELECT id, status FROM guardian_account
    WHERE email_normalized = ? AND is_test = ?`).bind(row.normalizedEmail, row.draftIsTest).all<GuardianRow>()).results;
  if (guardians.length === 0) return { guardianId: `guardian:${await sha256(row.normalizedEmail)}` };
  if (guardians.length === 1 && guardians[0].status === "active") return { guardianId: guardians[0].id };
  return { needsReview: true };
}

async function existingGuardian(database: D1Database, guardianId: string, isTest: number): Promise<boolean> {
  return Boolean(await database.prepare("SELECT 1 AS value FROM guardian_account WHERE id = ? AND is_test = ?")
    .bind(guardianId, isTest).first());
}

async function capturedReferral(database: D1Database, childId: string): Promise<DraftReferralRow | null> {
  return database.prepare(`SELECT registration_draft_referral.captured_code AS capturedCode,
    registration_draft_referral.referring_enrollment_id AS referringEnrollmentId,
    enrollment_referral_code.student_id AS referringStudentId,
    pre_registration.guardian_id AS referringGuardianId
    FROM registration_draft_referral
    INNER JOIN enrollment_referral_code ON enrollment_referral_code.id = registration_draft_referral.referral_code_id
    INNER JOIN enrollment ON enrollment.id = registration_draft_referral.referring_enrollment_id
    INNER JOIN application_child ON application_child.id = enrollment.application_child_id
    INNER JOIN pre_registration ON pre_registration.id = application_child.pre_registration_id
    WHERE registration_draft_referral.registration_draft_child_id = ?`).bind(childId).first<DraftReferralRow>();
}

export async function promotePaidDraftChild(
  env: WorkerEnv,
  actor: StaffPrincipal,
  draftChildId: string,
  manual: { kind: "existing"; studentId: string } | { kind: "new" } | null = null,
  nowDate = new Date(),
): Promise<{ state: ResolutionStatus; enrollmentId?: string }> {
  if (!hasStaffCapability(actor, "payment.manage")) throw new CanonicalPromotionError("forbidden");
  const row = await rowForChild(env.DB, draftChildId);
  if (!row) throw new CanonicalPromotionError("not_found");
  if (row.draftStatus === "cancelled" || row.childStatus === "cancelled" || row.canonicalEnrollmentStatus === "cancelled") {
    return { state: "not_eligible" };
  }
  if (row.canonicalEnrollmentId) {
    if (!row.canonicalStudentId) throw new CanonicalPromotionError("conflict");
    await ensureEnrollmentReferralCode(env.DB, row.canonicalEnrollmentId, row.canonicalStudentId,
      { isTest: row.childIsTest, testRunId: row.childTestRunId }, new Date().toISOString());
    const policy = await getDiscountPolicySettingFromDatabase(env.DB);
    if (row.canonicalGuardianId) {
      await awardFamilyDiscountsForGuardian(env, { guardianId: row.canonicalGuardianId, policy });
    }
    await awardReferrerDiscountForReferral(env, { referralId: `${row.childId}:referral`, policy });
    return { state: "promoted", enrollmentId: row.canonicalEnrollmentId };
  }
  const now = nowDate.toISOString();
  if (!promotionPaymentEligible(row) || !row.selectedClassSessionId || !row.activeInitialHold) {
    await env.DB.prepare(`UPDATE registration_draft_child SET identity_resolution_status = 'not_eligible',
      promotion_status = 'not_eligible', updated_at = ? WHERE id = ?`).bind(now, row.childId).run();
    return { state: "not_eligible" };
  }

  const guardian = await resolveGuardian(env.DB, row);
  if ("needsReview" in guardian) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE registration_draft SET guardian_resolution_status = 'needs_review', updated_at = ? WHERE id = ?`)
        .bind(now, row.draftId),
      env.DB.prepare(`UPDATE registration_draft_child SET identity_resolution_status = 'needs_identity_review',
        promotion_status = 'pending', updated_at = ? WHERE id = ?`).bind(now, row.childId),
      audit(env, actor, "canonical_guardian_identity_review_required", "registration_draft", row.draftId,
        {}, row.childIsTest, row.childTestRunId, now),
    ]);
    return { state: "needs_guardian_review" };
  }
  const guardianAlreadyExists = await existingGuardian(env.DB, guardian.guardianId, row.draftIsTest);

  const guardianInsert = () => env.DB.prepare(`INSERT OR IGNORE INTO guardian_account (
    id, full_name, primary_phone, primary_phone_normalized, secondary_phone, secondary_phone_normalized,
    email, email_normalized, facebook_name, home_address, status, is_test, test_run_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
    .bind(guardian.guardianId, row.guardianFullName, row.primaryPhone, normalizedPhone(row.primaryPhone),
      row.secondaryPhone, row.secondaryPhone ? normalizedPhone(row.secondaryPhone) : null,
      row.email, row.normalizedEmail, row.facebookName, row.homeAddress,
      row.draftIsTest, row.draftTestRunId, now, now);

  let studentId = row.canonicalStudentId;
  let resolution = "auto_resolved";
  let createStudent = false;
  let createRelationship = false;
  if (manual?.kind === "existing") {
    const candidates = await globalExactStudents(env.DB, row);
    if (!candidates.some((candidate) => candidate.id === manual.studentId)) throw new CanonicalPromotionError("invalid");
    studentId = manual.studentId;
    resolution = "manual_existing";
    createRelationship = !(await env.DB.prepare(`SELECT 1 AS value FROM guardian_student_relationship
      WHERE guardian_id = ? AND student_id = ? AND status = 'active'`).bind(guardian.guardianId, studentId).first());
  } else if (manual?.kind === "new") {
    studentId = `${row.childId}:student`;
    resolution = "manual_new";
    createStudent = true;
    createRelationship = true;
  } else if (!studentId) {
    const candidates = exactStudents(await linkedStudents(env.DB, guardian.guardianId, row.childIsTest), row);
    if (candidates.length === 1) {
      studentId = candidates[0].id;
    } else {
      // A zero-match returning child is still a legitimate new canonical
      // record. Any strict global match without an existing authorized
      // guardian link is a conflicting identity signal and remains a staff
      // decision.
      const globalCandidates = await globalExactStudents(env.DB, row);
      if (candidates.length === 0 && globalCandidates.length === 0) {
        studentId = `${row.childId}:student`;
        createStudent = true;
        createRelationship = true;
      } else {
        const statements = [
          env.DB.prepare(`UPDATE registration_draft SET canonical_guardian_account_id = ?, guardian_resolution_status = 'resolved', updated_at = ?
            WHERE id = ? AND canonical_guardian_account_id IS NULL`).bind(guardian.guardianId, now, row.draftId),
          env.DB.prepare(`UPDATE registration_draft_child SET identity_resolution_status = 'needs_identity_review',
            promotion_status = 'pending', updated_at = ? WHERE id = ?`).bind(now, row.childId),
          audit(env, actor, "canonical_student_identity_review_required", "registration_draft_child", row.childId,
            { returningStatus: row.returningStatus, candidateCount: Math.max(candidates.length, globalCandidates.length) }, row.childIsTest, row.childTestRunId, now),
        ];
        if (!guardianAlreadyExists) statements.unshift(guardianInsert());
        await env.DB.batch(statements);
        return { state: "needs_identity_review" };
      }
    }
  }
  if (!studentId) return { state: "failed" };

  const preRegistrationId = row.canonicalPreRegistrationId || `${row.draftId}:pre-registration`;
  const applicationChildId = row.canonicalApplicationChildId || `${row.childId}:application`;
  const enrollmentId = `${row.childId}:enrollment`;
  const grade = integerGrade(row.currentGrade);
  const referral = await capturedReferral(env.DB, row.childId);
  const sameFamilyReferral = Boolean(referral && (referral.referringStudentId === studentId || referral.referringGuardianId === guardian.guardianId));
  const statements: D1PreparedStatement[] = [];
  if (!guardianAlreadyExists) {
    statements.push(guardianInsert());
  }
  statements.push(
    env.DB.prepare(`UPDATE registration_draft SET canonical_guardian_account_id = ?, guardian_resolution_status = 'resolved', updated_at = ?
      WHERE id = ? AND (canonical_guardian_account_id IS NULL OR canonical_guardian_account_id = ?)`)
      .bind(guardian.guardianId, now, row.draftId, guardian.guardianId),
    env.DB.prepare(`INSERT OR IGNORE INTO pre_registration (
      id, guardian_id, academic_year_id, status, submitted_at, parent_rules_version, student_rules_version,
      is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(preRegistrationId, guardian.guardianId, row.academicYearId, row.verifiedAt ?? now,
        row.parentRulesVersion, row.studentRulesVersion, row.draftIsTest, row.draftTestRunId, now, now),
    env.DB.prepare(`UPDATE registration_draft SET canonical_pre_registration_id = ?, updated_at = ?
      WHERE id = ? AND (canonical_pre_registration_id IS NULL OR canonical_pre_registration_id = ?)`)
      .bind(preRegistrationId, now, row.draftId, preRegistrationId),
  );
  if (createStudent) {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO student (
      id, surname, given_name, gender, date_of_birth, status, is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
      .bind(studentId, row.surname, row.givenName, row.gender, row.dateOfBirth,
        row.childIsTest, row.childTestRunId, now, now));
  }
  if (createRelationship) {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO guardian_student_relationship (
      id, guardian_id, student_id, relationship_label, is_authorized_to_register, status,
      is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, 'active', ?, ?, ?, ?)`)
      .bind(`${guardian.guardianId}:relationship:${row.childId}`, guardian.guardianId, studentId,
        row.guardianRelationship, row.childIsTest, row.childTestRunId, now, now));
  }
  statements.push(
    env.DB.prepare(`INSERT OR IGNORE INTO application_child (
      id, pre_registration_id, student_id, current_school, current_grade, returning_status,
      previous_stage_code, code_input, selected_payment_plan_code, selected_class_session_id,
      status, is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'enrolled', ?, ?, ?, ?)`)
      .bind(applicationChildId, preRegistrationId, studentId, row.currentSchool, grade, row.returningStatus,
        row.previousStageCode === "unknown" ? null : row.previousStageCode, row.codeInput, row.paymentPlanCode,
        row.selectedClassSessionId, row.childIsTest, row.childTestRunId, now, now),
    env.DB.prepare(`INSERT OR IGNORE INTO enrollment (
      id, application_child_id, student_id, academic_year_id, class_session_id, status, confirmed_at,
      is_test, test_run_id, created_at, updated_at
    ) SELECT ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM registration_capacity_hold
        WHERE registration_draft_child_id = ? AND hold_type = 'initial_payment' AND status = 'active')`)
      .bind(enrollmentId, applicationChildId, studentId, row.academicYearId, row.selectedClassSessionId, now,
        row.childIsTest, row.childTestRunId, now, now, row.childId),
    env.DB.prepare(`UPDATE registration_capacity_hold SET status = 'released', converted_at = ?, release_reason = 'promoted_to_enrollment', updated_at = ?
      WHERE registration_draft_child_id = ? AND hold_type = 'initial_payment' AND status = 'active'
        AND EXISTS (SELECT 1 FROM enrollment WHERE id = ? AND status = 'confirmed')`)
      .bind(now, now, row.childId, enrollmentId),
    env.DB.prepare(`UPDATE registration_draft_child SET canonical_student_id = ?, canonical_application_child_id = ?,
      canonical_enrollment_id = ?, identity_resolution_status = 'promoted', promotion_status = 'promoted', updated_at = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM enrollment WHERE id = ? AND status = 'confirmed')`)
      .bind(studentId, applicationChildId, enrollmentId, now, row.childId, enrollmentId),
    env.DB.prepare(`UPDATE payment_installment SET canonical_application_child_id = ?, canonical_enrollment_id = ?, updated_at = ?
      WHERE registration_draft_child_id = ?`).bind(applicationChildId, enrollmentId, now, row.childId),
    env.DB.prepare(`UPDATE registration_draft_waitlist_entry SET canonical_application_child_id = ?, updated_at = ?
      WHERE registration_draft_child_id = ?`).bind(applicationChildId, now, row.childId),
    audit(env, actor, "canonical_enrollment_promoted", "registration_draft_child", row.childId,
      { guardianId: guardian.guardianId, studentId, enrollmentId, identityResolution: resolution },
      row.childIsTest, row.childTestRunId, now),
  );
  if (referral) {
    statements.push(
      env.DB.prepare(`INSERT OR IGNORE INTO referral (
        id, referral_code, referring_enrollment_id, referring_student_id, referred_application_child_id,
        status, qualification_reason, qualified_at, is_test, test_run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(`${row.childId}:referral`, referral.capturedCode, referral.referringEnrollmentId, referral.referringStudentId,
          applicationChildId, sameFamilyReferral ? "disqualified" : "qualified", sameFamilyReferral ? "same_family" : "referred_child_confirmed",
          sameFamilyReferral ? null : now,
          row.childIsTest, row.childTestRunId, now, now),
      env.DB.prepare(`UPDATE registration_draft_referral SET status = ?, disqualification_reason = ?, updated_at = ?
        WHERE registration_draft_child_id = ?`).bind(sameFamilyReferral ? "disqualified" : "promoted",
        sameFamilyReferral ? "same_family" : null, now, row.childId),
    );
  }
  await env.DB.batch(statements);
  const promoted = await env.DB.prepare(`SELECT canonical_enrollment_id AS enrollmentId FROM registration_draft_child
    WHERE id = ? AND promotion_status = 'promoted'`).bind(row.childId).first<{ enrollmentId: string }>();
  if (!promoted?.enrollmentId) {
    throw new CanonicalPromotionError("conflict");
  }
  await ensureEnrollmentReferralCode(env.DB, promoted.enrollmentId, studentId,
    { isTest: row.childIsTest, testRunId: row.childTestRunId }, now);
  await env.DB.prepare(`UPDATE discount_award SET beneficiary_enrollment_id = ?, updated_at = ?
    WHERE registration_draft_child_id = ? AND beneficiary_enrollment_id IS NULL`).bind(promoted.enrollmentId, now, row.childId).run();
  const discountPolicy = await getDiscountPolicySettingFromDatabase(env.DB);
  await awardFamilyDiscountsForGuardian(env, { guardianId: guardian.guardianId, policy: discountPolicy, now });
  if (referral && sameFamilyReferral) {
    await reverseReferralAwardForSameFamily(env, row.childId, now);
  } else if (referral) {
    await awardReferrerDiscountForReferral(env, { referralId: `${row.childId}:referral`, policy: discountPolicy, now });
  }
  // The promotion service is the single place where a newly confirmed
  // enrollment becomes eligible for its one idempotent parent-access email.
  // Delivery is advisory and must never undo the durable enrollment.
  try {
    await sendEnrollmentConfirmationEmail(env, row.draftId);
  } catch {
    // The outbox retains delivery failure for a teacher's explicit resend.
  }
  return { state: "promoted", enrollmentId: promoted.enrollmentId };
}

export async function promotePaidDraftChildren(env: WorkerEnv, actor: StaffPrincipal, registrationDraftId: string, nowDate = new Date()) {
  const result = await env.DB.prepare(`SELECT registration_draft_child.id
    FROM registration_draft_child
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    WHERE registration_draft_child.registration_draft_id = ?
      AND registration_draft_child.selected_class_session_id IS NOT NULL
      AND registration_draft_child.canonical_enrollment_id IS NULL
      AND registration_draft.status != 'cancelled'
      AND registration_draft_child.status != 'cancelled'
      AND ${promotionPaymentEligibleSql("registration_draft_child.id")}`)
    .bind(registrationDraftId).all<{ id: string }>();
  const outcomes = [];
  for (const child of result.results) outcomes.push(await promotePaidDraftChild(env, actor, child.id, null, nowDate));
  return outcomes;
}

export async function resolvePromotionIdentity(
  env: WorkerEnv,
  actor: StaffPrincipal,
  draftChildId: string,
  choice: { kind: "existing"; studentId: string } | { kind: "new" },
  nowDate = new Date(),
) {
  return promotePaidDraftChild(env, actor, draftChildId, choice, nowDate);
}

export async function getPromotionReviewQueue(env: WorkerEnv, actor: StaffPrincipal) {
  if (!hasStaffCapability(actor, "payment.view")) throw new CanonicalPromotionError("forbidden");
  const result = await env.DB.prepare(`SELECT registration_draft_child.id AS childId,
    registration_draft_child.surname || ' ' || registration_draft_child.given_name AS childName,
    registration_draft_child.date_of_birth AS dateOfBirth, registration_draft_child.gender,
    registration_draft_child.returning_status AS returningStatus, class_session.display_label AS classLabel,
    class_session.weekday, class_session.start_time AS startTime, class_session.end_time AS endTime,
    registration_draft.guardian_resolution_status AS guardianResolutionStatus,
    registration_draft_child.identity_resolution_status AS identityResolutionStatus
    FROM registration_draft_child
    INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    INNER JOIN class_session ON class_session.id = registration_draft_child.selected_class_session_id
    WHERE registration_draft_child.canonical_enrollment_id IS NULL
      AND registration_draft_child.selected_class_session_id IS NOT NULL
      AND registration_draft.status != 'cancelled'
      AND registration_draft_child.status != 'cancelled'
      AND ${promotionPaymentEligibleSql("registration_draft_child.id")}
    ORDER BY registration_draft_child.updated_at ASC`).all<ReviewRow>();
  const items = [];
  for (const item of result.results) {
    const row = await rowForChild(env.DB, item.childId);
    const candidates = row && item.guardianResolutionStatus === "resolved"
      ? await globalExactStudents(env.DB, row)
      : [];
    items.push({ ...item, candidates: candidates.map((candidate) => ({ id: candidate.id,
      name: `${candidate.surname} ${candidate.givenName}`, dateOfBirth: candidate.dateOfBirth })) });
  }
  return { items };
}
