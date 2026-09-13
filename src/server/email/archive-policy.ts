import type { WorkerEnv } from "../env";
import type { EmailMessage } from "./provider";

export type EmailSensitivity = "archive_bcc_safe" | "sensitive_capability";

// These are durable Outbox event types, rather than translated subject lines.
// The final enrollment email carries a parent-access capability, so it remains
// excluded from raw internal copies despite being a teacher-relevant event.
const teacherCopyEventTypes = new Set(["registration_received"]);

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

export class ArchiveRecipientParseError extends Error {
  constructor(public readonly invalidEntry?: string) { super("invalid_archive_recipients"); }
}

function recipientEntries(value: unknown): string[] {
  if (typeof value === "string") return value.split(/[\r\n,]+/).map((entry) => entry.trim()).filter(Boolean);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new ArchiveRecipientParseError();
  return (value as string[]).flatMap((entry) => entry.split(/[\r\n,]+/).map((part) => part.trim()).filter(Boolean));
}

export function parseArchiveRecipients(value: unknown): string[] {
  const entries = recipientEntries(value);
  if (entries.length > 5) throw new ArchiveRecipientParseError();
  const recipients = entries.map((entry) => {
    const email = normalizedEmail(entry);
    if (!email) throw new ArchiveRecipientParseError(entry);
    return email;
  });
  if (new Set(recipients).size !== recipients.length) throw new ArchiveRecipientParseError();
  return recipients;
}

function distinctRecipients(recipients: string[], primaryRecipient: string): string[] {
  const primary = normalizedEmail(primaryRecipient);
  const seen = new Set<string>();
  return recipients.filter((recipient) => {
    if (recipient === primary || seen.has(recipient)) return false;
    seen.add(recipient);
    return true;
  });
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

export async function archiveBccRecipients(env: WorkerEnv, input: {
  eventType: string;
  sensitivity: EmailSensitivity;
  primaryRecipient: string;
}): Promise<string[]> {
  if (input.sensitivity !== "archive_bcc_safe") return [];
  if (env.APP_ENV === "staging") {
    if (!env.STAGING_EMAIL_ARCHIVE_BCC_TO) return [];
    return distinctRecipients(parseArchiveRecipients(env.STAGING_EMAIL_ARCHIVE_BCC_TO.split(",")), input.primaryRecipient);
  }
  const row = await env.DB.prepare(`SELECT recipients_json AS adminRecipientsJson,
    teacher_recipients_json AS teacherRecipientsJson FROM email_archive_bcc_setting WHERE singleton = 1`)
    .first<{ adminRecipientsJson: string; teacherRecipientsJson: string }>();
  if (!row) return [];
  try {
    const adminRecipients = parseArchiveRecipients(JSON.parse(row.adminRecipientsJson));
    const teacherRecipients = teacherCopyEventTypes.has(input.eventType)
      ? parseArchiveRecipients(JSON.parse(row.teacherRecipientsJson))
      : [];
    return distinctRecipients([...adminRecipients, ...teacherRecipients], input.primaryRecipient);
  } catch {
    return [];
  }
}

// The final parent confirmation contains a short-lived parent capability. Its
// internal counterpart therefore resolves recipient lists as a separate email.
export async function internalEnrollmentNoticeRecipients(env: WorkerEnv): Promise<string[]> {
  if (env.APP_ENV === "staging") {
    return env.STAGING_EMAIL_OVERRIDE_TO ? parseArchiveRecipients(env.STAGING_EMAIL_OVERRIDE_TO) : [];
  }
  const row = await env.DB.prepare(`SELECT recipients_json AS adminRecipientsJson,
    teacher_recipients_json AS teacherRecipientsJson FROM email_archive_bcc_setting WHERE singleton = 1`)
    .first<{ adminRecipientsJson: string; teacherRecipientsJson: string }>();
  if (!row) return [];
  try {
    return distinctRecipients([
      ...parseArchiveRecipients(JSON.parse(row.adminRecipientsJson)),
      ...parseArchiveRecipients(JSON.parse(row.teacherRecipientsJson)),
    ], "");
  } catch {
    return [];
  }
}
