import type { D1Database, D1PreparedStatement, WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

export interface WaitlistOfferResponseSetting { responseMinutes: number; updatedAt: string; }
export class WaitlistOfferResponseSettingError extends Error { constructor(public readonly code: "forbidden" | "invalid" | "conflict") { super("Waitlist offer response setting failed."); } }

export async function getWaitlistOfferResponseSetting(database: D1Database): Promise<WaitlistOfferResponseSetting> {
  const row = await database.prepare(`SELECT response_minutes AS responseMinutes, updated_at AS updatedAt FROM waitlist_offer_response_setting WHERE singleton = 1`).first<WaitlistOfferResponseSetting>();
  if (!row) throw new WaitlistOfferResponseSettingError("invalid");
  return { responseMinutes: Number(row.responseMinutes), updatedAt: row.updatedAt };
}

export async function updateWaitlistOfferResponseSetting(env: WorkerEnv, actor: StaffPrincipal, input: WaitlistOfferResponseSetting): Promise<WaitlistOfferResponseSetting> {
  if (!hasStaffCapability(actor, "admin.settings.manage")) throw new WaitlistOfferResponseSettingError("forbidden");
  if (!Number.isInteger(input.responseMinutes) || input.responseMinutes < 1 || input.responseMinutes > 10080 || !input.updatedAt) throw new WaitlistOfferResponseSettingError("invalid");
  const now = new Date().toISOString();
  const updated = await env.DB.prepare(`UPDATE waitlist_offer_response_setting SET response_minutes = ?, updated_at = ? WHERE singleton = 1 AND updated_at = ?`)
    .bind(input.responseMinutes, now, input.updatedAt).run();
  if ((updated.meta?.changes ?? 0) !== 1) throw new WaitlistOfferResponseSettingError("conflict");
  const audit: D1PreparedStatement = env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id, metadata_json, environment, is_test, test_run_id, created_at)
    VALUES (?, ?, 'staff', ?, 'waitlist_offer_response_setting_changed', 'waitlist_offer_response_setting', '1', ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, JSON.stringify({ responseMinutes: input.responseMinutes }), env.APP_ENV, env.APP_ENV === "staging" ? 1 : 0, env.APP_ENV === "staging" ? "staff-settings" : null, now);
  await audit.run(); return { responseMinutes: input.responseMinutes, updatedAt: now };
}
