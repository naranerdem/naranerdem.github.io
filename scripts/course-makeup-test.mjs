import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const tempDir = mkdtempSync(path.join(tmpdir(), "naranerdem-course-makeup-"));
const databasePath = path.join(tempDir, "makeup.sqlite3");
const makeupBundle = path.join(tempDir, "course-makeups.mjs");
const attendanceBundle = path.join(tempDir, "course-attendance.mjs");
const esbuild = path.resolve("node_modules/esbuild/bin/esbuild");

function quote(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function bindSql(sql, values) {
  let index = 0;
  const bound = sql.replaceAll("?", () => quote(values[index++]));
  assert.equal(index, values.length);
  return bound;
}

function sqlite(sql, json = false) {
  const result = spawnSync("sqlite3", json ? ["-json", databasePath] : [databasePath], {
    input: `.timeout 5000\nPRAGMA foreign_keys=ON;\n${sql}`,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`sqlite3 failed\n${result.stderr}\n${sql}`);
  return result.stdout.trim();
}

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.database.query(this.sql, this.values)[0] ?? null; }
  async all() { return { success: true, results: this.database.query(this.sql, this.values) }; }
  async run() {
    const rows = this.database.query(`${this.sql}; SELECT changes() AS changes`, this.values);
    return { success: true, results: [], meta: { changes: Number(rows.at(-1)?.changes ?? 0) } };
  }
}

class SqliteD1 {
  prepare(sql) { return new Statement(this, sql); }
  query(sql, values = []) { const output = sqlite(`${bindSql(sql, values)};`, true); return output ? JSON.parse(output) : []; }
  async batch(statements) {
    const changes = statements.map((statement, index) => `${bindSql(statement.sql, statement.values)};
INSERT INTO _batch_changes VALUES (${index}, changes());`).join("\n");
    const output = sqlite(`CREATE TEMP TABLE _batch_changes (idx INTEGER, changes INTEGER);
BEGIN IMMEDIATE;
${changes}
COMMIT;
SELECT idx, changes FROM _batch_changes ORDER BY idx;`, true);
    return (output ? JSON.parse(output) : []).map((row) => ({ success: true, results: [], meta: { changes: Number(row.changes) } }));
  }
}

function localToday() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ulaanbaatar", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addCivilDays(value, days) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function actor(role = "teacher") {
  const capabilities = role === "accountant"
    ? ["payment.view"]
    : ["attendance.view", "attendance.manage", "makeup.view", "makeup.manage"];
  return { staffAccountId: `${role}-staff`, displayName: role, roles: [role], capabilities, sessionId: "test", sessionExpiresAt: "2030-01-01T00:00:00.000Z", sessionAbsoluteExpiresAt: "2030-01-01T00:00:00.000Z" };
}

function count(database, table, where = "1 = 1") {
  return Number(database.query(`SELECT COUNT(*) AS value FROM ${table} WHERE ${where}`)[0].value);
}

try {
  const migrations = readdirSync("migrations").filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
  sqlite(migrations.map((file) => readFileSync(path.join("migrations", file), "utf8")).join("\n"));

  for (const [source, output] of [["src/server/staff/course-makeups.ts", makeupBundle], ["src/server/staff/course-attendance.ts", attendanceBundle]]) {
    const result = spawnSync(esbuild, [source, "--bundle", "--format=esm", "--platform=node", `--outfile=${output}`], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`esbuild failed for ${source}\n${result.stderr}`);
  }
  const makeups = await import(pathToFileURL(makeupBundle).href);
  const attendance = await import(pathToFileURL(attendanceBundle).href);
  const database = new SqliteD1();
  const runtime = { APP_ENV: "staging", REGISTRATION_WRITE_ENABLED: "false", EMAIL_ENABLED: "false", AUTH_EMAIL_ENABLED: "false", STAFF_AUTH_EMAIL_ENABLED: "false", DB: database };
  const now = new Date().toISOString();
  const today = localToday();
  const sourceDate = addCivilDays(today, -7);
  const targetDate = addCivilDays(today, 7);
  const shiftedTargetDate = addCivilDays(today, 14);
  const confirmedAt = new Date(`${addCivilDays(today, -30)}T00:00:00+08:00`).toISOString();
  const beforeSourceEnd = new Date(`${sourceDate}T10:30:00+08:00`);
  const afterSourceEnd = new Date(`${sourceDate}T12:00:00+08:00`);

  sqlite(`
    INSERT INTO staff_account (id, email_normalized, display_name, status, is_test, test_run_id, created_at, updated_at) VALUES
      ('teacher-staff', 'teacher@example.invalid', 'Тест Багш', 'active', 1, 'makeup-test', '${now}', '${now}'),
      ('accountant-staff', 'accountant@example.invalid', 'Тест Нягтлан', 'active', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO staff_account_email (id, staff_account_id, email, email_normalized, is_primary, created_at, updated_at) VALUES
      ('teacher-email', 'teacher-staff', 'teacher@example.invalid', 'teacher@example.invalid', 1, '${now}', '${now}'),
      ('accountant-email', 'accountant-staff', 'accountant@example.invalid', 'accountant@example.invalid', 1, '${now}', '${now}');
    INSERT INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_current, is_test, test_run_id, created_at, updated_at)
      VALUES ('year', 'Нөхөх тест', 'closed', '${addCivilDays(today, -90)}', '${addCivilDays(today, 90)}', 1, 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO curriculum_program_family (id, kind, display_name, annual_stage_code, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('family', 'annual_course', '1-р шат', 'stage_1', 'active', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO curriculum_program (id, program_family_id, academic_year_id, stage_code, revision_number, display_name, program_kind, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('program', 'family', 'year', 'stage_1', 1, 'Нөхөх тест хөтөлбөр', 'annual_course', 'draft', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO curriculum_lesson (id, curriculum_program_id, sequence_number, title, status, is_test, test_run_id, created_at, updated_at) VALUES
      ('lesson-1', 'program', 1, 'Ижил хичээл', 'active', 1, 'makeup-test', '${now}', '${now}'),
      ('lesson-2', 'program', 2, 'Өөр хичээл', 'active', 1, 'makeup-test', '${now}', '${now}');
    UPDATE curriculum_program SET status = 'published', published_at = '${now}' WHERE id = 'program';
    UPDATE curriculum_program_family SET current_published_program_id = 'program' WHERE id = 'family';
    INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, starts_on, curriculum_program_id, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('offering', 'annual_course', 'Нөхөх тест сургалт', 'year', 'stage_1', '${sourceDate}', 'program', 1, 'paid', 'active', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO class_session (id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, activity_offering_id, is_test, test_run_id, created_at, updated_at) VALUES
      ('source-class', 'year', 'stage_1', 'Эх анги', 'Бямба', '10:00', '11:20', 10, 'available', 'offering', 1, 'makeup-test', '${now}', '${now}'),
      ('target-class', 'year', 'stage_1', 'Зорилтот анги', 'Ням', '14:00', '15:20', 2, 'available', 'offering', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO class_meeting_rule (class_session_id, recurrence_kind, first_date, weekly_weekday, start_time, end_time, created_at, updated_at) VALUES
      ('source-class', 'weekly', '${sourceDate}', 'Бямба', '10:00', '11:20', '${now}', '${now}'),
      ('target-class', 'weekly', '${targetDate}', 'Ням', '14:00', '15:20', '${now}', '${now}');
    INSERT INTO class_calendar (id, class_session_id, timezone, status, is_test, test_run_id, created_at, updated_at) VALUES
      ('source-calendar', 'source-class', 'Asia/Ulaanbaatar', 'active', 1, 'makeup-test', '${now}', '${now}'),
      ('target-calendar', 'target-class', 'Asia/Ulaanbaatar', 'active', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO class_calendar_revision (id, class_calendar_id, curriculum_program_id, revision_number, status, first_candidate_date, locked_through_sequence, is_test, test_run_id, created_at, updated_at) VALUES
      ('source-revision', 'source-calendar', 'program', 1, 'draft', '${sourceDate}', 0, 1, 'makeup-test', '${now}', '${now}'),
      ('target-revision', 'target-calendar', 'program', 1, 'draft', '${targetDate}', 0, 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO class_calendar_slot (id, class_calendar_revision_id, local_date, start_time, end_time, slot_source, status, curriculum_lesson_id, is_test, test_run_id, created_at, updated_at) VALUES
      ('source-slot', 'source-revision', '${sourceDate}', '10:00', '11:20', 'generated', 'scheduled', 'lesson-1', 1, 'makeup-test', '${now}', '${now}'),
      ('target-slot', 'target-revision', '${targetDate}', '14:00', '15:20', 'generated', 'scheduled', 'lesson-1', 1, 'makeup-test', '${now}', '${now}'),
      ('target-slot-2', 'target-revision', '${addCivilDays(targetDate, 7)}', '14:00', '15:20', 'generated', 'scheduled', 'lesson-2', 1, 'makeup-test', '${now}', '${now}');
    UPDATE class_calendar_revision SET status = 'published', published_at = '${now}' WHERE id IN ('source-revision', 'target-revision');
    INSERT INTO guardian_account (id, full_name, primary_phone, primary_phone_normalized, email, email_normalized, home_address, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('guardian', 'Тест Асран', '99000000', '99000000', 'guardian@example.invalid', 'guardian@example.invalid', 'Тест', 'active', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO student (id, surname, given_name, gender, date_of_birth, status, is_test, test_run_id, created_at, updated_at) VALUES
      ('student-1', 'Тест', 'Нэг', 'not_specified', '2015-01-01', 'active', 1, 'makeup-test', '${now}', '${now}'),
      ('student-2', 'Тест', 'Хоёр', 'not_specified', '2015-01-02', 'active', 1, 'makeup-test', '${now}', '${now}'),
      ('student-3', 'Тест', 'Гурав', 'not_specified', '2015-01-03', 'active', 1, 'makeup-test', '${now}', '${now}'),
      ('student-4', 'Тест', 'Дөрөв', 'not_specified', '2015-01-04', 'active', 1, 'makeup-test', '${now}', '${now}'),
      ('student-5', 'Тест', 'Тав', 'not_specified', '2015-01-05', 'active', 1, 'makeup-test', '${now}', '${now}'),
      ('student-target', 'Тест', 'Зорилт', 'not_specified', '2015-01-06', 'active', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO pre_registration (id, guardian_id, academic_year_id, status, is_test, test_run_id, created_at, updated_at)
      SELECT 'prereg-' || id, 'guardian', 'year', 'completed', 1, 'makeup-test', '${now}', '${now}' FROM student;
    INSERT INTO application_child (id, pre_registration_id, student_id, current_grade, returning_status, status, is_test, test_run_id, created_at, updated_at)
      SELECT 'application-' || id, 'prereg-' || id, id, 5, 'new', 'enrolled', 1, 'makeup-test', '${now}', '${now}' FROM student;
    INSERT INTO enrollment (id, application_child_id, student_id, academic_year_id, class_session_id, status, confirmed_at, is_test, test_run_id, created_at, updated_at) VALUES
      ('enrollment-1', 'application-student-1', 'student-1', 'year', 'source-class', 'confirmed', '${confirmedAt}', 1, 'makeup-test', '${now}', '${now}'),
      ('enrollment-2', 'application-student-2', 'student-2', 'year', 'source-class', 'confirmed', '${confirmedAt}', 1, 'makeup-test', '${now}', '${now}'),
      ('enrollment-3', 'application-student-3', 'student-3', 'year', 'source-class', 'confirmed', '${confirmedAt}', 1, 'makeup-test', '${now}', '${now}'),
      ('enrollment-4', 'application-student-4', 'student-4', 'year', 'source-class', 'confirmed', '${confirmedAt}', 1, 'makeup-test', '${now}', '${now}'),
      ('enrollment-5', 'application-student-5', 'student-5', 'year', 'source-class', 'confirmed', '${confirmedAt}', 1, 'makeup-test', '${now}', '${now}'),
      ('target-enrollment', 'application-student-target', 'student-target', 'year', 'target-class', 'confirmed', '${confirmedAt}', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO course_attendance (id, enrollment_id, class_session_id, curriculum_lesson_id, attendance_status, recorded_calendar_slot_id, scheduled_local_date, first_recorded_at, updated_at, recorded_by_staff_account_id, updated_by_staff_account_id, is_test, test_run_id, created_at)
      VALUES ('attendance-3', 'enrollment-3', 'source-class', 'lesson-1', 'present', 'source-slot', '${sourceDate}', '${now}', '${now}', 'teacher-staff', 'teacher-staff', 1, 'makeup-test', '${now}');
    INSERT INTO course_absence_notice (id, enrollment_id, class_session_id, curriculum_lesson_id, notice_source, status, note, recorded_calendar_slot_id, scheduled_local_date, created_by_staff_account_id, updated_by_staff_account_id, created_at, updated_at, is_test, test_run_id)
      VALUES ('notice-2', 'enrollment-2', 'source-class', 'lesson-1', 'staff_manual', 'active', NULL, 'source-slot', '${sourceDate}', 'teacher-staff', 'teacher-staff', '${now}', '${now}', 1, 'makeup-test');
  `);

  const source = (number) => ({ enrollmentId: `enrollment-${number}`, classSessionId: "source-class", curriculumLessonId: "lesson-1" });
  assert.equal((await makeups.getCourseMakeupOverview(runtime, actor(), undefined, beforeSourceEnd)).unresolved.length, 0, "no make-up case exists before source class end");
  let overview = await makeups.getCourseMakeupOverview(runtime, actor(), undefined, afterSourceEnd);
  assert.deepEqual(overview.unresolved.map((entry) => entry.enrollmentId).sort(), ["enrollment-1", "enrollment-2", "enrollment-4", "enrollment-5"], "post-class unchecked students are unresolved while present is excluded");
  assert.equal(overview.unresolved.find((entry) => entry.enrollmentId === "enrollment-2").hasAbsenceNotice, true, "prior notice is context only");
  await assert.rejects(() => makeups.getCourseMakeupOverview(runtime, actor("accountant"), undefined, afterSourceEnd), /Course make-up/, "accountants cannot view make-ups");

  await makeups.resolveCourseMakeupAsNotNeeded(runtime, actor(), source(2), afterSourceEnd);
  overview = await makeups.getCourseMakeupOverview(runtime, actor(), undefined, afterSourceEnd);
  assert.ok(!overview.unresolved.some((entry) => entry.enrollmentId === "enrollment-2"), "no-makeup decision suppresses the active queue");

  const enrollmentsBefore = count(database, "enrollment");
  const normalAssignment = await makeups.assignCourseMakeupToNormalClass(runtime, actor(), { ...source(1), targetClassSessionId: "target-class" }, afterSourceEnd);
  assert.equal(count(database, "enrollment"), enrollmentsBefore, "normal make-up does not create enrollment");
  assert.equal(database.query("SELECT attendance_status AS status FROM course_attendance WHERE enrollment_id = 'enrollment-1'")[0], undefined, "source derived absence remains unrecorded");
  assert.equal(count(database, "course_makeup_assignment", "status = 'active' AND target_class_session_id = 'target-class'"), 1);
  await assert.rejects(() => makeups.assignCourseMakeupToNormalClass(runtime, actor(), { ...source(4), targetClassSessionId: "target-class" }, afterSourceEnd), /Course make-up/, "final target seat is capacity-safe");
  await assert.rejects(() => makeups.assignCourseMakeupToNormalClass(runtime, actor(), { ...source(1), targetClassSessionId: "target-class" }, afterSourceEnd), /Course make-up/, "one source cannot receive a duplicate active assignment");

  assert.throws(() => sqlite(`
    INSERT INTO course_makeup_resolution (id, source_enrollment_id, source_class_session_id, source_curriculum_lesson_id, decision, status, decided_by_staff_account_id, decided_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('wrong-resolution', 'enrollment-4', 'source-class', 'lesson-1', 'assigned', 'active', 'teacher-staff', '${now}', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO course_makeup_assignment (id, resolution_id, target_kind, target_class_session_id, target_curriculum_lesson_id, status, assigned_by_staff_account_id, assigned_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('wrong-assignment', 'wrong-resolution', 'normal_class', 'target-class', 'lesson-2', 'active', 'teacher-staff', '${now}', 1, 'makeup-test', '${now}', '${now}');
  `), /same-lesson target/, "database rejects a wrong CurriculumLesson even when sequence context is nearby");
  sqlite(`UPDATE course_makeup_resolution SET status = 'invalidated', invalidated_at = '${now}', invalidated_by_staff_account_id = 'teacher-staff', invalidation_reason = 'assignment_cancelled', updated_at = '${now}' WHERE id = 'wrong-resolution';`);

  await attendance.recordCourseAttendance(runtime, actor(), { slotId: "source-slot", enrollmentId: "enrollment-1", status: "present" });
  assert.equal(database.query(`SELECT status FROM course_makeup_assignment WHERE id = ${quote(normalAssignment.assignmentId)}`)[0].status, "cancelled", "attendance correction invalidates active assignment");
  assert.equal(count(database, "course_makeup_resolution", "source_enrollment_id = 'enrollment-1' AND status = 'active'"), 0);
  assert.ok(!(await makeups.getCourseMakeupOverview(runtime, actor(), undefined, afterSourceEnd)).unresolved.some((entry) => entry.enrollmentId === "enrollment-1"), "corrected present source is no longer unresolved");
  await attendance.clearCourseAttendance(runtime, actor(), { slotId: "source-slot", enrollmentId: "enrollment-1" });
  assert.ok((await makeups.getCourseMakeupOverview(runtime, actor(), undefined, afterSourceEnd)).unresolved.some((entry) => entry.enrollmentId === "enrollment-1"), "correcting back to effective absence creates a fresh review without reviving old assignment");

  await attendance.recordCourseAttendance(runtime, actor(), { slotId: "source-slot", enrollmentId: "enrollment-2", status: "late" });
  assert.equal(count(database, "course_makeup_resolution", "source_enrollment_id = 'enrollment-2' AND status = 'active'"), 0, "late correction invalidates no-makeup resolution");
  await attendance.clearCourseAttendance(runtime, actor(), { slotId: "source-slot", enrollmentId: "enrollment-2" });
  assert.ok((await makeups.getCourseMakeupOverview(runtime, actor(), undefined, afterSourceEnd)).unresolved.some((entry) => entry.enrollmentId === "enrollment-2"), "later effective absence receives a new review instead of stale no-makeup intent");

  const special = await makeups.createSpecialCourseMakeupOccurrence(runtime, actor(), {
    sources: [source(4), source(5)], localDate: targetDate, startTime: "17:00", endTime: "18:00", capacity: 2, note: "Тусгай тест",
  }, afterSourceEnd);
  assert.equal(special.assignmentCount, 2, "one special occurrence accepts several same-lesson students");
  assert.equal(count(database, "course_makeup_assignment", `target_special_occurrence_id = ${quote(special.specialOccurrenceId)} AND status = 'active'`), 2);
  await assert.rejects(() => makeups.assignCourseMakeupToSpecialOccurrence(runtime, actor(), { ...source(1), specialOccurrenceId: special.specialOccurrenceId }, afterSourceEnd), /Course make-up/, "special occurrence capacity is enforced");
  await makeups.cancelSpecialCourseMakeupOccurrence(runtime, actor(), { specialOccurrenceId: special.specialOccurrenceId }, afterSourceEnd);
  assert.equal(count(database, "course_makeup_assignment", `target_special_occurrence_id = ${quote(special.specialOccurrenceId)} AND status = 'cancelled'`), 2, "special cancellation retains assignment history");
  overview = await makeups.getCourseMakeupOverview(runtime, actor(), undefined, afterSourceEnd);
  assert.ok(overview.unresolved.some((entry) => entry.enrollmentId === "enrollment-4") && overview.unresolved.some((entry) => entry.enrollmentId === "enrollment-5"), "special cancellation makes source absences unresolved again");

  const followed = await makeups.assignCourseMakeupToNormalClass(runtime, actor(), { ...source(1), targetClassSessionId: "target-class" }, afterSourceEnd);
  sqlite(`
    UPDATE class_calendar_revision SET status = 'superseded', superseded_at = '${now}', updated_at = '${now}' WHERE id = 'target-revision';
    INSERT INTO class_calendar_revision (id, class_calendar_id, curriculum_program_id, revision_number, status, first_candidate_date, locked_through_sequence, based_on_revision_id, is_test, test_run_id, created_at, updated_at)
      VALUES ('target-revision-2', 'target-calendar', 'program', 2, 'draft', '${shiftedTargetDate}', 0, 'target-revision', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO class_calendar_slot (id, class_calendar_revision_id, local_date, start_time, end_time, slot_source, status, curriculum_lesson_id, is_test, test_run_id, created_at, updated_at) VALUES
      ('target-slot-shifted', 'target-revision-2', '${shiftedTargetDate}', '14:00', '15:20', 'manual_extra', 'scheduled', 'lesson-1', 1, 'makeup-test', '${now}', '${now}'),
      ('target-slot-2-shifted', 'target-revision-2', '${addCivilDays(shiftedTargetDate, 7)}', '14:00', '15:20', 'generated', 'scheduled', 'lesson-2', 1, 'makeup-test', '${now}', '${now}');
    UPDATE class_calendar_revision SET status = 'published', published_at = '${now}' WHERE id = 'target-revision-2';
  `);
  const scheduled = (await makeups.getCourseMakeupOverview(runtime, actor(), undefined, afterSourceEnd)).scheduled.find((entry) => entry.assignmentId === followed.assignmentId);
  assert.equal(scheduled.targetLocalDate, shiftedTargetDate, "normal assignment follows target class + lesson after calendar reflow");

  const page = readFileSync("src/pages/staff/makeups.astro", "utf8");
  const built = readFileSync("dist/staff/makeups/index.html", "utf8");
  assert.match(page, /Нөхөхгүй/);
  assert.match(page, /Тусгай нөхөх хичээл үүсгэх/);
  assert.match(page, /Сул суудал/);
  assert.doesNotMatch(page, /урилга|Messenger|и-мэйл илгээ/, "make-up planning does not claim communication");
  assert.doesNotMatch(built, /Тест Нэг|Ижил хичээл/, "static make-up page contains no student or private lesson fixture");

  console.log("ok effective-absence make-up review, same-lesson capacity, special sessions, correction invalidation, and reflow following");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
