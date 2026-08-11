import type { WorkerEnv } from "../env";
import { sha256 } from "../auth/crypto";

export const STAFF_ROLES = ["admin", "teacher", "accountant"] as const;
export type StaffRole = typeof STAFF_ROLES[number];

export const STAFF_CAPABILITIES = [
  "admin.settings.manage",
  "admin.staff.manage",
  "program.view",
  "program.manage",
  "calendar.view",
  "calendar.manage",
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
    "program.view",
    "program.manage",
    "calendar.view",
    "calendar.manage",
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

export interface StaffPrincipal {
  staffAccountId: string;
  displayName: string;
  roles: StaffRole[];
  capabilities: StaffCapability[];
  sessionId: string;
  sessionExpiresAt: string;
}

interface StaffSessionRow {
  sessionId: string;
  staffAccountId: string;
  displayName: string;
  expiresAt: string;
  roleCodes: string | null;
}

export function isStaffRole(value: string): value is StaffRole {
  return STAFF_ROLES.includes(value as StaffRole);
}

export function capabilitiesForRoles(roles: readonly StaffRole[]): StaffCapability[] {
  return [...new Set(roles.flatMap((role) => ROLE_CAPABILITIES[role]))];
}

export function hasStaffCapability(principal: StaffPrincipal, capability: StaffCapability): boolean {
  return principal.capabilities.includes(capability);
}

export async function resolveStaffPrincipal(
  env: WorkerEnv,
  rawSessionToken: string,
  now = new Date(),
): Promise<StaffPrincipal | null> {
  if (!rawSessionToken || rawSessionToken.length > 256) return null;
  const tokenHash = await sha256(rawSessionToken);
  const row = await env.DB.prepare(`
    SELECT
      staff_session.id AS sessionId,
      staff_account.id AS staffAccountId,
      staff_account.display_name AS displayName,
      staff_session.expires_at AS expiresAt,
      GROUP_CONCAT(staff_account_role.role_code) AS roleCodes
    FROM staff_session
    JOIN staff_account ON staff_account.id = staff_session.staff_account_id
    LEFT JOIN staff_account_role ON staff_account_role.staff_account_id = staff_account.id
    WHERE staff_session.session_token_hash = ?
      AND staff_session.revoked_at IS NULL
      AND staff_session.expires_at > ?
      AND staff_account.status = 'active'
    GROUP BY staff_session.id, staff_account.id
  `).bind(tokenHash, now.toISOString()).first<StaffSessionRow>();
  if (!row) return null;
  const roles = (row.roleCodes ?? "").split(",").filter(isStaffRole);
  return {
    staffAccountId: row.staffAccountId,
    displayName: row.displayName,
    roles,
    capabilities: capabilitiesForRoles(roles),
    sessionId: row.sessionId,
    sessionExpiresAt: row.expiresAt,
  };
}
