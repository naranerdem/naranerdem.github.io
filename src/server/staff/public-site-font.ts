import type { WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

export type PublicSiteFont = "sans" | "serif";
export class PublicSiteFontError extends Error { constructor(public readonly code: "forbidden" | "invalid" | "conflict") { super("Public font setting failed."); } }

export async function getPublicSiteFont(env: WorkerEnv): Promise<{ font: PublicSiteFont; updatedAt: string }> {
  const row = await env.DB.prepare("SELECT font, updated_at AS updatedAt FROM public_site_font_setting WHERE singleton = 1").first<{ font: PublicSiteFont; updatedAt: string }>();
  return row ?? { font: "sans", updatedAt: "" };
}

export async function updatePublicSiteFont(env: WorkerEnv, actor: StaffPrincipal, input: { font: unknown; expectedUpdatedAt: unknown }) {
  if (!hasStaffCapability(actor, "admin.settings.manage")) throw new PublicSiteFontError("forbidden");
  if (input.font !== "sans" && input.font !== "serif") throw new PublicSiteFontError("invalid");
  const current = await getPublicSiteFont(env); if (!current.updatedAt || input.expectedUpdatedAt !== current.updatedAt) throw new PublicSiteFontError("conflict");
  const now = new Date().toISOString();
  const result = await env.DB.batch([
    env.DB.prepare("UPDATE public_site_font_setting SET font = ?, updated_at = ? WHERE singleton = 1 AND updated_at = ?").bind(input.font, now, current.updatedAt),
    env.DB.prepare(`INSERT INTO audit_event (id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id, metadata_json, environment, is_test, test_run_id, created_at)
      VALUES (?, ?, 'staff', ?, 'public_site_font_changed', 'public_site_font_setting', '1', ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), now, actor.staffAccountId, JSON.stringify({ font: input.font }), env.APP_ENV, env.APP_ENV === "staging" ? 1 : 0, env.APP_ENV === "staging" ? "public-font" : null, now),
  ]);
  if ((result[0]?.meta?.changes ?? 0) !== 1) throw new PublicSiteFontError("conflict");
  return { font: input.font, updatedAt: now };
}
