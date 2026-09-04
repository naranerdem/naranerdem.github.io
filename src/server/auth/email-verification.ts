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

export interface ParentAccessEmail {
  eventType: "enrollment_confirmed" | "parent_enrollment_resend";
  templateKey: "enrollment_confirmation_v1" | "parent_enrollment_resend_v1";
  context: Record<string, unknown>;
  template(accessUrl: string): { subject: string; html: string; text: string };
}

async function issueEmailChallenge(
  env: WorkerEnv,
  emailInput: string,
  input: {
    registrationDraftId?: string;
    invalidatePrevious?: boolean;
    eventType: string;
    templateKey: string;
    context: Record<string, unknown>;
    template(accessUrl: string): { subject: string; html: string; text: string };
  },
) {
  if (env.EMAIL_ENABLED !== "true") throw new EmailConfigurationError("email_disabled");
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
  const idempotencyKey = `${input.eventType}/${outboundEmailId}`;
  const draftProvenance = input.registrationDraftId
    ? await env.DB.prepare(`SELECT is_test AS isTest, test_run_id AS testRunId FROM registration_draft WHERE id = ?`)
      .bind(input.registrationDraftId).first<{ isTest: number; testRunId: string | null }>()
    : null;
  if (input.registrationDraftId && !draftProvenance) throw new EmailVerificationError("registration_not_found");
  const isTest = draftProvenance?.isTest ?? (env.APP_ENV === "staging" ? 1 : 0);
  const testRunId = draftProvenance?.testRunId ?? (isTest ? `email-verification:${challengeId}` : null);

  const outboundInsert = env.DB.prepare(`
    INSERT INTO outbound_email (
      id, event_type, template_key, intended_to_email, actual_delivery_email,
      delivery_mode, status, attempt_count, queued_at, context_json,
      idempotency_key, is_test, test_run_id, created_at, updated_at,
      registration_draft_id
    ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(outboundEmailId, input.eventType, input.templateKey, normalizedEmail, delivery.actualEmail,
    delivery.deliveryMode, now, JSON.stringify({ ...input.context, challenge_id: challengeId, purpose: "registration_email", expires_at: expiresAt }),
    idempotencyKey, isTest, testRunId, now, now, input.registrationDraftId ?? null);
  const challengeInsert = env.DB.prepare(`
    INSERT INTO email_verification_challenge (
      id, normalized_email, token_hash, purpose, status, outbound_email_id,
      created_at, expires_at, is_test, test_run_id, updated_at, registration_draft_id
    ) VALUES (?, ?, ?, 'registration_email', 'pending', ?, ?, ?, ?, ?, ?, ?)
  `).bind(challengeId, normalizedEmail, tokenHash, outboundEmailId, now, expiresAt, isTest, testRunId, now, input.registrationDraftId ?? null);
  const statements = [];
  if (input.registrationDraftId && input.invalidatePrevious) {
    statements.push(env.DB.prepare(`UPDATE email_verification_challenge
      SET status = 'invalidated', invalidated_at = ?, updated_at = ?
      WHERE registration_draft_id = ? AND status = 'pending'`).bind(now, now, input.registrationDraftId));
  }
  statements.push(outboundInsert, challengeInsert);
  const queued = await env.DB.batch(statements);
  if (changeCount(queued[queued.length - 2]) !== 1 || changeCount(queued[queued.length - 1]) !== 1) {
    throw new EmailVerificationError("queue_failed");
  }
  const accessUrl = new URL("/verify-email/", env.APP_ORIGIN);
  accessUrl.hash = new URLSearchParams({ token: rawToken }).toString();
  const template = input.template(accessUrl.toString());
  const provider = createResendProvider(env.RESEND_API_KEY);
  const providerMessageId = await deliverQueuedEmail(env, provider, {
    id: outboundEmailId, idempotencyKey, templateKey: input.templateKey,
    message: { from: env.EMAIL_FROM, to: delivery.actualEmail, subject: template.subject, html: template.html, text: template.text },
  });
  return { challengeId, outboundEmailId, providerMessageId };
}

export async function startEmailVerification(
  env: WorkerEnv,
  emailInput: string,
  options: StartEmailVerificationOptions = {},
) {
  if (env.EMAIL_ENABLED !== "true" || env.AUTH_EMAIL_ENABLED !== "true") {
    throw new EmailConfigurationError("auth_email_disabled");
  }
  return issueEmailChallenge(env, emailInput, {
    registrationDraftId: options.registrationDraftId,
    invalidatePrevious: options.invalidatePrevious,
    eventType: options.registrationDraftId ? "registration_confirmation_requested" : "email_verification_requested",
    templateKey: options.registrationDraftId ? "registration_confirmation_v1" : "email_verification_v1",
    context: {},
    template: (accessUrl) => options.registrationDraftId ? registrationConfirmationTemplate(accessUrl) : emailVerificationTemplate(accessUrl),
  });
}

export async function sendParentAccessEmail(env: WorkerEnv, email: string, registrationDraftId: string, message: ParentAccessEmail) {
  return issueEmailChallenge(env, email, {
    registrationDraftId,
    invalidatePrevious: true,
    eventType: message.eventType,
    templateKey: message.templateKey,
    context: message.context,
    template: message.template,
  });
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
  const source = await env.DB.prepare(`SELECT event_type AS eventType FROM outbound_email WHERE id = ?`)
    .bind(challenge.outboundEmailId).first<{ eventType: string }>();
  const eventType = source?.eventType ?? "";
  if (challenge.status !== "pending" || challenge.expiresAt <= nowDate.toISOString() || challenge.invalidatedAt) {
    if (
      challenge.status === "used"
      && challenge.registrationDraftId
      && await sessionOwnsDraft(env.DB, existingSessionToken, challenge.registrationDraftId, nowDate)
    ) {
      return {
        sessionId: null,
        cookie: null,
        redirectUrl: new URL(
          eventType === "enrollment_confirmed" || eventType === "parent_enrollment_resend"
            ? "/parent/"
            : "/register/?status=already-verified",
          env.APP_ORIGIN,
        ).toString(),
      };
    }
    throw new EmailVerificationError("invalid_or_expired_token");
  }

  const rawSessionToken = randomToken();
  const sessionTokenHash = await sha256(rawSessionToken);
  const sessionId = crypto.randomUUID();
  const now = nowDate.toISOString();
  const expiresAt = addSeconds(nowDate, VERIFIED_EMAIL_SESSION_TTL_SECONDS);

  const isParentAccess = eventType === "enrollment_confirmed" || eventType === "parent_enrollment_resend";
  if (isParentAccess && challenge.registrationDraftId) {
    const sessionInsert = env.DB.prepare(`
      INSERT INTO verified_email_session (
        id, normalized_email, session_token_hash, created_at, expires_at,
        revoked_at, is_test, test_run_id, registration_draft_id
      ) SELECT ?, normalized_email, ?, ?, ?, NULL, is_test, test_run_id, registration_draft_id
        FROM email_verification_challenge
        WHERE id = ? AND status = 'pending' AND expires_at > ? AND invalidated_at IS NULL
    `).bind(sessionId, sessionTokenHash, now, expiresAt, challenge.id, now);
    const challengeUpdate = env.DB.prepare(`UPDATE email_verification_challenge
      SET status = 'used', used_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND expires_at > ? AND invalidated_at IS NULL`)
      .bind(now, now, challenge.id, now);
    const verifiedDraft = env.DB.prepare(`UPDATE registration_draft SET verified_at = COALESCE(verified_at, ?), updated_at = ? WHERE id = ?`)
      .bind(now, now, challenge.registrationDraftId);
    const consumed = await env.DB.batch([sessionInsert, challengeUpdate, verifiedDraft]);
    if (changeCount(consumed[0]) !== 1 || changeCount(consumed[1]) !== 1) {
      throw new EmailVerificationError("invalid_or_expired_token");
    }
    return {
      sessionId,
      cookie: verifiedEmailCookie(rawSessionToken, true),
      redirectUrl: new URL("/parent/", env.APP_ORIGIN).toString(),
    };
  }

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
