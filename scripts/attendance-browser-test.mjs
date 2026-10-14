import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, webkit } from "@playwright/test";
import { assertDisposableLocalWrangler, failWithoutQuotaRetry } from "./local-disposable-test-target.mjs";
import { checkWeeklyAttendance, profileWeeklyAttendance } from './weekly-attendance-browser-check.mjs';

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
    ${process.env.WEEKLY_PROFILE || process.env.ATTENDANCE_CARD_PROFILE ? '' : `INSERT INTO curriculum_lesson (id,curriculum_program_id,sequence_number,title,is_test,test_run_id,created_at,updated_at)
      VALUES ('weekly-second-lesson','program',2,'Weekly second',1,'attendance-browser',${sql(now)},${sql(now)});`}
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
    ${process.env.WEEKLY_PROFILE || process.env.ATTENDANCE_CARD_PROFILE ? '' : `INSERT INTO class_calendar_slot (id,class_calendar_revision_id,local_date,start_time,end_time,slot_source,status,curriculum_lesson_id,is_test,test_run_id,created_at,updated_at)
      VALUES ('weekly-occupied','target-revision','${addDays(date, (7-new Date(date+'T00:00:00Z').getUTCDay())%7)}','16:00','17:20','generated','scheduled','weekly-second-lesson',1,'attendance-browser',${sql(now)},${sql(now)});`}
    UPDATE class_calendar_revision SET status = 'published', published_at = ${sql(now)} WHERE id = 'target-revision';
    INSERT INTO guardian_account (id, full_name, primary_phone, primary_phone_normalized, email, email_normalized, home_address, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('guardian', 'Attendance Guardian', '99000000', '99000000', 'attendance@example.test', 'attendance@example.test', 'Test', 'active', 1, 'attendance-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO student (id, surname, given_name, gender, date_of_birth, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('ordinary-student', 'Ердийн Ирцийн', 'Сурагч', 'not_specified', '2015-01-01', 'active', 1, 'attendance-browser', ${sql(now)}, ${sql(now)}),
        ('transfer-student', 'Шилжсэн Ирцийн', 'Сурагч', 'not_specified', '2015-01-02', 'active', 1, 'attendance-browser', ${sql(now)}, ${sql(now)}),
        ('bulk-student', 'Бөөн Ирцийн', 'Сурагч', 'not_specified', '2015-01-03', 'active', 1, 'attendance-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO pre_registration (id, guardian_id, academic_year_id, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('ordinary-prereg', 'guardian', 'year', 'completed', 1, 'attendance-browser', ${sql(now)}, ${sql(now)}),
        ('transfer-source-prereg', 'guardian', 'year', 'completed', 1, 'attendance-browser', ${sql(now)}, ${sql(now)}),
        ('transfer-target-prereg', 'guardian', 'year', 'completed', 1, 'attendance-browser', ${sql(now)}, ${sql(now)}),
        ('bulk-prereg', 'guardian', 'year', 'completed', 1, 'attendance-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO application_child (id, pre_registration_id, student_id, current_grade, returning_status, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('ordinary-application', 'ordinary-prereg', 'ordinary-student', 5, 'new', 'enrolled', 1, 'attendance-browser', ${sql(now)}, ${sql(now)}),
        ('transfer-source-application', 'transfer-source-prereg', 'transfer-student', 5, 'new', 'enrolled', 1, 'attendance-browser', ${sql(now)}, ${sql(now)}),
        ('transfer-target-application', 'transfer-target-prereg', 'transfer-student', 5, 'new', 'enrolled', 1, 'attendance-browser', ${sql(now)}, ${sql(now)}),
        ('bulk-application', 'bulk-prereg', 'bulk-student', 5, 'new', 'enrolled', 1, 'attendance-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO enrollment (id, application_child_id, student_id, academic_year_id, class_session_id, status, confirmed_at, transferred_out_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('ordinary-enrollment', 'ordinary-application', 'ordinary-student', 'year', 'target-class', 'confirmed', '${confirmedAt}', NULL, 1, 'attendance-browser', ${sql(now)}, ${sql(now)}),
        ('transfer-source-enrollment', 'transfer-source-application', 'transfer-student', 'year', 'source-class', 'confirmed', '${confirmedAt}', ${sql(now)}, 1, 'attendance-browser', ${sql(now)}, ${sql(now)}),
        ('transfer-target:enrollment', 'transfer-target-application', 'transfer-student', 'year', 'target-class', 'confirmed', '${confirmedAt}', NULL, 1, 'attendance-browser', ${sql(now)}, ${sql(now)}),
        ('bulk-enrollment', 'bulk-application', 'bulk-student', 'year', 'target-class', 'confirmed', '${confirmedAt}', NULL, 1, 'attendance-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO class_transfer (id, source_enrollment_id, source_application_child_id, source_class_session_id, target_class_session_id, target_enrollment_id, target_application_child_id, status, reason, created_by_staff_account_id, idempotency_key, source_pricing_snapshot_json, target_pricing_snapshot_json, source_effective_charge_mnt, target_effective_charge_mnt, recognized_paid_mnt, required_difference_mnt, resulting_credit_mnt, completed_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('completed-transfer', 'transfer-source-enrollment', 'transfer-source-application', 'source-class', 'target-class', 'transfer-target:enrollment', 'transfer-target-application', 'completed', 'browser test', 'attendance-browser-staff', 'attendance-completed-transfer', '{}', '{}', 0, 0, 0, 0, 0, ${sql(now)}, 1, 'attendance-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO registration_draft (id, access_token_hash, academic_year_id, guardian_full_name, guardian_relationship, primary_phone, email, normalized_email, home_address, payment_plan_code, parent_rules_version, student_rules_version, status, verified_at, expires_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('transfer-payment-draft', ${sql("t".repeat(64))}, 'year', 'Transfer guardian', 'Parent', '99000000', 'transfer-payment@example.test', 'transfer-payment@example.test', 'Test', 'single', 'rules', 'rules', 'awaiting_initial_payment', ${sql(now)}, '2027-12-31T00:00:00.000Z', 1, 'attendance-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO registration_draft_child (id, registration_draft_id, position, surname, given_name, gender, date_of_birth, current_grade, current_school, returning_status, selected_stage_code, selected_class_session_id, payment_plan_code, initial_payment_amount_mnt, status, canonical_student_id, canonical_application_child_id, canonical_enrollment_id, is_test, test_run_id, created_at, updated_at)
      VALUES ('transfer-payment-child', 'transfer-payment-draft', 0, 'Шилжсэн Ирцийн', 'Сурагч', 'not_specified', '2015-01-02', '5', 'Test', 'new', 'stage_1', 'target-class', 'single', 100000, 'awaiting_initial_payment', 'transfer-student', 'transfer-target-application', 'transfer-target:enrollment', 1, 'attendance-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO payment_request (id, registration_draft_id, payment_reference, created_at, updated_at, is_test, test_run_id)
      VALUES ('transfer-payment-request', 'transfer-payment-draft', 'NE-ATTENDANCE-CARD', ${sql(now)}, ${sql(now)}, 1, 'attendance-browser');
    INSERT INTO payment_installment (id, payment_request_id, registration_draft_child_id, installment_number, installment_kind, amount_mnt, original_due_at, effective_due_at, reminder_lead_minutes, reminder_at, status, canonical_application_child_id, canonical_enrollment_id, is_test, test_run_id, created_at, updated_at)
      VALUES ('transfer-payment-installment', 'transfer-payment-request', 'transfer-payment-child', 1, 'initial', 100000, '2027-01-01T15:59:59.999Z', '2027-01-01T15:59:59.999Z', 60, '2027-01-01T14:59:59.999Z', 'partially_paid', 'transfer-target-application', 'transfer-target:enrollment', 1, 'attendance-browser', ${sql(now)}, ${sql(now)});
  `);

  const profile = Boolean(process.env.ATTENDANCE_CARD_PROFILE || process.env.WEEKLY_PROFILE);
  {
    for (let i = 0; i < (profile ? 41 : 1); i++) execute(`
      INSERT INTO registration_draft_child (id, registration_draft_id, position, surname, given_name, gender, date_of_birth, current_grade, current_school, returning_status, selected_stage_code, selected_class_session_id, payment_plan_code, initial_payment_amount_mnt, status, canonical_student_id, canonical_application_child_id, canonical_enrollment_id, is_test, test_run_id, created_at, updated_at)
      SELECT 'profile-child-${i}', registration_draft_id, ${i + 1}, 'Profile', 'Child ${i}', gender, date_of_birth, current_grade, current_school, returning_status, selected_stage_code, selected_class_session_id, payment_plan_code, initial_payment_amount_mnt, status, ${i === 0 ? "'ordinary-student', 'ordinary-application', 'ordinary-enrollment'" : "NULL, NULL, NULL"}, is_test, test_run_id, created_at, updated_at FROM registration_draft_child WHERE id='transfer-payment-child';
      INSERT INTO payment_installment (id,payment_request_id,registration_draft_child_id,installment_number,installment_kind,amount_mnt,original_due_at,effective_due_at,reminder_lead_minutes,reminder_at,status,is_test,test_run_id,created_at,updated_at)
      SELECT 'profile-installment-${i}',payment_request_id,'profile-child-${i}',installment_number,installment_kind,amount_mnt,original_due_at,effective_due_at,reminder_lead_minutes,reminder_at,status,is_test,test_run_id,created_at,updated_at FROM payment_installment WHERE id='transfer-payment-installment';`);
  }
  worker = spawn(process.execPath, [wranglerCli, "dev", ...(profile ? ["scripts/attendance-profile-worker.ts"] : []), "--env", "staging", "--local", "--persist-to", persistDir,
    "--ip", "127.0.0.1", "--port", String(port), "--var", `APP_ORIGIN:${baseUrl}`], { stdio: ["ignore", "pipe", "pipe"] });
  worker.stdout.on("data", (chunk) => { workerOutput += String(chunk); });
  worker.stderr.on("data", (chunk) => { workerOutput += String(chunk); });
  await waitForWorker();
  browser = await (browserEngine === "webkit" ? webkit : chromium).launch({ headless: true });
  context = await browser.newContext();
  await context.addCookies([{ name: "naran_staff_session", value: rawSessionToken, url: baseUrl, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  if (process.env.WEEKLY_PROFILE) {
    const result = await profileWeeklyAttendance({ context, baseUrl, date });
    writeFileSync(path.join(screenshotDir, `weekly-profile-${process.env.WEEKLY_PROFILE}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } else if (process.env.WEEKLY_ONLY) {
    await checkWeeklyAttendance({ context, baseUrl, date, execute, screenshotDir, engine: browserEngine });
  } else if (profile) {
    const samples = [];
    let phase = 'attendance';
    const pending = [];
    page.on('response', response => {
      if (!response.url().includes('/api/')) return;
      const label = phase;
      pending.push((async () => {
        const body = await response.body();
        const h = response.headers();
        samples.push({ phase: label, path: new URL(response.url()).pathname, bytes: body.length,
          queries: Number(h['x-test-d1-queries']), rowsRead: Number(h['x-test-d1-rows-read']),
          dbMs: Number(h['x-test-d1-ms']), serverElapsedMs: Number(h['x-test-elapsed-ms']) });
      })());
    });
    const measures = [];
    await page.goto(`${baseUrl}/staff/attendance/?date=${date}&occurrence=attendance-slot`);
    await page.locator("[data-attendance-row='transfer-target:enrollment']").waitFor();
    for (const [label, id] of [['first','transfer-target:enrollment'], ['reopen','transfer-target:enrollment'], ['different','ordinary-enrollment']]) {
      phase = label;
      const started = performance.now();
      const row = page.locator(`[data-attendance-row='${id}']`);
      await row.locator('[data-attendance-card-toggle]').click();
      await row.locator('[data-student-card-runtime] .staff-payment-item').waitFor();
      measures.push({ phase: label, visibleMs: performance.now() - started });
      await Promise.all(pending);
      await row.locator('[data-attendance-card-toggle]').click();
    }
    await Promise.all(pending);
    const output = { implementation: process.env.ATTENDANCE_CARD_PROFILE, fixturePaymentChildren: 42, samples, measures };
    writeFileSync(path.join(screenshotDir, `profile-${process.env.ATTENDANCE_CARD_PROFILE}.json`), JSON.stringify(output, null, 2));
    console.log(JSON.stringify(output));
  } else {
  page.setDefaultTimeout(10_000);
  const browserErrors = [];
  const attendancePosts = [];
  const cardRequests = [];
  const replacementRequests = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("request", (request) => {
    if (request.url().includes('/api/staff/payments') && request.method() === 'GET') cardRequests.push(request.url());
    if (request.postData()?.includes('registration-detail.replace-email')) replacementRequests.push(request.postData());
    if (request.url().endsWith("/api/staff/attendance") && request.method() === "POST") attendancePosts.push(request.postData() || "");
  });
  await page.goto(`${baseUrl}/staff/attendance/?date=${date}&occurrence=attendance-slot`);
  await page.locator("#tool-app").waitFor({ state: "visible" });
  const ordinary = page.locator("[data-attendance-row='ordinary-enrollment']");
  const transferred = page.locator("[data-attendance-row='transfer-target:enrollment']");
  const bulk = page.locator("[data-attendance-row='bulk-enrollment']");
  await ordinary.getByText("Ердийн Ирцийн Сурагч", { exact: true }).waitFor({ state: "visible" });
  await transferred.getByText("Шилжсэн Ирцийн Сурагч", { exact: true }).waitFor({ state: "visible" });
  await bulk.getByText("Бөөн Ирцийн Сурагч", { exact: true }).waitFor({ state: "visible" });
  await page.setViewportSize({ width: 1280, height: 900 });
  const postFor = (enrollmentId) => page.waitForResponse((response) => response.url().endsWith("/api/staff/attendance")
    && response.request().method() === "POST" && response.request().postData()?.includes(`"${enrollmentId}"`));
  const postForAction = (action) => page.waitForResponse((response) => response.url().endsWith("/api/staff/attendance")
    && response.request().method() === "POST" && response.request().postData()?.includes(`"${action}"`));
  let releaseDelayedSave;
  let signalDelayedSave;
  const delayedSaveStarted = new Promise((resolve) => { signalDelayedSave = resolve; });
  const delayedSave = new Promise((resolve) => { releaseDelayedSave = resolve; });
  let delayedSaveCount = 0;
  await page.route("**/api/staff/attendance", async (route) => {
    const body = route.request().postData() || "";
    if (body.includes('"ordinary-enrollment"') && body.includes('"attendance.mark"')) {
      delayedSaveCount += 1;
      const response = await route.fetch();
      signalDelayedSave();
      await delayedSave;
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });
  await ordinary.locator("[data-attendance-control='present']").click();
  await delayedSaveStarted;
  await ordinary.getByText("Хадгалж байна…", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await ordinary.getByText("Ирсэн", { exact: true }).locator("input").isDisabled(), true, "the pending row disables repeated present taps");
  assert.equal(await ordinary.getByText("Хоцорсон", { exact: true }).locator("input").isDisabled(), true, "the pending row disables conflicting late taps");
  const attendancePostsBeforeCard = attendancePosts.length;
  let releaseCard;
  const delayedCard = new Promise(resolve => { releaseCard = resolve; });
  await page.route('**/api/staff/payments?attendanceEnrollment=*', async route => {
    const response = await route.fetch();
    await delayedCard;
    await route.fulfill({ response });
  });
  const cardRequestStarted = page.waitForRequest(request => request.url().includes('attendanceEnrollment='));
  await transferred.getByRole("button", { name: "Шилжсэн Ирцийн Сурагч" }).click();
  await cardRequestStarted;
  await transferred.getByRole("button", { name: "Шилжсэн Ирцийн Сурагч" }).click();
  await transferred.getByRole("button", { name: "Шилжсэн Ирцийн Сурагч" }).click();
  releaseCard();
  const transferredCard = transferred.locator(".staff-attendance-payment-card");
  await transferredCard.waitFor({ state: "visible" });
  await transferredCard.locator("[data-student-card-runtime]").waitFor({ state: "visible" });
  assert.equal(attendancePosts.length, attendancePostsBeforeCard, "opening a student card does not write attendance");
  await transferredCard.locator("[data-student-card-runtime] .staff-payment-item").waitFor({ state: "visible" });
  await page.unroute('**/api/staff/payments?attendanceEnrollment=*');
  assert.equal(cardRequests.length, 1, 'rapid toggles deduplicate the real scoped request');
  assert.ok(cardRequests.every(url => url.includes('attendanceEnrollment=')), 'card never loads the full Payments queue');
  const transferredCardText = await transferredCard.innerText();
  assert.match(transferredCardText, /Шилжсэн Ирцийн Сурагч/, "the card resolves the current payment record by stable enrollment identity");
  await transferredCard.getByRole("button", { name: "Мэдээлэл", exact: true }).click();
  await transferredCard.getByRole("heading", { name: "Асран хамгаалагч", exact: true }).waitFor({ state: "visible" });
  const cardNode = await transferredCard.locator('[data-student-card-runtime]').evaluate(node => { node.dataset.testRetained = 'yes'; return node.dataset.testRetained; });
  await transferred.getByRole('button', { name: 'Шилжсэн Ирцийн Сурагч' }).click();
  await transferred.getByRole('button', { name: 'Шилжсэн Ирцийн Сурагч' }).click();
  await transferredCard.getByRole('heading', { name: 'Асран хамгаалагч', exact: true }).waitFor();
  assert.equal(await transferredCard.locator('[data-student-card-runtime]').getAttribute('data-test-retained'), cardNode, 'reopen retains the original controller/DOM and tab');
  assert.equal(cardRequests.length, 1, 'immediate reopening performs no data request');
  await transferredCard.getByRole('button', { name: 'Мэдээлэл засах', exact: true }).click();
  const schoolDraft = transferredCard.locator('input[name="currentSchool"]');
  await schoolDraft.fill('Disposable unsaved school');
  const cardClose = transferredCard.getByRole('button', { name: 'Хаах', exact: true });
  assert.equal(await cardClose.getAttribute('type'), 'button', 'card close cannot submit a form');
  const requestsBeforeClose = cardRequests.length;
  await cardClose.click();
  await transferredCard.waitFor({ state: 'detached' });
  const nameToggle = transferred.getByRole('button', { name: 'Шилжсэн Ирцийн Сурагч' });
  assert.equal(await nameToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await nameToggle.evaluate(node => node === document.activeElement), true, 'close returns focus to student name');
  await transferred.getByRole('button', { name: 'Шилжсэн Ирцийн Сурагч' }).click();
  assert.equal(await schoolDraft.inputValue(), 'Disposable unsaved school', 'unsaved card fields survive close/reopen');
  assert.equal(await nameToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(cardRequests.length, requestsBeforeClose, 'card close/reopen retains cached draft without a data request');
  assert.equal(attendancePosts.length, attendancePostsBeforeCard, 'card close does not write attendance');
  // Cancelling the supported draft is not a business mutation.
  await transferredCard.locator('[data-registration-correction-cancel]').click();
  await transferredCard.getByRole('button', { name: 'Мэдээлэл', exact: true }).click();
  await transferredCard.getByRole('heading', { name: 'Асран хамгаалагч', exact: true }).waitFor();
  assert.equal(attendancePosts.length, attendancePostsBeforeCard, "shared card tabs and read-only details do not write attendance");
  const sourceResolution = await page.evaluate(async () => {
    const response = await fetch("/api/staff/payments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "attendance-payment-card.resolve", enrollmentId: "transfer-source-enrollment" }) });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(sourceResolution.status, 200, "historical source attendance can resolve a completed transfer");
  assert.equal(sourceResolution.body.currentEnrollmentId, "transfer-target:enrollment", "historical source attendance resolves to the current enrollment");
  assert.equal(sourceResolution.body.registrationDraftChildId, "transfer-payment-child", "historical source attendance resolves the current registration child");
  const projections = await page.evaluate(async () => {
    const scoped = await (await fetch('/api/staff/payments?attendanceEnrollment=transfer-target%3Aenrollment')).json();
    const full = await (await fetch('/api/staff/payments')).json();
    const historical = await (await fetch('/api/staff/payments?attendanceEnrollment=transfer-source-enrollment')).json();
    const malformed = await fetch('/api/staff/payments?attendanceEnrollment=%3Cbad%3E');
    return { scoped, full, historical, malformed: malformed.status };
  });
  assert.equal(projections.scoped.items.length, 1);
  assert.deepEqual(projections.scoped.items[0], projections.full.items.find(item => item.registrationDraftChildId === 'transfer-payment-child'), 'selected-card financial projection equals Payments');
  assert.equal(projections.scoped.capacity.length, 0, 'scoped card omits unrelated capacity roster');
  assert.deepEqual(projections.historical.items, projections.scoped.items, 'historical source resolves the same current card');
  assert.equal(projections.malformed, 400);
  const unauthorized = await fetch(`${baseUrl}/api/staff/payments?attendanceEnrollment=transfer-target%3Aenrollment`);
  assert.equal(unauthorized.status, 401, 'scoped data requires an authenticated authorized session');
  const recipients = await page.evaluate(async () => {
    const response = await fetch('/api/staff/payments?attendanceEnrollment=transfer-target%3Aenrollment&creditRecipientQuery=Profile');
    return { status: response.status, body: await response.json() };
  });
  assert.equal(recipients.status, 200);
  assert.equal(recipients.body.items[0].registrationDraftChildId, 'profile-child-0', 'explicit recipient search preserves the credit-transfer target by identity');
  assert.equal(recipients.body.items[0].installments, undefined, 'recipient search does not load another financial card');
  const paymentsPage = await context.newPage();
  paymentsPage.on("pageerror", (error) => browserErrors.push(error.message));
  await paymentsPage.goto(`${baseUrl}/staff/payments/`);
  await paymentsPage.locator("#tool-app").waitFor({ state: "visible" });
  await paymentsPage.locator('[data-group-toggle="Төлбөр хүлээж байна"]').click();
  const paymentsItem = paymentsPage.locator(".staff-payment-item").filter({ hasText: "Шилжсэн Ирцийн Сурагч" });
  await paymentsItem.getByRole("button", { name: "Нээх", exact: true }).click();
  await paymentsItem.getByRole("button", { name: "Мэдээлэл", exact: true }).waitFor({ state: "visible" });
  await paymentsItem.getByRole('button', { name: 'Хаах', exact: true }).click();
  await paymentsItem.getByRole('button', { name: 'Нээх', exact: true }).waitFor({ state: 'visible' });
  assert.equal(await paymentsItem.locator('.staff-payment-detail').count(), 0, 'normal Payments close still collapses details');
  await paymentsItem.getByRole('button', { name: 'Нээх', exact: true }).click();
  await paymentsItem.getByRole('button', { name: 'Мэдээлэл', exact: true }).waitFor({ state: 'visible' });
  await paymentsPage.close();
  assert.equal(await transferredCard.locator("iframe").count(), 0, "attendance mounts the shared card directly without a Payments-page iframe");
  assert.equal(await transferredCard.locator("[data-student-card-runtime]").count(), 1, "an attendance-row save leaves an open child card intact");
  await page.locator("#attendance-detail").screenshot({ path: path.join(screenshotDir, "pending-desktop.png") });
  await transferred.evaluate(node => window.scrollTo(0, window.scrollY + node.getBoundingClientRect().top - 100));
  await page.screenshot({ path: path.join(screenshotDir, 'card-desktop-viewport.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#attendance-detail").screenshot({ path: path.join(screenshotDir, "pending-mobile.png") });
  await transferred.evaluate(node => window.scrollTo(0, window.scrollY + node.getBoundingClientRect().top - 100));
  await page.screenshot({ path: path.join(screenshotDir, 'card-mobile-viewport.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'phone card has no horizontal document overflow');
  await page.setViewportSize({ width: 1280, height: 900 });
  await transferredCard.getByRole('button', { name: 'Мэдээлэл засах', exact: true }).click();
  await transferredCard.locator('summary').filter({ hasText: 'Холбоо барих мэдээлэл солих' }).click();
  await transferredCard.locator('[data-registration-email-replace]').click();
  await transferredCard.getByText('Шинэ и-мэйл, шалтгаан болон зөвшөөрлийг бүрэн оруулна уу.', { exact: true }).waitFor();
  assert.equal(replacementRequests.length, 0, 'incomplete optional email replacement cannot be submitted');
  await transferredCard.locator('input[name="currentSchool"]').fill('Saved disposable school');
  await transferredCard.locator('textarea[name="reason"]').fill('Disposable card cache validation');
  assert.deepEqual(await transferredCard.locator('[data-registration-correction-form]').evaluate(form => [...form.elements].filter(node => node.willValidate && !node.validity.valid).map(node => ({ name: node.name, value: node.value, message: node.validationMessage }))), [], 'disposable Info edit supplies all required fields');
  const infoSaved = page.waitForResponse(response => response.request().postData()?.includes('registration-detail.save') && response.request().method() === 'POST');
  const infoRefreshed = page.waitForResponse(response => response.url().includes('/api/staff/payments?attendanceEnrollment=') && response.request().method() === 'GET');
  await transferredCard.locator('[data-registration-correction-form]').getByRole('button', { name: 'Хадгалах', exact: true }).click();
  assert.equal((await infoSaved).status(), 200, 'an authorized card edit saves through the existing service');
  await infoRefreshed;
  await transferredCard.getByText('Мэдээлэл шинэчлэгдлээ.', { exact: true }).waitFor();
  const infoReloaded = page.waitForResponse(response => response.request().postData()?.includes('registration-detail.get') && response.request().method() === 'POST');
  await transferredCard.getByRole('button', { name: 'Мэдээлэл', exact: true }).click();
  const infoReloadedResponse = await infoReloaded;
  const infoReloadedData = await infoReloadedResponse.json();
  assert.equal(infoReloadedData.currentSchool, 'Saved disposable school', JSON.stringify({ status: infoReloadedResponse.status(), school: infoReloadedData.currentSchool }));
  await transferredCard.locator('.staff-registration-view').getByText(/Saved disposable school/).waitFor();
  const afterEditRequests = cardRequests.length;
  await transferred.getByRole('button', { name: 'Шилжсэн Ирцийн Сурагч' }).click();
  await transferred.getByRole('button', { name: 'Шилжсэн Ирцийн Сурагч' }).click();
  await transferredCard.locator('.staff-registration-view').getByText(/Saved disposable school/).waitFor();
  assert.equal(cardRequests.length, afterEditRequests, 'confirmed edit refreshes the cached data; immediate reopen remains local');
  assert.equal(attendancePosts.length, attendancePostsBeforeCard, 'card edits do not submit attendance or replace its pending state');
  const postsBeforeRepeatedTap = attendancePosts.length;
  await ordinary.getByText("Ирсэн", { exact: true }).click({ force: true });
  await ordinary.getByText("Хоцорсон", { exact: true }).click({ force: true });
  await page.locator("#attendance-bulk-present").evaluate((button) => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await page.waitForTimeout(75);
  assert.equal(attendancePosts.length, postsBeforeRepeatedTap, "same-row label taps and bulk do not submit while a row is pending");
  assert.equal(await page.locator("#attendance-bulk-present").isDisabled(), true, "bulk attendance is unavailable during an individual save");
  const transferredPresentResponse = postFor("transfer-target:enrollment");
  await transferred.locator("[data-attendance-control='present']").click();
  const transferredPresent = await transferredPresentResponse;
  assert.equal(transferredPresent.status(), 200, `transferred attendance save failed: ${await transferredPresent.text()}`);
  await transferred.getByText("Хадгаллаа", { exact: true }).waitFor({ state: "visible" });
  releaseDelayedSave();
  await ordinary.getByText("Хадгаллаа", { exact: true }).waitFor({ state: "visible" });
  await page.unroute("**/api/staff/attendance");
  assert.equal(delayedSaveCount, 1, "the delayed same-row interaction sends one request");
  assert.equal(await page.locator("#attendance-bulk-present").isDisabled(), false, "bulk attendance returns after the row save is confirmed");
  const bulkPresentResponse = postForAction("attendance.bulk-present");
  await page.locator("#attendance-bulk-present").click();
  await page.locator("#attendance-bulk-confirm").click();
  const bulkPresent = await bulkPresentResponse;
  assert.equal(bulkPresent.status(), 200, `bulk attendance save failed: ${await bulkPresent.text()}`);
  assert.equal(await bulk.locator("[data-attendance-control='present']").isChecked(), true, "bulk attendance still marks unmarked rows after individual saves finish");
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
  let lostResponseCount = 0;
  await page.route("**/api/staff/attendance", async (route) => {
    const body = route.request().postData() || "";
    if (body.includes('"ordinary-enrollment"') && body.includes('"attendance.clear"')) {
      lostResponseCount += 1;
      await route.fetch();
      await route.abort("connectionfailed");
      return;
    }
    await route.continue();
  });
  const reconciliationRead = page.waitForResponse((response) => response.url().includes("/api/staff/attendance?")
    && response.request().method() === "GET" && response.ok());
  await ordinary.locator("[data-attendance-control='present']").click();
  await reconciliationRead;
  await ordinary.getByText("Хадгалалт баталгаажлаа", { exact: true }).waitFor({ state: "visible" });
  assert.equal(lostResponseCount, 1, "a lost response performs one attendance mutation");
  assert.equal(await ordinary.locator("[data-attendance-control='present']").isChecked(), false, "one bounded reload reconciles a durable lost-response clear");
  await page.unroute("**/api/staff/attendance");
  await page.reload();
  await page.locator("#tool-app").waitFor({ state: "visible" });
  assert.equal(await page.locator("[data-attendance-row='ordinary-enrollment'] [data-attendance-control='present']").isChecked(), false, "the reconciled clear survives reload");
  assert.equal(await page.locator("[data-attendance-row='transfer-target:enrollment'] [data-attendance-control='present']").isChecked(), true, "transferred attendance survives reload");
  assert.equal(await page.locator("[data-attendance-row='bulk-enrollment'] [data-attendance-control='present']").isChecked(), true, "bulk attendance survives reload");
  assert.deepEqual(browserErrors, [], "attendance interaction produces no uncaught browser errors");
  const settingsBefore = await (await context.request.get(`${baseUrl}/api/staff/dashboard-preferences`)).json();
  assert.equal(settingsBefore.attendanceStudentCardsEnabled, true, 'migration defaults to enabled');
  const deniedSetting = await context.request.post(`${baseUrl}/api/staff/program-calendar`, { headers: { Origin: baseUrl }, data: {
    action: 'teacher-dashboard-preferences.save', ...settingsBefore,
    expectedUpdatedAt: settingsBefore.updatedAt, attendanceStudentCardsEnabled: false,
  } });
  assert.equal(deniedSetting.status(), 403, 'teacher cannot change admin setting');
  const adminToken = randomUUID();
  const adminHash = createHash('sha256').update(adminToken).digest('hex');
  execute(`INSERT INTO staff_account (id,email_normalized,display_name,status,is_test,test_run_id,created_at,updated_at)
    VALUES ('card-admin','card-admin@example.test','Card Admin','active',1,'attendance-browser',${sql(now)},${sql(now)});
    INSERT INTO staff_account_role (staff_account_id,role_code,assigned_at) VALUES ('card-admin','admin',${sql(now)});
    INSERT INTO staff_session (id,staff_account_id,session_token_hash,created_at,expires_at,last_seen_at,is_test,test_run_id)
    VALUES ('card-admin-session','card-admin',${sql(adminHash)},${sql(now)},'2027-12-31T00:00:00.000Z',${sql(now)},1,'attendance-browser');`);
  const adminContext = await browser.newContext();
  const existingCookies = await context.cookies();
  const sessionCookie = existingCookies.find(cookie => cookie.value === rawSessionToken);
  assert.ok(sessionCookie, 'test uses the real staff session cookie');
  await adminContext.addCookies([{ ...sessionCookie, value: adminToken }]);
  const settingsPage = await adminContext.newPage();
  await settingsPage.goto(`${baseUrl}/staff/settings/`);
  await settingsPage.locator('#tool-app').waitFor({ state: 'visible' });
  await settingsPage.locator('#attendance-card-setting summary').click();
  await settingsPage.locator('#attendance-card-setting').scrollIntoViewIfNeeded();
  await settingsPage.screenshot({ path: path.join(screenshotDir, 'attendance-card-setting-desktop.png') });
  await settingsPage.setViewportSize({ width: 390, height: 844 });
  await settingsPage.locator('#attendance-card-setting').scrollIntoViewIfNeeded();
  await settingsPage.screenshot({ path: path.join(screenshotDir, 'attendance-card-setting-mobile.png') });
  const saveSetting = async enabled => {
    await settingsPage.locator('#attendance-card-enabled').setChecked(enabled);
    const saved = settingsPage.waitForResponse(response => response.url().endsWith('/api/staff/program-calendar') && response.request().method() === 'POST');
    await settingsPage.locator('#attendance-card-setting-form button[type="submit"]').click();
    assert.equal((await saved).status(), 200);
    await settingsPage.getByText('Ирцээс карт нээх тохиргоог хадгаллаа.', { exact: true }).waitFor();
  };
  await transferred.locator('[data-attendance-card-toggle]').click();
  await transferredCard.locator('.staff-payment-item').waitFor();
  await transferredCard.getByRole('button', { name: 'Мэдээлэл', exact: true }).click();
  await transferredCard.getByRole('heading', { name: 'Асран хамгаалагч', exact: true }).waitFor();
  await transferredCard.getByRole('button', { name: 'Мэдээлэл засах', exact: true }).click();
  await schoolDraft.fill('Draft retained across admin disable');
  await saveSetting(false);
  const disabledRefresh = page.waitForResponse(response => response.url().includes('attendanceEnrollment=') && response.status() === 409);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await disabledRefresh;
  await schoolDraft.waitFor({ state: 'visible' });
  assert.equal(await schoolDraft.inputValue(), 'Draft retained across admin disable', 'disabling entry point is not permission revocation and retains mounted draft');
  await transferredCard.locator('[data-registration-correction-cancel]').click();
  await settingsPage.reload();
  await settingsPage.locator('#tool-app').waitFor({ state: 'visible' });
  await settingsPage.locator('#attendance-card-setting summary').click();
  assert.equal(await settingsPage.locator('#attendance-card-enabled').isChecked(), false, 'disabled persists');
  assert.equal((await context.request.get(`${baseUrl}/api/staff/payments?attendanceEnrollment=transfer-target:enrollment`)).status(), 409, 'scoped load disabled server-side without claiming permission revocation');
  assert.equal((await context.request.post(`${baseUrl}/api/staff/payments`, { headers: { Origin: baseUrl }, data: { action: 'attendance-payment-card.resolve', enrollmentId: 'transfer-target:enrollment' } })).status(), 409, 'legacy resolver also disabled');
  assert.equal((await context.request.get(`${baseUrl}/api/staff/payments`)).status(), 200, 'normal Payments unaffected');
  const disabledRequests = [];
  page.on('request', request => { if (request.url().includes('/api/staff/payments')) disabledRequests.push(request.url()); });
  await page.reload();
  await page.locator('#tool-app').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-attendance-card-toggle]').count(), 0);
  await page.getByText('Ердийн Ирцийн Сурагч', { exact: true }).click();
  assert.equal(await page.locator('[data-attendance-card-host]').count(), 0);
  assert.equal(disabledRequests.length, 0, 'plain name does not load card data');
  const disabledSave = postFor('ordinary-enrollment');
  await ordinary.locator('[data-attendance-control="present"]').click();
  assert.equal((await disabledSave).status(), 200, 'attendance save still works while cards disabled');
  await ordinary.getByText('Хадгаллаа', { exact: true }).waitFor();
  await saveSetting(true);
  await page.reload();
  await page.locator('#tool-app').waitFor({ state: 'visible' });
  const reenabledLoad = page.waitForResponse(response => response.url().includes('attendanceEnrollment=') && response.ok());
  await transferred.locator('[data-attendance-card-toggle]').click();
  await reenabledLoad;
  await page.locator('[data-attendance-card-host] .staff-payment-item').waitFor();
  const loadedCount = disabledRequests.length;
  await transferred.locator('[data-attendance-card-toggle]').click();
  await transferred.locator('[data-attendance-card-toggle]').click();
  assert.equal(disabledRequests.length, loadedCount, 're-enabled card retains cached reopening');
  await adminContext.close();
  await checkWeeklyAttendance({ context, baseUrl, date, execute, screenshotDir, engine: browserEngine });
  console.log('ok admin setting persists, denies teacher writes, gates scoped routes, leaves Payments and attendance enabled');
  console.log(`ok ${browserEngine} attendance browser pending locks, bulk guard, rollback, lost-response reconciliation, and reload (${screenshotDir})`);
  }
} finally {
  if (context) await context.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  if (worker && !worker.killed) worker.kill("SIGTERM");
  rmSync(persistDir, { recursive: true, force: true });
}
