import type { D1PreparedStatement, WorkerEnv, WorkerRateLimiter } from "../env";
import { sha256 } from "../auth/crypto";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

export const USAGE_PROTECTION_COLLECTOR_CRON = "*/15 * * * *";
const POLICY_CACHE_MS = 60_000;

export const PAUSABLE_BACKGROUND_WORK = ["reminders", "waitlist", "internalNotices", "recovery"] as const;
export type PausableBackgroundWork = typeof PAUSABLE_BACKGROUND_WORK[number];
export type PublicProtectionPreset = "normal" | "heightened";
export type PublicRequestKind = "registration" | "dynamic" | "message";

export const PUBLIC_REQUEST_LIMITS: Record<PublicProtectionPreset, Record<PublicRequestKind, { limit: number; periodSeconds: number }>> = {
  normal: {
    registration: { limit: 6, periodSeconds: 60 },
    dynamic: { limit: 60, periodSeconds: 60 },
    message: { limit: 4, periodSeconds: 60 },
  },
  heightened: {
    registration: { limit: 2, periodSeconds: 60 },
    dynamic: { limit: 20, periodSeconds: 60 },
    message: { limit: 1, periodSeconds: 60 },
  },
};

export interface UsageProtectionPolicy {
  enforcementMode: "observation";
  // Stored in the original 0069 column for compatibility. The available
  // GraphQL signal is total Worker errors, not a CPU-only counter.
  warningWorkerErrorCount: number;
  pauses: Record<PausableBackgroundWork, boolean>;
  publicProtection: {
    preset: PublicProtectionPreset;
    pauseNewRegistrations: boolean;
    pauseAnonymousMessages: boolean;
  };
  updatedAt: string;
}

export function usageProtectionEvaluation(
  policy: UsageProtectionPolicy,
  usage: { workerErrors: number | null } | null,
  plan: "free" | "paid" | "unknown" = "unknown",
) {
  return {
    plan,
    observationOnly: policy.enforcementMode === "observation",
    workerErrorWarning: usage?.workerErrors != null && usage.workerErrors >= policy.warningWorkerErrorCount,
  };
}

interface StoredPolicy {
  enforcementMode: "observation";
  warningWorkerErrorCount: number;
  pauseReminders: number;
  pauseWaitlist: number;
  pauseInternalNotices: number;
  pauseRecovery: number;
  publicProtectionPreset: PublicProtectionPreset;
  pausePublicRegistrations: number;
  pausePublicMessages: number;
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
  d1PeriodStartsAt: string | null;
  d1PeriodEndsAt: string | null;
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
    warningWorkerErrorCount: Number(row.warningWorkerErrorCount),
    pauses: {
      reminders: Boolean(row.pauseReminders),
      waitlist: Boolean(row.pauseWaitlist),
      internalNotices: Boolean(row.pauseInternalNotices),
      recovery: Boolean(row.pauseRecovery),
    },
    publicProtection: {
      preset: row.publicProtectionPreset,
      pauseNewRegistrations: Boolean(row.pausePublicRegistrations),
      pauseAnonymousMessages: Boolean(row.pausePublicMessages),
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
      warningWorkerErrorCount: policy.warningWorkerErrorCount,
      pauses: policy.pauses,
      publicProtection: policy.publicProtection,
    }), env.APP_ENV, isTest, isTest ? "staff-settings" : null, now);
}

export async function getUsageProtectionPolicy(env: WorkerEnv): Promise<UsageProtectionPolicy> {
  const row = await env.DB.prepare(`SELECT enforcement_mode AS enforcementMode,
    warning_cpu_error_count AS warningWorkerErrorCount, pause_reminders AS pauseReminders,
    pause_waitlist AS pauseWaitlist, pause_internal_notices AS pauseInternalNotices,
    pause_recovery AS pauseRecovery, public_protection_preset AS publicProtectionPreset,
    pause_public_registrations AS pausePublicRegistrations,
    pause_public_messages AS pausePublicMessages, updated_at AS updatedAt
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

export async function getCachedUsageProtectionPolicy(env: WorkerEnv): Promise<UsageProtectionPolicy> {
  return getCachedPolicy(env);
}

export async function isBackgroundWorkPaused(env: WorkerEnv, kind: PausableBackgroundWork): Promise<boolean> {
  return (await getCachedPolicy(env)).pauses[kind];
}

export class PublicRequestProtectionError extends Error {
  constructor(
    public readonly code: "paused" | "limited" | "unavailable",
    public readonly kind: PublicRequestKind,
    public readonly retryAfterSeconds: number,
  ) {
    super("Public request protection rejected the request.");
  }
}

function rateLimiterFor(
  env: WorkerEnv,
  preset: PublicProtectionPreset,
  kind: PublicRequestKind,
): WorkerRateLimiter | undefined {
  if (kind === "registration") return preset === "normal"
    ? env.PUBLIC_REGISTRATION_NORMAL_RATE_LIMITER
    : env.PUBLIC_REGISTRATION_HEIGHTENED_RATE_LIMITER;
  if (kind === "dynamic") return preset === "normal"
    ? env.PUBLIC_DYNAMIC_NORMAL_RATE_LIMITER
    : env.PUBLIC_DYNAMIC_HEIGHTENED_RATE_LIMITER;
  return preset === "normal"
    ? env.PUBLIC_MESSAGE_NORMAL_RATE_LIMITER
    : env.PUBLIC_MESSAGE_HEIGHTENED_RATE_LIMITER;
}

function clientIp(request: Request): string {
  const candidate = request.headers.get("CF-Connecting-IP")?.trim() ?? "";
  return /^[0-9a-fA-F:.]{3,64}$/.test(candidate) ? candidate : "unknown";
}

export async function guardPublicRequest(
  env: WorkerEnv,
  request: Request,
  kind: PublicRequestKind,
): Promise<UsageProtectionPolicy> {
  let policy: UsageProtectionPolicy;
  try {
    policy = await getCachedPolicy(env);
  } catch {
    throw new PublicRequestProtectionError("unavailable", kind, 60);
  }
  if (kind === "registration" && policy.publicProtection.pauseNewRegistrations) {
    throw new PublicRequestProtectionError("paused", kind, 60);
  }
  if (kind === "message" && policy.publicProtection.pauseAnonymousMessages) {
    throw new PublicRequestProtectionError("paused", kind, 60);
  }
  const limiter = rateLimiterFor(env, policy.publicProtection.preset, kind);
  if (!limiter) {
    // Wrangler's local D1/browser harness does not emulate Rate Limiting.
    // Deployed production fails closed; staging deployment binds independent
    // counters, while local disposable coverage supplies explicit fakes.
    if (env.APP_ENV === "production") {
      throw new PublicRequestProtectionError("unavailable", kind, 60);
    }
    return policy;
  }
  const limits = PUBLIC_REQUEST_LIMITS[policy.publicProtection.preset][kind];
  try {
    const key = await sha256(`public-request/${kind}/ip/${clientIp(request)}`);
    if (!(await limiter.limit({ key })).success) {
      throw new PublicRequestProtectionError("limited", kind, limits.periodSeconds);
    }
  } catch (caught) {
    if (caught instanceof PublicRequestProtectionError) throw caught;
    throw new PublicRequestProtectionError("unavailable", kind, 60);
  }
  return policy;
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

function publicProtectionFrom(value: unknown): UsageProtectionPolicy["publicProtection"] | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if ((source.preset !== "normal" && source.preset !== "heightened")
    || typeof source.pauseNewRegistrations !== "boolean"
    || typeof source.pauseAnonymousMessages !== "boolean") return null;
  return {
    preset: source.preset,
    pauseNewRegistrations: source.pauseNewRegistrations,
    pauseAnonymousMessages: source.pauseAnonymousMessages,
  };
}

export async function updateUsageProtectionPolicy(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { warningWorkerErrorCount: number; pauses: unknown; publicProtection: unknown; expectedUpdatedAt: string },
): Promise<UsageProtectionPolicy> {
  if (!hasStaffCapability(actor, "admin.settings.manage")) throw new UsageProtectionError("forbidden");
  const pauses = pausesFrom(input.pauses);
  const publicProtection = publicProtectionFrom(input.publicProtection);
  if (!Number.isInteger(input.warningWorkerErrorCount) || input.warningWorkerErrorCount < 0 || input.warningWorkerErrorCount > 100000 || !pauses || !publicProtection || !input.expectedUpdatedAt) {
    throw new UsageProtectionError("invalid");
  }
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE usage_protection_policy
    SET warning_cpu_error_count = ?, pause_reminders = ?, pause_waitlist = ?,
      pause_internal_notices = ?, pause_recovery = ?, public_protection_preset = ?,
      pause_public_registrations = ?, pause_public_messages = ?, updated_at = ?
    WHERE singleton = 1 AND updated_at = ?`).bind(
    input.warningWorkerErrorCount, Number(pauses.reminders), Number(pauses.waitlist),
    Number(pauses.internalNotices), Number(pauses.recovery), publicProtection.preset,
    Number(publicProtection.pauseNewRegistrations), Number(publicProtection.pauseAnonymousMessages),
    now, input.expectedUpdatedAt,
  ).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new UsageProtectionError("conflict");
  const policy: UsageProtectionPolicy = {
    enforcementMode: "observation", warningWorkerErrorCount: input.warningWorkerErrorCount,
    pauses, publicProtection, updatedAt: now,
  };
  await audit(env, actor, policy, now).run();
  policyCache = { value: policy, expiresAt: Date.now() + POLICY_CACHE_MS };
  return policy;
}

interface WorkerOutcome {
  scriptName: string;
  status: string | null;
  invocations: number | null;
  errors: number | null;
  cpuTimeP50: number | null;
  cpuTimeP99: number | null;
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function safeWorkerOutcomes(value: unknown): WorkerOutcome[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).flatMap((entry) => {
    const dimensions = (entry && typeof entry === "object" ? (entry as Record<string, unknown>).dimensions : null) as Record<string, unknown> | null;
    const sum = (entry && typeof entry === "object" ? (entry as Record<string, unknown>).sum : null) as Record<string, unknown> | null;
    const quantiles = (entry && typeof entry === "object" ? (entry as Record<string, unknown>).quantiles : null) as Record<string, unknown> | null;
    const scriptName = typeof dimensions?.scriptName === "string" ? dimensions.scriptName.slice(0, 120) : null;
    if (!scriptName) return [];
    return [{
      scriptName,
      status: typeof dimensions?.status === "string" ? dimensions.status.slice(0, 120) : null,
      invocations: numberOrNull(sum?.requests),
      errors: numberOrNull(sum?.errors),
      // Provider percentiles describe one outcome group. They are not
      // additive CPU totals and do not identify the collector invocation.
      cpuTimeP50: numberOrNull(quantiles?.cpuTimeP50),
      cpuTimeP99: numberOrNull(quantiles?.cpuTimeP99),
    }];
  });
}

function safeCachedWorkerOutcomes(value: unknown): WorkerOutcome[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).flatMap((entry) => {
    const source = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    if (!source) return [];
    const scriptName = typeof source?.scriptName === "string" ? source.scriptName.slice(0, 120) : null;
    if (!scriptName) return [];
    return [{
      scriptName,
      status: typeof source.status === "string" ? source.status.slice(0, 120) : null,
      invocations: numberOrNull(source.invocations),
      errors: numberOrNull(source.errors),
      cpuTimeP50: numberOrNull(source.cpuTimeP50),
      cpuTimeP99: numberOrNull(source.cpuTimeP99),
    }];
  });
}

function usageConfig(env: WorkerEnv) {
  return {
    token: env.CLOUDFLARE_ANALYTICS_TOKEN,
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    workerName: env.CLOUDFLARE_ANALYTICS_WORKER_NAME,
    d1DatabaseId: env.CLOUDFLARE_ANALYTICS_D1_DATABASE_ID,
  };
}

const USAGE_QUERY = `query UsageProtection($accountTag: string!, $start: string!, $end: string!, $scriptName: string!, $d1Start: Date!, $d1End: Date!, $databaseId: string!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    workersInvocationsAdaptive(limit: 12, filter: { datetime_geq: $start, datetime_lt: $end, scriptName: $scriptName }) {
      dimensions { scriptName status }
      sum { requests errors }
      quantiles { cpuTimeP50 cpuTimeP99 }
    }
    d1AnalyticsAdaptiveGroups(limit: 1, filter: { date_geq: $d1Start, date_leq: $d1End, databaseId: $databaseId }) {
      sum { rowsRead rowsWritten }
    }
  } }
}`;

function completedUtcDay(nowDate: Date) {
  const end = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate()));
  const start = new Date(end.getTime() - 24 * 60 * 60_000);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: start.toISOString().slice(0, 10),
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
  };
}

export async function collectUsageProtection(env: WorkerEnv, nowDate = new Date(), fetcher: typeof fetch = fetch): Promise<"available" | "unavailable" | "failed"> {
  const config = usageConfig(env);
  if (!config.token || !config.accountId || !config.workerName || !config.d1DatabaseId) return "unavailable";
  const end = nowDate.toISOString();
  const start = new Date(nowDate.getTime() - 24 * 60 * 60_000).toISOString();
  const d1Period = completedUtcDay(nowDate);
  let state: {
    collectorStatus: "available" | "unavailable" | "failed";
    source: string; workerInvocations: number | null; workerErrors: number | null;
    cpuLimitErrors: number | null; workerVersionsJson: string | null;
    d1RowsRead: number | null; d1RowsWritten: number | null;
    sampled: number; detailCode: string | null;
  };
  try {
    const response = await fetcher("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: USAGE_QUERY, variables: {
        accountTag: config.accountId,
        start,
        end,
        scriptName: config.workerName,
        d1Start: d1Period.startDate,
        d1End: d1Period.endDate,
        databaseId: config.d1DatabaseId,
      } }),
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const data = body?.data as Record<string, unknown> | undefined;
    const viewer = data?.viewer as Record<string, unknown> | undefined;
    const account = (viewer?.accounts as Array<Record<string, unknown>> | undefined)?.[0];
    const groups = account?.workersInvocationsAdaptive;
    if (!response.ok || !Array.isArray(groups)) throw new Error("analytics_unavailable");
    const workerOutcomes = safeWorkerOutcomes(groups);
    const d1Groups = account?.d1AnalyticsAdaptiveGroups;
    const d1Sum = Array.isArray(d1Groups) && d1Groups.length === 1 && d1Groups[0] && typeof d1Groups[0] === "object"
      ? (d1Groups[0] as Record<string, unknown>).sum as Record<string, unknown> | undefined
      : undefined;
    const d1RowsRead = numberOrNull(d1Sum?.rowsRead);
    const d1RowsWritten = numberOrNull(d1Sum?.rowsWritten);
    const d1Unavailable = d1RowsRead == null || d1RowsWritten == null;
    state = {
      // The bounded query does not return sampling metadata. Do not label a
      // successful aggregate as sampled merely because it came from analytics.
      collectorStatus: "available", source: "cloudflare_graphql_workers", sampled: 0,
      workerInvocations: workerOutcomes.reduce((total, entry) => total + (entry.invocations ?? 0), 0),
      workerErrors: workerOutcomes.reduce((total, entry) => total + (entry.errors ?? 0), 0),
      // This aggregate has no CPU-limit counter. Keep it null rather than
      // translating elapsed time or percentiles into a CPU-limit result.
      cpuLimitErrors: null,
      workerVersionsJson: JSON.stringify({ workerOutcomes }),
      d1RowsRead,
      d1RowsWritten,
      detailCode: d1Unavailable ? "cpu_not_exposed_d1_unavailable" : "cpu_not_exposed",
    };
  } catch {
    state = { collectorStatus: "failed", source: "cloudflare_graphql_workers", workerInvocations: null, workerErrors: null, cpuLimitErrors: null, workerVersionsJson: null, d1RowsRead: null, d1RowsWritten: null, sampled: 0, detailCode: "analytics_request_failed" };
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
    d1_rows_written, d1_period_starts_at, d1_period_ends_at, sampled, detail_code, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(environment) DO UPDATE SET collector_status = excluded.collector_status,
    source = excluded.source, observed_at = excluded.observed_at, attempted_at = excluded.attempted_at,
    period_starts_at = excluded.period_starts_at, period_ends_at = excluded.period_ends_at,
    worker_invocations = excluded.worker_invocations, worker_errors = excluded.worker_errors,
    cpu_limit_errors = excluded.cpu_limit_errors, worker_versions_json = excluded.worker_versions_json,
    d1_rows_read = excluded.d1_rows_read, d1_rows_written = excluded.d1_rows_written,
    d1_period_starts_at = excluded.d1_period_starts_at,
    d1_period_ends_at = excluded.d1_period_ends_at,
    sampled = excluded.sampled,
    detail_code = excluded.detail_code, updated_at = excluded.updated_at`).bind(
    env.APP_ENV, state.collectorStatus, state.source, state.collectorStatus === "available" ? now : null,
    now, start, end, state.workerInvocations, state.workerErrors, state.cpuLimitErrors,
    state.workerVersionsJson, state.d1RowsRead, state.d1RowsWritten,
    d1Period.startsAt, d1Period.endsAt, state.sampled, state.detailCode, now,
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
      d1_rows_written AS d1RowsWritten, d1_period_starts_at AS d1PeriodStartsAt,
      d1_period_ends_at AS d1PeriodEndsAt, sampled, detail_code AS detailCode,
      updated_at AS updatedAt FROM usage_protection_cache WHERE environment = ?`).bind(env.APP_ENV).first<StoredUsage>(),
  ]);
  const config = usageConfig(env);
  let workerOutcomes: WorkerOutcome[] = [];
  try {
    const details = cache?.workerVersionsJson ? JSON.parse(cache.workerVersionsJson) : null;
    workerOutcomes = safeCachedWorkerOutcomes(details?.workerOutcomes ?? details);
  } catch { workerOutcomes = []; }
  const evaluation = usageProtectionEvaluation(policy, cache ? { workerErrors: cache.workerErrors } : null);
  return {
    environment: env.APP_ENV,
    policy,
    collector: {
      intervalMinutes: 15,
      configured: Boolean(config.token && config.accountId && config.workerName && config.d1DatabaseId),
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
      workerInvocations: cache.workerInvocations,
      workerErrors: cache.workerErrors,
      cpuLimitErrors: cache.cpuLimitErrors,
      workerOutcomes,
      d1RowsRead: cache.d1RowsRead, d1RowsWritten: cache.d1RowsWritten,
      d1PeriodStartsAt: cache.d1PeriodStartsAt, d1PeriodEndsAt: cache.d1PeriodEndsAt,
      workerErrorWarning: evaluation.workerErrorWarning,
    } : null,
    evaluation,
  };
}

export function resetUsageProtectionPolicyCacheForTest() { policyCache = null; }
