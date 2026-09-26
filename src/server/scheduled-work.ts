import type { WorkerEnv } from "./env";
import { reconcileInternalEnrollmentConfirmationNotices } from "./email/registration-transactional";
import { finalizeDuePaymentConfirmations, type PaymentFinalizationRecovery } from "./staff/payment-reconciliation";
import { processDuePaymentReminders } from "./staff/payment-reminders";
import { reconcileWaitlistOffers } from "./services/waitlist-offers";

// One shared expression creates five staggered hourly invocations per Worker.
// The account's production and staging Workers therefore use two of the Free
// plan's five Cron Triggers while keeping expensive concerns isolated.
export const SCHEDULED_CRONS = {
  background: "1,13,25,37,49 * * * *",
} as const;

export type ScheduledWorkKind = keyof typeof SCHEDULED_CRONS;
export type BackgroundWorkKind = "dueFinalization" | "reminders" | "waitlist" | "internalNotices" | "recovery";

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
    case 1: return "dueFinalization";
    case 13: return "reminders";
    case 25: return "waitlist";
    case 37: return "internalNotices";
    case 49: return "recovery";
    default: return null;
  }
}

export async function runScheduledWork(cron: string, env: WorkerEnv, now: Date): Promise<ScheduledWorkKind | null> {
  const kind = scheduledWorkKind(cron);
  if (kind === "background") {
    const background = backgroundWorkKind(now);
    if (background === "dueFinalization") {
      await finalizeDuePaymentConfirmations(env, now, { dueBatchSize: 4, recovery: "none" });
    } else if (background === "reminders") {
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
