import type { WorkerEnv } from "../env";

export const CLOUDFLARE_TEST_TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
export const CLOUDFLARE_TEST_TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA";

type KnownEnvironment = "staging" | "production";

function environment(env: WorkerEnv): KnownEnvironment | null {
  return env.APP_ENV === "staging" || env.APP_ENV === "production" ? env.APP_ENV : null;
}

function isStagingTestTurnstile(siteKey?: string, secretKey?: string): boolean {
  return siteKey === CLOUDFLARE_TEST_TURNSTILE_SITE_KEY
    && secretKey === CLOUDFLARE_TEST_TURNSTILE_SECRET_KEY;
}

function isProductionTurnstile(siteKey?: string, secretKey?: string): boolean {
  return Boolean(siteKey && secretKey)
    && !isStagingTestTurnstile(siteKey, secretKey);
}

function turnstileReady(env: WorkerEnv, siteKey?: string, secretKey?: string): boolean {
  const currentEnvironment = environment(env);
  if (currentEnvironment === "staging") return isStagingTestTurnstile(siteKey, secretKey);
  if (currentEnvironment === "production") return isProductionTurnstile(siteKey, secretKey);
  return false;
}

export function registrationTurnstileReady(env: WorkerEnv): boolean {
  return turnstileReady(env, env.TURNSTILE_SITE_KEY, env.TURNSTILE_SECRET_KEY);
}

export function registrationWriteEnabled(env: WorkerEnv): boolean {
  const currentEnvironment = environment(env);
  return currentEnvironment !== null
    && env.REGISTRATION_WRITE_ENABLED === "true"
    && registrationTurnstileReady(env);
}

export function staffLoginTurnstileReady(env: WorkerEnv): boolean {
  return turnstileReady(env, env.STAFF_AUTH_TURNSTILE_SITE_KEY, env.STAFF_AUTH_TURNSTILE_SECRET_KEY);
}

export function staffAuthEmailEnabled(env: WorkerEnv): boolean {
  const currentEnvironment = environment(env);
  if (!currentEnvironment
    || env.STAFF_AUTH_EMAIL_ENABLED !== "true"
    || !staffLoginTurnstileReady(env)) return false;

  // Production staff login cannot be considered enabled without the Worker
  // edge limiter. Staging keeps its isolated rehearsal configuration usable.
  return currentEnvironment !== "production" || Boolean(env.STAFF_LOGIN_RATE_LIMITER);
}
