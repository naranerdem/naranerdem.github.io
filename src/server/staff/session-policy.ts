import type { D1PreparedStatement, WorkerEnv } from "../env";
import {
  hasStaffCapability,
  STAFF_ROLES,
  type StaffPrincipal,
  type StaffRole,
} from "./authorization";

const DAY_SECONDS = 24 * 60 * 60;

export const MIN_STAFF_INACTIVITY_SECONDS = DAY_SECONDS;
export const MAX_STAFF_INACTIVITY_SECONDS = 180 * 24 * 60 * 60;
export const MIN_STAFF_ABSOLUTE_SECONDS = 24 * 60 * 60;
export const MAX_STAFF_ABSOLUTE_SECONDS = 365 * 24 * 60 * 60;

export interface StaffSessionPolicy {
  role: StaffRole;
  inactivitySeconds: number;
  absoluteSeconds: number;
  updatedAt: string;
}

export interface StaffSessionPolicyInput {
  role: string;
  inactivitySeconds: number;
  absoluteSeconds: number;
}

export class StaffSessionPolicyError extends Error {
  constructor(public readonly code: "forbidden" | "invalid_policy") {
    super("Staff session policy operation failed.");
    this.name = "StaffSessionPolicyError";
  }
}

function validatePolicies(input: readonly StaffSessionPolicyInput[]): StaffSessionPolicyInput[] {
  if (input.length !== STAFF_ROLES.length) throw new StaffSessionPolicyError("invalid_policy");
  const byRole = new Map(input.map((policy) => [policy.role, policy]));
  if (byRole.size !== STAFF_ROLES.length || STAFF_ROLES.some((role) => !byRole.has(role))) {
    throw new StaffSessionPolicyError("invalid_policy");
  }
  return STAFF_ROLES.map((role) => {
    const policy = byRole.get(role);
    if (
      !policy
      || !Number.isInteger(policy.inactivitySeconds)
      || !Number.isInteger(policy.absoluteSeconds)
      || policy.inactivitySeconds < MIN_STAFF_INACTIVITY_SECONDS
      || policy.inactivitySeconds > MAX_STAFF_INACTIVITY_SECONDS
      || policy.absoluteSeconds < MIN_STAFF_ABSOLUTE_SECONDS
      || policy.absoluteSeconds > MAX_STAFF_ABSOLUTE_SECONDS
      || policy.inactivitySeconds % DAY_SECONDS !== 0
      || policy.absoluteSeconds % DAY_SECONDS !== 0
      || policy.inactivitySeconds > policy.absoluteSeconds
    ) {
      throw new StaffSessionPolicyError("invalid_policy");
    }
    return { role, inactivitySeconds: policy.inactivitySeconds, absoluteSeconds: policy.absoluteSeconds };
  });
}

export async function listStaffSessionPolicies(env: WorkerEnv): Promise<StaffSessionPolicy[]> {
  const result = await env.DB.prepare(`
    SELECT
      role_code AS role,
      inactivity_seconds AS inactivitySeconds,
      absolute_seconds AS absoluteSeconds,
      updated_at AS updatedAt
    FROM staff_session_policy
    ORDER BY CASE role_code WHEN 'teacher' THEN 1 WHEN 'accountant' THEN 2 ELSE 3 END
  `).all<StaffSessionPolicy>();
  return result.results;
}

export async function updateStaffSessionPolicies(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: readonly StaffSessionPolicyInput[],
  nowDate = new Date(),
): Promise<StaffSessionPolicy[]> {
  if (!hasStaffCapability(actor, "admin.settings.manage")) {
    throw new StaffSessionPolicyError("forbidden");
  }
  const policies = validatePolicies(input);
  const now = nowDate.toISOString();
  const statements: D1PreparedStatement[] = policies.map((policy) => env.DB.prepare(`
    UPDATE staff_session_policy
    SET inactivity_seconds = ?, absolute_seconds = ?, updated_at = ?,
      updated_by_staff_account_id = ?
    WHERE role_code = ?
  `).bind(
    policy.inactivitySeconds,
    policy.absoluteSeconds,
    now,
    actor.staffAccountId,
    policy.role,
  ));

  // Once a session crosses a newly shortened policy it is permanently expired.
  statements.push(env.DB.prepare(`
    UPDATE staff_session
    SET expired_at = ?
    WHERE revoked_at IS NULL
      AND expired_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM staff_account_role
        JOIN staff_session_policy
          ON staff_session_policy.role_code = staff_account_role.role_code
        WHERE staff_account_role.staff_account_id = staff_session.staff_account_id
          AND (
            unixepoch(staff_session.created_at) + staff_session_policy.absolute_seconds <= unixepoch(?)
            OR unixepoch(COALESCE(staff_session.last_seen_at, staff_session.created_at))
              + staff_session_policy.inactivity_seconds <= unixepoch(?)
          )
      )
  `).bind(now, now, now));
  statements.push(env.DB.prepare(`
    INSERT INTO audit_event (
      id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
      metadata_json, environment, is_test, test_run_id, created_at
    )
    SELECT ?, ?, 'staff', ?, 'staff_session_policies_changed', 'staff_session_policy',
      'role_defaults', ?, ?, staff_account.is_test, staff_account.test_run_id, ?
    FROM staff_account WHERE id = ?
  `).bind(
    crypto.randomUUID(),
    now,
    actor.staffAccountId,
    JSON.stringify({ policies }),
    env.APP_ENV,
    now,
    actor.staffAccountId,
  ));
  await env.DB.batch(statements);
  return listStaffSessionPolicies(env);
}
