import type { WorkerEnv } from "../env";
import { EmailProviderError, type EmailMessage, type EmailProvider } from "./provider";
import { archiveBccRecipients, emailSensitivityForTemplate, sanitizedOutboxSnapshot } from "./archive-policy";

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
  templateKey: string;
  message: EmailMessage;
}

async function messageForDelivery(env: WorkerEnv, email: QueuedEmail): Promise<EmailMessage> {
  const existing = await env.DB.prepare(`SELECT email_sensitivity AS sensitivity, bcc_recipients_json AS bccRecipientsJson,
    outbox_subject AS outboxSubject FROM outbound_email WHERE id = ?`).bind(email.id)
    .first<{ sensitivity: "archive_bcc_safe" | "sensitive_capability" | null; bccRecipientsJson: string | null; outboxSubject: string | null }>();
  const sensitivity = existing?.sensitivity ?? emailSensitivityForTemplate(email.templateKey);
  let bcc: string[] = [];
  if (existing?.bccRecipientsJson) {
    try { bcc = JSON.parse(existing.bccRecipientsJson) as string[]; } catch { bcc = []; }
  } else {
    // Archival is supplementary; an unavailable archive setting must not block
    // the parent-facing message or any operational state transition.
    try { bcc = await archiveBccRecipients(env, sensitivity); } catch { bcc = []; }
  }
  if (!existing?.outboxSubject) {
    const snapshot = sanitizedOutboxSnapshot(email.message, sensitivity);
    await env.DB.prepare(`UPDATE outbound_email SET email_sensitivity = ?, outbox_subject = ?, outbox_text = ?,
      bcc_recipients_json = ?, updated_at = ? WHERE id = ? AND outbox_subject IS NULL`)
      .bind(sensitivity, snapshot.subject, snapshot.text, JSON.stringify(bcc), new Date().toISOString(), email.id).run();
  }
  return bcc.length ? { ...email.message, bcc } : email.message;
}

export async function deliverQueuedEmail(
  env: WorkerEnv,
  provider: EmailProvider,
  email: QueuedEmail,
): Promise<string> {
  const message = await messageForDelivery(env, email);
  let attempts = 0;
  let providerMessageId = "";
  let failureCode = "provider_error";

  while (attempts < 2) {
    attempts += 1;
    try {
      const result = await provider.send(message, { idempotencyKey: email.idempotencyKey });
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
