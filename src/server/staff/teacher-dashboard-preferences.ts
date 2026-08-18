import type { D1PreparedStatement, WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

export interface TeacherDashboardPreferences {
  showSetupSection: boolean; showRegistration: boolean; showInformation: boolean; updatedAt: string;
}
export class TeacherDashboardPreferencesError extends Error {
  constructor(public readonly code: "forbidden" | "invalid" | "conflict") { super("Teacher dashboard preferences operation failed."); }
}
interface StoredPreferences { showSetupSection: number; showRegistration: number; showInformation: number; updatedAt: string; }
function fromStored(row: StoredPreferences): TeacherDashboardPreferences { return { showSetupSection: Boolean(row.showSetupSection), showRegistration: Boolean(row.showRegistration), showInformation: Boolean(row.showInformation), updatedAt: row.updatedAt }; }
export async function getTeacherDashboardPreferences(env: WorkerEnv): Promise<TeacherDashboardPreferences> {
  const row = await env.DB.prepare(`SELECT show_setup_section AS showSetupSection, show_registration AS showRegistration, show_information AS showInformation, updated_at AS updatedAt FROM teacher_dashboard_preferences WHERE singleton = 1`).first<StoredPreferences>();
  if (!row) throw new TeacherDashboardPreferencesError("invalid"); return fromStored(row);
}
function audit(env: WorkerEnv, actor: StaffPrincipal, value: TeacherDashboardPreferences, now: string): D1PreparedStatement {
  const isTest = env.APP_ENV === "staging" ? 1 : 0;
  return env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id, metadata_json, environment, is_test, test_run_id, created_at) VALUES (?, ?, 'staff', ?, 'teacher_dashboard_preferences_changed', 'teacher_dashboard_preferences', '1', ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, JSON.stringify(value), env.APP_ENV, isTest, isTest ? "staff-settings" : null, now);
}
export async function updateTeacherDashboardPreferences(env: WorkerEnv, actor: StaffPrincipal, input: Record<string, unknown>): Promise<TeacherDashboardPreferences> {
  if (!hasStaffCapability(actor, "admin.settings.manage")) throw new TeacherDashboardPreferencesError("forbidden");
  const current = await getTeacherDashboardPreferences(env);
  if (input.expectedUpdatedAt !== current.updatedAt || typeof input.showSetupSection !== "boolean" || typeof input.showRegistration !== "boolean" || typeof input.showInformation !== "boolean") throw new TeacherDashboardPreferencesError("invalid");
  const value = { showSetupSection: input.showSetupSection, showRegistration: input.showRegistration, showInformation: input.showInformation };
  const now = new Date().toISOString();
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE teacher_dashboard_preferences SET show_setup_section=?, show_registration=?, show_information=?, updated_at=? WHERE singleton=1 AND updated_at=?`).bind(value.showSetupSection ? 1 : 0, value.showRegistration ? 1 : 0, value.showInformation ? 1 : 0, now, current.updatedAt),
    audit(env, actor, { ...value, updatedAt: now }, now),
  ]);
  if ((result[0]?.meta?.changes ?? 0) !== 1) throw new TeacherDashboardPreferencesError("conflict");
  return { ...value, updatedAt: now };
}
