import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { assertDisposableLocalWrangler, failWithoutQuotaRetry } from "./local-disposable-test-target.mjs";

const persistDir = mkdtempSync(path.join(tmpdir(), "naranerdem-class-schedule-browser-"));
const screenshotDir = process.env.CLASS_SCHEDULE_SCREENSHOT_DIR || path.join(tmpdir(), "naranerdem-class-schedule-screens");
mkdirSync(screenshotDir, { recursive: true });
const token = randomUUID();
const tokenHash = createHash("sha256").update(token).digest("hex");
const port = 20700 + Math.floor(Math.random() * 300);
const baseUrl = `http://127.0.0.1:${port}`;
const wranglerCli = path.resolve("node_modules/wrangler/wrangler-dist/cli.js");
let worker;
let browser;
let context;
let workerOutput = "";

function sql(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function localDate(days) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ulaanbaatar", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const start = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day) + days));
  return start.toISOString().slice(0, 10);
}
function runWrangler(args, label) {
  assertDisposableLocalWrangler(args, persistDir, label);
  const result = spawnSync(process.execPath, [wranglerCli, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) failWithoutQuotaRetry(label, result);
}
function execute(command) {
  runWrangler(["d1", "execute", "DB", "--env", "staging", "--local", "--persist-to", persistDir, "--command", command], "class schedule local setup");
}
async function waitForWorker() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Local Worker did not become ready.\n${workerOutput}`);
}

try {
  runWrangler(["d1", "migrations", "apply", "DB", "--env", "staging", "--local", "--persist-to", persistDir], "class schedule local migrations");
  const now = new Date().toISOString();
  const future = localDate(14);
  execute(`
    INSERT INTO staff_account (id, email_normalized, display_name, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('staff', 'schedule@example.test', 'Хуваарийн багш', 'active', 1, 'class-schedule-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO staff_account_role (staff_account_id, role_code, assigned_at) VALUES ('staff', 'teacher', ${sql(now)});
    INSERT INTO staff_session (id, staff_account_id, session_token_hash, created_at, expires_at, last_seen_at, is_test, test_run_id)
      VALUES ('session', 'staff', ${sql(tokenHash)}, ${sql(now)}, '2027-12-31T00:00:00.000Z', ${sql(now)}, 1, 'class-schedule-browser');
    INSERT INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_current, is_test, test_run_id, created_at, updated_at)
      VALUES ('year', 'Хуваарийн тест жил', 'closed', '${localDate(-30)}', '${localDate(300)}', 1, 1, 'class-schedule-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO curriculum_program_family (id, kind, display_name, annual_stage_code, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('family', 'annual_course', 'Хуваарийн тест', 'stage_1', 'active', 1, 'class-schedule-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO curriculum_program (id, program_family_id, academic_year_id, stage_code, revision_number, display_name, program_kind, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('program', 'family', 'year', 'stage_1', 1, 'Хуваарийн тест хөтөлбөр', 'annual_course', 'draft', 1, 'class-schedule-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO curriculum_lesson (id, curriculum_program_id, sequence_number, title, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('lesson', 'program', 1, 'Тест хичээл', 'active', 1, 'class-schedule-browser', ${sql(now)}, ${sql(now)});
    UPDATE curriculum_program SET status = 'published', published_at = ${sql(now)} WHERE id = 'program';
    UPDATE curriculum_program_family SET current_published_program_id = 'program' WHERE id = 'family';
    INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, starts_on, curriculum_program_id, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('offering', 'annual_course', 'Хуваарийн тест сургалт', 'year', 'stage_1', '${future}', 'program', 1, 'paid', 'active', 1, 'class-schedule-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO class_session (id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, activity_offering_id, is_publicly_visible, is_test, test_run_id, created_at, updated_at)
      VALUES ('class', 'year', 'stage_1', 'Хуваарийн тест анги', 'Пүрэв', '18:00', '19:20', 10, 'available', 'offering', 1, 1, 'class-schedule-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO class_meeting_rule (class_session_id, recurrence_kind, first_date, weekly_weekday, start_time, end_time, created_at, updated_at)
      VALUES ('class', 'weekly', '${future}', 'Пүрэв', '18:00', '19:20', ${sql(now)}, ${sql(now)});
    INSERT INTO class_calendar (id, class_session_id, timezone, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('calendar', 'class', 'Asia/Ulaanbaatar', 'active', 1, 'class-schedule-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO class_calendar_revision (id, class_calendar_id, curriculum_program_id, revision_number, status, first_candidate_date, locked_through_sequence, is_test, test_run_id, created_at, updated_at)
      VALUES ('revision', 'calendar', 'program', 1, 'draft', '${future}', 0, 1, 'class-schedule-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO class_calendar_slot (id, class_calendar_revision_id, local_date, start_time, end_time, slot_source, status, curriculum_lesson_id, is_test, test_run_id, created_at, updated_at)
      VALUES ('slot', 'revision', '${future}', '18:00', '19:20', 'generated', 'scheduled', 'lesson', 1, 'class-schedule-browser', ${sql(now)}, ${sql(now)});
    UPDATE class_calendar_revision SET status = 'published', published_at = ${sql(now)} WHERE id = 'revision';
    INSERT INTO guardian_account (id, full_name, primary_phone, primary_phone_normalized, email, email_normalized, home_address, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('guardian', 'Календар асран хамгаалагч', '99112233', '99112233', 'calendar@example.test', 'calendar@example.test', 'Тест', 'active', 1, 'class-schedule-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO student (id, surname, given_name, gender, date_of_birth, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('student', 'Календар', 'Суралцагч', 'not_specified', '2015-01-01', 'active', 1, 'class-schedule-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO pre_registration (id, guardian_id, academic_year_id, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('pre', 'guardian', 'year', 'completed', 1, 'class-schedule-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO application_child (id, pre_registration_id, student_id, current_grade, returning_status, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('application', 'pre', 'student', 5, 'new', 'enrolled', 1, 'class-schedule-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO enrollment (id, application_child_id, student_id, academic_year_id, class_session_id, status, confirmed_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('enrollment', 'application', 'student', 'year', 'class', 'confirmed', ${sql(now)}, 1, 'class-schedule-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO registration_draft (id, access_token_hash, academic_year_id, guardian_full_name, guardian_relationship, primary_phone, email, normalized_email, home_address, payment_plan_code, parent_rules_version, student_rules_version, status, expires_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('pending-draft', '${"a".repeat(64)}', 'year', 'Хүлээгдэж буй асран хамгаалагч', 'Эцэг эх', '99112234', 'pending@example.test', 'pending@example.test', 'Тест', 'single', 'v1', 'v1', 'awaiting_initial_payment', '2027-12-31T00:00:00.000Z', 1, 'class-schedule-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO registration_draft_child (id, registration_draft_id, position, surname, given_name, gender, date_of_birth, current_grade, returning_status, selected_stage_code, selected_class_session_id, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('pending-child', 'pending-draft', 0, 'Хүлээгдэж', 'Буй', 'not_specified', '2015-01-01', '5', 'new', 'stage_1', 'class', 'awaiting_initial_payment', 1, 'class-schedule-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO registration_capacity_hold (id, registration_draft_child_id, class_session_id, hold_type, status, deadline_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('pending-hold', 'pending-child', 'class', 'initial_payment', 'active', '2027-12-31T00:00:00.000Z', 1, 'class-schedule-browser', ${sql(now)}, ${sql(now)});
  `);
  worker = spawn(process.execPath, [wranglerCli, "dev", "--env", "staging", "--local", "--persist-to", persistDir, "--ip", "127.0.0.1", "--port", String(port), "--var", `APP_ORIGIN:${baseUrl}`], { stdio: ["ignore", "pipe", "pipe"] });
  worker.stdout.on("data", (chunk) => { workerOutput += String(chunk); });
  worker.stderr.on("data", (chunk) => { workerOutput += String(chunk); });
  await waitForWorker();
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([{ name: "naran_staff_session", value: token, url: baseUrl, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto(`${baseUrl}/staff/offerings/`);
  await page.locator("#tool-app").waitFor({ state: "visible" });
  await page.locator('[data-edit-offering="offering"]').click();
  await page.locator('[data-class-edit="class"]').click();
  const form = page.locator("#class-form");
  await page.locator('[data-class-calendar-visibility="class"]').click();
  await page.getByText("Ангийг календараас нуусан. Баталгаатай суралцагчтай бол календард харагдсан хэвээр байна.", { exact: true }).waitFor({ state: "visible" });
  let overview = await page.evaluate(async () => (await fetch("/api/staff/program-calendar", { credentials: "same-origin" })).json());
  let classRow = overview.classes.find((entry) => entry.id === "class");
  assert.deepEqual([Boolean(classRow.calendarVisibility), Boolean(classRow.calendarEffectiveVisibility)], [false, true], "a confirmed enrollment makes a manually hidden class immediately visible to the calendar");
  let published = await page.evaluate(async () => (await fetch("/api/calendar/published", { credentials: "same-origin" })).json());
  assert.equal(published.calendars.some((entry) => entry.classSession.id === "class"), true, "the published calendar retains a manually hidden class with a current confirmed enrollment");
  execute(`UPDATE enrollment SET transferred_out_at = ${sql(now)} WHERE id = 'enrollment'`);
  await page.reload();
  await page.locator("#tool-app").waitFor({ state: "visible" });
  await page.locator('[data-edit-offering="offering"]').click();
  await page.locator('[data-class-edit="class"]').click();
  published = await page.evaluate(async () => (await fetch("/api/calendar/published", { credentials: "same-origin" })).json());
  assert.equal(published.calendars.some((entry) => entry.classSession.id === "class"), false, "transferred-out history and an active initial-payment hold do not keep a manually hidden class in the published calendar");
  execute(`UPDATE registration_capacity_hold SET status = 'released', released_at = ${sql(now)}, release_reason = 'test_cleanup' WHERE id = 'pending-hold'`);
  execute(`UPDATE registration_draft_child SET status = 'cancelled' WHERE id = 'pending-child'; UPDATE registration_draft SET status = 'cancelled' WHERE id = 'pending-draft'`);
  await page.locator('[data-class-calendar-visibility="class"]').click();
  await page.getByText("Ангийг календард харууллаа.", { exact: true }).waitFor({ state: "visible" });
  await form.getByRole("button", { name: "Хуваариас хасах", exact: true }).click();
  await form.locator("[data-class-schedule-remove-confirm]").click();
  await page.getByText("Ангийг хуваариас хаслаа. Бүртгэл хаагдаж, нийтээс нуусан.", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await form.locator("#class-open").count(), 0, "a removed class has no registration-open control");
  await page.screenshot({ path: path.join(screenshotDir, "class-schedule-removed-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(screenshotDir, "class-schedule-removed-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await form.getByRole("button", { name: "Хуваарьт оруулах", exact: true }).click();
  await form.locator("[data-class-schedule-restore-confirm]").click();
  await page.getByText("Ангийг хуваарьт орууллаа. Бүртгэл болон нийтэд харагдах төлөв хаалттай хэвээр байна.", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await form.locator("#class-open").isChecked(), false, "restoration retains closed registration");
  overview = await page.evaluate(async () => (await fetch("/api/staff/program-calendar", { credentials: "same-origin" })).json());
  classRow = overview.classes.find((entry) => entry.id === "class");
  assert.deepEqual([classRow.scheduleState, classRow.registrationOpen, Boolean(classRow.publicVisibility)], ["active", false, false], "restoration keeps public visibility hidden");
  assert.deepEqual(browserErrors, [], "the rendered controls create no browser errors");
  console.log(`ok class schedule controls browser (${screenshotDir})`);
} finally {
  if (context) await context.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  if (worker && !worker.killed) worker.kill("SIGTERM");
  rmSync(persistDir, { recursive: true, force: true });
}
