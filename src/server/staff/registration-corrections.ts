import type { D1PreparedStatement, WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

export class RegistrationCorrectionError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "invalid" | "needs_review") { super("Registration correction failed."); }
}

function text(value: unknown, max: number, required = false): string | null {
  const result = typeof value === "string" ? value.normalize("NFKC").trim().slice(0, max) : "";
  return result || (required ? null : null);
}
function date(value: unknown): string | null {
  const result = text(value, 10); return result && /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : null;
}
function audit(env: WorkerEnv, actor: StaffPrincipal, childId: string, draftId: string, fields: string[], isTest: number, testRunId: string | null, now: string): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at) VALUES (?, ?, 'staff', ?, 'registration_data_corrected',
    'registration_draft_child', ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, childId, JSON.stringify({ draftId, fields }), env.APP_ENV, isTest, testRunId, now);
}

export async function registrationCorrectionDetail(env: WorkerEnv, actor: StaffPrincipal, childId: string) {
  if (!hasStaffCapability(actor, "registration.manage")) throw new RegistrationCorrectionError("forbidden");
  const row = await env.DB.prepare(`SELECT registration_draft.id AS draftId, registration_draft.guardian_full_name AS guardianName,
    registration_draft.primary_phone AS primaryPhone, registration_draft.secondary_phone AS secondaryPhone,
    registration_draft.email, registration_draft.facebook_name AS facebookName, registration_draft.home_address AS homeAddress,
    registration_draft.verified_at AS verifiedAt, registration_draft.canonical_guardian_account_id AS canonicalGuardianId,
    registration_draft_child.id AS childId, registration_draft_child.surname, registration_draft_child.given_name AS givenName,
    registration_draft_child.gender, registration_draft_child.date_of_birth AS dateOfBirth,
    registration_draft_child.current_grade AS currentGrade, registration_draft_child.current_school AS currentSchool,
    registration_draft_child.facebook_name AS childFacebookName,
    registration_draft_child.canonical_student_id AS canonicalStudentId,
    registration_draft_referral.captured_code AS referralCode,
    registration_draft_referral.status AS referralStatus
    FROM registration_draft_child INNER JOIN registration_draft ON registration_draft.id = registration_draft_child.registration_draft_id
    LEFT JOIN registration_draft_referral ON registration_draft_referral.registration_draft_child_id = registration_draft_child.id
    WHERE registration_draft_child.id = ?`).bind(childId).first<Record<string, unknown>>();
  if (!row) throw new RegistrationCorrectionError("not_found");
  return row;
}

export async function saveRegistrationCorrection(env: WorkerEnv, actor: StaffPrincipal, childId: string, input: Record<string, unknown>) {
  const current = await registrationCorrectionDetail(env, actor, childId);
  const guardianName = text(input.guardianName, 160, true); const primaryPhone = text(input.primaryPhone, 40, true);
  const email = text(input.email, 254, true); const surname = text(input.surname, 100, true); const givenName = text(input.givenName, 100, true);
  const gender = input.gender === "female" || input.gender === "male" ? input.gender : null; const dateOfBirth = date(input.dateOfBirth);
  const currentGrade = text(input.currentGrade, 20, true);
  if (!guardianName || !primaryPhone || !email || !surname || !givenName || !gender || !dateOfBirth || !currentGrade) throw new RegistrationCorrectionError("invalid");
  const next = { guardianName, primaryPhone, secondaryPhone: text(input.secondaryPhone, 40), email, facebookName: text(input.facebookName, 160),
    homeAddress: text(input.homeAddress, 500, true), surname, givenName, gender, dateOfBirth, currentGrade, currentSchool: text(input.currentSchool, 160), childFacebookName: text(input.childFacebookName, 160) };
  if (!next.homeAddress) throw new RegistrationCorrectionError("invalid");
  const draftId = String(current.draftId); const canonicalGuardianId = current.canonicalGuardianId ? String(current.canonicalGuardianId) : "";
  // A verified/reused guardian can be shared by prior registrations; never silently rewrite it.
  if (canonicalGuardianId && canonicalGuardianId !== `${draftId}:unverified-guardian`) throw new RegistrationCorrectionError("needs_review");
  const canonicalStudentId = current.canonicalStudentId ? String(current.canonicalStudentId) : "";
  if (canonicalStudentId) {
    const shared = await env.DB.prepare(`SELECT COUNT(*) AS count FROM application_child WHERE student_id = ? AND id !=
      (SELECT canonical_application_child_id FROM registration_draft_child WHERE id = ?)`)
      .bind(canonicalStudentId, childId).first<{ count: number }>();
    if (Number(shared?.count || 0) > 0) throw new RegistrationCorrectionError("needs_review");
  }
  const before = { guardianName: current.guardianName, primaryPhone: current.primaryPhone, secondaryPhone: current.secondaryPhone, email: current.email,
    facebookName: current.facebookName, homeAddress: current.homeAddress, surname: current.surname, givenName: current.givenName, gender: current.gender,
    dateOfBirth: current.dateOfBirth, currentGrade: current.currentGrade, currentSchool: current.currentSchool, childFacebookName: current.childFacebookName };
  const fields = Object.keys(next).filter((key) => String((before as Record<string, unknown>)[key] ?? "") !== String((next as Record<string, unknown>)[key] ?? ""));
  if (!fields.length) return current;
  const now = new Date().toISOString();
  const emailChanged = String(current.email).normalize("NFKC").trim().toLowerCase() !== email.toLowerCase();
  const flags = await env.DB.prepare(`SELECT is_test AS isTest, test_run_id AS testRunId FROM registration_draft WHERE id = ?`).bind(draftId).first<{ isTest: number; testRunId: string | null }>();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`UPDATE registration_draft SET guardian_full_name = ?, primary_phone = ?, secondary_phone = ?, email = ?,
      normalized_email = lower(trim(?)), facebook_name = ?, home_address = ?, verified_at = CASE WHEN ? THEN NULL ELSE verified_at END,
      updated_at = ? WHERE id = ?`).bind(next.guardianName, next.primaryPhone, next.secondaryPhone, next.email, next.email, next.facebookName, next.homeAddress, emailChanged ? 1 : 0, now, draftId),
    env.DB.prepare(`UPDATE registration_draft_child SET surname = ?, given_name = ?, gender = ?, date_of_birth = ?, current_grade = ?, current_school = ?, facebook_name = ?, updated_at = ? WHERE id = ?`)
      .bind(next.surname, next.givenName, next.gender, next.dateOfBirth, next.currentGrade, next.currentSchool, next.childFacebookName, now, childId),
    env.DB.prepare(`INSERT INTO registration_data_correction (id, registration_draft_id, registration_draft_child_id, corrected_by_staff_account_id,
      before_json, after_json, created_at, is_test, test_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), draftId, childId, actor.staffAccountId, JSON.stringify(before), JSON.stringify(next), now, flags?.isTest ?? 0, flags?.testRunId ?? null),
    audit(env, actor, childId, draftId, fields, flags?.isTest ?? 0, flags?.testRunId ?? null, now),
  ];
  if (emailChanged) statements.push(
    env.DB.prepare(`UPDATE verified_email_session SET revoked_at = ? WHERE registration_draft_id = ? AND revoked_at IS NULL`).bind(now, draftId),
    env.DB.prepare(`UPDATE email_verification_challenge SET status = 'invalidated', invalidated_at = ?, updated_at = ?
      WHERE registration_draft_id = ? AND status = 'pending'`).bind(now, now, draftId),
  );
  if (canonicalGuardianId) statements.push(env.DB.prepare(`UPDATE guardian_account SET full_name = ?, primary_phone = ?, primary_phone_normalized = ?, secondary_phone = ?, secondary_phone_normalized = ?, email = ?, email_normalized = lower(trim(?)), facebook_name = ?, home_address = ?, updated_at = ? WHERE id = ?`)
    .bind(next.guardianName, next.primaryPhone, next.primaryPhone.replace(/[^0-9+]/g, ""), next.secondaryPhone, next.secondaryPhone?.replace(/[^0-9+]/g, "") ?? null, next.email, next.email, next.facebookName, next.homeAddress, now, canonicalGuardianId));
  if (canonicalStudentId) statements.push(env.DB.prepare(`UPDATE student SET surname = ?, given_name = ?, gender = ?, date_of_birth = ?, updated_at = ? WHERE id = ?`)
    .bind(next.surname, next.givenName, next.gender, next.dateOfBirth, now, canonicalStudentId));
  await env.DB.batch(statements);
  return registrationCorrectionDetail(env, actor, childId);
}
