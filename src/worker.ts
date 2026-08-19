import { handleApiRequest } from "./server/api/router";
import type { WorkerEnv, WorkerExecutionContext, WorkerScheduledController } from "./server/env";
import { handlePublicQrRedirect } from "./server/public-qr-redirects";
import { finalizeDuePaymentConfirmations } from "./server/staff/payment-reconciliation";

export default {
  async fetch(request: Request, env: WorkerEnv, context: WorkerExecutionContext): Promise<Response> {
    const qrRedirect = await handlePublicQrRedirect(request, env);
    if (qrRedirect) return qrRedirect;
    return handleApiRequest(request, env, context);
  },
  async scheduled(controller: WorkerScheduledController, env: WorkerEnv, context: WorkerExecutionContext): Promise<void> {
    context.waitUntil(finalizeDuePaymentConfirmations(env, new Date(controller.scheduledTime)));
  },
};
