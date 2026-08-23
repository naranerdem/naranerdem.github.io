import { handleApiRequest } from "./server/api/router";
import type { WorkerEnv, WorkerExecutionContext, WorkerScheduledController } from "./server/env";
import { handlePublicQrRedirect } from "./server/public-qr-redirects";
import { finalizeDuePaymentConfirmations } from "./server/staff/payment-reconciliation";
import { processDuePaymentReminders } from "./server/staff/payment-reminders";
import { reconcileWaitlistOffers } from "./server/services/waitlist-offers";

export default {
  async fetch(request: Request, env: WorkerEnv, context: WorkerExecutionContext): Promise<Response> {
    const qrRedirect = await handlePublicQrRedirect(request, env);
    if (qrRedirect) return qrRedirect;
    return handleApiRequest(request, env, context);
  },
  async scheduled(controller: WorkerScheduledController, env: WorkerEnv, context: WorkerExecutionContext): Promise<void> {
    const now = new Date(controller.scheduledTime);
    context.waitUntil(Promise.allSettled([
      finalizeDuePaymentConfirmations(env, now),
      processDuePaymentReminders(env, now),
      reconcileWaitlistOffers(env, now),
    ]));
  },
};
