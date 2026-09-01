import type { WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

type OutboxStatus = "queued" | "sent" | "failed";

export class EmailOutboxError extends Error {
  constructor(public readonly code: "forbidden" | "invalid" | "not_found") {
    super("Email Outbox operation failed.");
  }
}

interface OutboxRow {
  id: string;
  intendedToEmail: string;
  actualDeliveryEmail: string | null;
  deliveryMode: string;
  status: OutboxStatus;
  eventType: string;
  templateKey: string;
  emailSensitivity: string | null;
  outboxSubject: string | null;
  outboxText: string | null;
  bccRecipientsJson: string | null;
  providerMessageId: string | null;
  attemptCount: number;
  failureCode: string | null;
  queuedAt: string;
  sentAt: string | null;
  failedAt: string | null;
  guardianName: string | null;
  childName: string | null;
  classLabel: string | null;
}

const messageTypes: Record<string, string> = {
  email_verification_v1: "И-мэйл баталгаажуулалт",
  registration_confirmation_v1: "Бүртгэлийн баталгаажуулалт",
  staff_login_v2: "Ажилтны нэвтрэх холбоос",
  payment_confirmed_v1: "Төлбөр баталгаажсан",
  payment_reminder_v1: "Төлбөрийн сануулга",
  waitlist_offer_v1: "Хүлээлгийн санал",
  waitlist_payment_instructions_v1: "Хүлээлгийн төлбөрийн заавар",
};

function requireAdmin(actor: StaffPrincipal): void {
  if (!hasStaffCapability(actor, "admin.settings.manage")) throw new EmailOutboxError("forbidden");
}

function status(value: unknown): OutboxStatus | null {
  return value === "queued" || value === "sent" || value === "failed" ? value : null;
}

function search(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").trim().slice(0, 160);
}

function bccRecipients(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : [];
  } catch { return []; }
}

function presentation(row: OutboxRow) {
  return {
    id: row.id,
    intendedToEmail: row.intendedToEmail,
    actualDeliveryEmail: row.actualDeliveryEmail,
    deliveryMode: row.deliveryMode,
    status: row.status,
    messageType: messageTypes[row.templateKey] ?? "Системийн и-мэйл",
    templateKey: row.templateKey,
    subject: row.outboxSubject ?? "Аюулгүй хуучин и-мэйлийн бүртгэл",
    text: row.outboxText ?? "Энэ хуучин и-мэйлийн агуулгын аюулгүй хуулбар хадгалагдаагүй.",
    sensitivity: row.emailSensitivity ?? "sensitive_capability",
    bccRecipients: bccRecipients(row.bccRecipientsJson),
    providerMessageId: row.providerMessageId,
    attemptCount: row.attemptCount,
    failureCode: row.failureCode,
    queuedAt: row.queuedAt,
    sentAt: row.sentAt,
    failedAt: row.failedAt,
    context: {
      guardianName: row.guardianName,
      childName: row.childName,
      classLabel: row.classLabel,
    },
  };
}

const select = `SELECT oe.id, oe.intended_to_email AS intendedToEmail,
  oe.actual_delivery_email AS actualDeliveryEmail, oe.delivery_mode AS deliveryMode,
  oe.status, oe.event_type AS eventType, oe.template_key AS templateKey,
  oe.email_sensitivity AS emailSensitivity, oe.outbox_subject AS outboxSubject,
  oe.outbox_text AS outboxText, oe.bcc_recipients_json AS bccRecipientsJson,
  oe.provider_message_id AS providerMessageId, oe.attempt_count AS attemptCount,
  oe.failure_code AS failureCode, oe.queued_at AS queuedAt, oe.sent_at AS sentAt,
  oe.failed_at AS failedAt, rd.guardian_full_name AS guardianName,
  (SELECT trim(rdc.surname || ' ' || rdc.given_name) FROM registration_draft_child rdc
    WHERE rdc.registration_draft_id = oe.registration_draft_id ORDER BY rdc.position LIMIT 1) AS childName,
  (SELECT cs.stage_code || ' · ' || COALESCE(cmr.weekly_weekday, cs.weekday) || ' ' || COALESCE(cmr.start_time, cs.start_time) FROM registration_draft_child rdc
    LEFT JOIN class_session cs ON cs.id = rdc.selected_class_session_id
    LEFT JOIN class_meeting_rule cmr ON cmr.class_session_id = cs.id
    WHERE rdc.registration_draft_id = oe.registration_draft_id ORDER BY rdc.position LIMIT 1) AS classLabel
  FROM outbound_email oe
  LEFT JOIN registration_draft rd ON rd.id = oe.registration_draft_id`;

export async function listEmailOutbox(env: WorkerEnv, actor: StaffPrincipal, input: { status?: unknown; search?: unknown }) {
  requireAdmin(actor);
  const selectedStatus = input.status === "all" || input.status == null || input.status === "" ? null : status(input.status);
  if (input.status != null && input.status !== "" && input.status !== "all" && !selectedStatus) throw new EmailOutboxError("invalid");
  const query = search(input.search);
  const conditions: string[] = ["oe.status IN ('queued', 'sent', 'failed')"];
  const values: unknown[] = [];
  if (selectedStatus) { conditions.push("oe.status = ?"); values.push(selectedStatus); }
  if (query) {
    conditions.push("(lower(oe.intended_to_email) LIKE ? OR lower(coalesce(oe.outbox_subject, '')) LIKE ?)");
    values.push(`%${query.toLowerCase()}%`, `%${query.toLowerCase()}%`);
  }
  const rows = await env.DB.prepare(`${select} WHERE ${conditions.join(" AND ")} ORDER BY oe.queued_at DESC, oe.id DESC LIMIT 50`)
    .bind(...values).all<OutboxRow>();
  return { emails: rows.results.map(presentation), limit: 50 };
}

export async function getEmailOutboxEntry(env: WorkerEnv, actor: StaffPrincipal, id: string) {
  requireAdmin(actor);
  if (!id || id.length > 120) throw new EmailOutboxError("not_found");
  const row = await env.DB.prepare(`${select} WHERE oe.id = ?`).bind(id).first<OutboxRow>();
  if (!row) throw new EmailOutboxError("not_found");
  return presentation(row);
}
