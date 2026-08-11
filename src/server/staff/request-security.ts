import type { WorkerEnv } from "../env";

export class StaffRequestSecurityError extends Error {
  constructor(public readonly code: "origin_required" | "origin_mismatch") {
    super("Staff request origin check failed.");
    this.name = "StaffRequestSecurityError";
  }
}

function requestOrigin(request: Request): string | null {
  const origin = request.headers.get("Origin");
  if (origin) return origin;
  const referer = request.headers.get("Referer");
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

export function requireSameOrigin(request: Request, env: WorkerEnv): void {
  const supplied = requestOrigin(request);
  if (!supplied) throw new StaffRequestSecurityError("origin_required");
  if (supplied !== new URL(env.APP_ORIGIN).origin) {
    throw new StaffRequestSecurityError("origin_mismatch");
  }
}
