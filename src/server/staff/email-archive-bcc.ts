import type { D1PreparedStatement, WorkerEnv } from "../env";
import { parseArchiveRecipients } from "../email/archive-policy";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

export interface EmailArchiveBccSetting { recipients: string[]; updatedAt: string; }
export class EmailArchiveBccError extends Error { constructor(public readonly code: "forbidden" | "invalid" | "conflict") { super("Email archive setting failed."); } }

function audit(env: WorkerEnv, actor: StaffPrincipal, value: EmailArchiveBccSetting, now: string): D1PreparedStatement {
  const isTest = env.APP_ENV === "staging" ? 1 : 0;
  return env.DB.prepare(`INSERT INTO audit_event (
    id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at
  ) VALUES (?, ?, 'staff', ?, 'email_archive_bcc_changed', 'email_archive_bcc_setting', '1', ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, JSON.stringify({ recipientCount: value.recipients.length }), env.APP_ENV, isTest, isTest ? "staff-settings" : null, now);
}

export async function getEmailArchiveBccSetting(env: WorkerEnv): Promise<EmailArchiveBccSetting> {
  const row = await env.DB.prepare("SELECT recipients_json AS recipientsJson, updated_at AS updatedAt FROM email_archive_bcc_setting WHERE singleton = 1")
    .first<{ recipientsJson: string; updatedAt: string }>();
  if (!row) return { recipients: [], updatedAt: "" };
  try { return { recipients: parseArchiveRecipients(JSON.parse(row.recipientsJson)), updatedAt: row.updatedAt }; } catch { return { recipients: [], updatedAt: row.updatedAt }; }
}

export async function updateEmailArchiveBccSetting(env: WorkerEnv, actor: StaffPrincipal, input: { recipients: unknown; expectedUpdatedAt: unknown }): Promise<EmailArchiveBccSetting> {
  if (!hasStaffCapability(actor, "admin.settings.manage")) throw new EmailArchiveBccError("forbidden");
  if (typeof input.expectedUpdatedAt !== "string" || !input.expectedUpdatedAt) throw new EmailArchiveBccError("invalid");
  let recipients: string[];
  try { recipients = parseArchiveRecipients(input.recipients); } catch { throw new EmailArchiveBccError("invalid"); }
  const now = new Date().toISOString();
  const result = await env.DB.prepare("UPDATE email_archive_bcc_setting SET recipients_json = ?, updated_at = ? WHERE singleton = 1 AND updated_at = ?")
    .bind(JSON.stringify(recipients), now, input.expectedUpdatedAt).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new EmailArchiveBccError("conflict");
  const value = { recipients, updatedAt: now };
  await audit(env, actor, value, now).run();
  return value;
}
