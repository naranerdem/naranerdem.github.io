import type { D1Database, D1PreparedStatement, WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

export interface InitialPaymentDeadlineSetting {
  deadlineMinutes: number;
  updatedAt: string;
}

export class InitialPaymentDeadlineError extends Error {
  constructor(public readonly code: "forbidden" | "invalid" | "conflict") {
    super("Initial payment deadline operation failed.");
  }
}

function audit(env: WorkerEnv, actor: StaffPrincipal, value: InitialPaymentDeadlineSetting, now: string): D1PreparedStatement {
  const isTest = env.APP_ENV === "staging" ? 1 : 0;
  return env.DB.prepare(`INSERT INTO audit_event (
    id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at
  ) VALUES (?, ?, 'staff', ?, 'initial_payment_deadline_changed',
    'initial_payment_deadline_setting', '1', ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, JSON.stringify({ deadlineMinutes: value.deadlineMinutes }),
      env.APP_ENV, isTest, isTest ? "staff-settings" : null, now);
}

export async function getInitialPaymentDeadlineSettingFromDatabase(database: D1Database): Promise<InitialPaymentDeadlineSetting> {
  const row = await database.prepare(`SELECT deadline_minutes AS deadlineMinutes, updated_at AS updatedAt
    FROM initial_payment_deadline_setting WHERE singleton = 1`).first<InitialPaymentDeadlineSetting>();
  if (!row) throw new InitialPaymentDeadlineError("invalid");
  return row;
}

export async function getInitialPaymentDeadlineSetting(env: WorkerEnv): Promise<InitialPaymentDeadlineSetting> {
  return getInitialPaymentDeadlineSettingFromDatabase(env.DB);
}

export async function updateInitialPaymentDeadlineSetting(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { deadlineMinutes: number; expectedUpdatedAt: string },
): Promise<InitialPaymentDeadlineSetting> {
  if (!hasStaffCapability(actor, "admin.settings.manage")) throw new InitialPaymentDeadlineError("forbidden");
  if (!Number.isInteger(input.deadlineMinutes) || input.deadlineMinutes < 1 || input.deadlineMinutes > 10080 || !input.expectedUpdatedAt) {
    throw new InitialPaymentDeadlineError("invalid");
  }
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE initial_payment_deadline_setting SET deadline_minutes = ?, updated_at = ?
    WHERE singleton = 1 AND updated_at = ?`).bind(input.deadlineMinutes, now, input.expectedUpdatedAt).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new InitialPaymentDeadlineError("conflict");
  const value = { deadlineMinutes: input.deadlineMinutes, updatedAt: now };
  await audit(env, actor, value, now).run();
  return value;
}
