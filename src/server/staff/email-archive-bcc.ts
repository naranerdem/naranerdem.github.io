import type { D1PreparedStatement, WorkerEnv } from "../env";
import { ArchiveRecipientParseError, parseArchiveRecipients } from "../email/archive-policy";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

export interface EmailArchiveBccSetting {
  adminRecipients: string[];
  teacherRecipients: string[];
  updatedAt: string;
}
export class EmailArchiveBccError extends Error {
  constructor(public readonly code: "forbidden" | "invalid" | "conflict", public readonly invalidRecipient?: string) { super("Email archive setting failed."); }
}

function audit(env: WorkerEnv, actor: StaffPrincipal, value: EmailArchiveBccSetting, now: string): D1PreparedStatement {
  const isTest = env.APP_ENV === "staging" ? 1 : 0;
  return env.DB.prepare(`INSERT INTO audit_event (
    id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at
  ) VALUES (?, ?, 'staff', ?, 'email_archive_bcc_changed', 'email_archive_bcc_setting', '1', ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, JSON.stringify({
      adminRecipientCount: value.adminRecipients.length,
      teacherRecipientCount: value.teacherRecipients.length,
    }), env.APP_ENV, isTest, isTest ? "staff-settings" : null, now);
}

export async function getEmailArchiveBccSetting(env: WorkerEnv): Promise<EmailArchiveBccSetting> {
  const row = await env.DB.prepare(`SELECT recipients_json AS adminRecipientsJson,
    teacher_recipients_json AS teacherRecipientsJson, updated_at AS updatedAt
    FROM email_archive_bcc_setting WHERE singleton = 1`)
    .first<{ adminRecipientsJson: string; teacherRecipientsJson: string; updatedAt: string }>();
  if (!row) return { adminRecipients: [], teacherRecipients: [], updatedAt: "" };
  try {
    return {
      adminRecipients: parseArchiveRecipients(JSON.parse(row.adminRecipientsJson)),
      teacherRecipients: parseArchiveRecipients(JSON.parse(row.teacherRecipientsJson)),
      updatedAt: row.updatedAt,
    };
  } catch {
    return { adminRecipients: [], teacherRecipients: [], updatedAt: row.updatedAt };
  }
}

export async function updateEmailArchiveBccSetting(env: WorkerEnv, actor: StaffPrincipal, input: {
  adminRecipients: unknown; teacherRecipients: unknown; expectedUpdatedAt: unknown;
}): Promise<EmailArchiveBccSetting> {
  if (!hasStaffCapability(actor, "admin.settings.manage")) throw new EmailArchiveBccError("forbidden");
  if (typeof input.expectedUpdatedAt !== "string" || !input.expectedUpdatedAt) throw new EmailArchiveBccError("invalid");
  let adminRecipients: string[];
  let teacherRecipients: string[];
  try {
    adminRecipients = parseArchiveRecipients(input.adminRecipients);
    teacherRecipients = parseArchiveRecipients(input.teacherRecipients);
    if (new Set([...adminRecipients, ...teacherRecipients]).size > 5) throw new ArchiveRecipientParseError();
  } catch (caught) {
    if (caught instanceof ArchiveRecipientParseError) throw new EmailArchiveBccError("invalid", caught.invalidEntry);
    throw new EmailArchiveBccError("invalid");
  }
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE email_archive_bcc_setting
    SET recipients_json = ?, teacher_recipients_json = ?, updated_at = ?
    WHERE singleton = 1 AND updated_at = ?`)
    .bind(JSON.stringify(adminRecipients), JSON.stringify(teacherRecipients), now, input.expectedUpdatedAt).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new EmailArchiveBccError("conflict");
  const value = { adminRecipients, teacherRecipients, updatedAt: now };
  await audit(env, actor, value, now).run();
  return value;
}
