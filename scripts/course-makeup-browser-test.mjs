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
const screenshotDir = path.join(tmpdir(), "naranerdem-makeup-capacity-screens");
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

try {
  runWrangler(["d1", "migrations", "apply", "DB", "--env", "staging", "--local", "--persist-to", persistDir], "local migrations");
  const now = new Date().toISOString();
  const today = localToday();
  const sourceDate = addDays(today, -7);
  const targetDate = addDays(today, 7);
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
      VALUES ('lesson', 'program', 1, 'Ижил хичээл', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    UPDATE curriculum_program SET status = 'published', published_at = ${sql(now)} WHERE id = 'program';
    UPDATE curriculum_program_family SET current_published_program_id = 'program' WHERE id = 'family';
    INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, starts_on, curriculum_program_id, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('offering', 'annual_course', 'Browser нөхөх сургалт', 'year', 'stage_1', '${sourceDate}', 'program', 1, 'paid', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO class_session (id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, activity_offering_id, is_test, test_run_id, created_at, updated_at) VALUES
      ('source-class', 'year', 'stage_1', 'Эх анги', 'Бямба', '10:00', '11:20', 10, 'available', 'offering', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('target-class', 'year', 'stage_1', 'Зорилтот анги', 'Ням', '14:00', '15:20', 1, 'available', 'offering', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO class_meeting_rule (class_session_id, recurrence_kind, first_date, weekly_weekday, start_time, end_time, created_at, updated_at) VALUES
      ('source-class', 'weekly', '${sourceDate}', 'Бямба', '10:00', '11:20', ${sql(now)}, ${sql(now)}),
      ('target-class', 'weekly', '${targetDate}', 'Ням', '14:00', '15:20', ${sql(now)}, ${sql(now)});
    INSERT INTO class_calendar (id, class_session_id, timezone, status, is_test, test_run_id, created_at, updated_at) VALUES
      ('source-calendar', 'source-class', 'Asia/Ulaanbaatar', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('target-calendar', 'target-class', 'Asia/Ulaanbaatar', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO class_calendar_revision (id, class_calendar_id, curriculum_program_id, revision_number, status, first_candidate_date, locked_through_sequence, is_test, test_run_id, created_at, updated_at) VALUES
      ('source-revision', 'source-calendar', 'program', 1, 'draft', '${sourceDate}', 0, 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('target-revision', 'target-calendar', 'program', 1, 'draft', '${targetDate}', 0, 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO class_calendar_slot (id, class_calendar_revision_id, local_date, start_time, end_time, slot_source, status, curriculum_lesson_id, is_test, test_run_id, created_at, updated_at) VALUES
      ('source-slot', 'source-revision', '${sourceDate}', '10:00', '11:20', 'generated', 'scheduled', 'lesson', 1, 'makeup-browser', ${sql(now)}, ${sql(now)}),
      ('target-slot', 'target-revision', '${targetDate}', '14:00', '15:20', 'generated', 'scheduled', 'lesson', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    UPDATE class_calendar_revision SET status = 'published', published_at = ${sql(now)} WHERE id IN ('source-revision', 'target-revision');
    INSERT INTO guardian_account (id, full_name, primary_phone, primary_phone_normalized, email, email_normalized, home_address, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('guardian', 'Browser Асран', '99000000', '99000000', 'guardian@example.test', 'guardian@example.test', 'Тест', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
    INSERT INTO student (id, surname, given_name, gender, date_of_birth, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('student', 'Browser', 'Нөхөх', 'not_specified', '2015-01-01', 'active', 1, 'makeup-browser', ${sql(now)}, ${sql(now)});
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

  worker = spawn(process.execPath, [wranglerCli, "dev", "--env", "staging", "--local", "--persist-to", persistDir,
    "--ip", "127.0.0.1", "--port", String(port), "--var", `APP_ORIGIN:${baseUrl}`], { stdio: ["ignore", "pipe", "pipe"] });
  worker.stdout.on("data", (chunk) => { workerOutput += String(chunk); });
  worker.stderr.on("data", (chunk) => { workerOutput += String(chunk); });
  await waitForWorker();

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  await context.addCookies([{ name: "naran_staff_session", value: rawSessionToken, url: baseUrl, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
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
  console.log(`ok browser make-up capacity target availability and booking (${screenshotDir})`);
} finally {
  if (context) await context.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  if (worker && !worker.killed) worker.kill("SIGTERM");
  rmSync(persistDir, { recursive: true, force: true });
}
