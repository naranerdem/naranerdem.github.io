import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, webkit } from "@playwright/test";
import { assertDisposableLocalWrangler, failWithoutQuotaRetry } from "./local-disposable-test-target.mjs";

const persistDir = mkdtempSync(path.join(tmpdir(), "naranerdem-attendance-browser-"));
const screenshotDir = process.env.ATTENDANCE_BROWSER_SCREENSHOT_DIR || path.join(tmpdir(), "naranerdem-attendance-browser-screens");
const browserEngine = process.env.ATTENDANCE_BROWSER_ENGINE === "webkit" ? "webkit" : "chromium";
const rawSessionToken = randomUUID();
const sessionHash = createHash("sha256").update(rawSessionToken).digest("hex");
const port = 20200 + Math.floor(Math.random() * 300);
const baseUrl = `http://127.0.0.1:${port}`;
const wranglerCli = path.resolve("node_modules/wrangler/wrangler-dist/cli.js");
let worker;
let browser;
let context;
let workerOutput = "";

function sql(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function runWrangler(args, label) {
  assertDisposableLocalWrangler(args, persistDir, label);
  const result = spawnSync(process.execPath, [wranglerCli, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) failWithoutQuotaRetry(label, result);
}
function execute(command) {
  runWrangler(["d1", "execute", "DB", "--env", "staging", "--local", "--persist-to", persistDir, "--command", command], "local attendance setup");
}
function localToday() {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ulaanbaatar", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function addDays(value, days) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
async function waitForWorker() {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok) return;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Local Worker did not become ready: ${String(lastError)}\n${workerOutput}`);
}

try {
  mkdirSync(screenshotDir, { recursive: true });
  runWrangler(["d1", "migrations", "apply", "DB", "--env", "staging", "--local", "--persist-to", persistDir], "local migrations");
  const now = new Date().toISOString();
  const date = addDays(localToday(), -1);
  const confirmedAt = new Date(`${addDays(date, -20)}T00:00:00+08:00`).toISOString();
  execute(`
    INSERT INTO staff_account (id, email_normalized, display_name, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('attendance-browser-staff', 'attendance-browser@example.test', 'Attendance Browser Teacher', 'active', 1, 'attendance-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO staff_account_role (staff_account_id, role_code, assigned_at)
      VALUES ('attendance-browser-staff', 'teacher', ${sql(now)});
    INSERT INTO staff_session (id, staff_account_id, session_token_hash, created_at, expires_at, last_seen_at, is_test, test_run_id)
      VALUES ('attendance-browser-session', 'attendance-browser-staff', ${sql(sessionHash)}, ${sql(now)}, '2027-12-31T00:00:00.000Z', ${sql(now)}, 1, 'attendance-browser');
    INSERT INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_current, is_test, test_run_id, created_at, updated_at)
      VALUES ('year', 'Attendance browser', 'closed', '${addDays(date, -90)}', '${addDays(date, 90)}', 1, 1, 'attendance-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO curriculum_program_family (id, kind, display_name, annual_stage_code, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('family', 'annual_course', 'Attendance browser', 'stage_1', 'active', 1, 'attendance-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO curriculum_program (id, program_family_id, academic_year_id, stage_code, revision_number, display_name, program_kind, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('program', 'family', 'year', 'stage_1', 1, 'Attendance browser program', 'annual_course', 'draft', 1, 'attendance-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO curriculum_lesson (id, curriculum_program_id, sequence_number, title, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('lesson', 'program', 1, 'Attendance browser lesson', 'active', 1, 'attendance-browser', ${sql(now)}, ${sql(now)});
    UPDATE curriculum_program SET status = 'published', published_at = ${sql(now)} WHERE id = 'program';
    UPDATE curriculum_program_family SET current_published_program_id = 'program' WHERE id = 'family';
    INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, starts_on, curriculum_program_id, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('offering', 'annual_course', 'Attendance browser offering', 'year', 'stage_1', '${date}', 'program', 1, 'paid', 'active', 1, 'attendance-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO class_session (id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, activity_offering_id, is_test, test_run_id, created_at, updated_at)
      VALUES ('source-class', 'year', 'stage_1', 'Source class', 'Баасан', '14:00', '15:20', 10, 'available', 'offering', 1, 'attendance-browser', ${sql(now)}, ${sql(now)}),
        ('target-class', 'year', 'stage_1', 'Target class', 'Бямба', '14:00', '15:20', 10, 'available', 'offering', 1, 'attendance-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO class_calendar (id, class_session_id, timezone, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('target-calendar', 'target-class', 'Asia/Ulaanbaatar', 'active', 1, 'attendance-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO class_calendar_revision (id, class_calendar_id, curriculum_program_id, revision_number, status, first_candidate_date, locked_through_sequence, is_test, test_run_id, created_at, updated_at)
      VALUES ('target-revision', 'target-calendar', 'program', 1, 'draft', '${date}', 0, 1, 'attendance-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO class_calendar_slot (id, class_calendar_revision_id, local_date, start_time, end_time, slot_source, status, curriculum_lesson_id, is_test, test_run_id, created_at, updated_at)
      VALUES ('attendance-slot', 'target-revision', '${date}', '14:00', '15:20', 'generated', 'scheduled', 'lesson', 1, 'attendance-browser', ${sql(now)}, ${sql(now)});
    UPDATE class_calendar_revision SET status = 'published', published_at = ${sql(now)} WHERE id = 'target-revision';
    INSERT INTO guardian_account (id, full_name, primary_phone, primary_phone_normalized, email, email_normalized, home_address, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('guardian', 'Attendance Guardian', '99000000', '99000000', 'attendance@example.test', 'attendance@example.test', 'Test', 'active', 1, 'attendance-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO student (id, surname, given_name, gender, date_of_birth, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('ordinary-student', 'Ердийн Ирцийн', 'Сурагч', 'not_specified', '2015-01-01', 'active', 1, 'attendance-browser', ${sql(now)}, ${sql(now)}),
        ('transfer-student', 'Шилжсэн Ирцийн', 'Сурагч', 'not_specified', '2015-01-02', 'active', 1, 'attendance-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO pre_registration (id, guardian_id, academic_year_id, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('ordinary-prereg', 'guardian', 'year', 'completed', 1, 'attendance-browser', ${sql(now)}, ${sql(now)}),
        ('transfer-source-prereg', 'guardian', 'year', 'completed', 1, 'attendance-browser', ${sql(now)}, ${sql(now)}),
        ('transfer-target-prereg', 'guardian', 'year', 'completed', 1, 'attendance-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO application_child (id, pre_registration_id, student_id, current_grade, returning_status, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('ordinary-application', 'ordinary-prereg', 'ordinary-student', 5, 'new', 'enrolled', 1, 'attendance-browser', ${sql(now)}, ${sql(now)}),
        ('transfer-source-application', 'transfer-source-prereg', 'transfer-student', 5, 'new', 'enrolled', 1, 'attendance-browser', ${sql(now)}, ${sql(now)}),
        ('transfer-target-application', 'transfer-target-prereg', 'transfer-student', 5, 'new', 'enrolled', 1, 'attendance-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO enrollment (id, application_child_id, student_id, academic_year_id, class_session_id, status, confirmed_at, transferred_out_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('ordinary-enrollment', 'ordinary-application', 'ordinary-student', 'year', 'target-class', 'confirmed', '${confirmedAt}', NULL, 1, 'attendance-browser', ${sql(now)}, ${sql(now)}),
        ('transfer-source-enrollment', 'transfer-source-application', 'transfer-student', 'year', 'source-class', 'confirmed', '${confirmedAt}', ${sql(now)}, 1, 'attendance-browser', ${sql(now)}, ${sql(now)}),
        ('transfer-target-enrollment', 'transfer-target-application', 'transfer-student', 'year', 'target-class', 'confirmed', '${confirmedAt}', NULL, 1, 'attendance-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO class_transfer (id, source_enrollment_id, source_application_child_id, source_class_session_id, target_class_session_id, target_enrollment_id, target_application_child_id, status, reason, created_by_staff_account_id, idempotency_key, source_pricing_snapshot_json, target_pricing_snapshot_json, source_effective_charge_mnt, target_effective_charge_mnt, recognized_paid_mnt, required_difference_mnt, resulting_credit_mnt, completed_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('completed-transfer', 'transfer-source-enrollment', 'transfer-source-application', 'source-class', 'target-class', 'transfer-target-enrollment', 'transfer-target-application', 'completed', 'browser test', 'attendance-browser-staff', 'attendance-completed-transfer', '{}', '{}', 0, 0, 0, 0, 0, ${sql(now)}, 1, 'attendance-browser', ${sql(now)}, ${sql(now)});
  `);

  worker = spawn(process.execPath, [wranglerCli, "dev", "--env", "staging", "--local", "--persist-to", persistDir,
    "--ip", "127.0.0.1", "--port", String(port), "--var", `APP_ORIGIN:${baseUrl}`], { stdio: ["ignore", "pipe", "pipe"] });
  worker.stdout.on("data", (chunk) => { workerOutput += String(chunk); });
  worker.stderr.on("data", (chunk) => { workerOutput += String(chunk); });
  await waitForWorker();
  browser = await (browserEngine === "webkit" ? webkit : chromium).launch({ headless: true });
  context = await browser.newContext();
  await context.addCookies([{ name: "naran_staff_session", value: rawSessionToken, url: baseUrl, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto(`${baseUrl}/staff/attendance/?date=${date}&occurrence=attendance-slot`);
  await page.locator("#tool-app").waitFor({ state: "visible" });
  const ordinary = page.locator("[data-attendance-row='ordinary-enrollment']");
  const transferred = page.locator("[data-attendance-row='transfer-target-enrollment']");
  await ordinary.getByText("Ердийн Ирцийн Сурагч", { exact: true }).waitFor({ state: "visible" });
  await transferred.getByText("Шилжсэн Ирцийн Сурагч", { exact: true }).waitFor({ state: "visible" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("#attendance-detail").screenshot({ path: path.join(screenshotDir, "ordinary-transferred-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#attendance-detail").screenshot({ path: path.join(screenshotDir, "ordinary-transferred-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
  const postFor = (enrollmentId) => page.waitForResponse((response) => response.url().endsWith("/api/staff/attendance")
    && response.request().method() === "POST" && response.request().postData()?.includes(`"${enrollmentId}"`));
  const ordinaryPresentResponse = postFor("ordinary-enrollment");
  await ordinary.locator("[data-attendance-control='present']").click();
  const ordinaryPresent = await ordinaryPresentResponse;
  assert.equal(ordinaryPresent.status(), 200, `ordinary attendance save failed: ${await ordinaryPresent.text()}`);
  const transferredPresentResponse = postFor("transfer-target-enrollment");
  await transferred.locator("[data-attendance-control='present']").click();
  const transferredPresent = await transferredPresentResponse;
  assert.equal(transferredPresent.status(), 200, `transferred attendance save failed: ${await transferredPresent.text()}`);
  const ordinaryLateResponse = postFor("ordinary-enrollment");
  await ordinary.locator("[data-attendance-control='late']").click();
  const ordinaryLate = await ordinaryLateResponse;
  assert.equal(ordinaryLate.status(), 200, `ordinary attendance correction failed: ${await ordinaryLate.text()}`);
  const rejectClear = async (route) => {
    const body = route.request().postData() || "";
    if (body.includes('"ordinary-enrollment"') && body.includes('"attendance.clear"')) {
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { message: "Энэ тэмдэглэл өөрчлөгдсөн байна. Жагсаалтаа шинэчлээд дахин оролдоно уу." } }) });
      return;
    }
    await route.continue();
  };
  await page.route("**/api/staff/attendance", rejectClear);
  await ordinary.locator("[data-attendance-control='present']").click();
  await ordinary.getByText("Энэ тэмдэглэл өөрчлөгдсөн байна. Жагсаалтаа шинэчлээд дахин оролдоно уу.", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await ordinary.locator("[data-attendance-control='late']").isChecked(), true, "a rejected correction restores the affected row");
  assert.equal(await transferred.locator("[data-attendance-control='present']").isChecked(), true, "a rejected row cannot alter a different learner");
  await page.unroute("**/api/staff/attendance", rejectClear);
  await page.reload();
  await page.locator("#tool-app").waitFor({ state: "visible" });
  assert.equal(await page.locator("[data-attendance-row='ordinary-enrollment'] [data-attendance-control='late']").isChecked(), true, "ordinary late attendance survives reload");
  assert.equal(await page.locator("[data-attendance-row='transfer-target-enrollment'] [data-attendance-control='present']").isChecked(), true, "transferred attendance survives reload");
  assert.deepEqual(browserErrors, [], "attendance interaction produces no uncaught browser errors");
  console.log(`ok ${browserEngine} attendance browser ordinary, transferred, consecutive, rollback, and reload (${screenshotDir})`);
} finally {
  if (context) await context.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  if (worker && !worker.killed) worker.kill("SIGTERM");
  rmSync(persistDir, { recursive: true, force: true });
}
