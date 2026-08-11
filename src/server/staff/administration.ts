import type { D1PreparedStatement, WorkerEnv } from "../env";
import {
  hasStaffCapability,
  isStaffRole,
  type StaffPrincipal,
  type StaffRole,
} from "./authorization";

export class StaffAdministrationError extends Error {
  constructor(public readonly code: "forbidden" | "invalid_role" | "staff_not_found") {
    super("Staff administration failed.");
    this.name = "StaffAdministrationError";
  }
}

interface StaffAuditTarget {
  id: string;
  isTest: number;
  testRunId: string | null;
}

function requireStaffAdmin(principal: StaffPrincipal): void {
  if (!hasStaffCapability(principal, "admin.staff.manage")) {
    throw new StaffAdministrationError("forbidden");
  }
}

async function targetForAudit(env: WorkerEnv, staffAccountId: string): Promise<StaffAuditTarget> {
  const target = await env.DB.prepare(`
    SELECT id, is_test AS isTest, test_run_id AS testRunId
    FROM staff_account WHERE id = ?
  `).bind(staffAccountId).first<StaffAuditTarget>();
  if (!target) throw new StaffAdministrationError("staff_not_found");
  return target;
}

function auditStatement(
  env: WorkerEnv,
  actor: StaffPrincipal,
  target: StaffAuditTarget,
  action: string,
  metadata: Record<string, unknown>,
  now: string,
): D1PreparedStatement {
  return env.DB.prepare(`
    INSERT INTO audit_event (
      id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
      metadata_json, environment, is_test, test_run_id, created_at
    ) VALUES (?, ?, 'staff', ?, ?, 'staff_account', ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    now,
    actor.staffAccountId,
    action,
    target.id,
    JSON.stringify(metadata),
    env.APP_ENV,
    target.isTest,
    target.testRunId,
    now,
  );
}

export async function replaceStaffRoles(
  env: WorkerEnv,
  actor: StaffPrincipal,
  staffAccountId: string,
  requestedRoles: readonly string[],
  nowDate = new Date(),
): Promise<void> {
  requireStaffAdmin(actor);
  const roles = [...new Set(requestedRoles)];
  if (roles.length === 0 || roles.some((role) => !isStaffRole(role))) {
    throw new StaffAdministrationError("invalid_role");
  }
  const target = await targetForAudit(env, staffAccountId);
  const now = nowDate.toISOString();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM staff_account_role WHERE staff_account_id = ?").bind(staffAccountId),
  ];
  for (const role of roles as StaffRole[]) {
    statements.push(env.DB.prepare(`
      INSERT INTO staff_account_role (
        staff_account_id, role_code, assigned_by_staff_account_id, assigned_at
      ) VALUES (?, ?, ?, ?)
    `).bind(staffAccountId, role, actor.staffAccountId, now));
  }
  statements.push(auditStatement(env, actor, target, "staff_roles_changed", { roles }, now));
  await env.DB.batch(statements);
}

export async function setStaffAccountStatus(
  env: WorkerEnv,
  actor: StaffPrincipal,
  staffAccountId: string,
  status: "active" | "disabled",
  nowDate = new Date(),
): Promise<void> {
  requireStaffAdmin(actor);
  const target = await targetForAudit(env, staffAccountId);
  const now = nowDate.toISOString();
  const update = env.DB.prepare(`
    UPDATE staff_account
    SET status = ?, disabled_at = ?, updated_at = ?
    WHERE id = ?
  `).bind(status, status === "disabled" ? now : null, now, staffAccountId);
  const revokeSessions = env.DB.prepare(`
    UPDATE staff_session
    SET revoked_at = ?
    WHERE staff_account_id = ? AND revoked_at IS NULL AND expired_at IS NULL
  `).bind(now, staffAccountId);
  const cancelAttempts = env.DB.prepare(`
    UPDATE staff_login_attempt
    SET status = 'cancelled', cancelled_at = ?, updated_at = ?
    WHERE staff_account_id = ? AND status IN ('pending', 'approved')
  `).bind(now, now, staffAccountId);
  const audit = auditStatement(
    env,
    actor,
    target,
    status === "disabled" ? "staff_account_disabled" : "staff_account_enabled",
    { status },
    now,
  );
  await env.DB.batch(status === "disabled"
    ? [update, revokeSessions, cancelAttempts, audit]
    : [update, audit]);
}
