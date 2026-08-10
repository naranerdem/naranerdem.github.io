import { handleApiRequest } from "./server/api/router";
import type { WorkerEnv } from "./server/env";

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleApiRequest(request, env);
  },
};
