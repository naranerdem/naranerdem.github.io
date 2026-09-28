import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const directory = mkdtempSync(path.join(tmpdir(), "naranerdem-usage-protection-"));
const databasePath = path.join(directory, "usage.sqlite3");
const bundlePath = path.join(directory, "usage.mjs");
const scheduledPath = path.join(directory, "scheduled.mjs");

function value(value) { return value == null ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`; }
function bind(sql, values) { let index = 0; const out = sql.replaceAll("?", () => value(values[index++])); assert.equal(index, values.length); return out; }
function sqlite(input, json = false) {
  const result = spawnSync("sqlite3", json ? ["-json", databasePath] : [databasePath], { input: `PRAGMA foreign_keys=ON; ${input}`, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`sqlite failed: ${result.stderr}`);
  return result.stdout.trim();
}
class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.database.query(this.sql, this.values)[0] ?? null; }
  async all() { return { success: true, results: this.database.query(this.sql, this.values) }; }
  async run() { const rows = this.database.query(`${this.sql}; SELECT changes() AS changes`, this.values); return { success: true, results: [], meta: { changes: Number(rows.at(-1)?.changes ?? 0) } }; }
}
class SqliteD1 {
  constructor() { this.prepared = []; }
  prepare(sql) { this.prepared.push(sql); return new Statement(this, sql); }
  query(sql, values = []) { const output = sqlite(`${bind(sql, values)};`, true); return output ? JSON.parse(output) : []; }
  async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); }
}

const database = new SqliteD1();
const baseEnv = {
  APP_ENV: "staging", REGISTRATION_WRITE_ENABLED: "true", APP_ORIGIN: "https://staging.example.test",
  EMAIL_ENABLED: "false", AUTH_EMAIL_ENABLED: "false", STAFF_AUTH_EMAIL_ENABLED: "false",
  EMAIL_FROM: "Naran Erdem <test@example.invalid>", DB: database,
};
const admin = { staffAccountId: "admin", capabilities: ["admin.settings.manage"] };
const teacher = { staffAccountId: "teacher", capabilities: ["calendar.manage"] };

try {
  sqlite(readdirSync("migrations").filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort().map((file) => readFileSync(path.join("migrations", file), "utf8")).join("\n"));
  for (const [source, target] of [["src/server/staff/usage-protection.ts", bundlePath], ["src/server/scheduled-work.ts", scheduledPath]]) {
    const result = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), [source, "--bundle", "--format=esm", "--platform=node", `--outfile=${target}`], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  const usage = await import(`${pathToFileURL(bundlePath).href}?usage`);
  const scheduled = await import(`${pathToFileURL(scheduledPath).href}?scheduled`);

  const defaults = await usage.getUsageProtectionOverview(baseEnv);
  assert.equal(defaults.policy.enforcementMode, "observation", "automatic enforcement starts in observation mode");
  assert.deepEqual(defaults.policy.pauses, { reminders: false, waitlist: false, internalNotices: false, recovery: false });
  assert.equal(defaults.collector.configured, false, "missing token remains explicit rather than estimated");
  assert.equal(await usage.collectUsageProtection(baseEnv), "unavailable", "an unconfigured collector makes no network request or diagnostic write");
  assert.equal(database.query("SELECT COUNT(*) AS count FROM usage_protection_cache")[0].count, 0, "unconfigured collection does not churn D1 cache rows");

  await assert.rejects(usage.updateUsageProtectionPolicy(baseEnv, teacher, {
    warningWorkerErrorCount: 1, pauses: defaults.policy.pauses, expectedUpdatedAt: defaults.policy.updatedAt,
  }), /Usage protection/);
  const updated = await usage.updateUsageProtectionPolicy(baseEnv, admin, {
    warningWorkerErrorCount: 3,
    pauses: { reminders: true, waitlist: false, internalNotices: false, recovery: true },
    expectedUpdatedAt: defaults.policy.updatedAt,
  });
  assert.equal(updated.pauses.reminders, true);
  assert.equal(await usage.isBackgroundWorkPaused(baseEnv, "reminders"), true, "manual pause is read before a queued unit begins");
  assert.equal(await usage.isBackgroundWorkPaused(baseEnv, "waitlist"), false);
  assert.equal(database.query("SELECT COUNT(*) AS count FROM audit_event WHERE action = 'usage_protection_policy_changed'")[0].count, 1, "policy change is audited");

  let fetchCalls = 0;
  const configured = {
    ...baseEnv,
    CLOUDFLARE_ANALYTICS_TOKEN: "test-token",
    CLOUDFLARE_ACCOUNT_ID: "account",
    CLOUDFLARE_ANALYTICS_WORKER_NAME: "naran-erdem-staging",
    CLOUDFLARE_ANALYTICS_D1_DATABASE_ID: "d1-staging",
  };
  const status = await usage.collectUsageProtection(configured, new Date("2026-09-27T12:00:00.000Z"), async (url, init) => {
    fetchCalls += 1;
    assert.equal(url, "https://api.cloudflare.com/client/v4/graphql");
    assert.match(init.headers.Authorization, /^Bearer test-token$/);
    const request = JSON.parse(init.body);
    assert.equal(request.variables.d1Start, "2026-09-26", "D1 uses the last complete UTC day");
    assert.equal(request.variables.d1End, "2026-09-26");
    assert.equal(request.variables.databaseId, "d1-staging");
    return new Response(JSON.stringify({ data: { viewer: { accounts: [{
      workersInvocationsAdaptive: [
        { dimensions: { scriptName: "naran-erdem-staging", status: "success" }, sum: { requests: 12, errors: 2 }, quantiles: { cpuTimeP50: 4, cpuTimeP99: 9 } },
      ],
      d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: 345, rowsWritten: 12 } }],
    }] } } }), { status: 200 });
  });
  assert.equal(status, "available");
  assert.equal(fetchCalls, 1, "one collector run makes one bounded account request");
  const observed = await usage.getUsageProtectionOverview(configured);
  assert.equal(observed.usage.workerInvocations, 12);
  assert.equal(observed.usage.workerErrors, 2);
  assert.equal(observed.usage.cpuLimitErrors, null, "missing provider CPU field stays unavailable rather than becoming elapsed time");
  assert.equal(observed.usage.d1RowsRead, 345, "D1 rows read comes from the provider's date-bucketed aggregate");
  assert.equal(observed.usage.d1RowsWritten, 12);
  assert.equal(observed.usage.d1PeriodStartsAt, "2026-09-26T00:00:00.000Z");
  assert.equal(observed.usage.workerOutcomes[0].cpuTimeP99, 9, "CPU quantiles remain per-outcome metadata, not a total");
  assert.equal(observed.collector.sampled, false, "sampling remains unknown unless Cloudflare reports it");
  assert.equal(database.prepared.filter((query) => query.includes("usage_protection_cache")).length >= 2, true, "collector uses a singleton cache read/write path, not a business-history scan");
  assert.equal(usage.usageProtectionEvaluation(updated, { workerErrors: 3 }, "free").observationOnly, true, "Free policy stays in observation mode");
  assert.equal(usage.usageProtectionEvaluation(updated, { workerErrors: 3 }, "paid").workerErrorWarning, true, "the supported Worker-error warning uses the same semantics without a billing change");
  assert.equal(await usage.collectUsageProtection(configured, new Date("2026-09-27T12:15:00.000Z"), async () => { throw new Error("analytics unavailable"); }), "failed");
  const stale = await usage.getUsageProtectionOverview(configured);
  assert.equal(stale.collector.status, "failed", "failed collection is explicit");
  assert.equal(stale.usage.workerInvocations, 12, "failed collection retains the last measured sample instead of clearing it");
  assert.equal(stale.usage.d1RowsRead, 345, "failed collection retains the last D1 aggregate");
  assert.equal(await usage.isBackgroundWorkPaused(configured, "reminders"), true, "metrics failure cannot silently clear a manual pause");
  const resumed = await usage.updateUsageProtectionPolicy(configured, admin, {
    warningWorkerErrorCount: 3,
    pauses: { reminders: false, waitlist: false, internalNotices: false, recovery: false },
    expectedUpdatedAt: stale.policy.updatedAt,
  });
  assert.equal(await usage.isBackgroundWorkPaused(configured, "reminders"), false, "an audited manual resume restores later background work");
  assert.equal(resumed.enforcementMode, "observation", "resume does not turn on automatic enforcement");
  const repaused = await usage.updateUsageProtectionPolicy(configured, admin, {
    warningWorkerErrorCount: 3,
    pauses: { reminders: true, waitlist: false, internalNotices: false, recovery: true },
    expectedUpdatedAt: resumed.updatedAt,
  });
  assert.equal(repaused.pauses.reminders, true);

  // A reminder pause skips work before the reminder mutation path; immediate
  // confirmation remains intentionally outside the pausable job set.
  await scheduled.runScheduledWork(scheduled.SCHEDULED_CRONS.background, configured, new Date("2026-09-27T12:13:00.000Z"));
  assert.equal(await usage.isBackgroundWorkPaused(configured, "recovery"), true);
  assert.equal(scheduled.backgroundWorkKind(new Date("2026-09-27T12:01:00.000Z")), "dueFinalization", "due finalization remains separately scheduled");
  assert.equal(scheduled.scheduledWorkKind(usage.USAGE_PROTECTION_COLLECTOR_CRON), "usageProtection", "usage collection has its own 15-minute trigger");
  const panel = readFileSync("src/pages/staff/settings/usage.astro", "utf8");
  assert.match(panel, /\/api\/staff\/usage-protection/, "admin diagnostics use one dedicated on-demand endpoint");
  assert.doesNotMatch(panel, /setInterval|setTimeout\(.*load/, "admin diagnostics do not continuously poll");
  assert.match(panel, /Төлбөрийн 0 минутын баталгаажуулалт/, "panel documents that immediate confirmation remains synchronous");
  console.log("ok usage-protection policy, bounded collector, observation mode, and pre-mutation background pauses");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
