import { handleApiRequest } from "./server/api/router";
import type { WorkerEnv, WorkerExecutionContext, WorkerScheduledController } from "./server/env";
import { handlePublicQrRedirect } from "./server/public-qr-redirects";
import { runScheduledWork } from "./server/scheduled-work";

export default {
  async fetch(request: Request, env: WorkerEnv, context: WorkerExecutionContext): Promise<Response> {
    const qrRedirect = await handlePublicQrRedirect(request, env);
    if (qrRedirect) return qrRedirect;
    return handleApiRequest(request, env, context);
  },
  async scheduled(controller: WorkerScheduledController, env: WorkerEnv, context: WorkerExecutionContext): Promise<void> {
    const now = new Date(controller.scheduledTime);
    context.waitUntil(runScheduledWork(controller.cron, env, now).catch((error) => {
      console.error("Scheduled task failed", controller.cron, error);
    }));
  },
};
