import type { D1PreparedStatement, D1Result, WorkerEnv } from "../env";
import { normalizeEmail, validEmail } from "../auth/email-address";
import { randomToken, sha256 } from "../auth/crypto";
import { resolveStaffDeliveryAddress } from "../email/delivery-policy";
import type { EmailProvider } from "../email/provider";
import { createResendProvider } from "../email/resend";
import { EmailConfigurationError, deliverQueuedEmail } from "../email/service";
import { staffLoginTemplate } from "../email/templates/staff-login";
import { hasStaffCapability, resolveStaffPrincipal, type StaffPrincipal } from "./authorization";
import { MAX_STAFF_ABSOLUTE_SECONDS } from "./session-policy";
import { staffAuthEmailEnabled as staffAuthEmailGate } from "../security/operational-gates";

export const STAFF_MAGIC_LINK_TTL_SECONDS = 15 * 60;
export const STAFF_LOGIN_ATTEMPT_TTL_SECONDS = 15 * 60;
export const STAFF_LOGIN_COOLDOWN_SECONDS = 60;
export const STAFF_SESSION_COOKIE = "naran_staff_session";
export const STAFF_LOGIN_ATTEMPT_COOKIE = "naran_staff_login_attempt";

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
  rawClaimSecret?: string;
  existingAttemptSecret?: string;
}

interface StaffAccountRow {
  id: string;
  normalizedEmail: string;
  isTest: number;
  testRunId: string | null;
}

interface StaffAttemptRow {
  id: string;
  staffAccountId: string | null;
  claimSecretHash: string;
  status: "pending" | "approved" | "claimed" | "expired" | "cancelled";
  expiresAt: string;
  isTest: number;
  testRunId: string | null;
}

interface StaffChallengeRow {
  id: string;
  staffAccountId: string;
  status: string;
  expiresAt: string;
  attemptId: string;
  attemptStatus: string;
  attemptExpiresAt: string;
  claimSecretHash: string;
  isTest: number;
  testRunId: string | null;
}

interface ThrottleRow {
  windowStartedAt: string;
  attemptCount: number;
}

export interface StartStaffLoginResult {
  attemptCookie: string | null;
  delivery: Promise<void> | null;
}

export type StaffAttemptClaimResult =
  | { state: "none" | "pending" | "expired" | "claimed"; principal: null; cookie: null }
  | { state: "authenticated"; principal: StaffPrincipal; cookie: string };

function addSeconds(date: Date, seconds: number): string {
  return new Date(date.getTime() + seconds * 1000).toISOString();
}

function secondsUntil(value: string, now: Date): number {
  return Math.max(0, Math.ceil((new Date(value).getTime() - now.getTime()) / 1000));
}

function changeCount(result: D1Result<unknown> | undefined): number {
  return result?.meta?.changes ?? 0;
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
    env.APP_ENV,
    values.isTest,
    values.testRunId,
    values.now,
  );
}

function cookie(name: string, token: string, maxAge: number, secure = true): string {
  const parts = [
    `${name}=${encodeURIComponent(token)}`,
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function staffSessionCookie(token: string, secure = true): string {
  return cookie(STAFF_SESSION_COOKIE, token, MAX_STAFF_ABSOLUTE_SECONDS, secure);
}

export function staffAttemptCookie(token: string, maxAge = STAFF_LOGIN_ATTEMPT_TTL_SECONDS, secure = true): string {
  return cookie(STAFF_LOGIN_ATTEMPT_COOKIE, token, maxAge, secure);
}

export function clearStaffSessionCookie(secure = true): string {
  return cookie(STAFF_SESSION_COOKIE, "", 0, secure);
}

export function clearStaffAttemptCookie(secure = true): string {
  return cookie(STAFF_LOGIN_ATTEMPT_COOKIE, "", 0, secure);
}

function readCookie(request: Request, name: string): string {
  const cookieHeader = request.headers.get("Cookie") ?? "";
  for (const part of cookieHeader.split(";")) {
    const [cookieName, ...valueParts] = part.trim().split("=");
    if (cookieName === name) return decodeURIComponent(valueParts.join("="));
  }
  return "";
}

export function readStaffCookie(request: Request): string {
  return readCookie(request, STAFF_SESSION_COOKIE);
}

export function readStaffAttemptCookie(request: Request): string {
  return readCookie(request, STAFF_LOGIN_ATTEMPT_COOKIE);
}

export function staffAuthEmailEnabled(env: WorkerEnv): boolean {
  return staffAuthEmailGate(env);
}

export async function staffLoginEdgeLimitAllowed(env: WorkerEnv, clientIp: string): Promise<boolean> {
  const limiter = env.STAFF_LOGIN_RATE_LIMITER;
  if (!limiter) return env.APP_ENV !== "production";
  try {
    const key = await sha256(`staff-login/ip/${clientIp}`);
    return (await limiter.limit({ key })).success;
  } catch {
    return env.APP_ENV !== "production";
  }
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

async function reusableAttempt(
  env: WorkerEnv,
  rawSecret: string,
  staffAccountId: string | null,
  now: string,
): Promise<StaffAttemptRow | null> {
  if (!rawSecret || rawSecret.length > 256) return null;
  const claimHash = await sha256(rawSecret);
  const attempt = await env.DB.prepare(`
    SELECT
      id, staff_account_id AS staffAccountId, claim_secret_hash AS claimSecretHash,
      status, expires_at AS expiresAt, is_test AS isTest, test_run_id AS testRunId
    FROM staff_login_attempt
    WHERE claim_secret_hash = ? AND status = 'pending' AND expires_at > ?
  `).bind(claimHash, now).first<StaffAttemptRow>();
  if (!attempt || attempt.staffAccountId !== staffAccountId) return null;
  return attempt;
}

export async function startStaffLogin(
  env: WorkerEnv,
  emailInput: string,
  options: StartStaffLoginOptions = {},
): Promise<StartStaffLoginResult> {
  if (!staffAuthEmailEnabled(env)) return { attemptCookie: null, delivery: null };

  const normalizedEmail = normalizeEmail(emailInput.slice(0, 512));
  const nowDate = options.now ?? new Date();
  const now = nowDate.toISOString();
  const clientIp = (options.clientIp ?? "unknown").slice(0, 128);
  if (!validEmail(normalizedEmail) || !await withinLoginLimits(env, normalizedEmail, clientIp, nowDate)) {
    return { attemptCookie: null, delivery: null };
  }
  if (!env.RESEND_API_KEY && !options.provider) {
    throw new EmailConfigurationError("resend_api_key_missing");
  }
  const staff = await env.DB.prepare(`
    SELECT staff_account.id, staff_account_email.email_normalized AS normalizedEmail,
      staff_account.is_test AS isTest, staff_account.test_run_id AS testRunId
    FROM staff_account_email
    INNER JOIN staff_account ON staff_account.id = staff_account_email.staff_account_id
    WHERE staff_account_email.email_normalized = ? AND staff_account.status = 'active'
  `).bind(normalizedEmail).first<StaffAccountRow>();

  let deliveryAddress: ReturnType<typeof resolveStaffDeliveryAddress> | null = null;
  if (staff) {
    try {
      deliveryAddress = resolveStaffDeliveryAddress(
        env.APP_ENV,
        normalizedEmail,
        Boolean(staff.isTest),
        env.STAGING_EMAIL_OVERRIDE_TO,
      );
    } catch {
      throw new EmailConfigurationError("staging_override_missing");
    }
  }

  const reused = await reusableAttempt(env, options.existingAttemptSecret ?? "", staff?.id ?? null, now);
  const rawClaimSecret = reused
    ? options.existingAttemptSecret ?? ""
    : options.rawClaimSecret ?? randomToken();
  const attemptId = reused?.id ?? crypto.randomUUID();
  const attemptExpiresAt = reused?.expiresAt ?? addSeconds(nowDate, STAFF_LOGIN_ATTEMPT_TTL_SECONDS);
  const isTest = staff?.isTest ?? (env.APP_ENV === "staging" ? 1 : 0);
  const testRunId = isTest
    ? staff?.testRunId ?? `staff-login-attempt:${attemptId}`
    : null;

  if (!reused) {
    await env.DB.prepare(`
      INSERT INTO staff_login_attempt (
        id, staff_account_id, claim_secret_hash, status, created_at, expires_at,
        is_test, test_run_id, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `).bind(
      attemptId,
      staff?.id ?? null,
      await sha256(rawClaimSecret),
      now,
      attemptExpiresAt,
      isTest,
      testRunId,
      now,
    ).run();
  }

  const attemptCookie = staffAttemptCookie(rawClaimSecret, secondsUntil(attemptExpiresAt, nowDate), true);
  if (!staff) return { attemptCookie, delivery: null };
  if (!deliveryAddress) throw new EmailConfigurationError("delivery_address_missing");

  const cooldownCutoff = addSeconds(nowDate, -STAFF_LOGIN_COOLDOWN_SECONDS);
  const recent = await env.DB.prepare(`
    SELECT id
    FROM staff_login_challenge
    WHERE staff_account_id = ? AND status = 'pending' AND created_at > ?
    LIMIT 1
  `).bind(staff.id, cooldownCutoff).first<{ id: string }>();
  if (recent) return { attemptCookie, delivery: null };

  const rawToken = options.rawToken ?? randomToken();
  const tokenHash = await sha256(rawToken);
  const requestedIpHash = options.clientIp ? await sha256(clientIp) : null;
  const challengeId = crypto.randomUUID();
  const outboundEmailId = crypto.randomUUID();
  const idempotencyKey = `staff-login/${outboundEmailId}`;
  const challengeExpiresAt = addSeconds(nowDate, Math.min(
    STAFF_MAGIC_LINK_TTL_SECONDS,
    secondsUntil(attemptExpiresAt, nowDate),
  ));

  const queued = await env.DB.batch([
    env.DB.prepare(`
      UPDATE staff_login_challenge
      SET status = 'invalidated', invalidated_at = ?, updated_at = ?
      WHERE login_attempt_id = ? AND status = 'pending'
    `).bind(now, now, attemptId),
    env.DB.prepare(`
      INSERT INTO outbound_email (
        id, event_type, template_key, staff_account_id,
        intended_to_email, actual_delivery_email, delivery_mode, status,
        attempt_count, queued_at, context_json, idempotency_key,
        is_test, test_run_id, created_at, updated_at
      ) VALUES (?, 'staff_login_link_requested', 'staff_login_v2', ?, ?, ?, ?, 'queued',
        0, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      outboundEmailId,
      staff.id,
      normalizedEmail,
      deliveryAddress.actualEmail,
      deliveryAddress.deliveryMode,
      now,
      JSON.stringify({ challenge_id: challengeId, login_attempt_id: attemptId, purpose: "staff_login", expires_at: challengeExpiresAt }),
      idempotencyKey,
      isTest,
      testRunId,
      now,
      now,
    ),
    env.DB.prepare(`
      INSERT INTO staff_login_challenge (
        id, staff_account_id, normalized_email, token_hash, status,
        outbound_email_id, requested_ip_hash, created_at, expires_at,
        is_test, test_run_id, updated_at, login_attempt_id
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      challengeId,
      staff.id,
      normalizedEmail,
      tokenHash,
      outboundEmailId,
      requestedIpHash,
      now,
      challengeExpiresAt,
      isTest,
      testRunId,
      now,
      attemptId,
    ),
  ]);
  if (changeCount(queued[1]) !== 1 || changeCount(queued[2]) !== 1) {
    throw new StaffAuthError("queue_failed");
  }

  const verificationUrl = new URL("/staff/", env.APP_ORIGIN);
  verificationUrl.hash = new URLSearchParams({ token: rawToken }).toString();
  const template = staffLoginTemplate(verificationUrl.toString());
  const provider = options.provider ?? createResendProvider(env.RESEND_API_KEY ?? "");
  const delivery = deliverQueuedEmail(env, provider, {
    id: outboundEmailId,
    idempotencyKey,
    templateKey: "staff_login_v2",
    message: {
      from: env.EMAIL_FROM,
      to: deliveryAddress.actualEmail,
      subject: template.subject,
      html: template.html,
      text: template.text,
    },
  }).then(() => undefined).catch(async (caught) => {
    await env.DB.prepare(`
      UPDATE staff_login_challenge
      SET status = 'delivery_failed', updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).bind(new Date().toISOString(), challengeId).run();
    throw caught;
  });
  return { attemptCookie, delivery };
}

export async function claimStaffLoginAttempt(
  env: WorkerEnv,
  rawClaimSecret: string,
  nowDate = new Date(),
  rawSessionToken = randomToken(),
): Promise<StaffAttemptClaimResult> {
  if (!rawClaimSecret || rawClaimSecret.length > 256) {
    return { state: "none", principal: null, cookie: null };
  }
  const claimHash = await sha256(rawClaimSecret);
  const attempt = await env.DB.prepare(`
    SELECT
      id, staff_account_id AS staffAccountId, claim_secret_hash AS claimSecretHash,
      status, expires_at AS expiresAt, is_test AS isTest, test_run_id AS testRunId
    FROM staff_login_attempt
    WHERE claim_secret_hash = ?
  `).bind(claimHash).first<StaffAttemptRow>();
  if (!attempt) return { state: "none", principal: null, cookie: null };

  const now = nowDate.toISOString();
  if (attempt.expiresAt <= now) {
    await env.DB.prepare(`
      UPDATE staff_login_attempt
      SET status = 'expired', updated_at = ?
      WHERE id = ? AND status IN ('pending', 'approved')
    `).bind(now, attempt.id).run();
    return { state: "expired", principal: null, cookie: null };
  }
  if (attempt.status === "pending") return { state: "pending", principal: null, cookie: null };
  if (attempt.status !== "approved" || !attempt.staffAccountId) {
    return { state: attempt.status === "claimed" ? "claimed" : "expired", principal: null, cookie: null };
  }

  const sessionId = crypto.randomUUID();
  const sessionHash = await sha256(rawSessionToken);
  const physicalExpiresAt = addSeconds(nowDate, MAX_STAFF_ABSOLUTE_SECONDS);
  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO staff_session (
        id, staff_account_id, session_token_hash, created_at, expires_at,
        is_test, test_run_id, last_seen_at
      )
      SELECT ?, staff_login_attempt.staff_account_id, ?, ?, ?,
        staff_login_attempt.is_test, staff_login_attempt.test_run_id, ?
      FROM staff_login_attempt
      JOIN staff_account ON staff_account.id = staff_login_attempt.staff_account_id
      WHERE staff_login_attempt.id = ?
        AND staff_login_attempt.status = 'approved'
        AND staff_login_attempt.expires_at > ?
        AND staff_account.status = 'active'
        AND EXISTS (
          SELECT 1 FROM staff_account_role
          JOIN staff_session_policy ON staff_session_policy.role_code = staff_account_role.role_code
          WHERE staff_account_role.staff_account_id = staff_account.id
        )
    `).bind(sessionId, sessionHash, now, physicalExpiresAt, now, attempt.id, now),
    env.DB.prepare(`
      UPDATE staff_login_attempt
      SET status = 'claimed', claimed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'approved' AND expires_at > ?
        AND EXISTS (SELECT 1 FROM staff_account WHERE id = staff_account_id AND status = 'active')
    `).bind(now, now, attempt.id, now),
    env.DB.prepare(`
      INSERT INTO audit_event (
        id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
        metadata_json, environment, is_test, test_run_id, created_at
      )
      SELECT ?, ?, 'staff', ?, 'staff_login_succeeded', 'staff_session', ?,
        ?, ?, ?, ?, ?
      FROM staff_session WHERE id = ?
    `).bind(
      crypto.randomUUID(),
      now,
      attempt.staffAccountId,
      sessionId,
      JSON.stringify({ method: "email_approval_claim" }),
      env.APP_ENV,
      attempt.isTest,
      attempt.testRunId,
      now,
      sessionId,
    ),
  ]);
  if (changeCount(results[0]) !== 1 || changeCount(results[1]) !== 1) {
    await env.DB.prepare(`
      UPDATE staff_login_attempt
      SET status = 'cancelled', cancelled_at = ?, updated_at = ?
      WHERE id = ? AND status = 'approved'
    `).bind(now, now, attempt.id).run();
    return { state: "expired", principal: null, cookie: null };
  }

  const principal = await resolveStaffPrincipal(env, rawSessionToken, nowDate, "passive");
  if (!principal) throw new StaffAuthError("session_creation_failed");
  return { state: "authenticated", principal, cookie: staffSessionCookie(rawSessionToken, true) };
}

export async function verifyStaffLogin(
  env: WorkerEnv,
  rawToken: string,
  attemptClaimSecret = "",
  _existingSessionToken = "",
  nowDate = new Date(),
  rawSessionToken = randomToken(),
): Promise<{
  principal: StaffPrincipal | null;
  cookie: string | null;
  approved: boolean;
  claimed: boolean;
  alreadySignedIn: boolean;
}> {
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
      staff_login_challenge.login_attempt_id AS attemptId,
      staff_login_attempt.status AS attemptStatus,
      staff_login_attempt.expires_at AS attemptExpiresAt,
      staff_login_attempt.claim_secret_hash AS claimSecretHash,
      staff_login_challenge.is_test AS isTest,
      staff_login_challenge.test_run_id AS testRunId
    FROM staff_login_challenge
    JOIN staff_login_attempt ON staff_login_attempt.id = staff_login_challenge.login_attempt_id
    JOIN staff_account ON staff_account.id = staff_login_challenge.staff_account_id
    WHERE staff_login_challenge.token_hash = ? AND staff_account.status = 'active'
  `).bind(tokenHash).first<StaffChallengeRow>();
  if (!challenge) throw new StaffAuthError("invalid_or_expired_token");

  const now = nowDate.toISOString();
  if (
    challenge.status !== "pending"
    || challenge.attemptStatus !== "pending"
    || challenge.expiresAt <= now
    || challenge.attemptExpiresAt <= now
  ) {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE staff_login_challenge SET status = 'expired', updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).bind(now, challenge.id),
      env.DB.prepare(`
        UPDATE staff_login_attempt SET status = 'expired', updated_at = ?
        WHERE id = ? AND status IN ('pending', 'approved')
      `).bind(now, challenge.attemptId),
    ]);
    throw new StaffAuthError("invalid_or_expired_token");
  }

  const approved = await env.DB.batch([
    env.DB.prepare(`
      UPDATE staff_login_challenge
      SET status = 'used', used_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND expires_at > ?
    `).bind(now, now, challenge.id, now),
    env.DB.prepare(`
      UPDATE staff_login_attempt
      SET status = 'approved', approved_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND expires_at > ?
        AND EXISTS (SELECT 1 FROM staff_account WHERE id = staff_account_id AND status = 'active')
    `).bind(now, now, challenge.attemptId, now),
  ]);
  if (changeCount(approved[0]) !== 1 || changeCount(approved[1]) !== 1) {
    throw new StaffAuthError("invalid_or_expired_token");
  }

  if (attemptClaimSecret && await sha256(attemptClaimSecret) === challenge.claimSecretHash) {
    const claimed = await claimStaffLoginAttempt(env, attemptClaimSecret, nowDate, rawSessionToken);
    if (claimed.state !== "authenticated") throw new StaffAuthError("session_creation_failed");
    return {
      principal: claimed.principal,
      cookie: claimed.cookie,
      approved: true,
      claimed: true,
      alreadySignedIn: false,
    };
  }
  return { principal: null, cookie: null, approved: true, claimed: false, alreadySignedIn: false };
}

export async function revokeStaffSession(
  env: WorkerEnv,
  rawSessionToken: string,
  nowDate = new Date(),
): Promise<void> {
  if (!rawSessionToken || rawSessionToken.length > 256) return;
  const principal = await resolveStaffPrincipal(env, rawSessionToken, nowDate, "passive");
  if (!principal) return;
  const tokenHash = await sha256(rawSessionToken);
  const now = nowDate.toISOString();
  const account = await env.DB.prepare(`
    SELECT is_test AS isTest, test_run_id AS testRunId
    FROM staff_account WHERE id = ?
  `).bind(principal.staffAccountId).first<{ isTest: number; testRunId: string | null }>();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE staff_session SET revoked_at = ?
      WHERE session_token_hash = ? AND revoked_at IS NULL
    `).bind(now, tokenHash),
    staffAuditStatement(env, {
      action: "staff_session_revoked",
      staffAccountId: principal.staffAccountId,
      subjectType: "staff_session",
      subjectId: principal.sessionId,
      now,
      isTest: account?.isTest ?? 0,
      testRunId: account?.testRunId ?? null,
    }),
  ]);
}

function requireSessionAdmin(actor: StaffPrincipal): void {
  if (!hasStaffCapability(actor, "admin.staff.manage")) throw new StaffAuthError("forbidden");
}

export async function revokeStaffSessionById(
  env: WorkerEnv,
  actor: StaffPrincipal,
  sessionId: string,
  nowDate = new Date(),
): Promise<void> {
  requireSessionAdmin(actor);
  const now = nowDate.toISOString();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE staff_session SET revoked_at = ?
      WHERE id = ? AND revoked_at IS NULL AND expired_at IS NULL
    `).bind(now, sessionId),
    env.DB.prepare(`
      INSERT INTO audit_event (
        id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
        metadata_json, environment, is_test, test_run_id, created_at
      )
      SELECT ?, ?, 'staff', ?, 'staff_session_revoked_by_admin', 'staff_session',
        staff_session.id, ?, ?, staff_account.is_test, staff_account.test_run_id, ?
      FROM staff_session
      JOIN staff_account ON staff_account.id = staff_session.staff_account_id
      WHERE staff_session.id = ?
    `).bind(
      crypto.randomUUID(), now, actor.staffAccountId,
      JSON.stringify({ scope: "one" }), env.APP_ENV, now, sessionId,
    ),
  ]);
}

export async function revokeAllStaffSessions(
  env: WorkerEnv,
  actor: StaffPrincipal,
  staffAccountId: string,
  nowDate = new Date(),
): Promise<void> {
  requireSessionAdmin(actor);
  const now = nowDate.toISOString();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE staff_session SET revoked_at = ?
      WHERE staff_account_id = ? AND revoked_at IS NULL AND expired_at IS NULL
    `).bind(now, staffAccountId),
    env.DB.prepare(`
      INSERT INTO audit_event (
        id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
        metadata_json, environment, is_test, test_run_id, created_at
      )
      SELECT ?, ?, 'staff', ?, 'staff_sessions_revoked_by_admin', 'staff_account',
        staff_account.id, ?, ?, staff_account.is_test, staff_account.test_run_id, ?
      FROM staff_account WHERE id = ?
    `).bind(
      crypto.randomUUID(), now, actor.staffAccountId,
      JSON.stringify({ scope: "all" }), env.APP_ENV, now, staffAccountId,
    ),
  ]);
}
