import type { D1PreparedStatement, D1Result, WorkerEnv } from "../env";
import { normalizeEmail, validEmail } from "../auth/email-address";
import { randomToken, sha256 } from "../auth/crypto";
import { resolveDeliveryAddress } from "../email/delivery-policy";
import type { EmailProvider } from "../email/provider";
import { createResendProvider } from "../email/resend";
import { EmailConfigurationError, deliverQueuedEmail } from "../email/service";
import { staffLoginTemplate } from "../email/templates/staff-login";
import { resolveStaffPrincipal, type StaffPrincipal } from "./authorization";

export const STAFF_MAGIC_LINK_TTL_SECONDS = 15 * 60;
export const STAFF_SESSION_TTL_SECONDS = 10 * 60 * 60;
export const STAFF_LOGIN_COOLDOWN_SECONDS = 60;
export const STAFF_SESSION_COOKIE = "naran_staff_session";

const THROTTLE_WINDOW_SECONDS = 60 * 60;
const EMAIL_ATTEMPT_LIMIT = 5;
const IP_ATTEMPT_LIMIT = 20;

export class StaffAuthError extends Error {
  constructor(public readonly code: string) {
    super("Staff authentication failed.");
    this.name = "StaffAuthError";
  }
}

interface StartStaffLoginOptions {
  clientIp?: string;
  now?: Date;
  provider?: EmailProvider;
  rawToken?: string;
}

interface StaffAccountRow {
  id: string;
  normalizedEmail: string;
  isTest: number;
  testRunId: string | null;
}

interface StaffChallengeRow {
  id: string;
  staffAccountId: string;
  status: string;
  expiresAt: string;
  isTest: number;
  testRunId: string | null;
}

interface ThrottleRow {
  windowStartedAt: string;
  attemptCount: number;
}

function addSeconds(date: Date, seconds: number): string {
  return new Date(date.getTime() + seconds * 1000).toISOString();
}

function changeCount(result: D1Result<unknown> | undefined): number {
  return result?.meta?.changes ?? 0;
}

function auditEnvironment(env: WorkerEnv): "production" | "staging" {
  return env.APP_ENV;
}

function staffAuditStatement(
  env: WorkerEnv,
  values: {
    action: string;
    staffAccountId: string;
    subjectType: string;
    subjectId: string;
    metadata?: Record<string, unknown>;
    now: string;
    isTest: number;
    testRunId: string | null;
  },
): D1PreparedStatement {
  return env.DB.prepare(`
    INSERT INTO audit_event (
      id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
      metadata_json, environment, is_test, test_run_id, created_at
    ) VALUES (?, ?, 'staff', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    values.now,
    values.staffAccountId,
    values.action,
    values.subjectType,
    values.subjectId,
    values.metadata ? JSON.stringify(values.metadata) : null,
    auditEnvironment(env),
    values.isTest,
    values.testRunId,
    values.now,
  );
}

export function staffSessionCookie(token: string, secure = true): string {
  const parts = [
    `${STAFF_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    `Max-Age=${STAFF_SESSION_TTL_SECONDS}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearStaffSessionCookie(secure = true): string {
  const parts = [
    `${STAFF_SESSION_COOKIE}=`,
    "Max-Age=0",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function readStaffCookie(request: Request): string {
  const cookieHeader = request.headers.get("Cookie") ?? "";
  for (const part of cookieHeader.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name === STAFF_SESSION_COOKIE) return decodeURIComponent(valueParts.join("="));
  }
  return "";
}

export function staffAuthEmailEnabled(env: WorkerEnv): boolean {
  return env.EMAIL_ENABLED === "true" && env.STAFF_AUTH_EMAIL_ENABLED === "true";
}

async function claimThrottle(
  env: WorkerEnv,
  scope: "email" | "ip",
  value: string,
  limit: number,
  now: Date,
): Promise<boolean> {
  const keyHash = await sha256(`staff-auth/${scope}/${value}`);
  const row = await env.DB.prepare(`
    SELECT window_started_at AS windowStartedAt, attempt_count AS attemptCount
    FROM staff_auth_throttle
    WHERE key_hash = ?
  `).bind(keyHash).first<ThrottleRow>();
  const nowIso = now.toISOString();
  const windowCutoff = addSeconds(now, -THROTTLE_WINDOW_SECONDS);
  if (!row) {
    await env.DB.prepare(`
      INSERT INTO staff_auth_throttle (key_hash, scope, window_started_at, attempt_count, updated_at)
      VALUES (?, ?, ?, 1, ?)
    `).bind(keyHash, scope, nowIso, nowIso).run();
    return true;
  }
  if (row.windowStartedAt <= windowCutoff) {
    await env.DB.prepare(`
      UPDATE staff_auth_throttle
      SET window_started_at = ?, attempt_count = 1, updated_at = ?
      WHERE key_hash = ?
    `).bind(nowIso, nowIso, keyHash).run();
    return true;
  }
  if (row.attemptCount >= limit) return false;
  await env.DB.prepare(`
    UPDATE staff_auth_throttle
    SET attempt_count = attempt_count + 1, updated_at = ?
    WHERE key_hash = ?
  `).bind(nowIso, keyHash).run();
  return true;
}

async function withinLoginLimits(
  env: WorkerEnv,
  normalizedEmail: string,
  clientIp: string,
  now: Date,
): Promise<boolean> {
  const [emailAllowed, ipAllowed] = await Promise.all([
    claimThrottle(env, "email", normalizedEmail, EMAIL_ATTEMPT_LIMIT, now),
    claimThrottle(env, "ip", clientIp, IP_ATTEMPT_LIMIT, now),
  ]);
  return emailAllowed && ipAllowed;
}

export async function startStaffLogin(
  env: WorkerEnv,
  emailInput: string,
  options: StartStaffLoginOptions = {},
): Promise<void> {
  if (!staffAuthEmailEnabled(env)) return;
  if (!env.RESEND_API_KEY && !options.provider) {
    throw new EmailConfigurationError("resend_api_key_missing");
  }

  const normalizedEmail = normalizeEmail(emailInput.slice(0, 512));
  const nowDate = options.now ?? new Date();
  const clientIp = (options.clientIp ?? "unknown").slice(0, 128);
  if (!await withinLoginLimits(env, normalizedEmail, clientIp, nowDate)) return;
  if (!validEmail(normalizedEmail)) return;

  let delivery;
  try {
    delivery = resolveDeliveryAddress(env.APP_ENV, normalizedEmail, env.STAGING_EMAIL_OVERRIDE_TO);
  } catch {
    throw new EmailConfigurationError("staging_override_missing");
  }

  const staff = await env.DB.prepare(`
    SELECT id, email_normalized AS normalizedEmail, is_test AS isTest, test_run_id AS testRunId
    FROM staff_account
    WHERE email_normalized = ? AND status = 'active'
  `).bind(normalizedEmail).first<StaffAccountRow>();
  if (!staff) return;

  const now = nowDate.toISOString();
  const cooldownCutoff = addSeconds(nowDate, -STAFF_LOGIN_COOLDOWN_SECONDS);
  const recent = await env.DB.prepare(`
    SELECT id
    FROM staff_login_challenge
    WHERE staff_account_id = ? AND status = 'pending' AND created_at > ?
    LIMIT 1
  `).bind(staff.id, cooldownCutoff).first<{ id: string }>();
  if (recent) return;

  const rawToken = options.rawToken ?? randomToken();
  const tokenHash = await sha256(rawToken);
  const requestedIpHash = options.clientIp ? await sha256(clientIp) : null;
  const challengeId = crypto.randomUUID();
  const outboundEmailId = crypto.randomUUID();
  const idempotencyKey = `staff-login/${outboundEmailId}`;
  const expiresAt = addSeconds(nowDate, STAFF_MAGIC_LINK_TTL_SECONDS);
  const isTest = env.APP_ENV === "staging" ? 1 : staff.isTest;
  const testRunId = isTest ? staff.testRunId ?? `staff-login:${challengeId}` : null;

  const invalidatePrevious = env.DB.prepare(`
    UPDATE staff_login_challenge
    SET status = 'invalidated', invalidated_at = ?, updated_at = ?
    WHERE staff_account_id = ? AND status = 'pending'
  `).bind(now, now, staff.id);
  const outboundInsert = env.DB.prepare(`
    INSERT INTO outbound_email (
      id, event_type, template_key, staff_account_id,
      intended_to_email, actual_delivery_email, delivery_mode, status,
      attempt_count, queued_at, context_json, idempotency_key,
      is_test, test_run_id, created_at, updated_at
    ) VALUES (?, 'staff_login_link_requested', 'staff_login_v1', ?, ?, ?, ?, 'queued',
      0, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    outboundEmailId,
    staff.id,
    normalizedEmail,
    delivery.actualEmail,
    delivery.deliveryMode,
    now,
    JSON.stringify({ challenge_id: challengeId, purpose: "staff_login", expires_at: expiresAt }),
    idempotencyKey,
    isTest,
    testRunId,
    now,
    now,
  );
  const challengeInsert = env.DB.prepare(`
    INSERT INTO staff_login_challenge (
      id, staff_account_id, normalized_email, token_hash, status,
      outbound_email_id, requested_ip_hash, created_at, expires_at,
      is_test, test_run_id, updated_at
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    challengeId,
    staff.id,
    normalizedEmail,
    tokenHash,
    outboundEmailId,
    requestedIpHash,
    now,
    expiresAt,
    isTest,
    testRunId,
    now,
  );
  const queued = await env.DB.batch([invalidatePrevious, outboundInsert, challengeInsert]);
  if (changeCount(queued[1]) !== 1 || changeCount(queued[2]) !== 1) {
    throw new StaffAuthError("queue_failed");
  }

  const verificationUrl = new URL("/staff/", env.APP_ORIGIN);
  verificationUrl.hash = new URLSearchParams({ token: rawToken }).toString();
  const template = staffLoginTemplate(verificationUrl.toString());
  const provider = options.provider ?? createResendProvider(env.RESEND_API_KEY ?? "");
  try {
    await deliverQueuedEmail(env, provider, {
      id: outboundEmailId,
      idempotencyKey,
      message: {
        from: env.EMAIL_FROM,
        to: delivery.actualEmail,
        subject: template.subject,
        html: template.html,
        text: template.text,
      },
    });
  } catch (caught) {
    await env.DB.prepare(`
      UPDATE staff_login_challenge
      SET status = 'delivery_failed', updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).bind(new Date().toISOString(), challengeId).run();
    throw caught;
  }
}

export async function verifyStaffLogin(
  env: WorkerEnv,
  rawToken: string,
  existingSessionToken = "",
  nowDate = new Date(),
): Promise<{ principal: StaffPrincipal | null; cookie: string | null; alreadySignedIn: boolean }> {
  if (!staffAuthEmailEnabled(env) || !rawToken || rawToken.length > 256) {
    throw new StaffAuthError("invalid_or_expired_token");
  }
  const tokenHash = await sha256(rawToken);
  const challenge = await env.DB.prepare(`
    SELECT
      staff_login_challenge.id,
      staff_login_challenge.staff_account_id AS staffAccountId,
      staff_login_challenge.status,
      staff_login_challenge.expires_at AS expiresAt,
      staff_login_challenge.is_test AS isTest,
      staff_login_challenge.test_run_id AS testRunId
    FROM staff_login_challenge
    JOIN staff_account ON staff_account.id = staff_login_challenge.staff_account_id
    WHERE staff_login_challenge.token_hash = ? AND staff_account.status = 'active'
  `).bind(tokenHash).first<StaffChallengeRow>();
  if (!challenge) throw new StaffAuthError("invalid_or_expired_token");

  if (challenge.status === "used") {
    const principal = await resolveStaffPrincipal(env, existingSessionToken, nowDate);
    if (principal?.staffAccountId === challenge.staffAccountId) {
      return { principal, cookie: null, alreadySignedIn: true };
    }
    throw new StaffAuthError("invalid_or_expired_token");
  }

  const now = nowDate.toISOString();
  if (challenge.status !== "pending" || challenge.expiresAt <= now) {
    if (challenge.status === "pending") {
      await env.DB.prepare(`
        UPDATE staff_login_challenge SET status = 'expired', updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).bind(now, challenge.id).run();
    }
    throw new StaffAuthError("invalid_or_expired_token");
  }

  const sessionId = crypto.randomUUID();
  const rawSessionToken = randomToken();
  const sessionTokenHash = await sha256(rawSessionToken);
  const expiresAt = addSeconds(nowDate, STAFF_SESSION_TTL_SECONDS);
  const sessionInsert = env.DB.prepare(`
    INSERT INTO staff_session (
      id, staff_account_id, session_token_hash, created_at, expires_at,
      is_test, test_run_id
    )
    SELECT ?, staff_login_challenge.staff_account_id, ?, ?, ?,
      staff_login_challenge.is_test, staff_login_challenge.test_run_id
    FROM staff_login_challenge
    JOIN staff_account ON staff_account.id = staff_login_challenge.staff_account_id
    WHERE staff_login_challenge.id = ?
      AND staff_login_challenge.status = 'pending'
      AND staff_login_challenge.expires_at > ?
      AND staff_account.status = 'active'
  `).bind(sessionId, sessionTokenHash, now, expiresAt, challenge.id, now);
  const challengeUpdate = env.DB.prepare(`
    UPDATE staff_login_challenge
    SET status = 'used', used_at = ?, updated_at = ?
    WHERE id = ? AND status = 'pending' AND expires_at > ?
  `).bind(now, now, challenge.id, now);
  const auditInsert = env.DB.prepare(`
    INSERT INTO audit_event (
      id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
      metadata_json, environment, is_test, test_run_id, created_at
    )
    SELECT ?, ?, 'staff', ?, 'staff_login_succeeded', 'staff_session', ?,
      ?, ?, ?, ?, ?
    FROM staff_session
    WHERE id = ?
  `).bind(
    crypto.randomUUID(),
    now,
    challenge.staffAccountId,
    sessionId,
    JSON.stringify({ method: "email_magic_link" }),
    auditEnvironment(env),
    challenge.isTest,
    challenge.testRunId,
    now,
    sessionId,
  );
  const consumed = await env.DB.batch([sessionInsert, challengeUpdate, auditInsert]);
  if (changeCount(consumed[0]) !== 1 || changeCount(consumed[1]) !== 1) {
    throw new StaffAuthError("invalid_or_expired_token");
  }

  const principal = await resolveStaffPrincipal(env, rawSessionToken, nowDate);
  if (!principal) throw new StaffAuthError("session_creation_failed");
  return {
    principal,
    cookie: staffSessionCookie(rawSessionToken, true),
    alreadySignedIn: false,
  };
}

export async function revokeStaffSession(
  env: WorkerEnv,
  rawSessionToken: string,
  nowDate = new Date(),
): Promise<void> {
  if (!rawSessionToken || rawSessionToken.length > 256) return;
  const principal = await resolveStaffPrincipal(env, rawSessionToken, nowDate);
  if (!principal) return;
  const tokenHash = await sha256(rawSessionToken);
  const now = nowDate.toISOString();
  const account = await env.DB.prepare(`
    SELECT is_test AS isTest, test_run_id AS testRunId
    FROM staff_account WHERE id = ?
  `).bind(principal.staffAccountId).first<{ isTest: number; testRunId: string | null }>();
  const revoke = env.DB.prepare(`
    UPDATE staff_session SET revoked_at = ?
    WHERE session_token_hash = ? AND revoked_at IS NULL
  `).bind(now, tokenHash);
  const audit = staffAuditStatement(env, {
    action: "staff_logout",
    staffAccountId: principal.staffAccountId,
    subjectType: "staff_session",
    subjectId: principal.sessionId,
    now,
    isTest: account?.isTest ?? 0,
    testRunId: account?.testRunId ?? null,
  });
  await env.DB.batch([revoke, audit]);
}
