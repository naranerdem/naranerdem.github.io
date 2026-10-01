import type { D1PreparedStatement, WorkerEnv } from "../env";

// The durable authorization marker is the delivery linearization point. Until
// it exists, cancellation can stop the queued message before any provider call.
export function cancelUnauthorisedPaymentReminderStatements(
  env: WorkerEnv,
  registrationDraftChildId: string,
  now: string,
  milestoneTypes?: readonly string[],
): D1PreparedStatement[] {
  const typeFilter = milestoneTypes?.length
    ? ` AND milestone.milestone_type IN (${milestoneTypes.map(() => "?").join(", ")})`
    : "";
  const typeValues = milestoneTypes ?? [];
  return [
    env.DB.prepare(`UPDATE payment_notification_milestone AS milestone
      SET status = 'cancelled', updated_at = ?
      WHERE milestone.registration_draft_child_id = ?
        AND milestone.status IN ('pending', 'failed', 'sending')
        ${typeFilter}
        AND NOT EXISTS (
          SELECT 1 FROM outbound_email AS email
          WHERE email.id = milestone.outbound_email_id
            AND email.delivery_authorized_at IS NOT NULL
        )`).bind(now, registrationDraftChildId, ...typeValues),
    env.DB.prepare(`UPDATE outbound_email
      SET status = 'cancelled', updated_at = ?
      WHERE status IN ('queued', 'failed')
        AND delivery_authorized_at IS NULL
        AND id IN (
          SELECT outbound_email_id FROM payment_notification_milestone
          WHERE registration_draft_child_id = ? AND status = 'cancelled'
            ${milestoneTypes?.length ? `AND milestone_type IN (${milestoneTypes.map(() => "?").join(", ")})` : ""}
            AND outbound_email_id IS NOT NULL
        )`).bind(now, registrationDraftChildId, ...typeValues),
  ];
}
