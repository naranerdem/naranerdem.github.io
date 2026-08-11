import type { WorkerEnv } from "../env";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_TOKEN_LENGTH = 2048;

interface SiteverifyResponse {
  success?: boolean;
  action?: string;
  hostname?: string;
  "error-codes"?: string[];
}

export class TurnstileError extends Error {
  constructor(public readonly code: "missing" | "invalid" | "unavailable" | "configuration") {
    super("Turnstile verification failed.");
    this.name = "TurnstileError";
  }
}

export async function verifyTurnstile(
  env: WorkerEnv,
  token: string,
  remoteIp?: string,
  expectedAction = "registration_submit",
): Promise<void> {
  if (!env.TURNSTILE_SECRET_KEY) throw new TurnstileError("configuration");
  if (!token || token.length > MAX_TOKEN_LENGTH) throw new TurnstileError(token ? "invalid" : "missing");

  const body = new FormData();
  body.set("secret", env.TURNSTILE_SECRET_KEY);
  body.set("response", token);
  body.set("idempotency_key", crypto.randomUUID());
  if (remoteIp) body.set("remoteip", remoteIp);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      body,
      signal: controller.signal,
    });
    if (!response.ok) throw new TurnstileError("unavailable");
    const result = await response.json() as SiteverifyResponse;
    if (!result.success || (result.action && result.action !== expectedAction)) {
      throw new TurnstileError("invalid");
    }
  } catch (caught) {
    if (caught instanceof TurnstileError) throw caught;
    throw new TurnstileError("unavailable");
  } finally {
    clearTimeout(timeout);
  }
}
