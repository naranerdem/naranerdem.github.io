import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { assertDisposableLocalWrangler, failWithoutQuotaRetry } from "./local-disposable-test-target.mjs";

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
  assertDisposableLocalWrangler(args, persistDir, label);
  // The complete local migration ledger exceeds Node's default subprocess buffer.
  const result = spawnSync(process.execPath, [wranglerCli, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) failWithoutQuotaRetry(label, result);
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
async function openMakeupSectionAndFirstGroup(page, section, memberSelector = "") {
  const sectionNode = page.locator(`[data-section='${section}']`);
  console.log(`make-up browser fixture: opening ${section} section`);
  if (!await sectionNode.evaluate((details) => details.open)) await sectionNode.locator(":scope > summary").click();
  const groups = sectionNode.locator("[data-makeup-group]");
  const group = memberSelector ? groups.filter({ has: page.locator(memberSelector) }).first() : groups.first();
  await group.waitFor({ state: "attached" });
  console.log(`make-up browser fixture: opening ${section} lesson group`);
  if (!await group.evaluate((details) => details.open)) await group.locator(":scope > summary").click();
  return group;
}

try {
  console.log("make-up browser fixture: applying local schema");
  runWrangler(["d1", "migrations", "apply", "DB", "--env", "staging", "--local", "--persist-to", persistDir], "local migrations");
  const now = new Date().toISOString();
  const today = localToday();
  const sourceDate = addDays(today, -7);
  const targetDate = addDays(today, 2);
  const pastDate = addDays(today, -1);
  const specialAttendanceDate = today;
  const rescheduleDate = addDays(today, 9);
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
      ('day-change-class', 'year', 'stage_1', 'Өөрчлөлтийн анги', 'Даваа', '12:00', '13:20', 10, 'available', 'offering', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('day-change-second-class', 'year', 'stage_1', 'Хоёр дахь өөрчлөлтийн анги', 'Даваа', '15:00', '16:20', 10, 'available', 'offering', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO class_meeting_rule (class_session_id, recurrence_kind, first_date, weekly_weekday, start_time, end_time, created_at, updated_at) VALUES
      ('source-class', 'weekly', '${sourceDate}', 'Бямба', '10:00', '11:20', ${sql(now)}, ${sql(now)}),
      ('target-class', 'weekly', '${targetDate}', 'Ням', '23:00', '23:59', ${sql(now)}, ${sql(now)}),
      ('day-change-class', 'weekly', '${sourceDate}', 'Даваа', '12:00', '13:20', ${sql(now)}, ${sql(now)}),
      ('day-change-second-class', 'weekly', '${sourceDate}', 'Даваа', '15:00', '16:20', ${sql(now)}, ${sql(now)});
    INSERT INTO class_calendar (id, class_session_id, timezone, status, is_test, test_run_id, created_at, updated_at) VALUES
      ('source-calendar', 'source-class', 'Asia/Ulaanbaatar', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('target-calendar', 'target-class', 'Asia/Ulaanbaatar', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('day-change-calendar', 'day-change-class', 'Asia/Ulaanbaatar', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('day-change-second-calendar', 'day-change-second-class', 'Asia/Ulaanbaatar', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO class_calendar_revision (id, class_calendar_id, curriculum_program_id, revision_number, status, first_candidate_date, locked_through_sequence, is_test, test_run_id, created_at, updated_at) VALUES
      ('source-revision', 'source-calendar', 'program', 1, 'draft', '${sourceDate}', 0, 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('target-revision', 'target-calendar', 'program', 1, 'draft', '${targetDate}', 0, 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('day-change-revision', 'day-change-calendar', 'program', 1, 'draft', '${sourceDate}', 0, 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('day-change-second-revision', 'day-change-second-calendar', 'program', 1, 'draft', '${sourceDate}', 0, 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO class_calendar_slot (id, class_calendar_revision_id, local_date, start_time, end_time, slot_source, status, curriculum_lesson_id, is_test, test_run_id, created_at, updated_at) VALUES
      ('source-slot', 'source-revision', '${sourceDate}', '10:00', '11:20', 'generated', 'scheduled', 'lesson', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('source-slot-2', 'source-revision', '${addDays(sourceDate, 1)}', '10:00', '11:20', 'generated', 'scheduled', 'lesson-2', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('same-day-slot', 'target-revision', '${targetDate}', '22:00', '22:20', 'generated', 'scheduled', 'lesson-2', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('target-slot', 'target-revision', '${targetDate}', '23:00', '23:59', 'manual_extra', 'scheduled', 'lesson', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('alternate-day-slot', 'target-revision', '${alternateDate}', '21:00', '21:20', 'generated', 'scheduled', 'lesson-3', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('day-change-slot-1', 'day-change-revision', '${sourceDate}', '12:00', '13:20', 'generated', 'scheduled', 'lesson', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('day-change-slot', 'day-change-revision', '${dayChangeDate}', '12:00', '13:20', 'generated', 'scheduled', 'lesson-2', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('day-change-slot-3', 'day-change-revision', '${addDays(dayChangeDate, 7)}', '12:00', '13:20', 'generated', 'scheduled', 'lesson-3', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('day-change-slot-4', 'day-change-revision', '${addDays(dayChangeDate, 14)}', '12:00', '13:20', 'generated', 'scheduled', 'lesson-4', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('day-change-second-slot', 'day-change-second-revision', '${dayChangeDate}', '15:00', '16:20', 'generated', 'scheduled', 'lesson-3', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    UPDATE class_calendar_revision SET status = 'published', published_at = ${sql(now)} WHERE id IN ('source-revision', 'target-revision', 'day-change-revision', 'day-change-second-revision');
    INSERT INTO guardian_account (id, full_name, primary_phone, primary_phone_normalized, email, email_normalized, home_address, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('guardian', 'Browser Асран', '99000000', '99000000', 'guardian@example.test', 'guardian@example.test', 'Тест', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO student (id, surname, given_name, gender, date_of_birth, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('student', 'Browser Маш Урт', 'Нөхөх Оролцогчийн Нэр', 'not_specified', '2015-01-01', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO student (id, surname, given_name, gender, date_of_birth, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('archive-student', 'Fixture', 'Child 24', 'not_specified', '2015-01-09', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO student (id, surname, given_name, gender, date_of_birth, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('special-student-a', 'Тусгай Нөхөх', 'Анударь', 'not_specified', '2015-04-01', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('special-student-b', 'Тусгай Нөхөх', 'Билгүүн', 'not_specified', '2015-05-01', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('special-student-review', 'Ирц Шалгах', 'Энхрий', 'not_specified', '2015-06-01', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('special-student-reschedule', 'Өдөр Цаг', 'Өөрчлөх', 'not_specified', '2015-07-01', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('special-student-add', 'Тусгай Нөхөх', 'Нэмэх', 'not_specified', '2015-08-01', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO pre_registration (id, guardian_id, academic_year_id, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('prereg', 'guardian', 'year', 'completed', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO pre_registration (id, guardian_id, academic_year_id, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('archive-prereg', 'guardian', 'year', 'completed', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO application_child (id, pre_registration_id, student_id, current_grade, returning_status, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('application', 'prereg', 'student', 5, 'new', 'enrolled', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO application_child (id, pre_registration_id, student_id, current_grade, returning_status, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('archive-application', 'archive-prereg', 'archive-student', 5, 'new', 'enrolled', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO pre_registration (id, guardian_id, academic_year_id, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('special-prereg-a', 'guardian', 'year', 'completed', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('special-prereg-b', 'guardian', 'year', 'completed', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('special-prereg-review', 'guardian', 'year', 'completed', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('special-prereg-reschedule', 'guardian', 'year', 'completed', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('special-prereg-add', 'guardian', 'year', 'completed', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO application_child (id, pre_registration_id, student_id, current_grade, returning_status, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('special-application-a', 'special-prereg-a', 'special-student-a', 5, 'new', 'enrolled', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('special-application-b', 'special-prereg-b', 'special-student-b', 5, 'new', 'enrolled', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('special-application-review', 'special-prereg-review', 'special-student-review', 5, 'new', 'enrolled', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('special-application-reschedule', 'special-prereg-reschedule', 'special-student-reschedule', 5, 'new', 'enrolled', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('special-application-add', 'special-prereg-add', 'special-student-add', 5, 'new', 'enrolled', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO enrollment (id, application_child_id, student_id, academic_year_id, class_session_id, status, confirmed_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('source-enrollment', 'application', 'student', 'year', 'source-class', 'confirmed', '${confirmedAt}', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO enrollment (id, application_child_id, student_id, academic_year_id, class_session_id, status, confirmed_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('archive-enrollment', 'archive-application', 'archive-student', 'year', 'source-class', 'confirmed', '${confirmedAt}', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO enrollment (id, application_child_id, student_id, academic_year_id, class_session_id, status, confirmed_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('special-enrollment-a', 'special-application-a', 'special-student-a', 'year', 'source-class', 'confirmed', '${confirmedAt}', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('special-enrollment-b', 'special-application-b', 'special-student-b', 'year', 'source-class', 'confirmed', '${confirmedAt}', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('special-enrollment-review', 'special-application-review', 'special-student-review', 'year', 'source-class', 'confirmed', '${confirmedAt}', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('special-enrollment-reschedule', 'special-application-reschedule', 'special-student-reschedule', 'year', 'source-class', 'confirmed', '${confirmedAt}', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('special-enrollment-add', 'special-application-add', 'special-student-add', 'year', 'source-class', 'confirmed', '${confirmedAt}', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO course_makeup_special_occurrence (id, curriculum_lesson_id, local_date, start_time, end_time, capacity, status, created_by_staff_account_id, is_test, test_run_id, created_at, updated_at)
      VALUES ('special-occurrence', 'lesson', '${specialAttendanceDate}', '00:00', '01:20', 2, 'active', 'makeup-browser-staff', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('review-special-occurrence', 'lesson', '${pastDate}', '14:00', '15:20', 1, 'active', 'makeup-browser-staff', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('reschedule-special-occurrence', 'lesson', '${rescheduleDate}', '14:00', '15:20', 1, 'active', 'makeup-browser-staff', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('add-special-occurrence', 'lesson', '${pastDate}', '16:00', '17:20', 3, 'active', 'makeup-browser-staff', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO course_makeup_resolution (id, source_enrollment_id, source_class_session_id, source_curriculum_lesson_id, decision, status, decided_by_staff_account_id, decided_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('special-resolution-a', 'special-enrollment-a', 'source-class', 'lesson', 'assigned', 'active', 'makeup-browser-staff', ${sql(now)}, 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('special-resolution-b', 'special-enrollment-b', 'source-class', 'lesson', 'assigned', 'active', 'makeup-browser-staff', ${sql(now)}, 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('special-resolution-review', 'special-enrollment-review', 'source-class', 'lesson', 'assigned', 'active', 'makeup-browser-staff', ${sql(now)}, 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('special-resolution-reschedule', 'special-enrollment-reschedule', 'source-class', 'lesson', 'assigned', 'active', 'makeup-browser-staff', ${sql(now)}, 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('special-resolution-add', 'special-enrollment-add', 'source-class', 'lesson', 'assigned', 'active', 'makeup-browser-staff', ${sql(now)}, 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    -- The 0059 compatibility trigger adopts this released-Worker insert
    -- shape into one durable case per source. Do not fabricate a duplicate
    -- fixture case after the trigger has done its job.
    INSERT INTO course_makeup_assignment (id, resolution_id, target_kind, target_special_occurrence_id, target_curriculum_lesson_id, status, assigned_by_staff_account_id, assigned_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('special-assignment-a', 'special-resolution-a', 'special', 'special-occurrence', 'lesson', 'active', 'makeup-browser-staff', ${sql(now)}, 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('special-assignment-b', 'special-resolution-b', 'special', 'special-occurrence', 'lesson', 'active', 'makeup-browser-staff', ${sql(now)}, 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('special-assignment-review', 'special-resolution-review', 'special', 'review-special-occurrence', 'lesson', 'active', 'makeup-browser-staff', ${sql(now)}, 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('special-assignment-reschedule', 'special-resolution-reschedule', 'special', 'reschedule-special-occurrence', 'lesson', 'active', 'makeup-browser-staff', ${sql(now)}, 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('special-assignment-add', 'special-resolution-add', 'special', 'add-special-occurrence', 'lesson', 'active', 'makeup-browser-staff', ${sql(now)}, 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO registration_draft (id, access_token_hash, academic_year_id, guardian_full_name, guardian_relationship, primary_phone, email, normalized_email, home_address, payment_plan_code, parent_rules_version, student_rules_version, status, expires_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('hold-draft', '${"a".repeat(64)}', 'year', 'Hold Guardian', 'parent', '99000001', 'hold@example.test', 'hold@example.test', 'Тест', 'single', 'v1', 'v1', 'awaiting_initial_payment', '${addDays(today, 30)}T00:00:00.000Z', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO registration_draft_child (id, registration_draft_id, position, surname, given_name, gender, date_of_birth, current_grade, returning_status, selected_stage_code, selected_class_session_id, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('hold-child', 'hold-draft', 0, 'Hold', 'Child', 'not_specified', '2015-02-02', '5', 'new', 'stage_1', 'target-class', 'awaiting_initial_payment', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('day-hold-child', 'hold-draft', 1, 'Day Hold', 'Child', 'not_specified', '2015-02-03', '5', 'new', 'stage_1', 'day-change-class', 'awaiting_initial_payment', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO registration_capacity_hold (id, registration_draft_child_id, class_session_id, hold_type, status, deadline_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('target-hold', 'hold-child', 'target-class', 'initial_payment', 'active', '${addDays(today, 30)}T00:00:00.000Z', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
        ('day-target-hold', 'day-hold-child', 'day-change-class', 'initial_payment', 'active', '${addDays(today, 30)}T00:00:00.000Z', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
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
  page.setDefaultTimeout(10_000);
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  let destinationCandidateRequests = 0;
  page.on("request", (request) => {
    if (!request.url().endsWith("/api/staff/makeups") || request.method() !== "POST") return;
    try { if (JSON.parse(request.postData() || "{}").action === "makeup.destination-candidates") destinationCandidateRequests += 1; } catch {}
  });
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
  execute(`UPDATE class_session SET capacity = 1 WHERE id = 'day-change-class';`);
  await page.goto(`${baseUrl}/staff/makeups/`);
  await page.locator("#tool-app").waitFor({ state: "visible" });
  console.log("make-up browser fixture: checking selection and accordion responsiveness");
  let releaseAvailability;
  const availabilityHeld = new Promise((resolve) => { releaseAvailability = resolve; });
  let availabilityStarted;
  const availabilityRequested = new Promise((resolve) => { availabilityStarted = resolve; });
  let delayedAvailability = false;
  let availabilityRequestCount = 0;
  const delayFirstAvailability = async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    if (!delayedAvailability && body.action === "makeup.group-availability") {
      availabilityRequestCount += 1;
      delayedAvailability = true;
      availabilityStarted();
      await availabilityHeld;
    }
    await route.continue();
  };
  await page.route("**/api/staff/makeups", delayFirstAvailability);
  await openMakeupSectionAndFirstGroup(page, "open", "[data-case-select][value='source-enrollment|source-class|lesson']");
  await availabilityRequested;
  const interactionCheckbox = page.locator("[data-case-select][value='source-enrollment|source-class|lesson']");
  const interactionGroup = page.locator("[data-section='open'] [data-makeup-group]").filter({ has: page.locator("[data-case-select][value='source-enrollment|source-class|lesson']") }).first();
  const interactionLabel = interactionCheckbox.locator("xpath=ancestor::label");
  await interactionLabel.locator("strong").click();
  await page.waitForFunction((input) => input.checked, await interactionCheckbox.elementHandle());
  assert.equal(availabilityRequestCount, 1, "opening the lesson starts one shared availability request before local checkbox changes");
  await interactionLabel.locator("strong").click();
  await page.waitForFunction((input) => !input.checked, await interactionCheckbox.elementHandle());
  await interactionLabel.locator("strong").click();
  await page.waitForFunction((input) => input.checked, await interactionCheckbox.elementHandle());
  assert.match(await interactionGroup.locator(".staff-makeup-selection-info").innerText(), /1 сурагч сонгосон/,
    "label clicks immediately update the local selected count without a business-data write");
  const siblingGroup = page.locator("[data-section='open'] [data-makeup-group]").filter({ hasText: "Дараагийн хичээл" }).first();
  assert.equal(await page.locator("[data-section='open'] [data-makeup-group]").count() >= 2, true,
    "the fixture provides distinct named-lesson groups for accordion coverage");
  await siblingGroup.locator(":scope > summary").click();
  assert.equal(await siblingGroup.evaluate((details) => details.open), true, "another lesson group remains responsive while an earlier availability request is pending");
  assert.equal(await interactionGroup.evaluate((details) => details.open), false,
    "opening another lesson group closes the previous group without discarding its selection");
  await page.locator("[data-section='scheduled'] > summary").click();
  assert.equal(await page.locator("[data-section='scheduled']").evaluate((details) => details.open), true,
    "a different top-level section remains responsive while availability is pending");
  releaseAvailability();
  await page.waitForTimeout(200);
  assert.equal(await page.locator("[data-section='scheduled']").evaluate((details) => details.open), true,
    "a stale availability response does not reopen or overwrite the current section");
  await page.unroute("**/api/staff/makeups", delayFirstAvailability);
  await page.locator("[data-section='open'] > summary").click();
  await page.locator("[data-section='open'] [data-makeup-group]").filter({ has: page.locator("[data-case-select][value='source-enrollment|source-class|lesson']") }).first().locator(":scope > summary").click();
  assert.equal(await interactionCheckbox.isChecked(), true, "returning to the selected lesson preserves its local selection");
  await openMakeupSectionAndFirstGroup(page, "open", "[data-case-select][value='source-enrollment|source-class|lesson']");
  await page.waitForFunction(() => {
    const input = document.querySelector("[data-case-select][value='source-enrollment|source-class|lesson']");
    return input && input.getBoundingClientRect().width > 0;
  });
  const initialCheckbox = page.locator("[data-case-select][value='source-enrollment|source-class|lesson']");
  const initialLabel = initialCheckbox.locator("xpath=ancestor::label");
  const checkboxSize = await initialCheckbox.evaluate((input) => input.getBoundingClientRect().width);
  assert.ok(checkboxSize >= 22 && checkboxSize <= 26,
    "the make-up selection checkbox has a comfortably visible approximately 22–24px control");
  assert.ok(await initialLabel.evaluate((label) => label.getBoundingClientRect().height >= 44),
    "the complete learner label has a 44px minimum touch target");
  if (await initialCheckbox.isChecked()) {
    await initialLabel.locator("strong").click();
    await page.waitForFunction((input) => !input.checked, await initialCheckbox.elementHandle());
  }
  await initialLabel.locator("strong").click();
  await page.waitForFunction((input) => input.checked, await initialCheckbox.elementHandle());
  assert.equal(await interactionGroup.evaluate((details) => details.open), true,
    "selection keeps the current expanded lesson group open while availability refreshes");
  await page.getByText("Тохирох цагуудын суудал дүүрсэн байна.", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await page.getByRole("button", { name: "Түр шилжих", exact: true }).count(), 0, "the normal booking action is absent when no future matching lesson has capacity");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("#makeup-groups").screenshot({ path: path.join(screenshotDir, "makeup-case-pool-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#makeup-groups").screenshot({ path: path.join(screenshotDir, "makeup-case-pool-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 900 });

  execute(`UPDATE class_session SET capacity = 10 WHERE id = 'day-change-class';
    UPDATE registration_capacity_hold SET status = 'released', released_at = ${sql(now)} WHERE id IN ('target-hold', 'day-target-hold');`);
  await page.reload();
  await page.locator("#tool-app").waitFor({ state: "visible" });
  await openMakeupSectionAndFirstGroup(page, "open", "[data-case-select][value='source-enrollment|source-class|lesson']");
  await page.waitForFunction(() => document.querySelector("[data-case-select][value='source-enrollment|source-class|lesson']")?.getBoundingClientRect().width > 0);
  console.log("make-up browser fixture: reopening selection is ready");
  const refreshedGroup = page.locator("[data-section='open'] [data-makeup-group]").filter({ has: page.locator("[data-case-select][value='source-enrollment|source-class|lesson']") }).first();
  const refreshedCheckbox = page.locator("[data-case-select][value='source-enrollment|source-class|lesson']");
  await refreshedCheckbox.focus();
  await page.keyboard.press("Space");
  await page.waitForFunction((input) => input.checked, await refreshedCheckbox.elementHandle());
  console.log("make-up browser fixture: keyboard selection is ready");
  await page.getByRole("button", { name: "Түр шилжих", exact: true }).waitFor({ state: "visible" });
  const normalButton = refreshedGroup.getByRole("button", { name: "Түр шилжих", exact: true });
  await normalButton.click();
  await page.getByText("Сул суудал: 1").waitFor({ state: "visible" });
  const inlineReview = refreshedGroup.locator("#makeup-detail");
  assert.equal(await inlineReview.count(), 1, "the normal booking review stays inside its originating lesson group");
  await page.waitForFunction((panel) => document.activeElement === panel, await inlineReview.elementHandle());
  assert.equal(await inlineReview.evaluate((panel) => document.activeElement === panel), true,
    "opening a review moves focus into the inline panel");
  await page.setViewportSize({ width: 1280, height: 900 });
  await inlineReview.screenshot({ path: path.join(screenshotDir, "makeup-capacity-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await inlineReview.screenshot({ path: path.join(screenshotDir, "makeup-capacity-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
  await inlineReview.getByRole("button", { name: "Болих", exact: true }).click();
  await inlineReview.waitFor({ state: "hidden" });
  await page.waitForFunction((button) => document.activeElement === button, await normalButton.elementHandle());
  assert.equal(await normalButton.evaluate((button) => document.activeElement === button), true,
    "closing an inline review returns focus to its initiating action");
  await refreshedGroup.getByRole("button", { name: "Шинэ цаг", exact: true }).click();
  const specialDraft = refreshedGroup.locator("#group-special-form");
  await specialDraft.waitFor({ state: "visible" });
  await specialDraft.locator("[name='localDate']").fill(addDays(today, 4));
  await specialDraft.locator("[name='startTime']").fill("00:00");
  await specialDraft.locator("[name='note']").fill("Сонголт хадгалах туршилт");
  await refreshedCheckbox.uncheck();
  assert.equal(await refreshedCheckbox.isChecked(), false, "deselecting the learner updates the open new-session draft");
  await specialDraft.getByText("Товлох сурагч сонгоно уу.", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await specialDraft.locator("[name='startTime']").inputValue(), "00:00", "changing selection keeps the open new-session draft fields");
  assert.equal(await specialDraft.locator("[name='note']").inputValue(), "Сонголт хадгалах туршилт", "selection does not remount away the entered note");
  await page.setViewportSize({ width: 1280, height: 900 });
  await specialDraft.screenshot({ path: path.join(screenshotDir, "makeup-new-session-selection-empty-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await specialDraft.screenshot({ path: path.join(screenshotDir, "makeup-new-session-selection-empty-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
  await refreshedCheckbox.check();
  await specialDraft.getByRole("button", { name: "Урьдчилан харах", exact: true }).waitFor({ state: "visible" });
  await specialDraft.getByRole("button", { name: "Урьдчилан харах", exact: true }).click();
  await refreshedGroup.getByText(/00:00–01:20/, { exact: false }).waitFor({ state: "visible" });
  assert.equal(await refreshedGroup.getByRole("button", { name: "Шинэ цаг товлох", exact: true }).isEnabled(), true,
    "a midnight start produces a complete derived range and an enabled reviewed confirmation");
  await page.setViewportSize({ width: 390, height: 844 });
  await refreshedGroup.locator("#makeup-detail").screenshot({ path: path.join(screenshotDir, "makeup-new-session-midnight-review-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
  await refreshedGroup.getByRole("button", { name: "Засах", exact: true }).click();
  await specialDraft.getByRole("button", { name: "Болих", exact: true }).click();
  await specialDraft.waitFor({ state: "hidden" });

  console.log("make-up browser fixture: adding a learner to the rescheduled regular attendance occurrence");
  await page.goto(`${baseUrl}/staff/attendance/?date=${targetDate}&occurrence=target-slot&makeupAdd=1`);
  await page.locator("#tool-app").waitFor({ state: "visible" });
  const normalAttendancePicker = page.locator("#attendance-detail .staff-makeup-detail");
  await normalAttendancePicker.getByText("Browser Маш Урт Нөхөх Оролцогчийн Нэр", { exact: true }).waitFor({ state: "visible" });
  const normalAttendanceCheckbox = normalAttendancePicker.locator("[data-attendance-makeup-source][value='source-enrollment|source-class|lesson']");
  await normalAttendanceCheckbox.locator("xpath=ancestor::label").locator("strong").click();
  await normalAttendancePicker.getByRole("button", { name: "Урьдчилан харах", exact: true }).click();
  await page.locator("[data-confirm-makeup-picker]").waitFor({ state: "visible" });
  await page.getByText("Browser Маш Урт Нөхөх Оролцогчийн Нэр", { exact: true }).waitFor({ state: "visible" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("#attendance-detail").screenshot({ path: path.join(screenshotDir, "attendance-add-learner-regular-review-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#attendance-detail").screenshot({ path: path.join(screenshotDir, "attendance-add-learner-regular-review-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
  await normalAttendancePicker.getByRole("button", { name: "Баталгаажуулах", exact: true }).click();
  await page.getByText("Нөхөх хичээлийн товыг хадгаллаа.", { exact: true }).waitFor({ state: "visible" });
  await page.getByText("Browser Маш Урт Нөхөх Оролцогчийн Нэр", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await page.locator("[data-attendance-row]").count(), 1,
    "the rescheduled regular occurrence immediately renders its newly booked make-up learner once");
  await page.reload();
  await page.locator("#tool-app").waitFor({ state: "visible" });
  assert.equal(await page.getByText("Browser Маш Урт Нөхөх Оролцогчийн Нэр", { exact: true }).count(), 1,
    "reloading the exact rescheduled occurrence retains the make-up roster row once");
  const assignments = await page.evaluate(async () => (await fetch("/api/staff/makeups", { credentials: "same-origin" })).json());
  const normalAssignment = assignments.scheduled.filter((entry) => entry.targetKind === "normal_class");
  assert.equal(normalAssignment.length, 1, "attendance-page confirmation creates one active normal-class assignment");
  assert.equal(normalAssignment[0].targetClassSessionId, "target-class", "the booking retains its exact target class identity");

  console.log("make-up browser fixture: selecting an existing special-session destination from attendance");
  execute(`UPDATE course_makeup_special_occurrence
    SET local_date = '${addDays(today, 2)}', updated_at = ${sql(now)}
    WHERE id = 'add-special-occurrence';`);
  const candidateRequestsBeforeAgenda = destinationCandidateRequests;
  await page.goto(`${baseUrl}/staff/`);
  await page.locator("#staff-home").waitFor({ state: "visible" });
  assert.equal(await page.locator("#staff-agenda [data-agenda-add-learner]").count(), 0,
    "agenda cards navigate to attendance without preloading a separate learner picker");
  assert.equal(destinationCandidateRequests, candidateRequestsBeforeAgenda, "calendar rendering does not request destination candidates");
  await page.goto(`${baseUrl}/staff/attendance/?date=${addDays(today, 2)}&occurrence=add-special-occurrence&makeupAdd=1`);
  await page.locator("#tool-app").waitFor({ state: "visible" });
  const attendancePicker = page.locator("#attendance-detail .staff-makeup-detail");
  await attendancePicker.getByText("Fixture Child 24", { exact: true }).waitFor({ state: "visible" });
  assert.equal(destinationCandidateRequests, candidateRequestsBeforeAgenda + 1, "the attendance add action requests candidates exactly once for its selected occurrence");
  const attendancePickerCheckbox = attendancePicker.locator("[data-attendance-makeup-source][value='archive-enrollment|source-class|lesson']");
  await attendancePickerCheckbox.locator("xpath=ancestor::label").locator("strong").click();
  assert.equal(await attendancePickerCheckbox.isChecked(), true, "the attendance picker shares immediate local checkbox selection");
  await page.setViewportSize({ width: 1280, height: 900 });
  await attendancePicker.screenshot({ path: path.join(screenshotDir, "attendance-add-learner-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await attendancePicker.screenshot({ path: path.join(screenshotDir, "attendance-add-learner-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
  await attendancePicker.getByRole("button", { name: "Урьдчилан харах", exact: true }).click();
  await attendancePicker.getByText("Fixture Child 24", { exact: true }).waitFor({ state: "visible" });
  let destinationBookSeen = false;
  let refreshFailedAfterBook = false;
  const failOneRosterRefresh = async (route) => {
    const request = route.request();
    if (request.url().endsWith("/api/staff/makeups") && request.method() === "POST") {
      try { if (JSON.parse(request.postData() || "{}").action === "makeup.group-destination-book") destinationBookSeen = true; } catch {}
      await route.continue();
      return;
    }
    if (destinationBookSeen && !refreshFailedAfterBook && request.method() === "GET" && request.url().includes("/api/staff/attendance?")) {
      refreshFailedAfterBook = true;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "түр алдаа" } }) });
      return;
    }
    await route.continue();
  };
  await page.route("**/api/staff/**", failOneRosterRefresh);
  await attendancePicker.getByRole("button", { name: "Баталгаажуулах", exact: true }).click();
  await page.getByText("Тов хадгалагдсан боловч ирцийн жагсаалтыг шинэчилж чадсангүй.", { exact: true }).waitFor({ state: "visible" });
  assert.equal(refreshFailedAfterBook, true, "a post-book roster refresh failure is surfaced separately from the durable save");
  await page.unroute("**/api/staff/**", failOneRosterRefresh);
  await page.getByRole("button", { name: "Дахин ачаалах", exact: true }).click();
  await page.getByText("Нөхөх хичээлийн товыг хадгаллаа.", { exact: true }).waitFor({ state: "visible" });
  await page.getByText("Fixture Child 24", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await page.getByText("Fixture Child 24", { exact: true }).count(), 1,
    "special attendance confirmation renders the named learner exactly once without creating an attendance mark");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("#attendance-detail").screenshot({ path: path.join(screenshotDir, "attendance-add-learner-special-saved-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#attendance-detail").screenshot({ path: path.join(screenshotDir, "attendance-add-learner-special-saved-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await page.locator("#tool-app").waitFor({ state: "visible" });
  assert.equal(await page.getByText("Fixture Child 24", { exact: true }).count(), 1,
    "special attendance reload preserves the confirmed make-up learner exactly once");
  await page.goto(`${baseUrl}/staff/makeups/`);
  await page.locator("#tool-app").waitFor({ state: "visible" });
  const scheduledShortcutSelector = "a[href*='occurrence=add-special-occurrence'][href*='makeupAdd=1']";
  const scheduledSection = page.locator("[data-section='scheduled']");
  if (!await scheduledSection.evaluate((details) => details.open)) await scheduledSection.locator(":scope > summary").click();
  const scheduledGroup = scheduledSection.locator("[data-makeup-group]").filter({ has: page.locator(scheduledShortcutSelector) }).first();
  if (!await scheduledGroup.evaluate((details) => details.open)) await scheduledGroup.locator(":scope > summary").click();
  const scheduledShortcut = scheduledGroup.locator(scheduledShortcutSelector).first();
  await scheduledShortcut.click();
  await page.waitForURL(/\/staff\/attendance\/\?date=.*occurrence=add-special-occurrence.*makeupAdd=1/);
  await page.locator("#attendance-detail .staff-makeup-detail").getByText("Нэмэх боломжтой сурагч алга.", { exact: true }).waitFor({ state: "visible" });
  const afterSpecialAdd = await page.evaluate(async () => (await fetch("/api/staff/makeups", { credentials: "same-origin" })).json());
  assert.equal(afterSpecialAdd.scheduled.filter((entry) => entry.targetSpecialOccurrenceId === "add-special-occurrence").length, 2,
    "the attendance picker adds exactly one eligible learner to the existing special session");

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
  await page.goto(`${baseUrl}/staff/attendance/?date=${targetDate}&occurrence=target-slot`);
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
  const destination = await page.evaluate(async () => (await fetch(`/api/staff/attendance?date=${encodeURIComponent(location.search.match(/date=([^&]+)/)?.[1] || "")}&occurrence=target-slot`, { credentials: "same-origin" })).json());
  assert.equal(destination.selected.rosterCount, 2, "destination attendance summary counts the displayed ordinary and make-up attendees");
  assert.equal(destination.selected.roster.filter((entry) => entry.attendanceKind === "makeup").length, 1, "destination attendee remains visibly distinct from an ordinary enrollment");
  assert.equal(destination.selected.roster.filter((entry) => entry.attendanceKind === "ordinary").length, 1, "destination roster retains the ordinary attendee");
  assert.equal(destination.selected.roster.find((entry) => entry.attendanceKind === "makeup").makeupSource.lessonTitle, "Ижил хичээл", "destination attendee retains the source missed-lesson linkage");
  console.log("make-up browser fixture: inspecting case history, attendance review, and special reschedule preview");
  await page.goto(`${baseUrl}/staff/makeups/`);
  await page.locator("#tool-app").waitFor({ state: "visible" });
  const reviewGroup = await openMakeupSectionAndFirstGroup(page, "review");
  await reviewGroup.getByText(/Ирц Шалгах Энхрий/).waitFor({ state: "visible" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("#makeup-groups").screenshot({ path: path.join(screenshotDir, "makeup-attendance-review-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#makeup-groups").screenshot({ path: path.join(screenshotDir, "makeup-attendance-review-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMakeupSectionAndFirstGroup(page, "scheduled");
  await page.locator("[data-open-special-reschedule='reschedule-special-occurrence']").click();
  await page.locator("#special-reschedule-form").waitFor({ state: "visible" });
  await page.locator("#special-reschedule-form [name='localDate']").fill(addDays(rescheduleDate, 1));
  await page.locator("#special-reschedule-form [name='startTime']").fill("16:00");
  await page.locator("#special-reschedule-form [data-derived-end]").getByText("17:20", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Урьдчилан харах", exact: true }).click();
  await page.getByRole("heading", { name: "Өдөр, цаг өөрчлөх", exact: true }).waitFor({ state: "visible" });
  await page.getByText(/1 сурагчийн тов/).waitFor({ state: "visible" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("#makeup-detail").screenshot({ path: path.join(screenshotDir, "special-reschedule-preview-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#makeup-detail").screenshot({ path: path.join(screenshotDir, "special-reschedule-preview-mobile.png") });
  await page.getByRole("button", { name: "Болих", exact: true }).click();
  await page.locator("#makeup-detail").waitFor({ state: "hidden" });
  console.log("make-up browser fixture: reconciling agenda counts");
  await page.goto(`${baseUrl}/staff/`);
  await page.locator("#staff-home").waitFor({ state: "visible" });
  await page.locator(`[data-agenda-day-toggle='${targetDate}']`).click();
  await page.locator("#staff-agenda [data-agenda-occurrence='target-slot']").waitFor({ state: "visible" });
  assert.match(await page.locator("#staff-agenda [data-agenda-occurrence='target-slot']").innerText(), /Үндсэн 1 · Нөхөх 1/, "the agenda card keeps ordinary and make-up counts distinct");
  await page.locator("#staff-agenda [data-agenda-occurrence='target-slot']").click();
  await page.waitForURL(/\/staff\/attendance\/\?date=.*occurrence=target-slot/);
  await page.getByText("Browser Маш Урт Нөхөх Оролцогчийн Нэр", { exact: true }).waitFor({ state: "visible" });
  assert.match(await page.locator(".staff-attendance-makeup-source").innerText(), /Тасалсан хичээл · \d{2}\/\d{2}/, "the selected attendance roster keeps a compact missed-lesson link");
  assert.ok(await page.locator("#attendance-list [role='tab']").count() >= 3, "the attendance selector keeps time-only tabs for each dated regular or special occurrence");
  const selectedTabBounds = await page.locator("#attendance-list [role='tab'][aria-selected='true']").evaluate((selected) => {
    const strip = selected.parentElement.getBoundingClientRect();
    const tab = selected.getBoundingClientRect();
    return { stripLeft: strip.left, stripRight: strip.right, tabLeft: tab.left, tabRight: tab.right };
  });
  assert.ok(selectedTabBounds.tabLeft >= selectedTabBounds.stripLeft - 1 && selectedTabBounds.tabRight <= selectedTabBounds.stripRight + 1,
    "the selected time tab is visible inside its horizontal strip without treating subpixel rounding as clipping");
  await page.goBack();
  await page.locator("#staff-home").waitFor({ state: "visible" });
  console.log("make-up browser fixture: recording special-session attendance from the agenda");
  await page.locator(`[data-agenda-day-toggle='${specialAttendanceDate}']`).click();
  const specialAgendaLink = page.locator("#staff-agenda [data-agenda-occurrence='special-occurrence']");
  await specialAgendaLink.waitFor({ state: "visible" });
  assert.equal(await specialAgendaLink.count(), 1, "the home agenda renders one special-session occurrence");
  assert.match(await specialAgendaLink.innerText(), /Нөхөх 2/, "special-session agenda counts only booked make-up attendees");
  await specialAgendaLink.click();
  await page.waitForURL(/\/staff\/attendance\/\?date=.*occurrence=special-occurrence/);
  await page.getByText("Тусгай Нөхөх Анударь", { exact: true }).waitFor({ state: "visible" });
  await page.getByText("Тусгай Нөхөх Билгүүн", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await page.locator("[data-attendance-row]").count(), 2, "a special session does not add ordinary class enrollments to its attendance roster");
  assert.match(await page.locator("#attendance-summary").innerText(), /^0 \/ 2 тэмдэглэсэн/, "an untouched special roster does not claim completed attendance");
  assert.equal(await page.getByText("Нөхөх", { exact: true }).count(), 2, "each special-session attendee is visibly labelled as a make-up attendee");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("#attendance-detail").screenshot({ path: path.join(screenshotDir, "special-makeup-attendance-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#attendance-detail").screenshot({ path: path.join(screenshotDir, "special-makeup-attendance-mobile.png") });
  await page.locator("[data-attendance-row='special-enrollment-a'] [data-attendance-control='present']").check();
  await page.getByText("Ирцийг хадгаллаа.", { exact: true }).waitFor({ state: "visible" });
  await page.locator("[data-attendance-row='special-enrollment-a'] [data-attendance-control='late']").check();
  await page.getByText("Ирцийг хадгаллаа.", { exact: true }).waitFor({ state: "visible" });
  await page.locator("[data-attendance-row='special-enrollment-b'] [data-attendance-control='present']").check();
  await page.getByText("Ирцийг хадгаллаа.", { exact: true }).waitFor({ state: "visible" });
  await page.reload();
  await page.locator("#tool-app").waitFor({ state: "visible" });
  assert.equal(await page.locator("[data-attendance-row='special-enrollment-a'] [data-attendance-control='late']").isChecked(), true,
    "a corrected special-session mark survives reload");
  assert.equal(await page.locator("[data-attendance-row='special-enrollment-b'] [data-attendance-control='present']").isChecked(), true,
    "each special-session attendee persists independently");
  assert.match(await page.locator("#attendance-summary").innerText(), /^2 \/ 2 ирц бүрдсэн/, "the roster reports completion only after every special attendee has a saved status");
  const specialAttendance = await page.evaluate(async () => (await fetch(`/api/staff/attendance?date=${encodeURIComponent(location.search.match(/date=([^&]+)/)?.[1] || "")}&occurrence=special-occurrence`, { credentials: "same-origin" })).json());
  assert.equal(specialAttendance.selected.occurrenceKind, "special", "the attendance endpoint retains a stable special occurrence identity");
  assert.equal(specialAttendance.selected.rosterCount, 2, "saved marks do not remove special-session attendees from their expected roster");
  assert.equal(specialAttendance.selected.roster.filter((entry) => entry.attendanceKind === "ordinary").length, 0, "special attendance has no inferred ordinary roster rows");
  assert.ok(specialAttendance.selected.roster.every((entry) => entry.makeupSource?.slotId === "source-slot"), "each special attendee retains the original missed-lesson link");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#attendance-detail").screenshot({ path: path.join(screenshotDir, "special-makeup-attendance-saved-mobile.png") });
  await page.goBack();
  await page.locator("#staff-home").waitFor({ state: "visible" });
  await page.setViewportSize({ width: 390, height: 844 });
  console.log("make-up browser fixture: switching and collapsing the mobile day accordion");
  assert.equal(await page.locator(`[data-agenda-day='${specialAttendanceDate}']`).getAttribute("data-open"), "true", "returning from attendance restores the previously expanded day");
  await page.locator(`[data-agenda-day-toggle='${alternateDate}']`).click();
  assert.equal(await page.locator(`[data-agenda-day='${specialAttendanceDate}']`).getAttribute("data-open"), "false", "opening another day closes the prior day");
  assert.equal(await page.locator(`[data-agenda-day='${alternateDate}']`).getAttribute("data-open"), "true", "the chosen day opens");
  assert.equal(await page.locator(`[data-agenda-day='${specialAttendanceDate}'] [data-agenda-occurrence='special-occurrence']`).isVisible(), false, "collapsed mobile days do not expose their lesson cards");
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
  const explicitEmptyDate = addDays(today, 60);
  await page.locator("#staff-agenda [data-agenda-date]").fill(explicitEmptyDate);
  await page.locator("#staff-agenda [data-agenda-date]").dispatchEvent("change");
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
  assert.equal(await page.locator("[data-day-slot]").count(), 2, "the fixture exposes two distinct time-only occurrences for local selection coverage");
  let selectionReads = 0;
  const countSelectionReads = async (route) => {
    if (route.request().method() === "GET") selectionReads += 1;
    await route.continue();
  };
  await page.route("**/api/staff/day-changes*", countSelectionReads);
  await page.getByRole("button", { name: "15:00–16:20", exact: true }).click();
  await page.locator(".staff-day-selected").getByText("Хоёр дахь өөрчлөлтийн анги").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "12:00–13:20", exact: true }).click();
  await page.locator(".staff-day-selected").getByText("Өөрчлөлтийн анги").waitFor({ state: "visible" });
  assert.equal(selectionReads, 0, "switching loaded time-only occurrences is immediate local state, not a stale network refresh");
  await page.unroute("**/api/staff/day-changes*", countSelectionReads);

  let releaseDayRead;
  let delayedDayRead = false;
  const dayReadStarted = new Promise((resolve) => { releaseDayRead = resolve; });
  let allowDayRead;
  const dayReadGate = new Promise((resolve) => { allowDayRead = resolve; });
  const delayDayRead = async (route) => {
    if (route.request().method() === "GET") {
      if (!delayedDayRead) {
        delayedDayRead = true;
        releaseDayRead();
      }
      await dayReadGate;
    }
    await route.continue();
  };
  await page.route("**/api/staff/day-changes*", delayDayRead);
  await page.locator("#day-date").fill(addDays(dayChangeDate, 7));
  await page.locator("#day-date").dispatchEvent("change");
  await dayReadStarted;
  await page.getByText("Ачаалж байна…", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await page.locator(".staff-day-selected").count(), 0, "a loading date never leaves the prior class's actionable workspace beneath it");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".staff-day-loading").screenshot({ path: path.join(screenshotDir, "day-change-loading-mobile.png") });
  allowDayRead();
  await page.locator(".staff-day-selected").getByText("Өөр өдрийн хичээл").waitFor({ state: "visible" });
  await page.unroute("**/api/staff/day-changes*", delayDayRead);
  await page.goto(`${baseUrl}/staff/day-changes/?date=${dayChangeDate}&occurrence=day-change-slot`);
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
  await page.locator("[data-day-change-form]").getByRole("button", { name: "Болих", exact: true }).click();
  assert.equal(await page.locator("#day-confirmation").isHidden(), true, "abandoning an in-flight preview immediately restores the selected lesson without a mutation");
  const stalePreviewResponse = page.waitForResponse((response) => response.request().method() === "POST"
    && response.url().includes("/api/staff/day-changes")
    && response.request().postData()?.includes("day-change.preview"));
  allowPreview();
  await stalePreviewResponse;
  await page.unroute("**/api/staff/day-changes", delayDayPreview);
  assert.equal(await page.locator("#day-confirmation").isHidden(), true, "an abandoned delayed preview cannot resurrect its review state");
  await page.getByRole("button", { name: "Цуцлаад орлуулах цаг товлох", exact: true }).click();
  await page.locator('[data-day-change-form] [name="replacementDate"]').fill(dayChangeReplacementDate);
  await page.locator('[data-day-change-form] [name="replacementStartTime"]').fill("19:00");
  await page.getByRole("button", { name: "Урьдчилан харах", exact: true }).click();
  await page.locator("#day-confirmation").waitFor({ state: "visible" });
  assert.equal(await page.locator("[data-day-change-form]").count(), 0,
    "the reviewed operation replaces its editable form instead of leaving a competing preview button");
  await page.locator(".staff-day-preview-list").getByText("Дараагийн хичээл").waitFor({ state: "visible" });
  assert.equal(await page.locator("#day-operation").isHidden(), true, "whole-day controls collapse while an individual lesson change is under review");
  await page.getByRole("button", { name: "Засах", exact: true }).click();
  assert.equal(await page.locator("[name='replacementDate']").inputValue(), dayChangeReplacementDate,
    "editing restores the reviewed replacement date");
  await page.waitForFunction(() => document.activeElement?.matches('[data-day-change-form] [name="replacementDate"]'));
  assert.equal(await page.locator('[data-day-change-form] [name="replacementDate"]').evaluate((node) => document.activeElement === node), true,
    "editing returns focus to the restored replacement form");
  await page.locator('[data-day-change-form] [name="replacementStartTime"]').fill("18:30");
  assert.equal(await page.locator("#day-confirmation").isHidden(), true, "editing a reviewed replacement invalidates its stale preview");
  await page.locator('[data-day-change-form] [name="replacementStartTime"]').fill("19:00");
  await page.getByRole("button", { name: "Урьдчилан харах", exact: true }).click();
  await page.locator("#day-confirmation").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Болих", exact: true }).click();
  assert.equal(await page.locator("#day-confirmation").isHidden(), true, "abandoning a reviewed preview makes no schedule mutation");
  await page.getByRole("button", { name: "Цуцлаад орлуулах цаг товлох", exact: true }).click();
  await page.locator('[data-day-change-form] [name="replacementDate"]').fill(dayChangeReplacementDate);
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
  console.log("make-up browser fixture: confirming an automatic regular schedule completion");
  const automaticCancellationDate = addDays(dayChangeDate, 7);
  await page.goto(`${baseUrl}/staff/day-changes/?date=${automaticCancellationDate}`);
  await page.locator("#tool-app").waitFor({ state: "visible" });
  await page.locator(".staff-day-selected").getByText("Өөр өдрийн хичээл").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Энэ хичээлийг цуцлах", exact: true }).click();
  await page.getByRole("button", { name: "Урьдчилан харах", exact: true }).click();
  await page.locator("#day-confirmation").waitFor({ state: "visible" });
  await page.getByText("Шинэ ээлжит цаг:", { exact: false }).waitFor({ state: "visible" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: path.join(screenshotDir, "day-change-automatic-preview-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#day-confirmation").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(screenshotDir, "day-change-automatic-preview-mobile.png") });
  await page.getByRole("button", { name: "Цуцлахыг баталгаажуулах", exact: true }).click();
  await page.getByText("Хичээлийн бүрэн дарааллыг хадгалах эцсийн ээлжит цаг нэмэгдлээ.", { exact: true }).waitFor({ state: "visible" });
  await page.getByRole("link", { name: "Нэмэгдсэн хичээл рүү очих", exact: true }).waitFor({ state: "visible" });
  assert.equal(await page.getByRole("button", { name: "Орлуулах ээлжит цаг оруулах", exact: true }).count(), 0,
    "an automatically completed cancellation does not offer another manual replacement");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: path.join(screenshotDir, "day-change-automatic-result-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(screenshotDir, "day-change-automatic-result-mobile.png") });
  console.log("make-up browser fixture: retiring and restoring one archived lesson group");
  await page.goto(`${baseUrl}/staff/makeups/`);
  await page.locator("#tool-app").waitFor({ state: "visible" });
  const archiveSourceGroup = await openMakeupSectionAndFirstGroup(page, "open");
  await archiveSourceGroup.getByRole("button", { name: "Архивлах", exact: true }).click();
  await page.locator("#makeup-detail").getByRole("button", { name: "Архивлах", exact: true }).click();
  await page.getByText("Хичээлийг архивт орууллаа.", { exact: true }).waitFor({ state: "visible" });
  const archiveGroup = await openMakeupSectionAndFirstGroup(page, "archive");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("#makeup-groups").screenshot({ path: path.join(screenshotDir, "makeup-archive-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#makeup-groups").screenshot({ path: path.join(screenshotDir, "makeup-archive-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
  await archiveGroup.getByRole("button", { name: "Архиваас гаргах", exact: true }).click();
  await page.locator("#makeup-detail").getByRole("button", { name: "Архиваас гаргах", exact: true }).click();
  await page.getByText("Хичээлийг дахин шийдэхээр нээлээ.", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await page.locator("[data-section='open'] [data-makeup-group]").first().evaluate((node) => document.activeElement === node.querySelector("summary")), true,
    "restoring an archived lesson focuses its reopened actionable group");
  assert.deepEqual(browserErrors, [], "the rendered make-up workflow completes without uncaught browser errors");
  console.log(`ok browser make-up capacity target availability and booking (${screenshotDir})`);
} finally {
  if (context) await context.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  if (worker && !worker.killed) worker.kill("SIGTERM");
  rmSync(persistDir, { recursive: true, force: true });
}
