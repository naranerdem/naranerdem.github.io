import type { WorkerEnv } from "../env";
import type { EmailMessage } from "./provider";

export type EmailSensitivity = "archive_bcc_safe" | "sensitive_capability";

const archiveSafeTemplateKeys = new Set([
  "registration_receipt_v1",
  "payment_confirmed_v1",
  "payment_reminder_v1",
  "waitlist_payment_instructions_v1",
]);

export function emailSensitivityForTemplate(templateKey: string): EmailSensitivity {
  // New templates are private until deliberately reviewed for archival safety.
  return archiveSafeTemplateKeys.has(templateKey) ? "archive_bcc_safe" : "sensitive_capability";
}

function normalizedEmail(value: string): string | null {
  const email = value.normalize("NFKC").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

export function parseArchiveRecipients(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 5 || value.some((entry) => typeof entry !== "string")) throw new Error("invalid_archive_recipients");
  const recipients = value.map((entry) => normalizedEmail(entry)).filter((entry): entry is string => Boolean(entry));
  if (recipients.length !== value.length || new Set(recipients).size !== recipients.length) throw new Error("invalid_archive_recipients");
  return recipients;
}

function redactCapabilityUrls(value: string): string {
  return value.replace(/https?:\/\/[^\s<>'"`]+/giu, "[аюулгүй холбоос нуусан]");
}

export function sanitizedOutboxSnapshot(message: EmailMessage, sensitivity: EmailSensitivity) {
  return {
    subject: message.subject,
    text: sensitivity === "sensitive_capability" ? redactCapabilityUrls(message.text) : message.text,
  };
}

export async function archiveBccRecipients(env: WorkerEnv, sensitivity: EmailSensitivity): Promise<string[]> {
  if (sensitivity !== "archive_bcc_safe") return [];
  if (env.APP_ENV === "staging") {
    if (!env.STAGING_EMAIL_ARCHIVE_BCC_TO) return [];
    return parseArchiveRecipients(env.STAGING_EMAIL_ARCHIVE_BCC_TO.split(","));
  }
  const row = await env.DB.prepare("SELECT recipients_json AS recipientsJson FROM email_archive_bcc_setting WHERE singleton = 1")
    .first<{ recipientsJson: string }>();
  if (!row) return [];
  try { return parseArchiveRecipients(JSON.parse(row.recipientsJson)); } catch { return []; }
}
