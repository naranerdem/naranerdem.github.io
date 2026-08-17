import type { WorkerEnv } from "../env";
import { sha256 } from "../auth/crypto";

export const STAFF_ROLES = ["admin", "teacher", "accountant"] as const;
export type StaffRole = typeof STAFF_ROLES[number];

export const STAFF_CAPABILITIES = [
  "admin.settings.manage",
  "content.manage",
  "admin.staff.manage",
  "program.view",
  "program.manage",
  "calendar.view",
  "calendar.manage",
  "attendance.view",
  "attendance.manage",
  "makeup.view",
  "makeup.manage",
  "registration.view",
  "registration.manage",
  "payment.view",
  "payment.manage",
  "payment.extend",
  "accountant.call_queue.view",
  "accountant.contact.record",
] as const;
export type StaffCapability = typeof STAFF_CAPABILITIES[number];

const ROLE_CAPABILITIES: Record<StaffRole, readonly StaffCapability[]> = {
  admin: STAFF_CAPABILITIES,
  teacher: [
    "content.manage",
    "program.view",
    "program.manage",
    "calendar.view",
    "calendar.manage",
    "attendance.view",
    "attendance.manage",
    "makeup.view",
    "makeup.manage",
    "registration.view",
    "registration.manage",
    "payment.view",
    "payment.manage",
    "payment.extend",
  ],
  accountant: [
    "payment.view",
    "accountant.call_queue.view",
    "accountant.contact.record",
  ],
};

export const STAFF_SESSION_ACTIVITY_WRITE_SECONDS = 6 * 60 * 60;

export interface StaffPrincipal {
  staffAccountId: string;
  displayName: string;
  roles: StaffRole[];
  capabilities: StaffCapability[];
  sessionId: string;
  sessionExpiresAt: string;
  sessionAbsoluteExpiresAt: string;
}

interface StaffSessionRow {
  sessionId: string;
  staffAccountId: string;
  displayName: string;
  createdAt: string;
  lastSeenAt: string;
  inactivitySeconds: number;
  absoluteSeconds: number;
  roleCodes: string;
}

export type StaffSessionActivity = "meaningful" | "passive";

export function isStaffRole(value: string): value is StaffRole {
  return STAFF_ROLES.includes(value as StaffRole);
}

export function capabilitiesForRoles(roles: readonly StaffRole[]): StaffCapability[] {
  return [...new Set(roles.flatMap((role) => ROLE_CAPABILITIES[role]))];
}

export function hasStaffCapability(principal: StaffPrincipal, capability: StaffCapability): boolean {
  return principal.capabilities.includes(capability);
}

function addSeconds(value: string, seconds: number): string {
  return new Date(new Date(value).getTime() + seconds * 1000).toISOString();
}

export async function resolveStaffPrincipal(
  env: WorkerEnv,
  rawSessionToken: string,
  now = new Date(),
  activity: StaffSessionActivity = "meaningful",
): Promise<StaffPrincipal | null> {
  if (!rawSessionToken || rawSessionToken.length > 256) return null;
  const tokenHash = await sha256(rawSessionToken);
  const row = await env.DB.prepare(`
    SELECT
      staff_session.id AS sessionId,
      staff_account.id AS staffAccountId,
      staff_account.display_name AS displayName,
      staff_session.created_at AS createdAt,
      staff_session.last_seen_at AS lastSeenAt,
      MIN(staff_session_policy.inactivity_seconds) AS inactivitySeconds,
      MIN(staff_session_policy.absolute_seconds) AS absoluteSeconds,
      GROUP_CONCAT(staff_account_role.role_code) AS roleCodes
    FROM staff_session
    JOIN staff_account ON staff_account.id = staff_session.staff_account_id
    JOIN staff_account_role ON staff_account_role.staff_account_id = staff_account.id
    JOIN staff_session_policy ON staff_session_policy.role_code = staff_account_role.role_code
    WHERE staff_session.session_token_hash = ?
      AND staff_session.revoked_at IS NULL
      AND staff_session.expired_at IS NULL
      AND staff_account.status = 'active'
    GROUP BY staff_session.id, staff_account.id
  `).bind(tokenHash).first<StaffSessionRow>();
  if (!row || !row.lastSeenAt) return null;

  const inactivityDeadline = addSeconds(row.lastSeenAt, row.inactivitySeconds);
  const absoluteDeadline = addSeconds(row.createdAt, row.absoluteSeconds);
  const nowIso = now.toISOString();
  if (inactivityDeadline <= nowIso || absoluteDeadline <= nowIso) {
    await env.DB.prepare(`
      UPDATE staff_session
      SET expired_at = ?
      WHERE id = ? AND revoked_at IS NULL AND expired_at IS NULL
    `).bind(nowIso, row.sessionId).run();
    return null;
  }

  let effectiveLastSeenAt = row.lastSeenAt;
  if (
    activity === "meaningful"
    && now.getTime() - new Date(row.lastSeenAt).getTime() >= STAFF_SESSION_ACTIVITY_WRITE_SECONDS * 1000
  ) {
    await env.DB.prepare(`
      UPDATE staff_session
      SET last_seen_at = ?
      WHERE id = ? AND revoked_at IS NULL AND expired_at IS NULL AND last_seen_at = ?
    `).bind(nowIso, row.sessionId, row.lastSeenAt).run();
    effectiveLastSeenAt = nowIso;
  }

  const roles = row.roleCodes.split(",").filter(isStaffRole);
  const refreshedInactivityDeadline = addSeconds(effectiveLastSeenAt, row.inactivitySeconds);
  return {
    staffAccountId: row.staffAccountId,
    displayName: row.displayName,
    roles,
    capabilities: capabilitiesForRoles(roles),
    sessionId: row.sessionId,
    sessionExpiresAt: refreshedInactivityDeadline < absoluteDeadline
      ? refreshedInactivityDeadline
      : absoluteDeadline,
    sessionAbsoluteExpiresAt: absoluteDeadline,
  };
}
