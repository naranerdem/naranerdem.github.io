import type { D1PreparedStatement, WorkerEnv } from "../env";
import { normalizeEmail, validEmail } from "../auth/email-address";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

export class RegistrationCorrectionError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "invalid" | "needs_review" | "conflict" | "protected") { super("Registration correction failed."); }
}

function clean(value: unknown, max: number, required = false): string | null {
  const result = typeof value === "string" ? value.normalize("NFKC").trim().slice(0, max) : "";
  return result || (required ? null : null);
}
function validDate(value: string | null): value is string { return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))); }
function changed(before: Record<string, unknown>, after: Record<string, unknown>) { return Object.keys(after).filter((field) => String(before[field] ?? "") !== String(after[field] ?? "")); }

type Detail = Record<string, unknown> & { draftId: string; childId: string; draftUpdatedAt: string; childUpdatedAt: string; isTest: number; testRunId: string | null };

export async function registrationCorrectionDetail(env: WorkerEnv, actor: StaffPrincipal, childId: string): Promise<Detail> {
  if (!hasStaffCapability(actor, "registration.manage")) throw new RegistrationCorrectionError("forbidden");
  const row = await env.DB.prepare(`SELECT registration_draft.id AS draftId, registration_draft.guardian_full_name AS guardianName,
    registration_draft.primary_phone AS primaryPhone, registration_draft.secondary_phone AS secondaryPhone,
    registration_draft.email, registration_draft.facebook_name AS facebookName, registration_draft.home_address AS homeAddress,
    registration_draft.verified_at AS verifiedAt, registration_draft.canonical_guardian_account_id AS canonicalGuardianId,
    registration_draft.updated_at AS draftUpdatedAt, registration_draft.is_test AS isTest, registration_draft.test_run_id AS testRunId,
    registration_draft_child.id AS childId, registration_draft_child.surname, registration_draft_child.given_name AS givenName,
    registration_draft_child.gender, registration_draft_child.date_of_birth AS dateOfBirth,
    registration_draft_child.current_grade AS currentGrade, registration_draft_child.current_school AS currentSchool,
    registration_draft_child.facebook_name AS childFacebookName, registration_draft_child.previous_stage_code AS previousStageCode,
    registration_draft_child.updated_at AS childUpdatedAt, registration_draft_child.canonical_student_id AS canonicalStudentId,
    registration_draft_child.canonical_application_child_id AS canonicalApplicationChildId,
    registration_draft_child.canonical_enrollment_id AS canonicalEnrollmentId
    FROM registration_draft_child INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    WHERE registration_draft_child.id = ?`).bind(childId).first<Detail>();
  if (!row) throw new RegistrationCorrectionError("not_found");
  const shared = row.canonicalStudentId ? await env.DB.prepare(`SELECT COUNT(*) AS count FROM application_child WHERE student_id = ? AND id != COALESCE(?, '')`)
    .bind(row.canonicalStudentId, row.canonicalApplicationChildId).first<{ count: number }>() : null;
  return { ...row, guardianFieldsEditable: !row.verifiedAt && !row.canonicalGuardianId, childIdentityEditable: !row.canonicalStudentId || Number(shared?.count || 0) === 0, childProfileEditable: true } as Detail;
}

export async function saveRegistrationCorrection(env: WorkerEnv, actor: StaffPrincipal, childId: string, input: Record<string, unknown>) {
  const current = await registrationCorrectionDetail(env, actor, childId);
  const reason = clean(input.reason, 300, true);
  if (!reason || input.expectedDraftUpdatedAt !== current.draftUpdatedAt || input.expectedChildUpdatedAt !== current.childUpdatedAt) throw new RegistrationCorrectionError("conflict");
  const guardianBefore = { guardianName: current.guardianName, primaryPhone: current.primaryPhone, secondaryPhone: current.secondaryPhone, email: current.email, facebookName: current.facebookName, homeAddress: current.homeAddress };
  const childBefore = { surname: current.surname, givenName: current.givenName, gender: current.gender, dateOfBirth: current.dateOfBirth, currentGrade: current.currentGrade, currentSchool: current.currentSchool, childFacebookName: current.childFacebookName, previousStageCode: current.previousStageCode };
  const guardianNext = { guardianName: clean(input.guardianName ?? current.guardianName, 160, true), primaryPhone: clean(input.primaryPhone ?? current.primaryPhone, 40, true), secondaryPhone: clean(input.secondaryPhone ?? current.secondaryPhone, 40), email: clean(input.email ?? current.email, 254, true), facebookName: clean(input.facebookName ?? current.facebookName, 160), homeAddress: clean(input.homeAddress ?? current.homeAddress, 500, true) };
  const previousStageCode = input.previousStageCode === undefined ? current.previousStageCode : clean(input.previousStageCode, 20);
  const childNext = { surname: clean(input.surname ?? current.surname, 100, true), givenName: clean(input.givenName ?? current.givenName, 100, true), gender: input.gender ?? current.gender, dateOfBirth: clean(input.dateOfBirth ?? current.dateOfBirth, 10, true), currentGrade: clean(input.currentGrade ?? current.currentGrade, 20, true), currentSchool: clean(input.currentSchool ?? current.currentSchool, 160), childFacebookName: clean(input.childFacebookName ?? current.childFacebookName, 160), previousStageCode };
  if (!guardianNext.guardianName || !guardianNext.primaryPhone || !guardianNext.email || !guardianNext.homeAddress || !childNext.surname || !childNext.givenName || !childNext.currentGrade || !validEmail(normalizeEmail(guardianNext.email)) || !validDate(childNext.dateOfBirth) || !["female", "male", "not_specified"].includes(String(childNext.gender)) || !["stage_1", "stage_2", "stage_3", "unknown", null].includes(childNext.previousStageCode as string | null)) throw new RegistrationCorrectionError("invalid");
  const guardianFields = changed(guardianBefore, guardianNext as Record<string, unknown>); const childFields = changed(childBefore, childNext as Record<string, unknown>);
  if (guardianFields.length && !current.guardianFieldsEditable) throw new RegistrationCorrectionError("protected");
  if (childFields.some((field) => ["surname", "givenName", "gender", "dateOfBirth"].includes(field)) && !current.childIdentityEditable) throw new RegistrationCorrectionError("protected");
  const fields = [...guardianFields, ...childFields];
  if (!fields.length) return { ...current, unchanged: true };
  const now = new Date().toISOString(); const draftChanged = guardianFields.length > 0; const childChanged = childFields.length > 0;
  const statements: D1PreparedStatement[] = [];
  if (draftChanged) statements.push(env.DB.prepare(`UPDATE registration_draft SET guardian_full_name = ?, primary_phone = ?, secondary_phone = ?, email = ?, normalized_email = ?, facebook_name = ?, home_address = ?, updated_at = ? WHERE id = ? AND updated_at = ? AND EXISTS (SELECT 1 FROM registration_draft_child WHERE id = ? AND updated_at = ?)`)
    .bind(guardianNext.guardianName, guardianNext.primaryPhone, guardianNext.secondaryPhone, guardianNext.email, normalizeEmail(guardianNext.email), guardianNext.facebookName, guardianNext.homeAddress, now, current.draftId, current.draftUpdatedAt, childId, current.childUpdatedAt));
  if (childChanged) statements.push(env.DB.prepare(`UPDATE registration_draft_child SET surname = ?, given_name = ?, gender = ?, date_of_birth = ?, current_grade = ?, current_school = ?, facebook_name = ?, previous_stage_code = ?, updated_at = ? WHERE id = ? AND updated_at = ? AND EXISTS (SELECT 1 FROM registration_draft WHERE id = ? AND updated_at = ?)`)
    .bind(childNext.surname, childNext.givenName, childNext.gender, childNext.dateOfBirth, childNext.currentGrade, childNext.currentSchool, childNext.childFacebookName, childNext.previousStageCode, now, childId, current.childUpdatedAt, current.draftId, draftChanged ? now : current.draftUpdatedAt));
  const before = { ...guardianBefore, ...childBefore }; const after = { ...guardianNext, ...childNext };
  const gate = `EXISTS (SELECT 1 FROM registration_draft WHERE id = ? AND updated_at = ?) AND EXISTS (SELECT 1 FROM registration_draft_child WHERE id = ? AND updated_at = ?)`;
  const expectedDraftAfter = draftChanged ? now : current.draftUpdatedAt; const expectedChildAfter = childChanged ? now : current.childUpdatedAt;
  statements.push(env.DB.prepare(`INSERT INTO registration_data_correction (id, registration_draft_id, registration_draft_child_id, corrected_by_staff_account_id, before_json, after_json, created_at, is_test, test_run_id) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${gate}`)
    .bind(crypto.randomUUID(), current.draftId, childId, actor.staffAccountId, JSON.stringify(before), JSON.stringify(after), now, current.isTest, current.testRunId, current.draftId, expectedDraftAfter, childId, expectedChildAfter));
  statements.push(env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id, metadata_json, environment, is_test, test_run_id, created_at) SELECT ?, ?, 'staff', ?, 'registration_data_corrected', 'registration_draft_child', ?, ?, ?, ?, ?, ? WHERE ${gate}`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, childId, JSON.stringify({ registrationDraftId: current.draftId, canonicalEnrollmentId: current.canonicalEnrollmentId ?? null, reason, changes: fields.map((field) => ({ field, before: before[field as keyof typeof before] ?? null, after: after[field as keyof typeof after] ?? null })) }), env.APP_ENV, current.isTest, current.testRunId, now, current.draftId, expectedDraftAfter, childId, expectedChildAfter));
  if (childChanged && current.canonicalApplicationChildId) statements.push(env.DB.prepare(`UPDATE application_child SET current_school = ?, current_grade = ?, previous_stage_code = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM registration_draft_child WHERE id = ? AND updated_at = ?)`)
    .bind(childNext.currentSchool, childNext.currentGrade, childNext.previousStageCode, now, current.canonicalApplicationChildId, childId, expectedChildAfter));
  if (childChanged && current.canonicalStudentId && childFields.some((field) => ["surname", "givenName", "gender", "dateOfBirth"].includes(field))) statements.push(env.DB.prepare(`UPDATE student SET surname = ?, given_name = ?, gender = ?, date_of_birth = ?, updated_at = ? WHERE id = ?`)
    .bind(childNext.surname, childNext.givenName, childNext.gender, childNext.dateOfBirth, now, current.canonicalStudentId));
  if (guardianFields.includes("email")) statements.push(env.DB.prepare(`UPDATE email_verification_challenge SET status = 'invalidated', invalidated_at = ?, updated_at = ? WHERE registration_draft_id = ? AND status = 'pending'`).bind(now, now, current.draftId));
  const results = await env.DB.batch(statements);
  const changedStatements = Number(draftChanged) + Number(childChanged);
  if (results.slice(0, changedStatements).some((result) => (result.meta?.changes ?? 0) !== 1) || (results[changedStatements].meta?.changes ?? 0) !== 1) throw new RegistrationCorrectionError("conflict");
  return registrationCorrectionDetail(env, actor, childId);
}
