import type { D1PreparedStatement, WorkerEnv } from "../env";
import { normalizeEmail, validEmail } from "../auth/email-address";
import {
  hasStaffCapability,
  isStaffRole,
  type StaffPrincipal,
  type StaffRole,
} from "./authorization";

export class StaffAdministrationError extends Error {
  constructor(public readonly code:
    | "forbidden"
    | "invalid_email"
    | "invalid_name"
    | "invalid_role"
    | "email_conflict"
    | "email_limit"
    | "primary_email"
    | "last_active_admin"
    | "staff_not_found") {
    super("Staff administration failed.");
    this.name = "StaffAdministrationError";
  }
}

interface StaffAuditTarget {
  id: string;
  emailNormalized: string;
  displayName: string;
  status: "active" | "disabled";
  isTest: number;
  testRunId: string | null;
}

interface StaffListRow extends StaffAuditTarget {
  disabledAt: string | null;
  roleCodes: string | null;
  activeSessionCount: number;
  updatedAt: string;
}

interface StaffEmailRow {
  id: string;
  staffAccountId: string;
  email: string;
  emailNormalized: string;
  isPrimary: number;
  createdAt: string;
}

export interface StaffAccountInput {
  displayName: unknown;
  email: unknown;
  role: unknown;
}

export interface StaffAccountProfileInput {
  displayName: unknown;
  role: unknown;
}

function requireStaffAdmin(principal: StaffPrincipal): void {
  if (!hasStaffCapability(principal, "admin.staff.manage")) {
    throw new StaffAdministrationError("forbidden");
  }
}

function displayName(value: unknown): string {
  const result = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  if (!result || result.length > 120) throw new StaffAdministrationError("invalid_name");
  return result;
}

function staffEmail(value: unknown): string {
  const result = normalizeEmail(typeof value === "string" ? value.slice(0, 512) : "");
  if (!validEmail(result)) throw new StaffAdministrationError("invalid_email");
  return result;
}

function staffRole(value: unknown): StaffRole {
  if (typeof value !== "string" || !isStaffRole(value)) throw new StaffAdministrationError("invalid_role");
  return value;
}

function testFlags(env: WorkerEnv, email: string): { isTest: number; testRunId: string | null } {
  const isTest = email.endsWith("@example.invalid") ? 1 : 0;
  if (env.APP_ENV === "production" && isTest) throw new StaffAdministrationError("invalid_email");
  return { isTest, testRunId: isTest ? "staff-admin-fixture" : null };
}

async function targetForAudit(env: WorkerEnv, staffAccountId: string): Promise<StaffAuditTarget> {
  const target = await env.DB.prepare(`
    SELECT id, email_normalized AS emailNormalized, display_name AS displayName,
      status, is_test AS isTest, test_run_id AS testRunId
    FROM staff_account WHERE id = ?
  `).bind(staffAccountId).first<StaffAuditTarget>();
  if (!target) throw new StaffAdministrationError("staff_not_found");
  return target;
}

function auditStatement(
  env: WorkerEnv,
  actor: StaffPrincipal,
  target: Pick<StaffAuditTarget, "id" | "isTest" | "testRunId">,
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
    crypto.randomUUID(), now, actor.staffAccountId, action, target.id,
    JSON.stringify(metadata), env.APP_ENV, target.isTest, target.testRunId, now,
  );
}

function revokeAccessStatements(env: WorkerEnv, staffAccountId: string, now: string): D1PreparedStatement[] {
  return [
    env.DB.prepare(`UPDATE staff_session SET revoked_at = ?
      WHERE staff_account_id = ? AND revoked_at IS NULL AND expired_at IS NULL`).bind(now, staffAccountId),
    env.DB.prepare(`UPDATE staff_login_attempt
      SET status = 'cancelled', cancelled_at = ?, updated_at = ?
      WHERE staff_account_id = ? AND status IN ('pending', 'approved')`).bind(now, now, staffAccountId),
    env.DB.prepare(`UPDATE staff_login_challenge
      SET status = 'invalidated', invalidated_at = ?, updated_at = ?
      WHERE staff_account_id = ? AND status = 'pending'`).bind(now, now, staffAccountId),
  ];
}

async function assertNotLastActiveAdmin(
  env: WorkerEnv,
  target: StaffAuditTarget,
  nextStatus: "active" | "disabled",
  nextRoles: readonly StaffRole[],
): Promise<void> {
  if (target.status !== "active" || nextStatus === "active" && nextRoles.includes("admin")) return;
  const targetIsAdmin = await env.DB.prepare(`SELECT 1 AS value FROM staff_account_role
    WHERE staff_account_id = ? AND role_code = 'admin'`).bind(target.id).first<{ value: number }>();
  if (!targetIsAdmin) return;
  const activeAdmins = await env.DB.prepare(`SELECT COUNT(DISTINCT staff_account.id) AS value
    FROM staff_account INNER JOIN staff_account_role ON staff_account_role.staff_account_id = staff_account.id
    WHERE staff_account.status = 'active' AND staff_account_role.role_code = 'admin'`).first<{ value: number }>();
  if ((activeAdmins?.value ?? 0) <= 1) throw new StaffAdministrationError("last_active_admin");
}

export async function listStaffAccounts(env: WorkerEnv, actor: StaffPrincipal) {
  requireStaffAdmin(actor);
  const [accountResult, emailResult] = await Promise.all([
    env.DB.prepare(`SELECT staff_account.id,
      staff_account.email_normalized AS emailNormalized,
      staff_account.display_name AS displayName, staff_account.status,
      staff_account.disabled_at AS disabledAt, staff_account.is_test AS isTest,
      staff_account.test_run_id AS testRunId, staff_account.updated_at AS updatedAt,
      GROUP_CONCAT(staff_account_role.role_code) AS roleCodes,
      (SELECT COUNT(*) FROM staff_session
        WHERE staff_session.staff_account_id = staff_account.id
          AND staff_session.revoked_at IS NULL AND staff_session.expired_at IS NULL) AS activeSessionCount
    FROM staff_account
    LEFT JOIN staff_account_role ON staff_account_role.staff_account_id = staff_account.id
    GROUP BY staff_account.id
    ORDER BY staff_account.status, staff_account.display_name COLLATE NOCASE, staff_account.email_normalized`).all<StaffListRow>(),
    env.DB.prepare(`SELECT id, staff_account_id AS staffAccountId, email,
      email_normalized AS emailNormalized, is_primary AS isPrimary, created_at AS createdAt
      FROM staff_account_email
      ORDER BY staff_account_id, is_primary DESC, created_at, id`).all<StaffEmailRow>(),
  ]);
  const emailsByAccount = new Map<string, StaffEmailRow[]>();
  for (const email of emailResult.results) {
    const entries = emailsByAccount.get(email.staffAccountId) ?? [];
    entries.push(email);
    emailsByAccount.set(email.staffAccountId, entries);
  }
  return accountResult.results.map((row) => ({
    id: row.id,
    email: row.emailNormalized,
    emails: (emailsByAccount.get(row.id) ?? []).map((email) => ({
      id: email.id,
      email: email.email,
      isPrimary: Boolean(email.isPrimary),
    })),
    displayName: row.displayName,
    status: row.status,
    disabledAt: row.disabledAt,
    roles: (row.roleCodes ?? "").split(",").filter(isStaffRole),
    activeSessionCount: Number(row.activeSessionCount),
    isTest: Boolean(row.isTest),
    updatedAt: row.updatedAt,
  }));
}

export async function createStaffAccount(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: StaffAccountInput,
  nowDate = new Date(),
): Promise<{ id: string }> {
  requireStaffAdmin(actor);
  const name = displayName(input.displayName);
  const email = staffEmail(input.email);
  const role = staffRole(input.role);
  if (await env.DB.prepare("SELECT 1 AS value FROM staff_account_email WHERE email_normalized = ?").bind(email).first()) {
    throw new StaffAdministrationError("email_conflict");
  }
  const now = nowDate.toISOString();
  const id = crypto.randomUUID();
  const provenance = testFlags(env, email);
  const target = { id, ...provenance };
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO staff_account (
      id, email_normalized, display_name, status, is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`).bind(
      id, email, name, provenance.isTest, provenance.testRunId, now, now,
    ),
    env.DB.prepare(`INSERT INTO staff_account_role (
      staff_account_id, role_code, assigned_by_staff_account_id, assigned_at
    ) VALUES (?, ?, ?, ?)`).bind(id, role, actor.staffAccountId, now),
    env.DB.prepare(`INSERT INTO staff_account_email (
      id, staff_account_id, email, email_normalized, is_primary,
      created_by_staff_account_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`).bind(
      crypto.randomUUID(), id, email, email, actor.staffAccountId, now, now,
    ),
    auditStatement(env, actor, target, "staff_account_created", { role }, now),
    auditStatement(env, actor, target, "staff_role_assigned", { role }, now),
  ]);
  return { id };
}

export async function updateStaffAccount(
  env: WorkerEnv,
  actor: StaffPrincipal,
  staffAccountId: string,
  input: StaffAccountProfileInput,
  nowDate = new Date(),
): Promise<void> {
  requireStaffAdmin(actor);
  const target = await targetForAudit(env, staffAccountId);
  const name = displayName(input.displayName);
  const role = staffRole(input.role);
  await assertNotLastActiveAdmin(env, target, target.status, [role]);
  const now = nowDate.toISOString();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`UPDATE staff_account SET display_name = ?, updated_at = ? WHERE id = ?`)
      .bind(name, now, staffAccountId),
    env.DB.prepare("DELETE FROM staff_account_role WHERE staff_account_id = ?").bind(staffAccountId),
    env.DB.prepare(`INSERT INTO staff_account_role (
      staff_account_id, role_code, assigned_by_staff_account_id, assigned_at
    ) VALUES (?, ?, ?, ?)`).bind(staffAccountId, role, actor.staffAccountId, now),
  ];
  statements.push(auditStatement(env, actor, target, "staff_account_updated", {
    displayNameChanged: name !== target.displayName,
    role,
  }, now));
  await env.DB.batch(statements);
}

function assertAliasProvenance(env: WorkerEnv, target: StaffAuditTarget, email: string): void {
  const emailIsTest = email.endsWith("@example.invalid");
  if (env.APP_ENV === "production" && emailIsTest) throw new StaffAdministrationError("invalid_email");
  if (env.APP_ENV === "staging" && Boolean(target.isTest) !== emailIsTest) {
    throw new StaffAdministrationError("invalid_email");
  }
}

async function staffEmailEntry(
  env: WorkerEnv,
  staffAccountId: string,
  emailId: string,
): Promise<StaffEmailRow> {
  const entry = await env.DB.prepare(`SELECT id, staff_account_id AS staffAccountId, email,
    email_normalized AS emailNormalized, is_primary AS isPrimary, created_at AS createdAt
    FROM staff_account_email WHERE id = ? AND staff_account_id = ?`).bind(
    emailId, staffAccountId,
  ).first<StaffEmailRow>();
  if (!entry) throw new StaffAdministrationError("staff_not_found");
  return entry;
}

export async function addStaffAccountEmail(
  env: WorkerEnv,
  actor: StaffPrincipal,
  staffAccountId: string,
  value: unknown,
  nowDate = new Date(),
): Promise<{ id: string }> {
  requireStaffAdmin(actor);
  const target = await targetForAudit(env, staffAccountId);
  const email = staffEmail(value);
  assertAliasProvenance(env, target, email);
  const existing = await env.DB.prepare(`SELECT staff_account_id AS staffAccountId
    FROM staff_account_email WHERE email_normalized = ?`).bind(email).first<{ staffAccountId: string }>();
  if (existing) throw new StaffAdministrationError("email_conflict");
  const count = await env.DB.prepare(`SELECT COUNT(*) AS value FROM staff_account_email
    WHERE staff_account_id = ?`).bind(staffAccountId).first<{ value: number }>();
  if ((count?.value ?? 0) >= 3) throw new StaffAdministrationError("email_limit");
  const now = nowDate.toISOString();
  const emailId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO staff_account_email (
      id, staff_account_id, email, email_normalized, is_primary,
      created_by_staff_account_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, ?)`).bind(
      emailId, staffAccountId, email, email, actor.staffAccountId, now, now,
    ),
    auditStatement(env, actor, target, "staff_login_email_added", { email }, now),
  ]);
  return { id: emailId };
}

export async function setPrimaryStaffAccountEmail(
  env: WorkerEnv,
  actor: StaffPrincipal,
  staffAccountId: string,
  emailId: string,
  nowDate = new Date(),
): Promise<void> {
  requireStaffAdmin(actor);
  const target = await targetForAudit(env, staffAccountId);
  const entry = await staffEmailEntry(env, staffAccountId, emailId);
  if (entry.isPrimary) return;
  const now = nowDate.toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE staff_account_email SET is_primary = 0, updated_at = ?
      WHERE staff_account_id = ? AND is_primary = 1`).bind(now, staffAccountId),
    env.DB.prepare(`UPDATE staff_account_email SET is_primary = 1, updated_at = ?
      WHERE id = ? AND staff_account_id = ?`).bind(now, emailId, staffAccountId),
    auditStatement(env, actor, target, "staff_primary_login_email_changed", { email: entry.emailNormalized }, now),
  ]);
}

export async function removeStaffAccountEmail(
  env: WorkerEnv,
  actor: StaffPrincipal,
  staffAccountId: string,
  emailId: string,
  nowDate = new Date(),
): Promise<void> {
  requireStaffAdmin(actor);
  const target = await targetForAudit(env, staffAccountId);
  const entry = await staffEmailEntry(env, staffAccountId, emailId);
  if (entry.isPrimary) throw new StaffAdministrationError("primary_email");
  const now = nowDate.toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE staff_login_attempt SET status = 'cancelled', cancelled_at = ?, updated_at = ?
      WHERE status IN ('pending', 'approved') AND id IN (
        SELECT login_attempt_id FROM staff_login_challenge
        WHERE staff_account_id = ? AND normalized_email = ? AND login_attempt_id IS NOT NULL
      )`).bind(now, now, staffAccountId, entry.emailNormalized),
    env.DB.prepare(`UPDATE staff_login_challenge
      SET status = 'invalidated', invalidated_at = ?, updated_at = ?
      WHERE staff_account_id = ? AND normalized_email = ? AND status = 'pending'`).bind(
      now, now, staffAccountId, entry.emailNormalized,
    ),
    env.DB.prepare(`DELETE FROM staff_account_email
      WHERE id = ? AND staff_account_id = ? AND is_primary = 0`).bind(emailId, staffAccountId),
    auditStatement(env, actor, target, "staff_login_email_removed", { email: entry.emailNormalized }, now),
  ]);
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
  await assertNotLastActiveAdmin(env, target, target.status, roles as StaffRole[]);
  const now = nowDate.toISOString();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM staff_account_role WHERE staff_account_id = ?").bind(staffAccountId),
  ];
  for (const role of roles as StaffRole[]) {
    statements.push(env.DB.prepare(`INSERT INTO staff_account_role (
      staff_account_id, role_code, assigned_by_staff_account_id, assigned_at
    ) VALUES (?, ?, ?, ?)`).bind(staffAccountId, role, actor.staffAccountId, now));
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
  if (status !== "active" && status !== "disabled") throw new StaffAdministrationError("staff_not_found");
  await assertNotLastActiveAdmin(env, target, status, status === "active" ? ["admin"] : []);
  const now = nowDate.toISOString();
  const update = env.DB.prepare(`UPDATE staff_account SET status = ?, disabled_at = ?, updated_at = ?
    WHERE id = ?`).bind(status, status === "disabled" ? now : null, now, staffAccountId);
  const audit = auditStatement(env, actor, target,
    status === "disabled" ? "staff_account_disabled" : "staff_account_enabled", { status }, now);
  await env.DB.batch(status === "disabled"
    ? [update, ...revokeAccessStatements(env, staffAccountId, now), audit]
    : [update, audit]);
}
