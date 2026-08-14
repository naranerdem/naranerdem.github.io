import type { D1Result, WorkerEnv } from "../env";
import { resolveDeliveryAddress } from "../email/delivery-policy";
import { createResendProvider } from "../email/resend";
import { EmailConfigurationError, deliverQueuedEmail } from "../email/service";
import { emailVerificationTemplate } from "../email/templates/email-verification";
import { registrationConfirmationTemplate } from "../email/templates/registration-confirmation";
import {
  challengeForTokenHash,
  confirmRegistrationChallenge,
  sessionOwnsDraft,
} from "../services/registration-submission";
import { randomToken, sha256 } from "./crypto";
import { normalizeEmail, validEmail } from "./email-address";

export const REGISTRATION_PROVISIONAL_HOLD_TTL_SECONDS = 20 * 60;
export const REGISTRATION_CONFIRMATION_TTL_SECONDS = 24 * 60 * 60;
export const AUTH_MAGIC_LINK_TTL_SECONDS = 15 * 60;
export const VERIFIED_EMAIL_SESSION_TTL_SECONDS = 60 * 60;
export const VERIFIED_EMAIL_COOKIE = "naran_verified_email";

export class EmailVerificationError extends Error {
  constructor(public readonly code: string) {
    super("Email verification failed.");
    this.name = "EmailVerificationError";
  }
}

function addSeconds(date: Date, seconds: number): string {
  return new Date(date.getTime() + seconds * 1000).toISOString();
}

function changeCount(result: D1Result<unknown> | undefined): number {
  return result?.meta?.changes ?? 0;
}

export function verifiedEmailCookie(token: string, secure = true): string {
  const parts = [
    `${VERIFIED_EMAIL_COOKIE}=${encodeURIComponent(token)}`,
    `Max-Age=${VERIFIED_EMAIL_SESSION_TTL_SECONDS}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

interface StartEmailVerificationOptions {
  registrationDraftId?: string;
  invalidatePrevious?: boolean;
}

export async function startEmailVerification(
  env: WorkerEnv,
  emailInput: string,
  options: StartEmailVerificationOptions = {},
) {
  if (env.EMAIL_ENABLED !== "true" || env.AUTH_EMAIL_ENABLED !== "true") {
    throw new EmailConfigurationError("auth_email_disabled");
  }
  if (!env.RESEND_API_KEY) throw new EmailConfigurationError("resend_api_key_missing");

  const normalizedEmail = normalizeEmail(emailInput);
  if (!validEmail(normalizedEmail)) throw new EmailVerificationError("invalid_email");

  let delivery;
  try {
    delivery = resolveDeliveryAddress(env.APP_ENV, normalizedEmail, env.STAGING_EMAIL_OVERRIDE_TO);
  } catch {
    throw new EmailConfigurationError("staging_override_missing");
  }

  const nowDate = new Date();
  const now = nowDate.toISOString();
  const expiresAt = addSeconds(nowDate, REGISTRATION_CONFIRMATION_TTL_SECONDS);
  const rawToken = randomToken();
  const tokenHash = await sha256(rawToken);
  const challengeId = crypto.randomUUID();
  const outboundEmailId = crypto.randomUUID();
  const idempotencyKey = `email-verification/${outboundEmailId}`;
  const isTest = env.APP_ENV === "staging" ? 1 : 0;
  const testRunId = isTest
    ? options.registrationDraftId ? `registration:${options.registrationDraftId}` : `email-verification:${challengeId}`
    : null;

  const outboundInsert = env.DB.prepare(`
    INSERT INTO outbound_email (
      id, event_type, template_key, intended_to_email, actual_delivery_email,
      delivery_mode, status, attempt_count, queued_at, context_json,
      idempotency_key, is_test, test_run_id, created_at, updated_at,
      registration_draft_id
    ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    outboundEmailId,
    options.registrationDraftId ? "registration_confirmation_requested" : "email_verification_requested",
    options.registrationDraftId ? "registration_confirmation_v1" : "email_verification_v1",
    normalizedEmail,
    delivery.actualEmail,
    delivery.deliveryMode,
    now,
    JSON.stringify({ challenge_id: challengeId, purpose: "registration_email", expires_at: expiresAt }),
    idempotencyKey,
    isTest,
    testRunId,
    now,
    now,
    options.registrationDraftId ?? null,
  );
  const challengeInsert = env.DB.prepare(`
    INSERT INTO email_verification_challenge (
      id, normalized_email, token_hash, purpose, status, outbound_email_id,
      created_at, expires_at, is_test, test_run_id, updated_at,
      registration_draft_id
    ) VALUES (?, ?, ?, 'registration_email', 'pending', ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    challengeId,
    normalizedEmail,
    tokenHash,
    outboundEmailId,
    now,
    expiresAt,
    isTest,
    testRunId,
    now,
    options.registrationDraftId ?? null,
  );

  const statements = [];
  if (options.registrationDraftId && options.invalidatePrevious) {
    statements.push(env.DB.prepare(`
      UPDATE email_verification_challenge
      SET status = 'invalidated', invalidated_at = ?, updated_at = ?
      WHERE registration_draft_id = ? AND status = 'pending'
    `).bind(now, now, options.registrationDraftId));
  }
  statements.push(outboundInsert, challengeInsert);
  const queued = await env.DB.batch(statements);
  const outboundResult = queued[queued.length - 2];
  const challengeResult = queued[queued.length - 1];
  if (changeCount(outboundResult) !== 1 || changeCount(challengeResult) !== 1) {
    throw new EmailVerificationError("queue_failed");
  }

  const verificationUrl = new URL("/verify-email/", env.APP_ORIGIN);
  verificationUrl.hash = new URLSearchParams({ token: rawToken }).toString();
  const template = options.registrationDraftId
    ? registrationConfirmationTemplate(verificationUrl.toString())
    : emailVerificationTemplate(verificationUrl.toString());
  const provider = createResendProvider(env.RESEND_API_KEY);
  const providerMessageId = await deliverQueuedEmail(env, provider, {
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

  return { challengeId, outboundEmailId, providerMessageId };
}

export async function verifyEmailToken(
  env: WorkerEnv,
  rawToken: string,
  existingSessionToken = "",
  nowDate = new Date(),
) {
  if (!rawToken || rawToken.length > 256) throw new EmailVerificationError("invalid_or_expired_token");

  const tokenHash = await sha256(rawToken);
  const challenge = await challengeForTokenHash(env.DB, tokenHash);
  if (!challenge) throw new EmailVerificationError("invalid_or_expired_token");
  if (challenge.status !== "pending" || challenge.expiresAt <= nowDate.toISOString() || challenge.invalidatedAt) {
    if (
      challenge.status === "used"
      && challenge.registrationDraftId
      && await sessionOwnsDraft(env.DB, existingSessionToken, challenge.registrationDraftId, nowDate)
    ) {
      return {
        sessionId: null,
        cookie: null,
        redirectUrl: new URL("/register/?status=already-verified", env.APP_ORIGIN).toString(),
      };
    }
    throw new EmailVerificationError("invalid_or_expired_token");
  }

  const rawSessionToken = randomToken();
  const sessionTokenHash = await sha256(rawSessionToken);
  const sessionId = crypto.randomUUID();
  const now = nowDate.toISOString();
  const expiresAt = addSeconds(nowDate, VERIFIED_EMAIL_SESSION_TTL_SECONDS);

  if (challenge.registrationDraftId) {
    await confirmRegistrationChallenge(env, challenge, {
      id: sessionId,
      tokenHash: sessionTokenHash,
      createdAt: now,
      expiresAt,
    }, nowDate);
    return {
      sessionId,
      cookie: verifiedEmailCookie(rawSessionToken, true),
      redirectUrl: new URL("/register/?status=confirmed", env.APP_ORIGIN).toString(),
    };
  }

  const sessionInsert = env.DB.prepare(`
    INSERT INTO verified_email_session (
      id, normalized_email, session_token_hash, created_at, expires_at,
      revoked_at, is_test, test_run_id
    )
    SELECT ?, normalized_email, ?, ?, ?, NULL, is_test, test_run_id
    FROM email_verification_challenge
    WHERE token_hash = ? AND status = 'pending' AND expires_at > ? AND invalidated_at IS NULL
  `).bind(sessionId, sessionTokenHash, now, expiresAt, tokenHash, now);
  const challengeUpdate = env.DB.prepare(`
    UPDATE email_verification_challenge
    SET status = 'used', used_at = ?, updated_at = ?
    WHERE token_hash = ? AND status = 'pending' AND expires_at > ? AND invalidated_at IS NULL
  `).bind(now, now, tokenHash, now);

  const consumed = await env.DB.batch([sessionInsert, challengeUpdate]);
  if (changeCount(consumed[0]) !== 1 || changeCount(consumed[1]) !== 1) {
    throw new EmailVerificationError("invalid_or_expired_token");
  }

  return {
    sessionId,
    cookie: verifiedEmailCookie(rawSessionToken, true),
    redirectUrl: new URL("/register/?email=verified", env.APP_ORIGIN).toString(),
  };
}
