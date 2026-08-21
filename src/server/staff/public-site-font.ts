import type { D1Database, D1PreparedStatement, WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

export type PublicSiteFont = "sans" | "serif";
export interface PublicSiteFontSetting { font: PublicSiteFont; updatedAt: string; }
export class PublicSiteFontError extends Error { constructor(public readonly code: "forbidden" | "invalid" | "conflict") { super("Public font setting failed."); } }

function audit(env: WorkerEnv, actor: StaffPrincipal, value: PublicSiteFontSetting, now: string): D1PreparedStatement {
  const isTest = env.APP_ENV === "staging" ? 1 : 0;
  return env.DB.prepare(`INSERT INTO audit_event (
    id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at
  ) VALUES (?, ?, 'staff', ?, 'public_site_font_changed',
    'public_site_font_setting', '1', ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, JSON.stringify({ font: value.font }),
      env.APP_ENV, isTest, isTest ? "staff-settings" : null, now);
}

export async function getPublicSiteFontFromDatabase(database: D1Database): Promise<PublicSiteFontSetting> {
  const row = await database.prepare("SELECT font, updated_at AS updatedAt FROM public_site_font_setting WHERE singleton = 1").first<PublicSiteFontSetting>();
  return row ?? { font: "sans", updatedAt: "" };
}

export async function getPublicSiteFont(env: WorkerEnv): Promise<PublicSiteFontSetting> {
  return getPublicSiteFontFromDatabase(env.DB);
}

export async function getPublicSiteFontForPresentation(env: WorkerEnv): Promise<PublicSiteFontSetting> {
  try { return await getPublicSiteFont(env); } catch { return { font: "sans", updatedAt: "" }; }
}

export async function updatePublicSiteFont(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { font: unknown; expectedUpdatedAt: unknown },
): Promise<PublicSiteFontSetting> {
  if (!hasStaffCapability(actor, "admin.settings.manage")) throw new PublicSiteFontError("forbidden");
  if ((input.font !== "sans" && input.font !== "serif") || typeof input.expectedUpdatedAt !== "string" || !input.expectedUpdatedAt) throw new PublicSiteFontError("invalid");
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE public_site_font_setting SET font = ?, updated_at = ?
    WHERE singleton = 1 AND updated_at = ?`).bind(input.font, now, input.expectedUpdatedAt).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new PublicSiteFontError("conflict");
  const value = { font: input.font, updatedAt: now } satisfies PublicSiteFontSetting;
  await audit(env, actor, value, now).run();
  return value;
}
