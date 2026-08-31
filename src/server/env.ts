export type AppEnvironment = "production" | "staging";

export interface D1Result<T> {
  results: T[];
  success: boolean;
  meta?: {
    changes?: number;
  };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface WorkerRateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface WorkerEnv {
  APP_ENV: AppEnvironment;
  REGISTRATION_WRITE_ENABLED: "true" | "false";
  APP_ORIGIN: string;
  EMAIL_ENABLED: "true" | "false";
  AUTH_EMAIL_ENABLED: "true" | "false";
  STAFF_AUTH_EMAIL_ENABLED: "true" | "false";
  EMAIL_FROM: string;
  RESEND_API_KEY?: string;
  STAGING_EMAIL_OVERRIDE_TO?: string;
  STAGING_AUTH_TEST_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  STAFF_AUTH_TURNSTILE_SITE_KEY?: string;
  STAFF_AUTH_TURNSTILE_SECRET_KEY?: string;
  STAFF_LOGIN_RATE_LIMITER?: WorkerRateLimiter;
  DB: D1Database;
}

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface WorkerScheduledController {
  scheduledTime: number;
}
