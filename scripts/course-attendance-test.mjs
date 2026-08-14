import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const tempDir = mkdtempSync(path.join(tmpdir(), "naranerdem-course-attendance-"));
const databasePath = path.join(tempDir, "attendance.sqlite3");
const attendanceBundle = path.join(tempDir, "course-attendance.mjs");
const calendarBundle = path.join(tempDir, "program-calendar.mjs");
const esbuild = path.resolve("node_modules/esbuild/bin/esbuild");

function quote(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function bindSql(sql, values) {
  let index = 0;
  const bound = sql.replaceAll("?", () => quote(values[index++]));
  assert.equal(index, values.length, "all SQLite bindings are used");
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
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return result.toISOString().slice(0, 10);
}

function civilWeekday(value) {
  const [year, month, day] = value.split("-").map(Number);
  return ["Ням", "Даваа", "Мягмар", "Лхагва", "Пүрэв", "Баасан", "Бямба"][new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

function actor(role = "teacher") {
  const capabilities = role === "accountant"
    ? ["payment.view"]
    : ["program.view", "program.manage", "calendar.view", "calendar.manage", "attendance.view", "attendance.manage"];
  return { staffAccountId: `${role}-staff`, displayName: role, roles: [role], capabilities, sessionId: "test", sessionExpiresAt: "2030-01-01T00:00:00.000Z", sessionAbsoluteExpiresAt: "2030-01-01T00:00:00.000Z" };
}

function env(database) {
  return {
    APP_ENV: "staging", REGISTRATION_WRITE_ENABLED: "false", APP_ORIGIN: "https://staging.example.test",
    EMAIL_ENABLED: "false", AUTH_EMAIL_ENABLED: "false", STAFF_AUTH_EMAIL_ENABLED: "false", EMAIL_FROM: "test@example.invalid", DB: database,
  };
}

function count(database, table, where = "1 = 1") {
  return Number(database.query(`SELECT COUNT(*) AS value FROM ${table} WHERE ${where}`)[0].value);
}

try {
  const migrations = readdirSync("migrations").filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
  sqlite(migrations.map((file) => readFileSync(path.join("migrations", file), "utf8")).join("\n"));

  for (const [source, output] of [["src/server/staff/course-attendance.ts", attendanceBundle], ["src/server/staff/program-calendar.ts", calendarBundle]]) {
    const result = spawnSync(esbuild, [source, "--bundle", "--format=esm", "--platform=node", `--outfile=${output}`], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`esbuild failed for ${source}\n${result.stderr}`);
  }
  const attendance = await import(pathToFileURL(attendanceBundle).href);
  const calendar = await import(pathToFileURL(calendarBundle).href);
  const database = new SqliteD1();
  const runtime = env(database);
  const now = new Date().toISOString();
  const today = localToday();
  const past = addCivilDays(today, -7);
  const future = addCivilDays(today, 7);
  const weekday = civilWeekday(past);
  const confirmedAt = new Date(`${addCivilDays(today, -14)}T00:00:00+08:00`).toISOString();

  sqlite(`
    INSERT INTO staff_account (id, email_normalized, display_name, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('teacher-staff', 'teacher@example.invalid', 'Тест Багш', 'active', 1, 'attendance-test', '${now}', '${now}'),
        ('accountant-staff', 'accountant@example.invalid', 'Тест Нягтлан', 'active', 1, 'attendance-test', '${now}', '${now}');
    INSERT INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_current, is_test, test_run_id, created_at, updated_at)
      VALUES ('year', 'Ирцийн тест', 'closed', '${addCivilDays(today, -90)}', '${addCivilDays(today, 90)}', 1, 1, 'attendance-test', '${now}', '${now}');
    INSERT INTO curriculum_program_family (id, kind, display_name, annual_stage_code, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('family', 'annual_course', '1-р шат', 'stage_1', 'active', 1, 'attendance-test', '${now}', '${now}');
    INSERT INTO curriculum_program (id, program_family_id, academic_year_id, stage_code, revision_number, display_name, program_kind, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('program', 'family', 'year', 'stage_1', 1, 'Ирцийн хөтөлбөр', 'annual_course', 'draft', 1, 'attendance-test', '${now}', '${now}');
    INSERT INTO curriculum_lesson (id, curriculum_program_id, sequence_number, title, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('lesson-1', 'program', 1, 'Өнгөрсөн хичээл', 'active', 1, 'attendance-test', '${now}', '${now}'),
        ('lesson-2', 'program', 2, 'Өнөөдрийн хичээл', 'active', 1, 'attendance-test', '${now}', '${now}'),
        ('lesson-3', 'program', 3, 'Ирээдүйн хичээл', 'active', 1, 'attendance-test', '${now}', '${now}');
    UPDATE curriculum_program SET status = 'published', published_at = '${now}' WHERE id = 'program';
    UPDATE curriculum_program_family SET current_published_program_id = 'program' WHERE id = 'family';
    INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, starts_on, curriculum_program_id, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('offering', 'annual_course', 'Ирцийн жилийн сургалт', 'year', 'stage_1', '${addCivilDays(today, -14)}', 'program', 1, 'paid', 'active', 1, 'attendance-test', '${now}', '${now}');
    INSERT INTO class_session (id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, activity_offering_id, is_test, test_run_id, created_at, updated_at)
      VALUES ('class-a', 'year', 'stage_1', 'Тест анги', '${weekday}', '10:00', '11:20', 10, 'closed', 'offering', 1, 'attendance-test', '${now}', '${now}'),
        ('class-b', 'year', 'stage_1', 'Өөр тест анги', 'Ням', '10:00', '11:20', 10, 'closed', 'offering', 1, 'attendance-test', '${now}', '${now}');
    INSERT INTO class_meeting_rule (class_session_id, recurrence_kind, first_date, weekly_weekday, start_time, end_time, created_at, updated_at)
      VALUES ('class-a', 'weekly', '${past}', '${weekday}', '10:00', '11:20', '${now}', '${now}'),
        ('class-b', 'weekly', '${past}', 'Ням', '10:00', '11:20', '${now}', '${now}');
    INSERT INTO class_calendar (id, class_session_id, timezone, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('calendar-a', 'class-a', 'Asia/Ulaanbaatar', 'active', 1, 'attendance-test', '${now}', '${now}');
    INSERT INTO class_calendar_revision (id, class_calendar_id, curriculum_program_id, revision_number, status, first_candidate_date, locked_through_sequence, is_test, test_run_id, created_at, updated_at)
      VALUES ('revision-a', 'calendar-a', 'program', 1, 'draft', '${past}', 0, 1, 'attendance-test', '${now}', '${now}');
    INSERT INTO class_calendar_slot (id, class_calendar_revision_id, local_date, start_time, end_time, slot_source, status, curriculum_lesson_id, is_test, test_run_id, created_at, updated_at)
      VALUES ('slot-past', 'revision-a', '${past}', '10:00', '11:20', 'generated', 'scheduled', 'lesson-1', 1, 'attendance-test', '${now}', '${now}'),
        ('slot-today', 'revision-a', '${today}', '10:00', '11:20', 'generated', 'scheduled', 'lesson-2', 1, 'attendance-test', '${now}', '${now}'),
        ('slot-future', 'revision-a', '${future}', '10:00', '11:20', 'generated', 'scheduled', 'lesson-3', 1, 'attendance-test', '${now}', '${now}');
    UPDATE class_calendar_revision SET status = 'published', published_at = '${now}' WHERE id = 'revision-a';
    INSERT INTO academic_year_break (id, academic_year_id, label, starts_on, ends_on, excludes_habitual_slots, generation_behavior, exclude_from_generation, warn_on_overlap, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('today-holiday', 'year', 'Тест амралт', '${today}', '${today}', 0, 'warn_only', 0, 1, 'active', 1, 'attendance-test', '${now}', '${now}');
    INSERT INTO guardian_account (id, full_name, primary_phone, primary_phone_normalized, email, email_normalized, home_address, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('guardian', 'Тест Асран хамгаалагч', '99000000', '99000000', 'guardian@example.invalid', 'guardian@example.invalid', 'Тест хаяг', 'active', 1, 'attendance-test', '${now}', '${now}');
    INSERT INTO student (id, surname, given_name, gender, date_of_birth, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('student-a', 'Бат', 'Анударь', 'female', '2015-01-01', 'active', 1, 'attendance-test', '${now}', '${now}'),
        ('student-b', 'Дорж', 'Билгүүн', 'male', '2015-02-02', 'active', 1, 'attendance-test', '${now}', '${now}');
    INSERT INTO pre_registration (id, guardian_id, academic_year_id, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('prereg-a', 'guardian', 'year', 'completed', 1, 'attendance-test', '${now}', '${now}'),
        ('prereg-b', 'guardian', 'year', 'completed', 1, 'attendance-test', '${now}', '${now}');
    INSERT INTO application_child (id, pre_registration_id, student_id, current_grade, returning_status, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('application-a', 'prereg-a', 'student-a', 5, 'new', 'enrolled', 1, 'attendance-test', '${now}', '${now}'),
        ('application-b', 'prereg-b', 'student-b', 5, 'new', 'enrolled', 1, 'attendance-test', '${now}', '${now}');
    INSERT INTO enrollment (id, application_child_id, student_id, academic_year_id, class_session_id, status, confirmed_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('enrollment-a', 'application-a', 'student-a', 'year', 'class-a', 'confirmed', '${confirmedAt}', 1, 'attendance-test', '${now}', '${now}'),
        ('enrollment-b', 'application-b', 'student-b', 'year', 'class-a', 'confirmed', '${confirmedAt}', 1, 'attendance-test', '${now}', '${now}');
  `);

  const day = await attendance.getCourseAttendanceDay(runtime, actor(), today, "slot-today");
  assert.equal(day.occurrences.length, 1, "daily attendance lists scheduled course occurrences only");
  assert.equal(day.occurrences[0].rosterCount, 2, "daily occurrence list includes its compact roster count");
  assert.equal(day.occurrences[0].markedCount, 0, "daily occurrence list includes its compact marked count");
  assert.equal(day.selected.rosterCount, 2, "confirmed students are rostered for the occurrence");
  assert.equal(day.selected.holidayLabel, "Тест амралт", "a restored school-calendar date keeps its warning");
  assert.equal(day.selected.markedCount, 0);
  await assert.rejects(() => attendance.getCourseAttendanceDay(runtime, actor("accountant"), today), /Course attendance/, "accountants cannot view attendance");

  const marked = await attendance.recordCourseAttendance(runtime, actor(), { slotId: "slot-today", enrollmentId: "enrollment-a", status: "present" });
  assert.equal(marked.changed, true);
  assert.throws(() => sqlite(`INSERT INTO course_attendance (
    id, enrollment_id, class_session_id, curriculum_lesson_id, attendance_status, scheduled_local_date,
    first_recorded_at, updated_at, recorded_by_staff_account_id, updated_by_staff_account_id, is_test, test_run_id, created_at
  ) VALUES ('duplicate-attendance', 'enrollment-a', 'class-a', 'lesson-2', 'late', '${today}', '${now}', '${now}', 'teacher-staff', 'teacher-staff', 1, 'attendance-test', '${now}');`), /UNIQUE constraint failed/, "one enrollment has at most one current record for a class lesson");
  assert.equal((await attendance.recordCourseAttendance(runtime, actor(), { slotId: "slot-today", enrollmentId: "enrollment-a", status: "present" })).changed, false, "same status is a no-op");
  await attendance.recordCourseAttendance(runtime, actor(), { slotId: "slot-today", enrollmentId: "enrollment-a", status: "late" });
  await attendance.clearCourseAttendance(runtime, actor(), { slotId: "slot-today", enrollmentId: "enrollment-a" });
  assert.equal(database.query("SELECT attendance_status AS status FROM course_attendance WHERE enrollment_id = 'enrollment-a'")[0].status, null, "clear returns the current attendance state to unmarked");
  assert.equal(count(database, "course_attendance_change", "course_attendance_id = (SELECT id FROM course_attendance WHERE enrollment_id = 'enrollment-a')"), 3, "mark, correction, and clear remain auditable");
  assert.throws(() => sqlite("DELETE FROM course_attendance_change WHERE id = (SELECT id FROM course_attendance_change LIMIT 1);"), /course attendance history is append-only/, "attendance history cannot be deleted");
  assert.equal(await attendance.attendanceProtectedThroughSequence(runtime, "class-a", "program"), 0, "clearing removes the attendance-derived schedule lock");

  const bulk = await attendance.markUnmarkedRosterPresent(runtime, actor(), { slotId: "slot-today" });
  assert.equal(bulk.markedCount, 2, "bulk present changes only currently unmarked roster entries");
  const completed = await attendance.getCourseAttendanceDay(runtime, actor(), today, "slot-today");
  assert.equal(completed.selected.markedCount, 2);
  assert.equal(completed.selected.rosterCount, 2);
  assert.equal(count(database, "class_calendar_revision"), 1, "attendance does not create a calendar revision");
  await attendance.recordCourseAttendance(runtime, actor(), { slotId: "slot-past", enrollmentId: "enrollment-a", status: "absent" });
  sqlite(`UPDATE enrollment SET status = 'cancelled', cancelled_at = '${now}' WHERE id = 'enrollment-a';`);
  const withdrawnHistorical = await attendance.getCourseAttendanceDay(runtime, actor(), past, "slot-past");
  assert.ok(withdrawnHistorical.selected.roster.some((entry) => entry.enrollmentId === "enrollment-a"), "existing attendance stays available after later enrollment cancellation");
  sqlite(`
    INSERT INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_test, test_run_id, created_at, updated_at)
      VALUES ('year-next', 'Дараагийн туршилтын жил', 'draft', '2027-09-01', '2028-05-31', 1, 'attendance-test', '${now}', '${now}');
    INSERT INTO curriculum_program (id, program_family_id, academic_year_id, stage_code, revision_number, display_name, program_kind, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('program-next', 'family', 'year-next', 'stage_1', 2, 'Дараагийн тест хөтөлбөр', 'annual_course', 'draft', 1, 'attendance-test', '${now}', '${now}');
    INSERT INTO curriculum_lesson (id, curriculum_program_id, sequence_number, title, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('lesson-next', 'program-next', 1, 'Дараагийн тест хичээл', 'active', 1, 'attendance-test', '${now}', '${now}');
    UPDATE curriculum_program SET status = 'published', published_at = '${now}' WHERE id = 'program-next';
    UPDATE curriculum_program_family SET current_published_program_id = 'program-next' WHERE id = 'family';
  `);
  assert.equal(count(database, "course_attendance", "attendance_status IS NOT NULL"), 3, "a newer logical Program revision does not disturb attendance on the Offering-pinned revision");

  await assert.rejects(() => attendance.recordCourseAttendance(runtime, actor(), { slotId: "slot-future", enrollmentId: "enrollment-a", status: "present" }), /Course attendance/, "future attendance is rejected server-side");
  await attendance.saveCourseAbsenceNotice(runtime, actor(), { slotId: "slot-future", enrollmentId: "enrollment-b", note: "Тест мэдэгдэл" });
  assert.equal(database.query("SELECT status, note FROM course_absence_notice WHERE enrollment_id = 'enrollment-b' AND curriculum_lesson_id = 'lesson-3'")[0].status, "active", "future notice is separate from attendance");
  await attendance.cancelCourseAbsenceNotice(runtime, actor(), { slotId: "slot-future", enrollmentId: "enrollment-b" });
  assert.equal(database.query("SELECT status FROM course_absence_notice WHERE enrollment_id = 'enrollment-b' AND curriculum_lesson_id = 'lesson-3'")[0].status, "cancelled", "notice cancellation keeps the durable row");
  assert.equal(count(database, "course_absence_notice_change"), 2, "notice creation and cancellation retain history");

  assert.throws(() => sqlite(`INSERT INTO course_attendance (
    id, enrollment_id, class_session_id, curriculum_lesson_id, attendance_status, scheduled_local_date,
    first_recorded_at, updated_at, recorded_by_staff_account_id, updated_by_staff_account_id, is_test, test_run_id, created_at
  ) VALUES ('wrong-class', 'enrollment-a', 'class-b', 'lesson-1', 'present', '${past}', '${now}', '${now}', 'teacher-staff', 'teacher-staff', 1, 'attendance-test', '${now}');`), /course attendance enrollment must belong to class session/, "database rejects cross-class attendance");

  const beforeDrafts = count(database, "class_calendar_revision");
  await calendar.createCalendarChangeDraft(runtime, actor(), { classSessionId: "class-a" });
  const changeDraft = database.query("SELECT id, locked_through_sequence AS lockedThroughSequence FROM class_calendar_revision WHERE class_calendar_id = 'calendar-a' AND status = 'draft'")[0];
  assert.equal(changeDraft.lockedThroughSequence, 1, "the persistent draft lock keeps only historical schedule protection");
  await assert.rejects(() => calendar.changeCalendarDraft(runtime, actor(), {
    revisionId: changeDraft.id, expectedUpdatedAt: database.query(`SELECT updated_at AS updatedAt FROM class_calendar_revision WHERE id = ${quote(changeDraft.id)}`)[0].updatedAt,
    kind: "extra", localDate: today, startTime: "09:00", endTime: "09:30",
  }), /Program and calendar operation failed/, "current attendance dynamically protects its lesson from reflow");
  await attendance.clearCourseAttendance(runtime, actor(), { slotId: "slot-today", enrollmentId: "enrollment-a" });
  await attendance.clearCourseAttendance(runtime, actor(), { slotId: "slot-today", enrollmentId: "enrollment-b" });
  await attendance.clearCourseAttendance(runtime, actor(), { slotId: "slot-past", enrollmentId: "enrollment-a" });
  assert.equal(await attendance.attendanceProtectedThroughSequence(runtime, "class-a", "program"), 0, "no current attendance remains after clearing the marks");
  await calendar.changeCalendarDraft(runtime, actor(), {
    revisionId: changeDraft.id, expectedUpdatedAt: database.query(`SELECT updated_at AS updatedAt FROM class_calendar_revision WHERE id = ${quote(changeDraft.id)}`)[0].updatedAt,
    kind: "extra", localDate: today, startTime: "09:00", endTime: "09:30",
  });
  assert.equal(count(database, "class_calendar_slot", `class_calendar_revision_id = ${quote(changeDraft.id)} AND local_date = ${quote(today)} AND start_time = '09:00'`), 1, "clearing attendance removes only its dynamic reflow protection");
  assert.equal(count(database, "class_calendar_revision"), beforeDrafts + 1, "calendar drafting remains separate from attendance");

  const source = readFileSync("src/pages/staff/attendance.astro", "utf8");
  const staffHome = readFileSync("src/pages/staff.astro", "utf8");
  const renderedAttendance = readFileSync("dist/staff/attendance/index.html", "utf8");
  assert.match(source, /Бүгд ирсэн/);
  assert.match(source, /Одоогоор тэмдэглээгүй/);
  assert.match(source, /Тэмдэглэгээг арилгах/);
  assert.match(source, /Урьдчилж мэдэгдсэн/);
  assert.match(source, /createOptimisticRosterMutator/, "individual attendance updates are optimistic");
  assert.match(source, /data-staff-action-menu/, "clearing a mark uses the compact row action menu");
  assert.doesNotMatch(source, /Ирэхгүйг мэдэгдэх/, "teacher roster uses completed-notice wording");
  assert.doesNotMatch(source, /await refresh\(success\)/, "individual mutations do not refetch the full roster");
  assert.doesNotMatch(source, /Хадгалах<\/button>/, "attendance has no page-level save action");
  assert.doesNotMatch(source, /Ноорог|Нийтлэх|Хувилбар/, "attendance has no calendar draft terminology");
  assert.doesNotMatch(source, /window\.confirm/, "bulk attendance uses an in-page Mongolian confirmation");
  assert.match(staffHome, /href="\/staff\/attendance\/"/, "staff home links to daily attendance");
  assert.match(staffHome, /Өдөр тутмын ажил[\s\S]*?Ирц[\s\S]*?Сургалтын тохиргоо/, "staff home places attendance before setup tools");
  assert.doesNotMatch(staffHome, /Таны ажиллах хэсэг/, "staff home has no redundant capability list");
  assert.doesNotMatch(renderedAttendance, /Анударь|Билгүүн|Тест амралт/, "the static attendance page ships no roster or curriculum data");

  console.log("ok course attendance identity, history, notice, roster, protection, and staff UI tests");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
