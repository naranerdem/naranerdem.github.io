import type { WorkerEnv } from "../env";
import { EmailProviderError, type EmailMessage, type EmailProvider } from "./provider";

export class EmailConfigurationError extends Error {
  constructor(public readonly code: string) {
    super("Transactional email is not configured.");
    this.name = "EmailConfigurationError";
  }
}

export class EmailDeliveryError extends Error {
  constructor(public readonly code: string) {
    super("Transactional email delivery failed.");
    this.name = "EmailDeliveryError";
  }
}

interface QueuedEmail {
  id: string;
  idempotencyKey: string;
  message: EmailMessage;
}

export async function deliverQueuedEmail(
  env: WorkerEnv,
  provider: EmailProvider,
  email: QueuedEmail,
): Promise<string> {
  let attempts = 0;
  let providerMessageId = "";
  let failureCode = "provider_error";

  while (attempts < 2) {
    attempts += 1;
    try {
      const result = await provider.send(email.message, { idempotencyKey: email.idempotencyKey });
      providerMessageId = result.providerMessageId;
      break;
    } catch (error) {
      const providerError = error instanceof EmailProviderError
        ? error
        : new EmailProviderError("provider_error", false);
      failureCode = providerError.code;
      if (!providerError.retryable || attempts >= 2) break;
    }
  }

  const now = new Date().toISOString();
  if (providerMessageId) {
    await env.DB.prepare(`
      UPDATE outbound_email
      SET status = 'sent', provider_message_id = ?, attempt_count = attempt_count + ?,
          sent_at = ?, failed_at = NULL, failure_code = NULL, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'failed')
    `).bind(providerMessageId, attempts, now, now, email.id).run();
    return providerMessageId;
  }

  await env.DB.prepare(`
    UPDATE outbound_email
    SET status = 'failed', attempt_count = attempt_count + ?, failed_at = ?,
        failure_code = ?, updated_at = ?
    WHERE id = ? AND status IN ('queued', 'failed')
  `).bind(attempts, now, failureCode, now, email.id).run();
  throw new EmailDeliveryError(failureCode);
}
