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
function normalizedPhone(value: string) { return value.normalize("NFKC").replace(/[^0-9+]/g, ""); }
function validDate(value: string | null): value is string { return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))); }
function changed(before: Record<string, unknown>, after: Record<string, unknown>) { return Object.keys(after).filter((field) => String(before[field] ?? "") !== String(after[field] ?? "")); }

type Detail = Record<string, unknown> & {
  draftId: string; childId: string; draftUpdatedAt: string; childUpdatedAt: string;
  canonicalGuardianId: string | null; canonicalGuardianUpdatedAt: string | null;
  isTest: number; testRunId: string | null;
};

function guardianValues(row: Detail) {
  return { guardianName: row.guardianName, primaryPhone: row.primaryPhone, secondaryPhone: row.secondaryPhone, email: row.email, facebookName: row.facebookName, homeAddress: row.homeAddress };
}
function childValues(row: Detail) {
  return { surname: row.surname, givenName: row.givenName, gender: row.gender, dateOfBirth: row.dateOfBirth, currentGrade: row.currentGrade, currentSchool: row.currentSchool, childFacebookName: row.childFacebookName, previousStageCode: row.previousStageCode };
}
function correctionStatements(env: WorkerEnv, actor: StaffPrincipal, current: Detail, before: Record<string, unknown>, after: Record<string, unknown>, fields: string[], reason: string, action: string, now: string): D1PreparedStatement[] {
  const metadata = { registrationDraftId: current.draftId, canonicalEnrollmentId: current.canonicalEnrollmentId ?? null, reason, changes: fields.map((field) => ({ field, before: before[field] ?? null, after: after[field] ?? null })) };
  return [
    env.DB.prepare(`INSERT INTO registration_data_correction (id, registration_draft_id, registration_draft_child_id, corrected_by_staff_account_id, before_json, after_json, created_at, is_test, test_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), current.draftId, current.childId, actor.staffAccountId, JSON.stringify(before), JSON.stringify(after), now, current.isTest, current.testRunId),
    env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id, metadata_json, environment, is_test, test_run_id, created_at) VALUES (?, ?, 'staff', ?, ?, 'registration_draft_child', ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), now, actor.staffAccountId, action, current.childId, JSON.stringify(metadata), env.APP_ENV, current.isTest, current.testRunId, now),
  ];
}

export async function registrationCorrectionDetail(env: WorkerEnv, actor: StaffPrincipal, childId: string): Promise<Detail> {
  if (!hasStaffCapability(actor, "registration.manage")) throw new RegistrationCorrectionError("forbidden");
  const row = await env.DB.prepare(`SELECT registration_draft.id AS draftId,
    COALESCE(guardian_account.full_name, registration_draft.guardian_full_name) AS guardianName,
    COALESCE(guardian_account.primary_phone, registration_draft.primary_phone) AS primaryPhone,
    COALESCE(guardian_account.secondary_phone, registration_draft.secondary_phone) AS secondaryPhone,
    COALESCE(guardian_account.email, registration_draft.email) AS email,
    COALESCE(guardian_account.facebook_name, registration_draft.facebook_name) AS facebookName,
    COALESCE(guardian_account.home_address, registration_draft.home_address) AS homeAddress,
    registration_draft.verified_at AS verifiedAt, registration_draft.canonical_guardian_account_id AS canonicalGuardianId,
    guardian_account.updated_at AS canonicalGuardianUpdatedAt,
    registration_draft.updated_at AS draftUpdatedAt, registration_draft.is_test AS isTest, registration_draft.test_run_id AS testRunId,
    registration_draft_child.id AS childId, registration_draft_child.surname, registration_draft_child.given_name AS givenName,
    registration_draft_child.gender, registration_draft_child.date_of_birth AS dateOfBirth,
    registration_draft_child.current_grade AS currentGrade, registration_draft_child.current_school AS currentSchool,
    registration_draft_child.facebook_name AS childFacebookName, registration_draft_child.previous_stage_code AS previousStageCode,
    registration_draft_child.updated_at AS childUpdatedAt, registration_draft_child.canonical_student_id AS canonicalStudentId,
    registration_draft_child.canonical_application_child_id AS canonicalApplicationChildId,
    registration_draft_child.canonical_enrollment_id AS canonicalEnrollmentId
    FROM registration_draft_child INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    LEFT JOIN guardian_account ON guardian_account.id = registration_draft.canonical_guardian_account_id
    WHERE registration_draft_child.id = ?`).bind(childId).first<Detail>();
  if (!row) throw new RegistrationCorrectionError("not_found");
  const sharedStudent = row.canonicalStudentId ? await env.DB.prepare(`SELECT COUNT(*) AS count FROM application_child WHERE student_id = ? AND id != COALESCE(?, '')`).bind(row.canonicalStudentId, row.canonicalApplicationChildId).first<{ count: number }>() : null;
  const scope = row.canonicalGuardianId ? "registration_draft.canonical_guardian_account_id = ?" : "registration_draft.id = ?";
  const scopeValue = row.canonicalGuardianId || row.draftId;
  const impact = await env.DB.prepare(`SELECT COUNT(DISTINCT registration_draft.id) AS registrations, COUNT(DISTINCT registration_draft_child.id) AS children,
    MAX(CASE WHEN registration_draft.verified_at IS NOT NULL THEN 1 ELSE 0 END) AS hasVerifiedEmail,
    EXISTS(SELECT 1 FROM verified_email_session INNER JOIN registration_draft AS session_draft ON session_draft.id = verified_email_session.registration_draft_id
      WHERE verified_email_session.revoked_at IS NULL AND verified_email_session.expires_at > ? AND ${row.canonicalGuardianId ? "session_draft.canonical_guardian_account_id = ?" : "session_draft.id = ?"}) AS hasAccessSession
    FROM registration_draft LEFT JOIN registration_draft_child ON registration_draft_child.registration_draft_id = registration_draft.id WHERE ${scope}`)
    .bind(new Date().toISOString(), scopeValue, scopeValue).first<{ registrations: number; children: number; hasVerifiedEmail: number; hasAccessSession: number }>();
  const emailProtected = Boolean(row.verifiedAt) || Boolean(impact?.hasVerifiedEmail) || Boolean(impact?.hasAccessSession);
  return { ...row, guardianProfileEditable: true, guardianEmailEditable: !emailProtected, emailProtected,
    guardianAffectedRegistrationCount: Number(impact?.registrations || 1), guardianAffectedChildCount: Number(impact?.children || 1),
    childIdentityEditable: !row.canonicalStudentId || Number(sharedStudent?.count || 0) === 0, childProfileEditable: true } as Detail;
}

function validate(input: Record<string, unknown>, current: Detail) {
  const guardianNext = { guardianName: clean(input.guardianName ?? current.guardianName, 160, true), primaryPhone: clean(input.primaryPhone ?? current.primaryPhone, 40, true), secondaryPhone: clean(input.secondaryPhone ?? current.secondaryPhone, 40), email: clean(input.email ?? current.email, 254, true), facebookName: clean(input.facebookName ?? current.facebookName, 160), homeAddress: clean(input.homeAddress ?? current.homeAddress, 500, true) };
  const previousStageCode = input.previousStageCode === undefined ? current.previousStageCode : clean(input.previousStageCode, 20);
  const childNext = { surname: clean(input.surname ?? current.surname, 100, true), givenName: clean(input.givenName ?? current.givenName, 100, true), gender: input.gender ?? current.gender, dateOfBirth: clean(input.dateOfBirth ?? current.dateOfBirth, 10, true), currentGrade: clean(input.currentGrade ?? current.currentGrade, 20, true), currentSchool: clean(input.currentSchool ?? current.currentSchool, 160), childFacebookName: clean(input.childFacebookName ?? current.childFacebookName, 160), previousStageCode };
  if (!guardianNext.guardianName || !guardianNext.primaryPhone || !guardianNext.email || !guardianNext.homeAddress || !childNext.surname || !childNext.givenName || !childNext.currentGrade || !validEmail(normalizeEmail(guardianNext.email)) || !validDate(childNext.dateOfBirth) || !["female", "male", "not_specified"].includes(String(childNext.gender)) || !["stage_1", "stage_2", "stage_3", "unknown", null].includes(childNext.previousStageCode as string | null)) throw new RegistrationCorrectionError("invalid");
  return { guardianNext, childNext };
}

export async function saveRegistrationCorrection(env: WorkerEnv, actor: StaffPrincipal, childId: string, input: Record<string, unknown>) {
  const current = await registrationCorrectionDetail(env, actor, childId); const reason = clean(input.reason, 300, true);
  if (!reason || input.expectedDraftUpdatedAt !== current.draftUpdatedAt || input.expectedChildUpdatedAt !== current.childUpdatedAt || (current.canonicalGuardianId && input.expectedGuardianUpdatedAt !== current.canonicalGuardianUpdatedAt)) throw new RegistrationCorrectionError("conflict");
  const guardianBefore = guardianValues(current); const childBefore = childValues(current); const validated = validate(input, current);
  const guardianNext = validated.guardianNext as { guardianName: string; primaryPhone: string; secondaryPhone: string | null; email: string; facebookName: string | null; homeAddress: string };
  const childNext = validated.childNext;
  const guardianFields = changed(guardianBefore, guardianNext as Record<string, unknown>); const childFields = changed(childBefore, childNext as Record<string, unknown>);
  if (guardianFields.includes("email") && !current.guardianEmailEditable) throw new RegistrationCorrectionError("protected");
  if (childFields.some((field) => ["surname", "givenName", "gender", "dateOfBirth"].includes(field)) && !current.childIdentityEditable) throw new RegistrationCorrectionError("protected");
  const fields = [...guardianFields, ...childFields]; if (!fields.length) return { ...current, unchanged: true };
  const now = new Date().toISOString(); const statements: D1PreparedStatement[] = []; const guarded: number[] = [];
  if (guardianFields.length) {
    if (current.canonicalGuardianId) {
      guarded.push(statements.length); statements.push(env.DB.prepare(`UPDATE guardian_account SET full_name = ?, primary_phone = ?, primary_phone_normalized = ?, secondary_phone = ?, secondary_phone_normalized = ?, email = ?, email_normalized = ?, facebook_name = ?, home_address = ?, updated_at = ? WHERE id = ? AND updated_at = ?`)
        .bind(guardianNext.guardianName, guardianNext.primaryPhone, normalizedPhone(guardianNext.primaryPhone), guardianNext.secondaryPhone, guardianNext.secondaryPhone ? normalizedPhone(guardianNext.secondaryPhone) : null, guardianNext.email, normalizeEmail(guardianNext.email), guardianNext.facebookName, guardianNext.homeAddress, now, current.canonicalGuardianId, current.canonicalGuardianUpdatedAt));
      statements.push(env.DB.prepare(`UPDATE registration_draft SET guardian_full_name = ?, primary_phone = ?, secondary_phone = ?, email = ?, normalized_email = ?, facebook_name = ?, home_address = ?, verified_at = CASE WHEN ? THEN NULL ELSE verified_at END, updated_at = ? WHERE canonical_guardian_account_id = ?`)
        .bind(guardianNext.guardianName, guardianNext.primaryPhone, guardianNext.secondaryPhone, guardianNext.email, normalizeEmail(guardianNext.email), guardianNext.facebookName, guardianNext.homeAddress, guardianFields.includes("email") ? 1 : 0, now, current.canonicalGuardianId));
    } else {
      guarded.push(statements.length); statements.push(env.DB.prepare(`UPDATE registration_draft SET guardian_full_name = ?, primary_phone = ?, secondary_phone = ?, email = ?, normalized_email = ?, facebook_name = ?, home_address = ?, updated_at = ? WHERE id = ? AND updated_at = ? AND EXISTS (SELECT 1 FROM registration_draft_child WHERE id = ? AND updated_at = ?)`)
        .bind(guardianNext.guardianName, guardianNext.primaryPhone, guardianNext.secondaryPhone, guardianNext.email, normalizeEmail(guardianNext.email), guardianNext.facebookName, guardianNext.homeAddress, now, current.draftId, current.draftUpdatedAt, current.childId, current.childUpdatedAt));
    }
  }
  const draftExpected = guardianFields.length ? now : current.draftUpdatedAt;
  if (childFields.length) { guarded.push(statements.length); statements.push(env.DB.prepare(`UPDATE registration_draft_child SET surname = ?, given_name = ?, gender = ?, date_of_birth = ?, current_grade = ?, current_school = ?, facebook_name = ?, previous_stage_code = ?, updated_at = ? WHERE id = ? AND updated_at = ? AND EXISTS (SELECT 1 FROM registration_draft WHERE id = ? AND updated_at = ?)`)
    .bind(childNext.surname, childNext.givenName, childNext.gender, childNext.dateOfBirth, childNext.currentGrade, childNext.currentSchool, childNext.childFacebookName, childNext.previousStageCode, now, current.childId, current.childUpdatedAt, current.draftId, draftExpected)); }
  if (guardianFields.includes("email")) { const linkedDrafts = current.canonicalGuardianId ? "registration_draft_id IN (SELECT id FROM registration_draft WHERE canonical_guardian_account_id = ?)" : "registration_draft_id = ?"; statements.push(env.DB.prepare(`UPDATE email_verification_challenge SET status = 'invalidated', invalidated_at = ?, updated_at = ? WHERE ${linkedDrafts} AND status = 'pending'`).bind(now, now, current.canonicalGuardianId || current.draftId)); }
  if (childFields.length && current.canonicalApplicationChildId) statements.push(env.DB.prepare(`UPDATE application_child SET current_school = ?, current_grade = ?, previous_stage_code = ?, updated_at = ? WHERE id = ?`).bind(childNext.currentSchool, childNext.currentGrade, childNext.previousStageCode, now, current.canonicalApplicationChildId));
  if (childFields.some((field) => ["surname", "givenName", "gender", "dateOfBirth"].includes(field)) && current.canonicalStudentId) statements.push(env.DB.prepare(`UPDATE student SET surname = ?, given_name = ?, gender = ?, date_of_birth = ?, updated_at = ? WHERE id = ?`).bind(childNext.surname, childNext.givenName, childNext.gender, childNext.dateOfBirth, now, current.canonicalStudentId));
  const before = { ...guardianBefore, ...childBefore }; const after = { ...guardianNext, ...childNext }; statements.push(...correctionStatements(env, actor, current, before, after, fields, reason, "registration_data_corrected", now));
  const results = await env.DB.batch(statements); if (guarded.some((index) => (results[index].meta?.changes ?? 0) !== 1)) throw new RegistrationCorrectionError("conflict");
  return registrationCorrectionDetail(env, actor, childId);
}

export async function replaceRegistrationEmail(env: WorkerEnv, actor: StaffPrincipal, childId: string, input: Record<string, unknown>) {
  const current = await registrationCorrectionDetail(env, actor, childId); const reason = clean(input.reason, 300, true); const nextEmail = clean(input.email, 254, true);
  if (!reason || input.confirmed !== true || !nextEmail || !validEmail(normalizeEmail(nextEmail)) || input.expectedDraftUpdatedAt !== current.draftUpdatedAt || input.expectedChildUpdatedAt !== current.childUpdatedAt || (current.canonicalGuardianId && input.expectedGuardianUpdatedAt !== current.canonicalGuardianUpdatedAt)) throw new RegistrationCorrectionError("conflict");
  const currentEmail = String(current.email); if (normalizeEmail(currentEmail) === normalizeEmail(nextEmail)) return { ...current, unchanged: true };
  const now = new Date().toISOString(); const statements: D1PreparedStatement[] = []; const guarded: number[] = []; const scope = current.canonicalGuardianId || current.draftId;
  if (current.canonicalGuardianId) { guarded.push(statements.length); statements.push(env.DB.prepare(`UPDATE guardian_account SET email = ?, email_normalized = ?, updated_at = ? WHERE id = ? AND updated_at = ?`).bind(nextEmail, normalizeEmail(nextEmail), now, current.canonicalGuardianId, current.canonicalGuardianUpdatedAt)); statements.push(env.DB.prepare(`UPDATE registration_draft SET email = ?, normalized_email = ?, access_token_hash = lower(hex(randomblob(32))), verified_at = NULL, updated_at = ? WHERE canonical_guardian_account_id = ?`).bind(nextEmail, normalizeEmail(nextEmail), now, current.canonicalGuardianId)); }
  else { guarded.push(statements.length); statements.push(env.DB.prepare(`UPDATE registration_draft SET email = ?, normalized_email = ?, access_token_hash = lower(hex(randomblob(32))), verified_at = NULL, updated_at = ? WHERE id = ? AND updated_at = ? AND EXISTS (SELECT 1 FROM registration_draft_child WHERE id = ? AND updated_at = ?)`)
    .bind(nextEmail, normalizeEmail(nextEmail), now, current.draftId, current.draftUpdatedAt, current.childId, current.childUpdatedAt)); }
  const linkedDrafts = current.canonicalGuardianId ? "registration_draft_id IN (SELECT id FROM registration_draft WHERE canonical_guardian_account_id = ?)" : "registration_draft_id = ?";
  statements.push(env.DB.prepare(`UPDATE email_verification_challenge SET status = 'invalidated', invalidated_at = ?, updated_at = ? WHERE ${linkedDrafts} AND status = 'pending'`).bind(now, now, scope));
  statements.push(env.DB.prepare(`UPDATE verified_email_session SET revoked_at = ? WHERE revoked_at IS NULL AND registration_draft_id IN (SELECT id FROM registration_draft WHERE ${current.canonicalGuardianId ? "canonical_guardian_account_id = ?" : "id = ?"})`).bind(now, scope));
  const before = { ...guardianValues(current), email: currentEmail }; const after = { ...before, email: nextEmail }; statements.push(...correctionStatements(env, actor, current, before, after, ["email"], reason, "registration_protected_email_replaced", now));
  const results = await env.DB.batch(statements); if (guarded.some((index) => (results[index].meta?.changes ?? 0) !== 1)) throw new RegistrationCorrectionError("conflict");
  return registrationCorrectionDetail(env, actor, childId);
}
