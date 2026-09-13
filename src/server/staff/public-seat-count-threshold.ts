import type { D1Database, D1PreparedStatement, WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

export interface PublicSeatCountThresholdSetting {
  // Null is the explicit backwards-compatible "show all available counts" mode.
  remainingSeatThreshold: number | null;
  updatedAt: string;
}

export class PublicSeatCountThresholdError extends Error {
  constructor(public readonly code: "forbidden" | "invalid" | "conflict") {
    super("Public seat count threshold operation failed.");
  }
}

function audit(env: WorkerEnv, actor: StaffPrincipal, value: PublicSeatCountThresholdSetting, now: string): D1PreparedStatement {
  const isTest = env.APP_ENV === "staging" ? 1 : 0;
  return env.DB.prepare(`INSERT INTO audit_event (
    id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at
  ) VALUES (?, ?, 'staff', ?, 'public_seat_count_threshold_changed',
    'public_seat_count_threshold_setting', '1', ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId,
      JSON.stringify({ remainingSeatThreshold: value.remainingSeatThreshold }), env.APP_ENV,
      isTest, isTest ? "staff-settings" : null, now);
}

export async function getPublicSeatCountThresholdFromDatabase(database: D1Database): Promise<PublicSeatCountThresholdSetting> {
  const row = await database.prepare(`SELECT remaining_seat_threshold AS remainingSeatThreshold,
    updated_at AS updatedAt FROM public_seat_count_threshold_setting WHERE singleton = 1`)
    .first<PublicSeatCountThresholdSetting>();
  if (!row) throw new PublicSeatCountThresholdError("invalid");
  return { ...row, remainingSeatThreshold: row.remainingSeatThreshold == null ? null : Number(row.remainingSeatThreshold) };
}

export async function getPublicSeatCountThreshold(env: WorkerEnv): Promise<PublicSeatCountThresholdSetting> {
  return getPublicSeatCountThresholdFromDatabase(env.DB);
}

export async function updatePublicSeatCountThreshold(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { remainingSeatThreshold: unknown; expectedUpdatedAt: unknown },
): Promise<PublicSeatCountThresholdSetting> {
  if (!hasStaffCapability(actor, "admin.settings.manage")) throw new PublicSeatCountThresholdError("forbidden");
  const value: number | null = input.remainingSeatThreshold === null ? null
    : typeof input.remainingSeatThreshold === "number" ? input.remainingSeatThreshold : Number.NaN;
  if ((value !== null && (!Number.isInteger(value) || value < 0 || value > 1000))
    || typeof input.expectedUpdatedAt !== "string" || !input.expectedUpdatedAt) {
    throw new PublicSeatCountThresholdError("invalid");
  }
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE public_seat_count_threshold_setting
    SET remaining_seat_threshold = ?, updated_at = ? WHERE singleton = 1 AND updated_at = ?`)
    .bind(value, now, input.expectedUpdatedAt).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new PublicSeatCountThresholdError("conflict");
  const setting = { remainingSeatThreshold: value, updatedAt: now } satisfies PublicSeatCountThresholdSetting;
  await audit(env, actor, setting, now).run();
  return setting;
}
