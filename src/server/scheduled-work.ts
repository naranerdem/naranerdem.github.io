import type { WorkerEnv } from "./env";
import { reconcileInternalEnrollmentConfirmationNotices } from "./email/registration-transactional";
import { finalizeDuePaymentConfirmations, type PaymentFinalizationRecovery } from "./staff/payment-reconciliation";
import { processDuePaymentReminders } from "./staff/payment-reminders";
import { reconcileWaitlistOffers } from "./services/waitlist-offers";

// The Free plan allows five Cron Triggers per account. Production and staging
// each use these two expressions, leaving one account-wide trigger spare.
// Their minute offsets ensure that due-finalization never shares an invocation
// with an expensive background concern.
export const SCHEDULED_CRONS = {
  dueFinalization: "*/5 * * * *",
  background: "1,16,31,46 * * * *",
} as const;

export type ScheduledWorkKind = keyof typeof SCHEDULED_CRONS;
export type BackgroundWorkKind = "reminders" | "waitlist" | "internalNotices" | "recovery";

const RECOVERY_SLICES: PaymentFinalizationRecovery[] = [
  "conditional", "outstanding", "stranded", "additional_admission",
];

export function scheduledWorkKind(cron: string): ScheduledWorkKind | null {
  return (Object.entries(SCHEDULED_CRONS).find(([, expression]) => expression === cron)?.[0] as ScheduledWorkKind | undefined) ?? null;
}

export function scheduledRecoverySlice(now: Date): PaymentFinalizationRecovery {
  return RECOVERY_SLICES[now.getUTCHours() % RECOVERY_SLICES.length];
}

export function backgroundWorkKind(now: Date): BackgroundWorkKind | null {
  switch (now.getUTCMinutes()) {
    case 1: return "reminders";
    case 16: return "waitlist";
    case 31: return "internalNotices";
    case 46: return "recovery";
    default: return null;
  }
}

export async function runScheduledWork(cron: string, env: WorkerEnv, now: Date): Promise<ScheduledWorkKind | null> {
  const kind = scheduledWorkKind(cron);
  if (kind === "dueFinalization") {
    await finalizeDuePaymentConfirmations(env, now, { dueBatchSize: 4, recovery: "none" });
  } else if (kind === "background") {
    const background = backgroundWorkKind(now);
    if (background === "reminders") {
      await processDuePaymentReminders(env, now, undefined, { reconciliationBatchSize: 8, dueBatchSize: 8 });
    } else if (background === "waitlist") {
      await reconcileWaitlistOffers(env, now, 2);
    } else if (background === "internalNotices") {
      await reconcileInternalEnrollmentConfirmationNotices(env, now, 4);
    } else if (background === "recovery") {
      await finalizeDuePaymentConfirmations(env, now, {
        processDue: false, recovery: scheduledRecoverySlice(now), recoveryBatchSize: 1,
      });
    }
  }
  return kind;
}
