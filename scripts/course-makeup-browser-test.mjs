import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

// Disposable Worker/D1 coverage for the rendered teacher make-up workflow.
// The staff cookie is a regular hashed local session, never a production bypass.
const persistDir = mkdtempSync(path.join(tmpdir(), "naranerdem-makeup-browser-"));
const screenshotDir = process.env.MAKEUP_BROWSER_SCREENSHOT_DIR || path.join(tmpdir(), "naranerdem-makeup-capacity-screens");
mkdirSync(screenshotDir, { recursive: true });
const rawSessionToken = randomUUID();
const sessionHash = createHash("sha256").update(rawSessionToken).digest("hex");
const port = 19800 + Math.floor(Math.random() * 400);
const baseUrl = `http://127.0.0.1:${port}`;
const wranglerCli = path.resolve("node_modules/wrangler/wrangler-dist/cli.js");
let worker;
let browser;
let context;
let workerOutput = "";

function runWrangler(args, label) {
  const result = spawnSync(process.execPath, [wranglerCli, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${label} failed\n${result.stdout}\n${result.stderr}`);
}
function sql(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function execute(command) {
  runWrangler(["d1", "execute", "DB", "--env", "staging", "--local", "--persist-to", persistDir, "--command", command], "local D1 setup");
}
function localToday() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ulaanbaatar", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
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
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Local Worker did not become ready: ${String(lastError)}\n${workerOutput}`);
}
async function waitForRenderedCount(page, selector, expected, label) {
  const deadline = Date.now() + 5_000;
  let actual = -1;
  while (Date.now() < deadline) {
    actual = await page.locator(selector).count();
    if (actual === expected) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`${label}: expected ${expected} rendered element(s), found ${actual}`);
}

try {
  console.log("make-up browser fixture: applying local schema");
  runWrangler(["d1", "migrations", "apply", "DB", "--env", "staging", "--local", "--persist-to", persistDir], "local migrations");
  const now = new Date().toISOString();
  const today = localToday();
  const sourceDate = addDays(today, -7);
  const targetDate = today;
  const dayChangeDate = addDays(today, 16);
  const dayChangeReplacementDate = addDays(today, 18);
  const alternateDate = new Date(`${today}T00:00:00Z`).getUTCDay() === 0 ? addDays(today, -1) : addDays(today, 1);
  const confirmedAt = new Date(`${addDays(today, -30)}T00:00:00+08:00`).toISOString();
  execute(`
    INSERT INTO staff_account (id, email_normalized, display_name, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('makeup-browser-staff', 'makeup-browser@example.test', 'Makeup Browser Teacher', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO staff_account_role (staff_account_id, role_code, assigned_at) VALUES ('makeup-browser-staff', 'teacher', ${sql(now)});
    INSERT INTO staff_session (id, staff_account_id, session_token_hash, created_at, expires_at, last_seen_at, is_test, test_run_id)
      VALUES ('makeup-browser-session', 'makeup-browser-staff', ${sql(sessionHash)}, ${sql(now)}, '2027-12-31T00:00:00.000Z', ${sql(now)}, 1, 'makeup-browser');
    INSERT INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_current, is_test, test_run_id, created_at, updated_at)
      VALUES ('year', 'Browser нөхөх', 'closed', '${addDays(today, -90)}', '${addDays(today, 90)}', 1, 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO curriculum_program_family (id, kind, display_name, annual_stage_code, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('family', 'annual_course', 'Browser нөхөх', 'stage_1', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO curriculum_program (id, program_family_id, academic_year_id, stage_code, revision_number, display_name, program_kind, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('program', 'family', 'year', 'stage_1', 1, 'Browser нөхөх хөтөлбөр', 'annual_course', 'draft', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO curriculum_lesson (id, curriculum_program_id, sequence_number, title, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('lesson', 'program', 1, 'Ижил хичээл', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('lesson-2', 'program', 2, 'Дараагийн хичээл', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('lesson-3', 'program', 3, 'Өөр өдрийн хичээл', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('lesson-4', 'program', 4, 'Орлуулах өдрийн хичээл', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    UPDATE curriculum_program SET status = 'published', published_at = ${sql(now)} WHERE id = 'program';
    UPDATE curriculum_program_family SET current_published_program_id = 'program' WHERE id = 'family';
    INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, starts_on, curriculum_program_id, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('offering', 'annual_course', 'Browser нөхөх сургалт', 'year', 'stage_1', '${sourceDate}', 'program', 1, 'paid', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO class_session (id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, activity_offering_id, is_test, test_run_id, created_at, updated_at) VALUES
      ('source-class', 'year', 'stage_1', 'Эх анги', 'Бямба', '10:00', '11:20', 10, 'available', 'offering', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('target-class', 'year', 'stage_1', 'Зорилтот анги', 'Ням', '23:00', '23:59', 1, 'available', 'offering', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('day-change-class', 'year', 'stage_1', 'Өөрчлөлтийн анги', 'Даваа', '12:00', '13:20', 10, 'available', 'offering', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO class_meeting_rule (class_session_id, recurrence_kind, first_date, weekly_weekday, start_time, end_time, created_at, updated_at) VALUES
      ('source-class', 'weekly', '${sourceDate}', 'Бямба', '10:00', '11:20', ${sql(now)}, ${sql(now)}),
      ('target-class', 'weekly', '${targetDate}', 'Ням', '23:00', '23:59', ${sql(now)}, ${sql(now)}),
      ('day-change-class', 'weekly', '${sourceDate}', 'Даваа', '12:00', '13:20', ${sql(now)}, ${sql(now)});
    INSERT INTO class_calendar (id, class_session_id, timezone, status, is_test, test_run_id, created_at, updated_at) VALUES
      ('source-calendar', 'source-class', 'Asia/Ulaanbaatar', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('target-calendar', 'target-class', 'Asia/Ulaanbaatar', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('day-change-calendar', 'day-change-class', 'Asia/Ulaanbaatar', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO class_calendar_revision (id, class_calendar_id, curriculum_program_id, revision_number, status, first_candidate_date, locked_through_sequence, is_test, test_run_id, created_at, updated_at) VALUES
      ('source-revision', 'source-calendar', 'program', 1, 'draft', '${sourceDate}', 0, 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('target-revision', 'target-calendar', 'program', 1, 'draft', '${targetDate}', 0, 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('day-change-revision', 'day-change-calendar', 'program', 1, 'draft', '${sourceDate}', 0, 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO class_calendar_slot (id, class_calendar_revision_id, local_date, start_time, end_time, slot_source, status, curriculum_lesson_id, is_test, test_run_id, created_at, updated_at) VALUES
      ('source-slot', 'source-revision', '${sourceDate}', '10:00', '11:20', 'generated', 'scheduled', 'lesson', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('same-day-slot', 'target-revision', '${targetDate}', '22:00', '22:20', 'generated', 'scheduled', 'lesson-2', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('target-slot', 'target-revision', '${targetDate}', '23:00', '23:59', 'generated', 'scheduled', 'lesson', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('alternate-day-slot', 'target-revision', '${alternateDate}', '21:00', '21:20', 'generated', 'scheduled', 'lesson-3', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('day-change-slot-1', 'day-change-revision', '${sourceDate}', '12:00', '13:20', 'generated', 'scheduled', 'lesson', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('day-change-slot', 'day-change-revision', '${dayChangeDate}', '12:00', '13:20', 'generated', 'scheduled', 'lesson-2', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('day-change-slot-3', 'day-change-revision', '${addDays(dayChangeDate, 7)}', '12:00', '13:20', 'generated', 'scheduled', 'lesson-3', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('day-change-slot-4', 'day-change-revision', '${addDays(dayChangeDate, 14)}', '12:00', '13:20', 'generated', 'scheduled', 'lesson-4', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    UPDATE class_calendar_revision SET status = 'published', published_at = ${sql(now)} WHERE id IN ('source-revision', 'target-revision', 'day-change-revision');
    INSERT INTO guardian_account (id, full_name, primary_phone, primary_phone_normalized, email, email_normalized, home_address, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('guardian', 'Browser Асран', '99000000', '99000000', 'guardian@example.test', 'guardian@example.test', 'Тест', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO student (id, surname, given_name, gender, date_of_birth, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('student', 'Browser Маш Урт', 'Нөхөх Оролцогчийн Нэр', 'not_specified', '2015-01-01', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO pre_registration (id, guardian_id, academic_year_id, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('prereg', 'guardian', 'year', 'completed', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO application_child (id, pre_registration_id, student_id, current_grade, returning_status, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('application', 'prereg', 'student', 5, 'new', 'enrolled', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO enrollment (id, application_child_id, student_id, academic_year_id, class_session_id, status, confirmed_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('source-enrollment', 'application', 'student', 'year', 'source-class', 'confirmed', '${confirmedAt}', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO registration_draft (id, access_token_hash, academic_year_id, guardian_full_name, guardian_relationship, primary_phone, email, normalized_email, home_address, payment_plan_code, parent_rules_version, student_rules_version, status, expires_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('hold-draft', '${"a".repeat(64)}', 'year', 'Hold Guardian', 'parent', '99000001', 'hold@example.test', 'hold@example.test', 'Тест', 'single', 'v1', 'v1', 'awaiting_initial_payment', '${addDays(today, 30)}T00:00:00.000Z', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO registration_draft_child (id, registration_draft_id, position, surname, given_name, gender, date_of_birth, current_grade, returning_status, selected_stage_code, selected_class_session_id, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('hold-child', 'hold-draft', 0, 'Hold', 'Child', 'not_specified', '2015-02-02', '5', 'new', 'stage_1', 'target-class', 'awaiting_initial_payment', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO registration_capacity_hold (id, registration_draft_child_id, class_session_id, hold_type, status, deadline_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('target-hold', 'hold-child', 'target-class', 'initial_payment', 'active', '${addDays(today, 30)}T00:00:00.000Z', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
  `);

  console.log("make-up browser fixture: starting local Worker");
  worker = spawn(process.execPath, [wranglerCli, "dev", "--env", "staging", "--local", "--persist-to", persistDir,
    "--ip", "127.0.0.1", "--port", String(port), "--var", `APP_ORIGIN:${baseUrl}`], { stdio: ["ignore", "pipe", "pipe"] });
  worker.stdout.on("data", (chunk) => { workerOutput += String(chunk); });
  worker.stderr.on("data", (chunk) => { workerOutput += String(chunk); });
  await waitForWorker();

  console.log("make-up browser fixture: exercising rendered staff workflow");
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  await context.addCookies([{ name: "naran_staff_session", value: rawSessionToken, url: baseUrl, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  console.log("make-up browser fixture: opening teacher home");
  await page.goto(`${baseUrl}/staff/`);
  await page.locator("#staff-home").waitFor({ state: "visible" });
  await page.getByRole("link", { name: "Бүртгэл, төлбөр" }).waitFor({ state: "visible" });
  await page.getByRole("link", { name: "Нөхөх хичээл" }).waitFor({ state: "visible" });
  await page.locator("#staff-agenda [data-agenda-occurrence='target-slot']").waitFor({ state: "visible" });
  assert.equal(await page.locator("#staff-agenda [data-agenda-occurrence='target-slot']").count(), 1, "home renders one stable link for the dated lesson occurrence");
  await page.locator("#staff-agenda [data-agenda-occurrence='target-slot']").click();
  await page.waitForURL(/\/staff\/attendance\/\?date=.*occurrence=target-slot/);
  await page.getByText("Бүртгэлтэй сурагч алга.", { exact: true }).waitFor({ state: "visible" });
  await page.goBack();
  await page.locator("#staff-home").waitFor({ state: "visible" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("#staff-agenda").screenshot({ path: path.join(screenshotDir, "teacher-home-agenda-before-booking-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#staff-agenda").screenshot({ path: path.join(screenshotDir, "teacher-home-agenda-before-booking-mobile.png") });
  await page.setViewportSize({ width: 768, height: 900 });
  await page.locator("#staff-agenda").screenshot({ path: path.join(screenshotDir, "teacher-home-agenda-before-booking-intermediate.png") });
  await page.setViewportSize({ width: 1280, height: 900 });

  execute(`UPDATE teacher_dashboard_preferences SET show_setup_section = 0, updated_at = ${sql(now)} WHERE singleton = 1;`);
  await page.reload();
  await page.locator("#staff-home").waitFor({ state: "visible" });
  assert.equal(await page.locator("#staff-setup-section").isHidden(), true, "the existing hidden-settings preference hides the complete setup section without exposing replacement shortcuts");
  await page.screenshot({ path: path.join(screenshotDir, "teacher-home-settings-hidden.png") });
  execute(`UPDATE teacher_dashboard_preferences SET show_setup_section = 1, updated_at = ${sql(now)} WHERE singleton = 1;`);
  await page.reload();
  await page.locator("#staff-setup-section").waitFor({ state: "visible" });

  console.log("make-up browser fixture: checking make-up availability");
  await page.goto(`${baseUrl}/staff/makeups/`);
  await page.locator("#tool-app").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Нөхөх", exact: true }).click();
  await page.getByText("Тохирох энгийн анги одоогоор алга.").waitFor({ state: "visible" });
  assert.equal(await page.getByRole("button", { name: "Энд нөхөх", exact: true }).count(), 0, "a capacity-consuming hold hides the unavailable normal target");

  execute(`UPDATE registration_capacity_hold SET status = 'released', released_at = ${sql(now)} WHERE id = 'target-hold';`);
  await page.reload();
  await page.locator("#tool-app").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Нөхөх", exact: true }).click();
  await page.getByText("Сул суудал: 1").waitFor({ state: "visible" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("#makeup-detail").screenshot({ path: path.join(screenshotDir, "makeup-capacity-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#makeup-detail").screenshot({ path: path.join(screenshotDir, "makeup-capacity-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Энд нөхөх", exact: true }).click();
  await page.getByText("Нөхөх хичээлийг товлолоо.").waitFor({ state: "visible" });
  const assignments = await page.evaluate(async () => (await fetch("/api/staff/makeups", { credentials: "same-origin" })).json());
  assert.equal(assignments.scheduled.length, 1, "the rendered normal-target action creates one active assignment");
  assert.equal(assignments.scheduled[0].targetClassSessionId, "target-class", "the booking retains its exact target class identity");

  execute(`
    UPDATE class_session SET capacity = 2 WHERE id = 'target-class';
    INSERT INTO student (id, surname, given_name, gender, date_of_birth, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('ordinary-student', 'Үндсэн Оролцогчийн', 'Маш Урт Туршилтын Нэр', 'not_specified', '2014-03-03', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO application_child (id, pre_registration_id, student_id, current_grade, returning_status, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('ordinary-application', 'prereg', 'ordinary-student', 6, 'new', 'enrolled', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO enrollment (id, application_child_id, student_id, academic_year_id, class_session_id, status, confirmed_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('ordinary-target-enrollment', 'ordinary-application', 'ordinary-student', 'year', 'target-class', 'confirmed', '${confirmedAt}', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
  `);

  console.log("make-up browser fixture: checking destination attendance");
  await page.goto(`${baseUrl}/staff/attendance/?date=${today}&occurrence=target-slot`);
  await page.locator("#tool-app").waitFor({ state: "visible" });
  await page.getByText("Browser Маш Урт Нөхөх Оролцогчийн Нэр", { exact: true }).waitFor({ state: "visible" });
  await page.getByText("Үндсэн Оролцогчийн Маш Урт Туршилтын Нэр", { exact: true }).waitFor({ state: "visible" });
  await page.getByText("Нөхөх", { exact: true }).waitFor({ state: "visible" });
  await page.locator("#attendance-summary").getByText("0 / 2 тэмдэглэсэн", { exact: true }).waitFor({ state: "visible" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("#attendance-detail").screenshot({ path: path.join(screenshotDir, "makeup-destination-attendance-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#attendance-detail").screenshot({ path: path.join(screenshotDir, "makeup-destination-attendance-mobile.png") });
  await page.setViewportSize({ width: 768, height: 900 });
  await page.locator("#attendance-detail").screenshot({ path: path.join(screenshotDir, "makeup-destination-attendance-intermediate.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("[data-attendance-row='source-enrollment'] [data-attendance-control='present']").check();
  await page.getByText("Ирцийг хадгаллаа.", { exact: true }).waitFor({ state: "visible" });
  await page.locator("[data-attendance-row='source-enrollment'] [data-attendance-control='late']").check();
  await page.getByText("Ирцийг хадгаллаа.", { exact: true }).waitFor({ state: "visible" });
  await page.reload();
  await page.locator("#tool-app").waitFor({ state: "visible" });
  await page.locator("[data-attendance-row='source-enrollment'] [data-attendance-control='late']").waitFor({ state: "visible" });
  assert.equal(await page.locator("[data-attendance-row='source-enrollment'] [data-attendance-control='late']").isChecked(), true, "destination make-up attendance persists through reload");
  const destination = await page.evaluate(async () => (await fetch(`/api/staff/attendance?date=${encodeURIComponent(location.search.match(/date=([^&]+)/)?.[1] || "")}&occurrence=target-slot`, { credentials: "same-origin" })).json());
  assert.equal(destination.selected.rosterCount, 2, "destination attendance summary counts the displayed ordinary and make-up attendees");
  assert.equal(destination.selected.roster.filter((entry) => entry.attendanceKind === "makeup").length, 1, "destination attendee remains visibly distinct from an ordinary enrollment");
  assert.equal(destination.selected.roster.filter((entry) => entry.attendanceKind === "ordinary").length, 1, "destination roster retains the ordinary attendee");
  assert.equal(destination.selected.roster.find((entry) => entry.attendanceKind === "makeup").makeupSource.lessonTitle, "Ижил хичээл", "destination attendee retains the source missed-lesson linkage");
  console.log("make-up browser fixture: reconciling agenda counts");
  await page.goto(`${baseUrl}/staff/`);
  await page.locator("#staff-home").waitFor({ state: "visible" });
  await page.locator("#staff-agenda [data-agenda-occurrence='target-slot']").waitFor({ state: "visible" });
  assert.match(await page.locator("#staff-agenda [data-agenda-occurrence='target-slot']").innerText(), /Үндсэн 1 · Нөхөх 1/, "the agenda card keeps ordinary and make-up counts distinct");
  await page.locator("#staff-agenda [data-agenda-occurrence='target-slot']").click();
  await page.waitForURL(/\/staff\/attendance\/\?date=.*occurrence=target-slot/);
  await page.getByText("Browser Маш Урт Нөхөх Оролцогчийн Нэр", { exact: true }).waitFor({ state: "visible" });
  assert.match(await page.locator(".staff-attendance-makeup-source").innerText(), /Тасалсан хичээл · \d{2}\/\d{2}/, "the selected attendance roster keeps a compact missed-lesson link");
  assert.equal(await page.locator("#attendance-list [role='tab']").count(), 2, "the attendance selector keeps time-only tabs for each dated occurrence");
  const selectedTabBounds = await page.locator("#attendance-list [role='tab'][aria-selected='true']").evaluate((selected) => {
    const strip = selected.parentElement.getBoundingClientRect();
    const tab = selected.getBoundingClientRect();
    return { stripLeft: strip.left, stripRight: strip.right, tabLeft: tab.left, tabRight: tab.right };
  });
  assert.ok(selectedTabBounds.tabLeft >= selectedTabBounds.stripLeft && selectedTabBounds.tabRight <= selectedTabBounds.stripRight, "the selected time tab is visible inside its horizontal strip");
  await page.goBack();
  await page.locator("#staff-home").waitFor({ state: "visible" });
  await page.setViewportSize({ width: 390, height: 844 });
  console.log("make-up browser fixture: switching and collapsing the mobile day accordion");
  assert.equal(await page.locator(`[data-agenda-day='${targetDate}']`).getAttribute("data-open"), "true", "returning from attendance restores the previously expanded day");
  await page.locator(`[data-agenda-day-toggle='${alternateDate}']`).click();
  assert.equal(await page.locator(`[data-agenda-day='${targetDate}']`).getAttribute("data-open"), "false", "opening another day closes the prior day");
  assert.equal(await page.locator(`[data-agenda-day='${alternateDate}']`).getAttribute("data-open"), "true", "the chosen day opens");
  assert.equal(await page.locator(`[data-agenda-day='${targetDate}'] [data-agenda-occurrence='target-slot']`).isVisible(), false, "collapsed mobile days do not expose their lesson cards");
  await page.locator(`[data-agenda-day-toggle='${alternateDate}']`).click();
  assert.equal(await page.locator(`[data-agenda-day='${alternateDate}']`).getAttribute("data-open"), "false", "an open day can be collapsed");
  assert.equal(await page.locator(".staff-agenda-day.empty [data-agenda-day-toggle]").count(), 0, "empty days have no expansion controls");
  assert.equal(await page.locator(".staff-agenda-day.empty").getByText("Хичээлгүй", { exact: true }).count() > 0, true, "empty days show their state below the heading separator");
  await page.locator(`[data-agenda-day-toggle='${targetDate}']`).click();
  assert.equal(await page.locator(`[data-agenda-day='${targetDate}']`).getAttribute("data-open"), "true", "reopening a day restores its lesson cards");
  await page.locator(`[data-agenda-day-toggle='${alternateDate}']`).click();
  const returnLink = page.locator("#staff-agenda [data-agenda-occurrence='alternate-day-slot']");
  assert.match(await returnLink.getAttribute("href"), new RegExp(`homeDay=${alternateDate}`), "direct attendance links carry the current home view for the supported return action");
  await returnLink.click();
  await page.waitForURL(/\/staff\/attendance\/\?date=.*occurrence=alternate-day-slot/);
  assert.match(await page.locator("#attendance-back").getAttribute("href"), new RegExp(`day=${alternateDate}`), "attendance retains the validated home return target");
  await page.locator("#attendance-back").click();
  await page.locator("#staff-home").waitFor({ state: "visible" });
  assert.equal(await page.locator(`[data-agenda-day='${alternateDate}']`).getAttribute("data-open"), "true", "the supported return action restores the expanded day identity");
  console.log("make-up browser fixture: navigating to an explicit empty week");
  await page.locator("#staff-agenda [data-agenda-week='next']").click();
  await waitForRenderedCount(page, "#staff-agenda [data-agenda-day]", 7, "explicit week navigation");
  assert.equal(await page.locator("#staff-agenda [data-agenda-occurrence]").count(), 0, "an explicitly selected empty week remains an empty agenda instead of a loading or error state");
  console.log("make-up browser fixture: returning to the current week");
  await page.locator("#staff-agenda [data-agenda-week='today']").click();
  await waitForRenderedCount(page, "#staff-agenda [data-agenda-occurrence='target-slot']", 1, "returning to the current week");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("#staff-agenda").screenshot({ path: path.join(screenshotDir, "teacher-home-agenda-after-booking-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#staff-agenda").screenshot({ path: path.join(screenshotDir, "teacher-home-agenda-after-booking-mobile.png") });
  console.log("make-up browser fixture: previewing and confirming a regular day change");
  await page.goto(`${baseUrl}/staff/day-changes/?date=${dayChangeDate}&occurrence=day-change-slot`);
  await page.locator("#tool-app").waitFor({ state: "visible" });
  await page.locator(".staff-day-selected").getByText("Дараагийн хичээл").waitFor({ state: "visible" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: path.join(screenshotDir, "day-change-idle-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(screenshotDir, "day-change-idle-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Цуцлаад орлуулах цаг товлох", exact: true }).click();
  await page.locator('[data-day-change-form] [name="replacementDate"]').fill(dayChangeReplacementDate);
  await page.locator('[data-day-change-form] [name="replacementStartTime"]').fill("19:00");
  const failDayPreview = async (route) => {
    if (route.request().method() === "POST" && route.request().postData()?.includes("day-change.preview")) {
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { message: "Туршилтын урьдчилан харах алдаа" } }) });
      return;
    }
    await route.continue();
  };
  await page.route("**/api/staff/day-changes", failDayPreview);
  await page.getByRole("button", { name: "Урьдчилан харах", exact: true }).click();
  await page.getByText("Туршилтын урьдчилан харах алдаа", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await page.locator('[data-day-change-form] [name="replacementDate"]').inputValue(), dayChangeReplacementDate,
    "a recoverable preview error retains the entered replacement date");
  assert.equal(await page.locator('[data-day-change-form] [name="replacementStartTime"]').inputValue(), "19:00",
    "a recoverable preview error retains the entered replacement time");
  await page.unroute("**/api/staff/day-changes", failDayPreview);
  let releasePreview;
  let previewPosts = 0;
  const previewStarted = new Promise((resolve) => { releasePreview = resolve; });
  let allowPreview;
  const continuePreview = new Promise((resolve) => { allowPreview = resolve; });
  const delayDayPreview = async (route) => {
    if (route.request().method() === "POST" && route.request().postData()?.includes("day-change.preview")) {
      previewPosts += 1;
      releasePreview();
      await continuePreview;
      await route.continue();
      return;
    }
    await route.continue();
  };
  await page.route("**/api/staff/day-changes", delayDayPreview);
  await page.getByRole("button", { name: "Урьдчилан харах", exact: true }).click();
  await previewStarted;
  await page.getByRole("button", { name: "Тооцоолж байна…", exact: true }).waitFor({ state: "visible" });
  assert.equal(await page.getByRole("button", { name: "Тооцоолж байна…", exact: true }).isDisabled(), true,
    "the day-change preview enters a visible, duplicate-safe busy state before the response");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: path.join(screenshotDir, "day-change-busy-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("[data-day-change-form]").screenshot({ path: path.join(screenshotDir, "day-change-busy-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('[data-day-change-form] [name="replacementDate"]').press("Enter");
  assert.equal(previewPosts, 1, "a busy day-change form ignores a repeated Enter submission");
  allowPreview();
  await page.locator("#day-confirmation").waitFor({ state: "visible" });
  await page.unroute("**/api/staff/day-changes", delayDayPreview);
  assert.equal(await page.locator("[data-day-change-form]").count(), 0,
    "the reviewed operation replaces its editable form instead of leaving a competing preview button");
  await page.locator(".staff-day-preview-list").getByText("Дараагийн хичээл").waitFor({ state: "visible" });
  assert.equal(await page.locator("#day-operation").isHidden(), true, "whole-day controls collapse while an individual lesson change is under review");
  await page.getByRole("button", { name: "Засах", exact: true }).click();
  assert.equal(await page.locator("[name='replacementDate']").inputValue(), dayChangeReplacementDate,
    "editing restores the reviewed replacement date");
  await page.locator('[data-day-change-form] [name="replacementStartTime"]').fill("18:30");
  assert.equal(await page.locator("#day-confirmation").isHidden(), true, "editing a reviewed replacement invalidates its stale preview");
  await page.locator('[data-day-change-form] [name="replacementStartTime"]').fill("19:00");
  await page.getByRole("button", { name: "Урьдчилан харах", exact: true }).click();
  await page.locator("#day-confirmation").waitFor({ state: "visible" });
  await page.locator("#day-confirmation").scrollIntoViewIfNeeded();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: path.join(screenshotDir, "day-change-preview-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#day-confirmation").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(screenshotDir, "day-change-preview-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
  let releaseApply;
  let applyPosts = 0;
  const applyOperationIds = [];
  const applyStarted = new Promise((resolve) => { releaseApply = resolve; });
  let allowApply;
  const continueApply = new Promise((resolve) => { allowApply = resolve; });
  const delayDayApply = async (route) => {
    if (route.request().method() === "POST" && route.request().postData()?.includes("day-change.apply")) {
      applyPosts += 1;
      applyOperationIds.push(route.request().postDataJSON().operationId);
      releaseApply();
      await continueApply;
      if (applyPosts === 1) {
        const committed = await route.fetch();
        assert.equal(committed.ok(), true, "the delayed first apply reaches the real Worker before its response is lost");
        await route.abort("failed");
        return;
      }
      await route.continue();
      return;
    }
    await route.continue();
  };
  await page.route("**/api/staff/day-changes", delayDayApply);
  await page.getByRole("button", { name: "Орлуулах цагийг хадгалах", exact: true }).click();
  await applyStarted;
  await page.getByRole("button", { name: "Хадгалж байна…", exact: true }).waitFor({ state: "visible" });
  assert.equal(applyPosts, 1, "the reviewed day change sends one operation while busy");
  assert.equal(await page.getByRole("button", { name: "Хадгалж байна…", exact: true }).isDisabled(), true,
    "the reviewed day-change confirmation cannot be clicked twice while saving");
  allowApply();
  await page.getByText("Хадгалсан эсэх тодорхойгүй байна. Ижил баталгаажуулалтыг дахин дарж шалгана уу.", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await page.locator("#day-confirmation").isHidden(), false,
    "a lost apply response keeps the reviewed operation available for same-ID recovery");
  await page.getByRole("button", { name: "Орлуулах цагийг хадгалах", exact: true }).click();
  await page.getByText("Өдрийн хуваарийн өөрчлөлтийг хадгаллаа.", { exact: true }).waitFor({ state: "visible" });
  await page.unroute("**/api/staff/day-changes", delayDayApply);
  assert.equal(applyPosts, 2, "a recovery retry sends one additional request after the lost response");
  assert.equal(applyOperationIds[0], applyOperationIds[1], "the lost-response retry keeps its original durable operation identity");
  assert.equal(await page.locator("#day-confirmation").isHidden(), true, "the reviewed regular change is applied once and clears its preview");
  await page.getByText("Орлуулах ээлжит цаг товлогдлоо.", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("link", { name: "Орлуулах хичээл рүү очих", exact: true }).waitFor({ state: "visible" });
  assert.equal(await page.getByRole("button", { name: "Орлуулах ээлжит цаг оруулах", exact: true }).count(), 0,
    "a saved replacement does not offer a second replacement for the same cancelled source slot");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: path.join(screenshotDir, "day-change-result-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(screenshotDir, "day-change-result-mobile.png") });
  console.log(`ok browser make-up capacity target availability and booking (${screenshotDir})`);
} finally {
  if (context) await context.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  if (worker && !worker.killed) worker.kill("SIGTERM");
  rmSync(persistDir, { recursive: true, force: true });
}
