export type AppEnvironment = "production" | "staging";

export interface D1Result<T> {
  results: T[];
  success: boolean;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

export interface WorkerEnv {
  APP_ENV: AppEnvironment;
  REGISTRATION_WRITE_ENABLED: "false";
  DB: D1Database;
}
