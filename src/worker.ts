import { handleApiRequest } from "./server/api/router";
import type { WorkerEnv, WorkerExecutionContext } from "./server/env";

export default {
  fetch(request: Request, env: WorkerEnv, context: WorkerExecutionContext): Promise<Response> {
    return handleApiRequest(request, env, context);
  },
};
