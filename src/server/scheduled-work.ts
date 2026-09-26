import type { WorkerEnv } from "./env";
import { reconcileInternalEnrollmentConfirmationNotices } from "./email/registration-transactional";
import { finalizeDuePaymentConfirmations, type PaymentFinalizationRecovery } from "./staff/payment-reconciliation";
import { processDuePaymentReminders } from "./staff/payment-reminders";
import { reconcileWaitlistOffers } from "./services/waitlist-offers";

// Each expression produces an isolated Worker invocation. The one-minute
// finalizer stays separate from slower recovery so one scheduler concern
// cannot consume another concern's CPU budget.
export const SCHEDULED_CRONS = {
  dueFinalization: "* * * * *",
  reminders: "1,6,11,16,21,26,31,36,41,46,51,56 * * * *",
  waitlist: "2,17,32,47 * * * *",
  internalNotices: "3,18,33,48 * * * *",
  recovery: "4 * * * *",
} as const;

export type ScheduledWorkKind = keyof typeof SCHEDULED_CRONS;

const RECOVERY_SLICES: PaymentFinalizationRecovery[] = [
  "conditional", "outstanding", "stranded", "additional_admission",
];

export function scheduledWorkKind(cron: string): ScheduledWorkKind | null {
  return (Object.entries(SCHEDULED_CRONS).find(([, expression]) => expression === cron)?.[0] as ScheduledWorkKind | undefined) ?? null;
}

export function scheduledRecoverySlice(now: Date): PaymentFinalizationRecovery {
  return RECOVERY_SLICES[now.getUTCHours() % RECOVERY_SLICES.length];
}

export async function runScheduledWork(cron: string, env: WorkerEnv, now: Date): Promise<ScheduledWorkKind | null> {
  const kind = scheduledWorkKind(cron);
  if (kind === "dueFinalization") {
    await finalizeDuePaymentConfirmations(env, now, { dueBatchSize: 1, recovery: "none" });
  } else if (kind === "reminders") {
    await processDuePaymentReminders(env, now, undefined, { reconciliationBatchSize: 1, dueBatchSize: 1 });
  } else if (kind === "waitlist") {
    await reconcileWaitlistOffers(env, now, 1);
  } else if (kind === "internalNotices") {
    await reconcileInternalEnrollmentConfirmationNotices(env, now, 1);
  } else if (kind === "recovery") {
    await finalizeDuePaymentConfirmations(env, now, {
      processDue: false, recovery: scheduledRecoverySlice(now), recoveryBatchSize: 1,
    });
  }
  return kind;
}
