import type { D1PreparedStatement, WorkerEnv } from "./env";
import { hasStaffCapability, type StaffPrincipal } from "./staff/authorization";

export const PUBLIC_QR_DEFAULT_DESTINATIONS = {
  n: "https://www.facebook.com/naran.erdem.lab",
  t: "https://www.facebook.com/tsenegle",
} as const;

export type PublicQrSlug = keyof typeof PUBLIC_QR_DEFAULT_DESTINATIONS;

export interface PublicQrRedirectSettings {
  nDestinationUrl: string;
  tDestinationUrl: string;
  updatedAt: string | null;
}

interface StoredSettings {
  nDestinationUrl: string;
  tDestinationUrl: string;
  updatedAt: string;
}

export class PublicQrRedirectSettingsError extends Error {
  constructor(public readonly code: "forbidden" | "invalid" | "conflict") {
    super("Public QR redirect settings operation failed.");
    this.name = "PublicQrRedirectSettingsError";
  }
}

function defaults(): PublicQrRedirectSettings {
  return { nDestinationUrl: PUBLIC_QR_DEFAULT_DESTINATIONS.n, tDestinationUrl: PUBLIC_QR_DEFAULT_DESTINATIONS.t, updatedAt: null };
}

function safeOrigin(value: string): string | null {
  try { return new URL(value).origin; } catch { return null; }
}

function validDestination(value: unknown, env: WorkerEnv): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  try {
    const target = new URL(trimmed);
    if (target.protocol !== "https:" || target.username || target.password) return null;
    const path = target.pathname.replace(/\/+$/, "") || "/";
    const appOrigin = safeOrigin(env.APP_ORIGIN);
    if ((target.origin === appOrigin || target.origin === "https://naranerdem.com") && (path === "/qr/n" || path === "/qr/t")) return null;
    return target.toString();
  } catch {
    return null;
  }
}

function fromStored(row: StoredSettings | null, env: WorkerEnv): PublicQrRedirectSettings {
  if (!row) return defaults();
  const nDestinationUrl = validDestination(row.nDestinationUrl, env);
  const tDestinationUrl = validDestination(row.tDestinationUrl, env);
  if (!nDestinationUrl || !tDestinationUrl) return defaults();
  return { nDestinationUrl, tDestinationUrl, updatedAt: row.updatedAt };
}

export async function getPublicQrRedirectSettings(env: WorkerEnv): Promise<PublicQrRedirectSettings> {
  try {
    const row = await env.DB.prepare(`SELECT n_destination_url AS nDestinationUrl,
      t_destination_url AS tDestinationUrl, updated_at AS updatedAt
      FROM public_qr_redirect_settings WHERE singleton = 1`).first<StoredSettings>();
    return fromStored(row, env);
  } catch {
    return defaults();
  }
}

export async function publicQrDestination(env: WorkerEnv, slug: PublicQrSlug): Promise<string> {
  const settings = await getPublicQrRedirectSettings(env);
  return slug === "n" ? settings.nDestinationUrl : settings.tDestinationUrl;
}

function audit(env: WorkerEnv, actor: StaffPrincipal, settings: PublicQrRedirectSettings, now: string): D1PreparedStatement {
  const isTest = env.APP_ENV === "staging" ? 1 : 0;
  return env.DB.prepare(`INSERT INTO audit_event (
    id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at
  ) VALUES (?, ?, 'staff', ?, 'public_qr_redirect_settings_changed',
    'public_qr_redirect_settings', '1', ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId,
      JSON.stringify({ nDestinationUrl: settings.nDestinationUrl, tDestinationUrl: settings.tDestinationUrl }),
      env.APP_ENV, isTest, isTest ? "staff-settings" : null, now);
}

export async function updatePublicQrRedirectSettings(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { nDestinationUrl: unknown; tDestinationUrl: unknown; expectedUpdatedAt: unknown },
): Promise<PublicQrRedirectSettings> {
  if (!hasStaffCapability(actor, "admin.settings.manage")) throw new PublicQrRedirectSettingsError("forbidden");
  const nDestinationUrl = validDestination(input.nDestinationUrl, env);
  const tDestinationUrl = validDestination(input.tDestinationUrl, env);
  if (!nDestinationUrl || !tDestinationUrl) throw new PublicQrRedirectSettingsError("invalid");
  const current = await env.DB.prepare(`SELECT n_destination_url AS nDestinationUrl,
    t_destination_url AS tDestinationUrl, updated_at AS updatedAt
    FROM public_qr_redirect_settings WHERE singleton = 1`).first<StoredSettings>();
  const expectedUpdatedAt = typeof input.expectedUpdatedAt === "string" ? input.expectedUpdatedAt : null;
  if (current && current.updatedAt !== expectedUpdatedAt) throw new PublicQrRedirectSettingsError("conflict");
  if (!current && expectedUpdatedAt) throw new PublicQrRedirectSettingsError("conflict");
  const now = new Date().toISOString();
  const settings = { nDestinationUrl, tDestinationUrl, updatedAt: now };
  if (current) {
    const result = await env.DB.prepare(`UPDATE public_qr_redirect_settings
      SET n_destination_url = ?, t_destination_url = ?, updated_at = ?
      WHERE singleton = 1 AND updated_at = ?`).bind(nDestinationUrl, tDestinationUrl, now, current.updatedAt).run();
    if ((result.meta?.changes ?? 0) !== 1) throw new PublicQrRedirectSettingsError("conflict");
  } else {
    await env.DB.prepare(`INSERT INTO public_qr_redirect_settings (
      singleton, n_destination_url, t_destination_url, updated_at
    ) VALUES (1, ?, ?, ?)`).bind(nDestinationUrl, tDestinationUrl, now).run();
  }
  await audit(env, actor, settings, now).run();
  return settings;
}

export async function handlePublicQrRedirect(request: Request, env: WorkerEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/qr/")) return null;
  if (path !== "/qr/n" && path !== "/qr/t") {
    return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" } });
  }
  return new Response(null, { status: 302, headers: { Location: await publicQrDestination(env, path.slice(-1) as PublicQrSlug), "Cache-Control": "no-store" } });
}
