import type { D1PreparedStatement, WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

export const USAGE_PROTECTION_COLLECTOR_CRON = "*/15 * * * *";
const POLICY_CACHE_MS = 60_000;

export const PAUSABLE_BACKGROUND_WORK = ["reminders", "waitlist", "internalNotices", "recovery"] as const;
export type PausableBackgroundWork = typeof PAUSABLE_BACKGROUND_WORK[number];

export interface UsageProtectionPolicy {
  enforcementMode: "observation";
  warningCpuErrorCount: number;
  pauses: Record<PausableBackgroundWork, boolean>;
  updatedAt: string;
}

export function usageProtectionEvaluation(
  policy: UsageProtectionPolicy,
  usage: { cpuLimitErrors: number | null } | null,
  plan: "free" | "paid" | "unknown" = "unknown",
) {
  return {
    plan,
    observationOnly: policy.enforcementMode === "observation",
    cpuWarning: usage?.cpuLimitErrors != null && usage.cpuLimitErrors >= policy.warningCpuErrorCount,
  };
}

interface StoredPolicy {
  enforcementMode: "observation";
  warningCpuErrorCount: number;
  pauseReminders: number;
  pauseWaitlist: number;
  pauseInternalNotices: number;
  pauseRecovery: number;
  updatedAt: string;
}

interface StoredUsage {
  environment: "production" | "staging";
  collectorStatus: "unknown" | "available" | "unavailable" | "failed";
  source: string;
  observedAt: string | null;
  attemptedAt: string | null;
  periodStartsAt: string | null;
  periodEndsAt: string | null;
  workerInvocations: number | null;
  workerErrors: number | null;
  cpuLimitErrors: number | null;
  workerVersionsJson: string | null;
  d1RowsRead: number | null;
  d1RowsWritten: number | null;
  sampled: number;
  detailCode: string | null;
  updatedAt: string;
}

interface CachedPolicy { value: UsageProtectionPolicy; expiresAt: number; }
let policyCache: CachedPolicy | null = null;

export class UsageProtectionError extends Error {
  constructor(public readonly code: "forbidden" | "invalid" | "conflict") {
    super("Usage protection operation failed.");
  }
}

function toPolicy(row: StoredPolicy): UsageProtectionPolicy {
  return {
    enforcementMode: "observation",
    warningCpuErrorCount: Number(row.warningCpuErrorCount),
    pauses: {
      reminders: Boolean(row.pauseReminders),
      waitlist: Boolean(row.pauseWaitlist),
      internalNotices: Boolean(row.pauseInternalNotices),
      recovery: Boolean(row.pauseRecovery),
    },
    updatedAt: row.updatedAt,
  };
}

function audit(env: WorkerEnv, actor: StaffPrincipal, policy: UsageProtectionPolicy, now: string): D1PreparedStatement {
  const isTest = env.APP_ENV === "staging" ? 1 : 0;
  return env.DB.prepare(`INSERT INTO audit_event (
    id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at
  ) VALUES (?, ?, 'staff', ?, 'usage_protection_policy_changed',
    'usage_protection_policy', '1', ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), now, actor.staffAccountId, JSON.stringify({
      enforcementMode: policy.enforcementMode,
      warningCpuErrorCount: policy.warningCpuErrorCount,
      pauses: policy.pauses,
    }), env.APP_ENV, isTest, isTest ? "staff-settings" : null, now);
}

export async function getUsageProtectionPolicy(env: WorkerEnv): Promise<UsageProtectionPolicy> {
  const row = await env.DB.prepare(`SELECT enforcement_mode AS enforcementMode,
    warning_cpu_error_count AS warningCpuErrorCount, pause_reminders AS pauseReminders,
    pause_waitlist AS pauseWaitlist, pause_internal_notices AS pauseInternalNotices,
    pause_recovery AS pauseRecovery, updated_at AS updatedAt
    FROM usage_protection_policy WHERE singleton = 1`).first<StoredPolicy>();
  if (!row) throw new UsageProtectionError("invalid");
  return toPolicy(row);
}

async function getCachedPolicy(env: WorkerEnv): Promise<UsageProtectionPolicy> {
  if (policyCache && policyCache.expiresAt > Date.now()) return policyCache.value;
  const value = await getUsageProtectionPolicy(env);
  policyCache = { value, expiresAt: Date.now() + POLICY_CACHE_MS };
  return value;
}

export async function isBackgroundWorkPaused(env: WorkerEnv, kind: PausableBackgroundWork): Promise<boolean> {
  return (await getCachedPolicy(env)).pauses[kind];
}

function pausesFrom(value: unknown): Record<PausableBackgroundWork, boolean> | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const result = {} as Record<PausableBackgroundWork, boolean>;
  for (const key of PAUSABLE_BACKGROUND_WORK) {
    if (typeof source[key] !== "boolean") return null;
    result[key] = source[key] as boolean;
  }
  return result;
}

export async function updateUsageProtectionPolicy(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { warningCpuErrorCount: number; pauses: unknown; expectedUpdatedAt: string },
): Promise<UsageProtectionPolicy> {
  if (!hasStaffCapability(actor, "admin.settings.manage")) throw new UsageProtectionError("forbidden");
  const pauses = pausesFrom(input.pauses);
  if (!Number.isInteger(input.warningCpuErrorCount) || input.warningCpuErrorCount < 0 || input.warningCpuErrorCount > 100000 || !pauses || !input.expectedUpdatedAt) {
    throw new UsageProtectionError("invalid");
  }
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE usage_protection_policy
    SET warning_cpu_error_count = ?, pause_reminders = ?, pause_waitlist = ?,
      pause_internal_notices = ?, pause_recovery = ?, updated_at = ?
    WHERE singleton = 1 AND updated_at = ?`).bind(
    input.warningCpuErrorCount, Number(pauses.reminders), Number(pauses.waitlist),
    Number(pauses.internalNotices), Number(pauses.recovery), now, input.expectedUpdatedAt,
  ).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new UsageProtectionError("conflict");
  const policy: UsageProtectionPolicy = { enforcementMode: "observation", warningCpuErrorCount: input.warningCpuErrorCount, pauses, updatedAt: now };
  await audit(env, actor, policy, now).run();
  policyCache = { value: policy, expiresAt: Date.now() + POLICY_CACHE_MS };
  return policy;
}

function safeVersions(value: unknown): Array<{ scriptName: string; invocations: number | null; errors: number | null }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).flatMap((entry) => {
    const dimensions = (entry && typeof entry === "object" ? (entry as Record<string, unknown>).dimensions : null) as Record<string, unknown> | null;
    const sum = (entry && typeof entry === "object" ? (entry as Record<string, unknown>).sum : null) as Record<string, unknown> | null;
    const scriptName = typeof dimensions?.scriptName === "string" ? dimensions.scriptName.slice(0, 120) : null;
    if (!scriptName) return [];
    return [{ scriptName, invocations: Number.isFinite(Number(sum?.requests)) ? Number(sum?.requests) : null, errors: Number.isFinite(Number(sum?.errors)) ? Number(sum?.errors) : null }];
  });
}

function usageConfig(env: WorkerEnv) {
  return {
    token: env.CLOUDFLARE_ANALYTICS_TOKEN,
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    workerName: env.CLOUDFLARE_ANALYTICS_WORKER_NAME,
  };
}

const WORKER_USAGE_QUERY = `query UsageProtection($accountTag: String!, $start: DateTime!, $end: DateTime!, $scriptName: String!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    workersInvocationsAdaptive(limit: 12, filter: { datetime_geq: $start, datetime_lt: $end, scriptName: $scriptName }) {
      dimensions { scriptName }
      sum { requests errors }
    }
  } }
}`;

export async function collectUsageProtection(env: WorkerEnv, nowDate = new Date(), fetcher: typeof fetch = fetch): Promise<"available" | "unavailable" | "failed"> {
  const config = usageConfig(env);
  if (!config.token || !config.accountId || !config.workerName) return "unavailable";
  const end = nowDate.toISOString();
  const start = new Date(nowDate.getTime() - 24 * 60 * 60_000).toISOString();
  let state: {
    collectorStatus: "available" | "unavailable" | "failed";
    source: string; workerInvocations: number | null; workerErrors: number | null;
    cpuLimitErrors: number | null; workerVersionsJson: string | null;
    sampled: number; detailCode: string | null;
  };
  try {
    const response = await fetcher("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: WORKER_USAGE_QUERY, variables: { accountTag: config.accountId, start, end, scriptName: config.workerName } }),
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const groups = (body?.data as Record<string, unknown> | undefined)?.viewer
      && (((body?.data as Record<string, unknown>).viewer as Record<string, unknown>).accounts as Array<Record<string, unknown>> | undefined)?.[0]?.workersInvocationsAdaptive;
    if (!response.ok || !Array.isArray(groups)) throw new Error("analytics_unavailable");
    const versions = safeVersions(groups);
    state = {
      collectorStatus: "available", source: "cloudflare_graphql_workers", sampled: 1,
      workerInvocations: versions.reduce((total, entry) => total + (entry.invocations ?? 0), 0),
      workerErrors: versions.reduce((total, entry) => total + (entry.errors ?? 0), 0),
      // This account query does not expose a CPU-limit counter or D1 rows.
      // Keep those fields null instead of translating elapsed time into CPU.
      cpuLimitErrors: null, workerVersionsJson: JSON.stringify(versions), detailCode: "cpu_and_d1_not_exposed",
    };
  } catch {
    state = { collectorStatus: "failed", source: "cloudflare_graphql_workers", workerInvocations: null, workerErrors: null, cpuLimitErrors: null, workerVersionsJson: null, sampled: 0, detailCode: "analytics_request_failed" };
  }
  const now = nowDate.toISOString();
  if (state.collectorStatus === "failed") {
    await env.DB.prepare(`INSERT INTO usage_protection_cache (
      environment, collector_status, source, attempted_at, sampled, detail_code, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(environment) DO UPDATE SET collector_status = excluded.collector_status,
      source = excluded.source, attempted_at = excluded.attempted_at,
      sampled = excluded.sampled, detail_code = excluded.detail_code,
      updated_at = excluded.updated_at`).bind(
      env.APP_ENV, state.collectorStatus, state.source, now, state.sampled, state.detailCode, now,
    ).run();
    return state.collectorStatus;
  }
  await env.DB.prepare(`INSERT INTO usage_protection_cache (
    environment, collector_status, source, observed_at, attempted_at, period_starts_at, period_ends_at,
    worker_invocations, worker_errors, cpu_limit_errors, worker_versions_json, d1_rows_read,
    d1_rows_written, sampled, detail_code, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
  ON CONFLICT(environment) DO UPDATE SET collector_status = excluded.collector_status,
    source = excluded.source, observed_at = excluded.observed_at, attempted_at = excluded.attempted_at,
    period_starts_at = excluded.period_starts_at, period_ends_at = excluded.period_ends_at,
    worker_invocations = excluded.worker_invocations, worker_errors = excluded.worker_errors,
    cpu_limit_errors = excluded.cpu_limit_errors, worker_versions_json = excluded.worker_versions_json,
    d1_rows_read = NULL, d1_rows_written = NULL, sampled = excluded.sampled,
    detail_code = excluded.detail_code, updated_at = excluded.updated_at`).bind(
    env.APP_ENV, state.collectorStatus, state.source, state.collectorStatus === "available" ? now : null,
    now, start, end, state.workerInvocations, state.workerErrors, state.cpuLimitErrors,
    state.workerVersionsJson, state.sampled, state.detailCode, now,
  ).run();
  return state.collectorStatus;
}

export async function getUsageProtectionOverview(env: WorkerEnv) {
  const [policy, cache] = await Promise.all([
    getUsageProtectionPolicy(env),
    env.DB.prepare(`SELECT environment, collector_status AS collectorStatus, source,
      observed_at AS observedAt, attempted_at AS attemptedAt, period_starts_at AS periodStartsAt,
      period_ends_at AS periodEndsAt, worker_invocations AS workerInvocations,
      worker_errors AS workerErrors, cpu_limit_errors AS cpuLimitErrors,
      worker_versions_json AS workerVersionsJson, d1_rows_read AS d1RowsRead,
      d1_rows_written AS d1RowsWritten, sampled, detail_code AS detailCode,
      updated_at AS updatedAt FROM usage_protection_cache WHERE environment = ?`).bind(env.APP_ENV).first<StoredUsage>(),
  ]);
  const config = usageConfig(env);
  let versions: Array<{ scriptName: string; invocations: number | null; errors: number | null }> = [];
  try { versions = cache?.workerVersionsJson ? safeVersions(JSON.parse(cache.workerVersionsJson)) : []; } catch { versions = []; }
  const evaluation = usageProtectionEvaluation(policy, cache ? { cpuLimitErrors: cache.cpuLimitErrors } : null);
  return {
    environment: env.APP_ENV,
    policy,
    collector: {
      intervalMinutes: 15,
      configured: Boolean(config.token && config.accountId && config.workerName),
      status: cache?.collectorStatus ?? "unknown",
      source: cache?.source ?? "unavailable",
      observedAt: cache?.observedAt ?? null,
      attemptedAt: cache?.attemptedAt ?? null,
      periodStartsAt: cache?.periodStartsAt ?? null,
      periodEndsAt: cache?.periodEndsAt ?? null,
      sampled: Boolean(cache?.sampled),
      detailCode: cache?.detailCode ?? (config.token ? "configuration_incomplete" : "token_not_configured"),
      propagationDelaySeconds: 60,
    },
    usage: cache ? {
      workerInvocations: cache.workerInvocations, workerErrors: cache.workerErrors,
      cpuLimitErrors: cache.cpuLimitErrors, workerVersions: versions,
      d1RowsRead: cache.d1RowsRead, d1RowsWritten: cache.d1RowsWritten,
      cpuWarning: evaluation.cpuWarning,
    } : null,
    evaluation,
  };
}

export function resetUsageProtectionPolicyCacheForTest() { policyCache = null; }
