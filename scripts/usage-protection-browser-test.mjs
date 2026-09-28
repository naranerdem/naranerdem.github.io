import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { assertDisposableLocalWrangler, failWithoutQuotaRetry } from "./local-disposable-test-target.mjs";

const persistDir = mkdtempSync(path.join(tmpdir(), "naranerdem-usage-protection-browser-"));
const screenshotDir = process.env.USAGE_PROTECTION_SCREENSHOT_DIR || path.join(tmpdir(), "naranerdem-usage-protection-screens");
mkdirSync(screenshotDir, { recursive: true });
const port = 21000 + Math.floor(Math.random() * 300);
const baseUrl = `http://127.0.0.1:${port}`;
const wranglerCli = path.resolve("node_modules/wrangler/wrangler-dist/cli.js");
const now = new Date().toISOString();
let worker;
let browser;
let output = "";

function sql(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function tokenHash(token) { return createHash("sha256").update(token).digest("hex"); }
function runWrangler(args, label) {
  assertDisposableLocalWrangler(args, persistDir, label);
  const result = spawnSync(process.execPath, [wranglerCli, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) failWithoutQuotaRetry(label, result);
}
function execute(command) {
  runWrangler(["d1", "execute", "DB", "--env", "staging", "--local", "--persist-to", persistDir, "--command", command], "usage-protection local setup");
}
async function waitForWorker() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Local Worker did not become ready.\n${output}`);
}
async function signedInContext(staffToken) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([{ name: "naran_staff_session", value: staffToken, url: baseUrl, httpOnly: true, sameSite: "Lax" }]);
  return context;
}
async function waitForUsageApp(page, errors) {
  try {
    await page.locator("#usage-app").waitFor({ state: "visible" });
  } catch (error) {
    const surface = await page.locator("body").getAttribute("data-usage-protection-surface");
    const loadError = await page.locator("#usage-load-error").textContent();
    throw new Error(`Usage panel did not load (surface=${surface}; error=${loadError || "none"}; browserErrors=${errors.join(" | ") || "none"}). ${error.message}`);
  }
}

try {
  runWrangler(["d1", "migrations", "apply", "DB", "--env", "staging", "--local", "--persist-to", persistDir], "usage-protection local migrations");
  const adminToken = randomUUID();
  const teacherToken = randomUUID();
  execute(`
    INSERT INTO staff_account (id, email_normalized, display_name, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('usage-admin', 'usage-admin@example.test', 'Usage Admin', 'active', 1, 'usage-protection-browser', ${sql(now)}, ${sql(now)}),
             ('usage-teacher', 'usage-teacher@example.test', 'Usage Teacher', 'active', 1, 'usage-protection-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO staff_account_role (staff_account_id, role_code, assigned_at)
      VALUES ('usage-admin', 'admin', ${sql(now)}), ('usage-teacher', 'teacher', ${sql(now)});
    INSERT INTO staff_session (id, staff_account_id, session_token_hash, created_at, expires_at, last_seen_at, is_test, test_run_id)
      VALUES ('usage-admin-session', 'usage-admin', ${sql(tokenHash(adminToken))}, ${sql(now)}, '2027-12-31T00:00:00.000Z', ${sql(now)}, 1, 'usage-protection-browser'),
             ('usage-teacher-session', 'usage-teacher', ${sql(tokenHash(teacherToken))}, ${sql(now)}, '2027-12-31T00:00:00.000Z', ${sql(now)}, 1, 'usage-protection-browser');
    INSERT INTO usage_protection_cache (
      environment, collector_status, source, observed_at, attempted_at, period_starts_at, period_ends_at,
      worker_invocations, worker_errors, worker_versions_json, d1_rows_read, d1_rows_written,
      d1_period_starts_at, d1_period_ends_at, sampled, detail_code, updated_at
    ) VALUES (
      'staging', 'available', 'cloudflare_graphql_workers', '2026-09-28T01:30:12.000Z', '2026-09-28T01:30:12.000Z',
      '2026-09-27T01:30:12.000Z', '2026-09-28T01:30:12.000Z', 137, 0,
      '{"workerOutcomes":[{"scriptName":"naran-erdem-staging","status":"success","invocations":137,"errors":0,"cpuTimeP50":4,"cpuTimeP99":9}]}',
      18791, 12, '2026-09-27T00:00:00.000Z', '2026-09-28T00:00:00.000Z', 0, 'cpu_not_exposed', '2026-09-28T01:30:12.000Z'
    );
  `);
  worker = spawn(process.execPath, [wranglerCli, "dev", "--env", "staging", "--local", "--persist-to", persistDir, "--ip", "127.0.0.1", "--port", String(port), "--var", `APP_ORIGIN:${baseUrl}`, "--var", "CLOUDFLARE_ANALYTICS_TOKEN:local-test", "--var", "CLOUDFLARE_ACCOUNT_ID:local-account", "--var", "CLOUDFLARE_ANALYTICS_WORKER_NAME:naran-erdem-staging", "--var", "CLOUDFLARE_ANALYTICS_D1_DATABASE_ID:local-d1"], { stdio: ["ignore", "pipe", "pipe"] });
  worker.stdout.on("data", (chunk) => { output += String(chunk); });
  worker.stderr.on("data", (chunk) => { output += String(chunk); });
  await waitForWorker();
  browser = await chromium.launch({ headless: true });
  const browserErrors = [];

  const adminContext = await signedInContext(adminToken);
  const adminPage = await adminContext.newPage();
  adminPage.on("pageerror", (error) => browserErrors.push(error.message));
  let usageRequests = 0;
  adminPage.on("request", (request) => { if (request.method() === "GET" && request.url().includes("/api/staff/usage-protection")) usageRequests += 1; });
  await adminPage.goto(`${baseUrl}/staff/settings/usage/`);
  await waitForUsageApp(adminPage, browserErrors);
  assert.equal(await adminPage.locator("html").getAttribute("lang"), "en", "the usage page is intentionally English only");
  await assert.doesNotReject(() => adminPage.getByText("Configured", { exact: true }).waitFor({ state: "visible" }));
  await assert.doesNotReject(() => adminPage.getByText("Rolling 24-hour Worker window", { exact: true }).waitFor({ state: "visible" }));
  await assert.doesNotReject(() => adminPage.getByText("Last completed UTC day:", { exact: false }).waitFor({ state: "visible" }));
  await assert.doesNotReject(() => adminPage.getByText("CPU-limit failures", { exact: true }).waitFor({ state: "visible" }));
  await assert.doesNotReject(() => adminPage.getByText(/18.?791\s*\/\s*12/).waitFor({ state: "visible" }));
  await adminPage.getByLabel("Protection preset").selectOption("heightened");
  await adminPage.getByText(/Registration submission: 2 requests per IP \/ minute/i).waitFor({ state: "visible" });
  await adminPage.getByLabel("Pause new public registrations").check();
  await adminPage.getByLabel("Pause anonymous message and link requests").check();
  await adminPage.getByRole("button", { name: "Save policy", exact: true }).click();
  await adminPage.getByText("Policy saved.", { exact: true }).waitFor({ state: "visible" });
  await assert.doesNotReject(() => adminPage.getByLabel("Pause new public registrations").isChecked());
  await adminPage.getByLabel("Protection preset").selectOption("normal");
  await adminPage.getByLabel("Pause new public registrations").uncheck();
  await adminPage.getByLabel("Pause anonymous message and link requests").uncheck();
  await adminPage.getByRole("button", { name: "Save policy", exact: true }).click();
  await adminPage.getByText("Policy saved.", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await adminPage.getByLabel("Pause new public registrations").isChecked(), false, "the test restores the normal, unpaused local policy");
  await adminPage.locator(".usage-technical summary").click();
  await assert.doesNotReject(() => adminPage.getByText(/not total CPU consumption/i).waitFor({ state: "visible" }));
  assert.equal(usageRequests, 1, "a page load reads the cached diagnostics once and does not launch collection work");
  await adminPage.screenshot({ path: path.join(screenshotDir, "usage-protection-admin-desktop.png"), fullPage: true });
  await adminPage.setViewportSize({ width: 390, height: 844 });
  await adminPage.screenshot({ path: path.join(screenshotDir, "usage-protection-admin-mobile.png"), fullPage: true });
  await adminPage.reload();
  await waitForUsageApp(adminPage, browserErrors);
  assert.equal(usageRequests, 2, "a second page load reads the same cache once and does not create a browser polling loop");

  const settingsPage = await adminContext.newPage();
  await settingsPage.goto(`${baseUrl}/staff/settings/`);
  await settingsPage.locator("#tool-app").waitFor({ state: "visible" });
  const navigation = settingsPage.locator(".staff-settings-navigation");
  await navigation.waitFor({ state: "visible" });
  const navigationLinks = await navigation.locator("a").evaluateAll((links) => links.map((link) => ({
    text: link.textContent?.trim(),
    left: link.getBoundingClientRect().left,
    top: link.getBoundingClientRect().top,
    bottom: link.getBoundingClientRect().bottom,
  })));
  assert.deepEqual(navigationLinks.map((link) => link.text), ["Хэрэглээ, хамгаалалт", "Нэвтрэх хугацааны тохиргоо"], "the Mongolian settings links retain their labels");
  assert.equal(navigationLinks[0].left, navigationLinks[1].left, "the settings links share one scoped navigation column");
  assert.ok(navigationLinks[1].top >= navigationLinks[0].bottom, "the settings links are stacked as separate rows");
  await settingsPage.screenshot({ path: path.join(screenshotDir, "staff-settings-navigation-desktop.png"), fullPage: true });
  await settingsPage.setViewportSize({ width: 390, height: 844 });
  await settingsPage.screenshot({ path: path.join(screenshotDir, "staff-settings-navigation-mobile.png"), fullPage: true });
  await settingsPage.close();
  await adminContext.close();

  const teacherContext = await signedInContext(teacherToken);
  const teacherPage = await teacherContext.newPage();
  await teacherPage.goto(`${baseUrl}/staff/settings/usage/`);
  await teacherPage.locator("#usage-denied").waitFor({ state: "visible" });
  assert.equal(await teacherPage.locator("#usage-app").isVisible(), false, "non-admin staff never receive the diagnostics form");
  await teacherContext.close();

  const failedContext = await signedInContext(adminToken);
  const failedPage = await failedContext.newPage();
  await failedPage.route("**/api/staff/usage-protection", async (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Түр алдаа" } }) }));
  await failedPage.goto(`${baseUrl}/staff/settings/usage/`);
  await failedPage.locator("#usage-error").waitFor({ state: "visible" });
  await failedPage.getByRole("button", { name: "Try again", exact: true }).waitFor({ state: "visible" });
  assert.equal(await failedPage.locator("#usage-app").isVisible(), false, "a failed refresh never leaves a writable policy form without a model");
  await failedContext.close();

  const unavailableContext = await signedInContext(adminToken);
  const unavailablePage = await unavailableContext.newPage();
  const unavailablePayload = {
    environment: "staging",
    policy: { warningWorkerErrorCount: 25, pauses: { reminders: false, waitlist: false, internalNotices: false, recovery: false }, publicProtection: { preset: "normal", pauseNewRegistrations: false, pauseAnonymousMessages: false }, updatedAt: "2026-09-28T01:30:12.000Z" },
    collector: { intervalMinutes: 15, configured: false, status: "unavailable", source: "unavailable", observedAt: null, attemptedAt: null, periodStartsAt: null, periodEndsAt: null, sampled: false, detailCode: "token_not_configured", propagationDelaySeconds: 60 },
    usage: null,
    evaluation: { workerErrorWarning: false },
  };
  await unavailablePage.route("**/api/staff/usage-protection", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(unavailablePayload) }));
  await unavailablePage.goto(`${baseUrl}/staff/settings/usage/`);
  await waitForUsageApp(unavailablePage, browserErrors);
  await unavailablePage.getByText("Not configured", { exact: true }).waitFor({ state: "visible" });
  await unavailablePage.getByText("Unavailable", { exact: true }).first().waitFor({ state: "visible" });
  await unavailablePage.locator(".usage-technical summary").click();
  await unavailablePage.getByText(/not configured, so no metrics are estimated/i).waitFor({ state: "visible" });
  await unavailableContext.close();

  assert.deepEqual(browserErrors, [], "usage controls create no browser errors");
  console.log(`ok usage-protection browser (${screenshotDir})`);
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (worker && !worker.killed) worker.kill("SIGTERM");
  rmSync(persistDir, { recursive: true, force: true });
}
