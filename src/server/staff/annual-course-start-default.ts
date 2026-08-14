import type { D1PreparedStatement, WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

export interface AnnualCourseStartDefault {
  month: number;
  day: number;
  updatedAt: string;
}

export class AnnualCourseStartDefaultError extends Error {
  constructor(public readonly code: "forbidden" | "invalid" | "conflict") {
    super("Annual course start default operation failed.");
    this.name = "AnnualCourseStartDefaultError";
  }
}

function validMonthDay(month: number, day: number): boolean {
  if (!Number.isInteger(month) || !Number.isInteger(day)) return false;
  const value = new Date(Date.UTC(2025, month - 1, day));
  return value.getUTCFullYear() === 2025 && value.getUTCMonth() === month - 1 && value.getUTCDate() === day;
}

export async function getAnnualCourseStartDefault(env: WorkerEnv): Promise<AnnualCourseStartDefault> {
  const setting = await env.DB.prepare(`SELECT month, day, updated_at AS updatedAt
    FROM annual_course_start_default WHERE singleton = 1`).first<AnnualCourseStartDefault>();
  if (!setting) throw new AnnualCourseStartDefaultError("invalid");
  return setting;
}

function audit(
  env: WorkerEnv,
  actor: StaffPrincipal,
  setting: AnnualCourseStartDefault,
  now: string,
): D1PreparedStatement {
  const isTest = env.APP_ENV === "staging" ? 1 : 0;
  return env.DB.prepare(`INSERT INTO audit_event (
    id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at
  ) VALUES (?, ?, 'staff', ?, 'annual_course_start_default_changed',
    'annual_course_start_default', '1', ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId,
      JSON.stringify({ month: setting.month, day: setting.day }), env.APP_ENV,
      isTest, isTest ? "staff-settings" : null, now);
}

export async function updateAnnualCourseStartDefault(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { month: number; day: number; expectedUpdatedAt: string },
): Promise<AnnualCourseStartDefault> {
  if (!hasStaffCapability(actor, "admin.settings.manage")) {
    throw new AnnualCourseStartDefaultError("forbidden");
  }
  if (!validMonthDay(input.month, input.day) || !input.expectedUpdatedAt) {
    throw new AnnualCourseStartDefaultError("invalid");
  }
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE annual_course_start_default
    SET month = ?, day = ?, updated_at = ?
    WHERE singleton = 1 AND updated_at = ?`).bind(input.month, input.day, now, input.expectedUpdatedAt).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new AnnualCourseStartDefaultError("conflict");
  await audit(env, actor, { month: input.month, day: input.day, updatedAt: now }, now).run();
  return { month: input.month, day: input.day, updatedAt: now };
}
