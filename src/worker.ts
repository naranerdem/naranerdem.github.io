import { handleApiRequest } from "./server/api/router";
import type { WorkerEnv, WorkerExecutionContext } from "./server/env";
import { handlePublicQrRedirect } from "./server/public-qr-redirects";

export default {
  async fetch(request: Request, env: WorkerEnv, context: WorkerExecutionContext): Promise<Response> {
    const qrRedirect = await handlePublicQrRedirect(request, env);
    if (qrRedirect) return qrRedirect;
    return handleApiRequest(request, env, context);
  },
};
