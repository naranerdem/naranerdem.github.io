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

function sqlite(sql, json = false, bail = false) {
  const result = spawnSync("sqlite3", json ? ["-json", databasePath] : [databasePath], {
    input: `.timeout 5000\n${bail ? ".bail on\n" : ""}PRAGMA foreign_keys=ON;\n${sql}`,
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
SELECT idx, changes FROM _batch_changes ORDER BY idx;`, true, true);
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
  const lifecycleMigration = migrations.find((file) => file === "0059_course_makeup_case_lifecycle.sql");
  const lessonRetirementMigration = migrations.find((file) => file === "0060_course_makeup_lesson_retirement.sql");
  const assignmentOperationMigration = migrations.find((file) => file === "0061_course_makeup_assignment_operations.sql");
  const sourceCalendarContextMigration = migrations.find((file) => file === "0062_course_makeup_source_calendar_context.sql");
  assert.ok(lifecycleMigration, "the lifecycle migration is present");
  assert.ok(lessonRetirementMigration, "the lesson-retirement migration is present");
  assert.ok(assignmentOperationMigration, "the assignment-operation migration is present");
  assert.ok(sourceCalendarContextMigration, "the source-calendar-context migration is present");
  sqlite(migrations.filter((file) => file < lifecycleMigration).map((file) => readFileSync(path.join("migrations", file), "utf8")).join("\n"));

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
      ('target-class', 'year', 'stage_1', 'Зорилтот анги', 'Ням', '14:00', '15:20', 2, 'available', 'offering', 1, 'makeup-test', '${now}', '${now}'),
      ('capacity-target', 'year', 'stage_1', 'Багтаамжийн зорилт', 'Ням', '16:00', '17:20', 1, 'available', 'offering', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO class_meeting_rule (class_session_id, recurrence_kind, first_date, weekly_weekday, start_time, end_time, created_at, updated_at) VALUES
      ('source-class', 'weekly', '${sourceDate}', 'Бямба', '10:00', '11:20', '${now}', '${now}'),
      ('target-class', 'weekly', '${targetDate}', 'Ням', '14:00', '15:20', '${now}', '${now}'),
      ('capacity-target', 'weekly', '${targetDate}', 'Ням', '16:00', '17:20', '${now}', '${now}');
    INSERT INTO class_calendar (id, class_session_id, timezone, status, is_test, test_run_id, created_at, updated_at) VALUES
      ('source-calendar', 'source-class', 'Asia/Ulaanbaatar', 'active', 1, 'makeup-test', '${now}', '${now}'),
      ('target-calendar', 'target-class', 'Asia/Ulaanbaatar', 'active', 1, 'makeup-test', '${now}', '${now}'),
      ('capacity-calendar', 'capacity-target', 'Asia/Ulaanbaatar', 'active', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO class_calendar_revision (id, class_calendar_id, curriculum_program_id, revision_number, status, first_candidate_date, locked_through_sequence, is_test, test_run_id, created_at, updated_at) VALUES
      ('source-revision', 'source-calendar', 'program', 1, 'draft', '${sourceDate}', 0, 1, 'makeup-test', '${now}', '${now}'),
      ('target-revision', 'target-calendar', 'program', 1, 'draft', '${targetDate}', 0, 1, 'makeup-test', '${now}', '${now}'),
      ('capacity-revision', 'capacity-calendar', 'program', 1, 'draft', '${targetDate}', 0, 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO class_calendar_slot (id, class_calendar_revision_id, local_date, start_time, end_time, slot_source, status, curriculum_lesson_id, is_test, test_run_id, created_at, updated_at) VALUES
      ('source-slot', 'source-revision', '${sourceDate}', '10:00', '11:20', 'generated', 'scheduled', 'lesson-1', 1, 'makeup-test', '${now}', '${now}'),
      ('target-slot', 'target-revision', '${targetDate}', '14:00', '15:20', 'generated', 'scheduled', 'lesson-1', 1, 'makeup-test', '${now}', '${now}'),
      ('target-slot-2', 'target-revision', '${addCivilDays(targetDate, 7)}', '14:00', '15:20', 'generated', 'scheduled', 'lesson-2', 1, 'makeup-test', '${now}', '${now}'),
      ('capacity-slot', 'capacity-revision', '${targetDate}', '16:00', '17:20', 'generated', 'scheduled', 'lesson-1', 1, 'makeup-test', '${now}', '${now}'),
      ('capacity-slot-2', 'capacity-revision', '${addCivilDays(targetDate, 7)}', '16:00', '17:20', 'generated', 'scheduled', 'lesson-2', 1, 'makeup-test', '${now}', '${now}');
    UPDATE class_calendar_revision SET status = 'published', published_at = '${now}' WHERE id IN ('source-revision', 'target-revision', 'capacity-revision');
    INSERT INTO guardian_account (id, full_name, primary_phone, primary_phone_normalized, email, email_normalized, home_address, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('guardian', 'Тест Асран', '99000000', '99000000', 'guardian@example.invalid', 'guardian@example.invalid', 'Тест', 'active', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO student (id, surname, given_name, gender, date_of_birth, status, is_test, test_run_id, created_at, updated_at) VALUES
      ('student-1', 'Тест', 'Нэг', 'not_specified', '2015-01-01', 'active', 1, 'makeup-test', '${now}', '${now}'),
      ('student-2', 'Тест', 'Хоёр', 'not_specified', '2015-01-02', 'active', 1, 'makeup-test', '${now}', '${now}'),
      ('student-3', 'Тест', 'Гурав', 'not_specified', '2015-01-03', 'active', 1, 'makeup-test', '${now}', '${now}'),
      ('student-4', 'Тест', 'Дөрөв', 'not_specified', '2015-01-04', 'active', 1, 'makeup-test', '${now}', '${now}'),
      ('student-5', 'Тест', 'Тав', 'not_specified', '2015-01-05', 'active', 1, 'makeup-test', '${now}', '${now}'),
      ('student-6', 'Тест', 'Зургаа', 'not_specified', '2015-01-06', 'active', 1, 'makeup-test', '${now}', '${now}'),
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
      ('enrollment-6', 'application-student-6', 'student-6', 'year', 'source-class', 'confirmed', '${confirmedAt}', 1, 'makeup-test', '${now}', '${now}'),
      ('target-enrollment', 'application-student-target', 'student-target', 'year', 'target-class', 'confirmed', '${confirmedAt}', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO course_attendance (id, enrollment_id, class_session_id, curriculum_lesson_id, attendance_status, recorded_calendar_slot_id, scheduled_local_date, first_recorded_at, updated_at, recorded_by_staff_account_id, updated_by_staff_account_id, is_test, test_run_id, created_at)
      VALUES ('attendance-3', 'enrollment-3', 'source-class', 'lesson-1', 'present', 'source-slot', '${sourceDate}', '${now}', '${now}', 'teacher-staff', 'teacher-staff', 1, 'makeup-test', '${now}');
    INSERT INTO course_absence_notice (id, enrollment_id, class_session_id, curriculum_lesson_id, notice_source, status, note, recorded_calendar_slot_id, scheduled_local_date, created_by_staff_account_id, updated_by_staff_account_id, created_at, updated_at, is_test, test_run_id)
      VALUES ('notice-2', 'enrollment-2', 'source-class', 'lesson-1', 'staff_manual', 'active', NULL, 'source-slot', '${sourceDate}', 'teacher-staff', 'teacher-staff', '${now}', '${now}', 1, 'makeup-test');
    INSERT INTO course_makeup_resolution (id, source_enrollment_id, source_class_session_id, source_curriculum_lesson_id, decision, status, decided_by_staff_account_id, decided_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('legacy-no-makeup', 'enrollment-3', 'source-class', 'lesson-1', 'no_makeup', 'active', 'teacher-staff', '${now}', 1, 'makeup-test', '${now}', '${now}');
  `);

  sqlite(readFileSync(path.join("migrations", lifecycleMigration), "utf8"));
  const migratedCase = JSON.parse(sqlite(`SELECT makeup_case.state, resolution.case_id AS caseId
    FROM course_makeup_case AS makeup_case
    INNER JOIN course_makeup_resolution AS resolution ON resolution.id = makeup_case.current_resolution_id
    WHERE resolution.id = 'legacy-no-makeup';`, true));
  assert.equal(migratedCase.length, 1, "0059 creates one case for one historical source decision");
  assert.equal(migratedCase[0].state, "closed", "0059 preserves a legacy no-makeup decision without inventing attendance");
  assert.ok(migratedCase[0].caseId, "0059 links the legacy resolution to its durable case");
  assert.equal(sqlite("PRAGMA foreign_key_check;"), "", "0059 preserves legacy make-up foreign keys");
  assert.equal(Number(JSON.parse(sqlite(`SELECT COUNT(*) AS value FROM sqlite_master
    WHERE type = 'index' AND name = 'idx_course_makeup_resolution_one_active';`, true))[0].value), 1,
  "0059 retains the released Worker's active-resolution uniqueness protection during deployment");
  sqlite(readFileSync(path.join("migrations", lessonRetirementMigration), "utf8"));
  sqlite(readFileSync(path.join("migrations", assignmentOperationMigration), "utf8"));
  assert.equal(sqlite("PRAGMA foreign_key_check;"), "", "0060 adds lesson retirement without changing legacy records");

  // A calendar can legitimately continue a historical published program after
  // its Offering advances. Before 0062, the source trigger rejects that same
  // source even though the published calendar is authoritative for attendance.
  sqlite(`INSERT INTO curriculum_program (
      id, program_family_id, academic_year_id, stage_code, revision_number,
      display_name, program_kind, status, is_test, test_run_id, created_at, updated_at
    ) VALUES ('offering-current-program', 'family', 'year', 'stage_1', 2,
      'Offering шинэ хувилбар', 'annual_course', 'draft', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO activity_offering (
      id, kind, title, academic_year_id, stage_code, starts_on,
      curriculum_program_id, use_academic_year_breaks, charge_mode, status,
      is_test, test_run_id, created_at, updated_at
    ) VALUES ('offering-current', 'annual_course', 'Шинэчилсэн сургалт', 'year', 'stage_1', '${sourceDate}',
      'offering-current-program', 1, 'paid', 'archived', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO class_session (
      id, academic_year_id, stage_code, display_label, weekday, start_time, end_time,
      capacity, status, activity_offering_id, is_test, test_run_id, created_at, updated_at
    ) VALUES ('calendar-context-source-class', 'year', 'stage_1', 'Өмнөх хуваарьтай эх анги', 'Бямба', '12:00', '13:20',
      10, 'available', NULL, 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO class_calendar (id, class_session_id, timezone, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('calendar-context-source-calendar', 'calendar-context-source-class', 'Asia/Ulaanbaatar', 'active', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO class_calendar_revision (
      id, class_calendar_id, curriculum_program_id, revision_number, status, first_candidate_date,
      locked_through_sequence, is_test, test_run_id, created_at, updated_at
    ) VALUES ('calendar-context-source-revision', 'calendar-context-source-calendar', 'program', 1, 'draft', '${sourceDate}',
      0, 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO class_calendar_slot (
      id, class_calendar_revision_id, local_date, start_time, end_time, slot_source, status,
      curriculum_lesson_id, is_test, test_run_id, created_at, updated_at
    ) VALUES ('calendar-context-source-slot', 'calendar-context-source-revision', '${sourceDate}', '12:00', '13:20',
      'generated', 'scheduled', 'lesson-1', 1, 'makeup-test', '${now}', '${now}');
    UPDATE class_calendar_revision SET status = 'published', published_at = '${now}'
      WHERE id = 'calendar-context-source-revision';
    UPDATE class_session SET activity_offering_id = 'offering-current'
      WHERE id = 'calendar-context-source-class';
    INSERT INTO student (id, surname, given_name, gender, date_of_birth, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('calendar-context-student', 'Хуучин', 'Хуваарь', 'not_specified', '2015-01-07', 'active', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO pre_registration (id, guardian_id, academic_year_id, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('calendar-context-prereg', 'guardian', 'year', 'completed', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO application_child (id, pre_registration_id, student_id, current_grade, returning_status, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('calendar-context-application', 'calendar-context-prereg', 'calendar-context-student', 5, 'new', 'enrolled', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO enrollment (id, application_child_id, student_id, academic_year_id, class_session_id, status, confirmed_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('calendar-context-enrollment', 'calendar-context-application', 'calendar-context-student', 'year',
        'calendar-context-source-class', 'confirmed', '${confirmedAt}', 1, 'makeup-test', '${now}', '${now}');`);
  assert.throws(() => sqlite(`INSERT INTO course_makeup_resolution (
      id, source_enrollment_id, source_class_session_id, source_curriculum_lesson_id,
      decision, status, decided_by_staff_account_id, decided_at,
      is_test, test_run_id, created_at, updated_at
    ) VALUES ('calendar-context-before-0062', 'calendar-context-enrollment', 'calendar-context-source-class', 'lesson-1',
      'assigned', 'active', 'teacher-staff', '${now}', 1, 'makeup-test', '${now}', '${now}');`),
  /make-up source must match enrollment class and offering lesson/,
  "the pre-0062 source trigger rejects a historical published calendar program");
  sqlite(readFileSync(path.join("migrations", sourceCalendarContextMigration), "utf8"));
  sqlite(`INSERT INTO course_makeup_resolution (
      id, source_enrollment_id, source_class_session_id, source_curriculum_lesson_id,
      decision, status, decided_by_staff_account_id, decided_at,
      is_test, test_run_id, created_at, updated_at
    ) VALUES ('calendar-context-after-0062', 'calendar-context-enrollment', 'calendar-context-source-class', 'lesson-1',
      'assigned', 'active', 'teacher-staff', '${now}', 1, 'makeup-test', '${now}', '${now}');
    UPDATE course_makeup_resolution
    SET status = 'invalidated', invalidated_at = '${now}', invalidated_by_staff_account_id = 'teacher-staff',
      invalidation_reason = 'assignment_cancelled', updated_at = '${now}'
    WHERE id = 'calendar-context-after-0062';`);
  assert.equal(Number(JSON.parse(sqlite(`SELECT COUNT(*) AS value FROM course_makeup_resolution
    WHERE id = 'calendar-context-after-0062';`, true))[0].value), 1,
  "0062 permits a source still represented by its published calendar revision");

  // This is the released Worker's resolution write shape: no case_id exists in
  // its SQL. It must remain safe if it reaches D1 after 0059 but before the
  // compatible Worker is serving traffic.
  sqlite(`INSERT INTO course_makeup_resolution (
    id, source_enrollment_id, source_class_session_id, source_curriculum_lesson_id,
    decision, status, decided_by_staff_account_id, decided_at,
    is_test, test_run_id, created_at, updated_at
  ) VALUES (
    'legacy-post-0059', 'enrollment-6', 'source-class', 'lesson-1',
    'no_makeup', 'active', 'teacher-staff', '${now}',
    1, 'makeup-test', '${now}', '${now}'
  );`);
  const legacyTransition = JSON.parse(sqlite(`SELECT resolution.case_id AS caseId,
      makeup_case.current_resolution_id AS currentResolutionId, makeup_case.state
    FROM course_makeup_resolution AS resolution
    INNER JOIN course_makeup_case AS makeup_case ON makeup_case.id = resolution.case_id
    WHERE resolution.id = 'legacy-post-0059';`, true));
  assert.deepEqual(legacyTransition, [{ caseId: legacyTransition[0].caseId, currentResolutionId: 'legacy-post-0059', state: 'closed' }],
    "a released Worker write after 0059 is adopted into exactly one durable case");
  assert.throws(() => sqlite(`INSERT INTO course_makeup_resolution (
    id, source_enrollment_id, source_class_session_id, source_curriculum_lesson_id,
    decision, status, decided_by_staff_account_id, decided_at,
    is_test, test_run_id, created_at, updated_at
  ) VALUES (
    'legacy-post-0059-duplicate', 'enrollment-6', 'source-class', 'lesson-1',
    'assigned', 'active', 'teacher-staff', '${now}',
    1, 'makeup-test', '${now}', '${now}'
  );`), /sqlite3 failed/, "the released Worker cannot create a second active resolution after 0059");
  sqlite(`UPDATE course_makeup_resolution SET status = 'invalidated', invalidated_at = '${now}',
    invalidated_by_staff_account_id = 'teacher-staff', invalidation_reason = 'assignment_cancelled', updated_at = '${now}'
    WHERE id = 'legacy-post-0059';`);
  const reopenedLegacyCase = JSON.parse(sqlite(`SELECT current_resolution_id AS currentResolutionId, state
    FROM course_makeup_case WHERE id = ${quote(legacyTransition[0].caseId)};`, true));
  assert.deepEqual(reopenedLegacyCase, [{ currentResolutionId: null, state: 'open' }],
    "legacy invalidation reopens its adopted case without leaving a stale current attempt");

  for (const [source, output] of [["src/server/staff/course-makeups.ts", makeupBundle], ["src/server/staff/course-attendance.ts", attendanceBundle]]) {
    const result = spawnSync(esbuild, [source, "--bundle", "--format=esm", "--platform=node", `--outfile=${output}`], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`esbuild failed for ${source}\n${result.stderr}`);
  }
  const makeups = await import(pathToFileURL(makeupBundle).href);
  const attendance = await import(pathToFileURL(attendanceBundle).href);

  const source = (number) => ({ enrollmentId: `enrollment-${number}`, classSessionId: "source-class", curriculumLessonId: "lesson-1" });
  function createDraftSeat(label) {
    const draftId = `capacity-draft-${label}`;
    const childId = `capacity-child-${label}`;
    const tokenHash = `${label}${"0".repeat(64)}`.slice(0, 64);
    sqlite(`
      INSERT INTO registration_draft (
        id, access_token_hash, academic_year_id, guardian_full_name, guardian_relationship,
        primary_phone, email, normalized_email, home_address, payment_plan_code,
        parent_rules_version, student_rules_version, status, expires_at,
        is_test, test_run_id, created_at, updated_at
      ) VALUES (
        '${draftId}', '${tokenHash}', 'year', 'Багтаамж Асран', 'parent',
        '99000000', '${label}@example.invalid', '${label}@example.invalid', 'Тест', 'single',
        'v1', 'v1', 'awaiting_initial_payment', '${addCivilDays(today, 30)}T00:00:00.000Z',
        1, 'makeup-test', '${now}', '${now}'
      );
      INSERT INTO registration_draft_child (
        id, registration_draft_id, position, surname, given_name, gender, date_of_birth,
        current_grade, returning_status, selected_stage_code, selected_class_session_id,
        status, is_test, test_run_id, created_at, updated_at
      ) VALUES (
        '${childId}', '${draftId}', 0, 'Багтаамж', '${label}', 'not_specified', '2015-02-01',
        '5', 'new', 'stage_1', 'capacity-target', 'awaiting_initial_payment',
        1, 'makeup-test', '${now}', '${now}'
      );
    `);
    return { draftId, childId };
  }
  assert.equal((await makeups.getCourseMakeupOverview(runtime, actor(), undefined, beforeSourceEnd)).unresolved.length, 0, "no make-up case exists before source class end");
  let overview = await makeups.getCourseMakeupOverview(runtime, actor(), undefined, afterSourceEnd);
  assert.deepEqual(overview.unresolved.map((entry) => entry.enrollmentId).sort(), ["enrollment-1", "enrollment-2", "enrollment-4", "enrollment-5", "enrollment-6"], "post-class unchecked students and reopened legacy cases are unresolved while present is excluded");
  assert.equal(overview.unresolved.find((entry) => entry.enrollmentId === "enrollment-2").hasAbsenceNotice, true, "prior notice is context only");
  await assert.rejects(() => makeups.getCourseMakeupOverview(runtime, actor("accountant"), undefined, afterSourceEnd), /Course make-up/, "accountants cannot view make-ups");

  await makeups.resolveCourseMakeupAsNotNeeded(runtime, actor(), source(2), afterSourceEnd);
  overview = await makeups.getCourseMakeupOverview(runtime, actor(), undefined, afterSourceEnd);
  assert.ok(!overview.unresolved.some((entry) => entry.enrollmentId === "enrollment-2"), "no-makeup decision suppresses the active queue");
  const noMakeup = overview.noMakeup.find((entry) => entry.enrollmentId === "enrollment-2");
  assert.ok(noMakeup, "no-makeup remains visible as an auditable teacher decision");
  await makeups.reopenCourseMakeupResolution(runtime, actor(), { resolutionId: noMakeup.resolutionId });
  overview = await makeups.getCourseMakeupOverview(runtime, actor(), undefined, afterSourceEnd);
  assert.ok(overview.unresolved.some((entry) => entry.enrollmentId === "enrollment-2"), "a no-makeup decision can be reopened for a new choice");
  await makeups.resolveCourseMakeupAsNotNeeded(runtime, actor(), source(2), afterSourceEnd);

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

  await assert.rejects(() => makeups.createSpecialCourseMakeupOccurrence(runtime, actor(), {
    sources: [source(4)], localDate: targetDate, startTime: "14:00", endTime: "15:20", capacity: 1,
  }, afterSourceEnd), /Course make-up/, "special-session creation shares the one-room check with regular teaching slots");

  const special = await makeups.createSpecialCourseMakeupOccurrence(runtime, actor(), {
    sources: [source(4), source(5)], localDate: targetDate, startTime: "18:00", endTime: "19:00", capacity: 2, note: "Тусгай тест",
  }, afterSourceEnd);
  assert.equal(special.assignmentCount, 2, "one special occurrence accepts several same-lesson students");
  assert.equal(count(database, "course_makeup_assignment", `target_special_occurrence_id = ${quote(special.specialOccurrenceId)} AND status = 'active'`), 2);
  await assert.rejects(() => makeups.assignCourseMakeupToSpecialOccurrence(runtime, actor(), { ...source(1), specialOccurrenceId: special.specialOccurrenceId }, afterSourceEnd), /Course make-up/, "special occurrence capacity is enforced");
  const attendedSpecialAssignment = database.query(`SELECT id FROM course_makeup_assignment
    WHERE target_special_occurrence_id = ${quote(special.specialOccurrenceId)} AND status = 'active'
    ORDER BY id LIMIT 1`)[0].id;
  sqlite(`INSERT INTO course_makeup_special_attendance (
    id, course_makeup_assignment_id, special_occurrence_id, attendance_status, scheduled_local_date,
    first_recorded_at, updated_at, recorded_by_staff_account_id, updated_by_staff_account_id,
    is_test, test_run_id, created_at
  ) VALUES ('attended-special-mark', ${quote(attendedSpecialAssignment)}, ${quote(special.specialOccurrenceId)}, 'present', '${targetDate}',
    '${now}', '${now}', 'teacher-staff', 'teacher-staff', 1, 'makeup-test', '${now}');`);
  await assert.rejects(() => makeups.cancelCourseMakeupAssignment(runtime, actor(), { assignmentId: attendedSpecialAssignment }, afterSourceEnd),
    /Course make-up/, "the service rejects unbooking a special assignment with recorded attendance");
  await assert.rejects(() => makeups.cancelSpecialCourseMakeupOccurrence(runtime, actor(), { specialOccurrenceId: special.specialOccurrenceId }, afterSourceEnd),
    /Course make-up/, "the service rejects cancelling a special session with recorded attendance");
  sqlite(`UPDATE course_makeup_special_attendance SET attendance_status = NULL WHERE id = 'attended-special-mark';`);
  await makeups.cancelSpecialCourseMakeupOccurrence(runtime, actor(), { specialOccurrenceId: special.specialOccurrenceId }, afterSourceEnd);
  assert.equal(count(database, "course_makeup_assignment", `target_special_occurrence_id = ${quote(special.specialOccurrenceId)} AND status = 'cancelled'`), 2, "special cancellation retains assignment history");
  overview = await makeups.getCourseMakeupOverview(runtime, actor(), undefined, afterSourceEnd);
  assert.ok(overview.unresolved.some((entry) => entry.enrollmentId === "enrollment-4") && overview.unresolved.some((entry) => entry.enrollmentId === "enrollment-5"), "special cancellation makes source absences unresolved again");

  // A completed destination is represented by its explicit mark, never merely
  // by elapsed time. Retired attempts remain attached to the same source case.
  sqlite(`
    INSERT INTO class_session (id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, activity_offering_id, is_test, test_run_id, created_at, updated_at)
      VALUES ('review-target', 'year', 'stage_1', 'Ирцийн зорилт', 'Даваа', '00:00', '01:00', 3, 'available', 'offering', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO class_meeting_rule (class_session_id, recurrence_kind, first_date, weekly_weekday, start_time, end_time, created_at, updated_at)
      VALUES ('review-target', 'weekly', '${today}', 'Даваа', '00:00', '01:00', '${now}', '${now}');
    INSERT INTO class_calendar (id, class_session_id, timezone, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('review-target-calendar', 'review-target', 'Asia/Ulaanbaatar', 'active', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO class_calendar_revision (id, class_calendar_id, curriculum_program_id, revision_number, status, first_candidate_date, locked_through_sequence, is_test, test_run_id, created_at, updated_at)
      VALUES ('review-target-revision', 'review-target-calendar', 'program', 1, 'draft', '${today}', 0, 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO class_calendar_slot (id, class_calendar_revision_id, local_date, start_time, end_time, slot_source, status, curriculum_lesson_id, is_test, test_run_id, created_at, updated_at)
      VALUES ('review-target-slot', 'review-target-revision', '${today}', '00:00', '01:00', 'manual_extra', 'scheduled', 'lesson-1', 1, 'makeup-test', '${now}', '${now}');
    UPDATE class_calendar_revision SET status = 'published', published_at = '${now}' WHERE id = 'review-target-revision';
  `);
  const firstAttempt = await makeups.assignCourseMakeupToNormalClass(runtime, actor(), { ...source(2), targetClassSessionId: 'review-target' }, afterSourceEnd);
  overview = await makeups.getCourseMakeupOverview(runtime, actor(), undefined, new Date(`${today}T12:00:00+08:00`));
  assert.ok(overview.attendanceReview.some((entry) => entry.assignmentId === firstAttempt.assignmentId), "an ended unmarked destination requires attendance review");
  await attendance.recordCourseAttendance(runtime, actor(), { slotId: 'review-target-slot', enrollmentId: 'enrollment-2', makeupAssignmentId: firstAttempt.assignmentId, status: 'absent' });
  overview = await makeups.getCourseMakeupOverview(runtime, actor(), undefined, new Date(`${today}T12:00:00+08:00`));
  assert.ok(overview.unresolved.some((entry) => entry.enrollmentId === 'enrollment-2'), "a recorded missed make-up returns the same source to an explicit action choice");
  await makeups.resolveCourseMakeupAsNotNeeded(runtime, actor(), source(2), afterSourceEnd);
  overview = await makeups.getCourseMakeupOverview(runtime, actor(), undefined, new Date(`${today}T12:00:00+08:00`));
  const closedAfterMiss = overview.noMakeup.find((entry) => entry.enrollmentId === 'enrollment-2');
  assert.ok(closedAfterMiss, "staff can explicitly close a case after a recorded missed make-up without deleting its attempt");
  await makeups.reopenCourseMakeupResolution(runtime, actor(), { resolutionId: closedAfterMiss.resolutionId });
  overview = await makeups.getCourseMakeupOverview(runtime, actor(), undefined, new Date(`${today}T12:00:00+08:00`));
  assert.ok(overview.unresolved.some((entry) => entry.enrollmentId === 'enrollment-2'), "reopening a closed missed make-up case restores an explicit booking decision");
  const secondAttempt = await makeups.assignCourseMakeupToNormalClass(runtime, actor(), { ...source(2), targetClassSessionId: 'target-class' }, afterSourceEnd);
  assert.equal(count(database, 'course_makeup_case', "source_enrollment_id = 'enrollment-2' AND source_class_session_id = 'source-class' AND source_curriculum_lesson_id = 'lesson-1'"), 1, "rebooking retains one durable source case");
  await attendance.recordCourseAttendance(runtime, actor(), { slotId: 'review-target-slot', enrollmentId: 'enrollment-2', makeupAssignmentId: firstAttempt.assignmentId, status: 'present' });
  overview = await makeups.getCourseMakeupOverview(runtime, actor(), undefined, afterSourceEnd);
  assert.equal(overview.scheduled.find((entry) => entry.assignmentId === secondAttempt.assignmentId)?.state, 'reconciliation', "a corrected earlier absence does not silently duplicate fulfilment after rebooking");
  await makeups.cancelCourseMakeupAssignment(runtime, actor(), { assignmentId: secondAttempt.assignmentId }, afterSourceEnd);
  assert.equal(database.query("SELECT state FROM course_makeup_case WHERE source_enrollment_id = 'enrollment-2'")[0].state, 'resolved', "cancelling an unmarked later attempt restores the truthful completed outcome");
  assert.equal(database.query(`SELECT attendance_status AS status FROM course_makeup_attendance WHERE course_makeup_assignment_id = ${quote(firstAttempt.assignmentId)}`)[0].status, 'present', "retired attempt attendance remains immutable history");

  const missedSpecial = await makeups.createSpecialCourseMakeupOccurrence(runtime, actor(), {
    sources: [source(6)], localDate: today, startTime: '02:00', endTime: '03:00', capacity: 1,
  }, afterSourceEnd);
  const missedSpecialAssignment = database.query(`SELECT id FROM course_makeup_assignment
    WHERE target_special_occurrence_id = ${quote(missedSpecial.specialOccurrenceId)} AND status = 'active'`)[0].id;
  await attendance.recordCourseAttendance(runtime, actor(), {
    slotId: missedSpecial.specialOccurrenceId, enrollmentId: 'enrollment-6',
    makeupAssignmentId: missedSpecialAssignment, status: 'absent',
  });
  const rebookedSpecialMiss = await makeups.assignCourseMakeupToNormalClass(runtime, actor(), {
    ...source(6), targetClassSessionId: 'review-target',
  }, afterSourceEnd);
  assert.equal(database.query(`SELECT status FROM course_makeup_assignment WHERE id = ${quote(missedSpecialAssignment)}`)[0].status, 'cancelled',
    "an explicitly absent special attempt retires before the same case is rebooked");
  const retiredSpecialRoster = await attendance.getCourseAttendanceDay(runtime, actor(), today, missedSpecial.specialOccurrenceId, afterSourceEnd);
  assert.equal(retiredSpecialRoster.selected.roster.find((entry) => entry.makeupAssignmentId === missedSpecialAssignment)?.recordedAttendanceStatus, 'absent',
    "a retired special attempt remains visible with its recorded destination attendance");
  await attendance.recordCourseAttendance(runtime, actor(), {
    slotId: missedSpecial.specialOccurrenceId, enrollmentId: 'enrollment-6',
    makeupAssignmentId: missedSpecialAssignment, status: 'late',
  });
  assert.equal(database.query(`SELECT attendance_status AS status FROM course_makeup_special_attendance
    WHERE course_makeup_assignment_id = ${quote(missedSpecialAssignment)}`)[0].status, 'late',
  "a retired marked special attempt can receive a truthful attendance correction without retargeting it");
  assert.equal(database.query("SELECT state FROM course_makeup_case WHERE source_enrollment_id = 'enrollment-6'")[0].state, 'reconciliation',
    "a corrected fulfilled historical attempt flags the case while its later booking remains current");
  assert.equal(rebookedSpecialMiss.assignmentId.length > 0, true, "rebooking creates one new current attempt without retargeting the historical special mark");

  const rescheduled = await makeups.createSpecialCourseMakeupOccurrence(runtime, actor(), {
    sources: [source(5)], localDate: addCivilDays(targetDate, 2), startTime: '18:00', endTime: '19:00', capacity: 1,
  }, afterSourceEnd);
  const reschedulePreview = await makeups.previewSpecialCourseMakeupReschedule(runtime, actor(), {
    specialOccurrenceId: rescheduled.specialOccurrenceId, localDate: addCivilDays(targetDate, 3), startTime: '19:00', endTime: '20:00',
  }, afterSourceEnd);
  const operationId = '11111111-1111-4111-8111-111111111111';
  const rescheduleInput = {
    specialOccurrenceId: rescheduled.specialOccurrenceId, expectedUpdatedAt: reschedulePreview.expectedUpdatedAt,
    localDate: reschedulePreview.next.localDate, startTime: reschedulePreview.next.startTime, endTime: reschedulePreview.next.endTime, operationId,
  };
  const moved = await makeups.rescheduleSpecialCourseMakeupOccurrence(runtime, actor(), rescheduleInput, afterSourceEnd);
  const replayedMove = await makeups.rescheduleSpecialCourseMakeupOccurrence(runtime, actor(), rescheduleInput, afterSourceEnd);
  assert.deepEqual(replayedMove, moved, "a lost-response retry returns the original special-session move");
  assert.equal(database.query(`SELECT local_date AS localDate, start_time AS startTime, end_time AS endTime FROM course_makeup_special_occurrence WHERE id = ${quote(rescheduled.specialOccurrenceId)}`)[0].startTime, '19:00', "whole-session rescheduling preserves its occurrence identity while moving the time");
  assert.equal(count(database, 'course_makeup_assignment', `target_special_occurrence_id = ${quote(rescheduled.specialOccurrenceId)} AND status = 'active'`), 1, "whole-session rescheduling retains booked learners once");
  const concurrentPreview = await makeups.previewSpecialCourseMakeupReschedule(runtime, actor(), {
    specialOccurrenceId: rescheduled.specialOccurrenceId, localDate: addCivilDays(targetDate, 5), startTime: '20:00', endTime: '21:00',
  }, afterSourceEnd);
  const competingMoves = await Promise.allSettled([
    makeups.rescheduleSpecialCourseMakeupOccurrence(runtime, actor(), {
      specialOccurrenceId: rescheduled.specialOccurrenceId, expectedUpdatedAt: concurrentPreview.expectedUpdatedAt,
      localDate: concurrentPreview.next.localDate, startTime: concurrentPreview.next.startTime, endTime: concurrentPreview.next.endTime,
      operationId: '22222222-2222-4222-8222-222222222222',
    }, afterSourceEnd),
    makeups.rescheduleSpecialCourseMakeupOccurrence(runtime, actor(), {
      specialOccurrenceId: rescheduled.specialOccurrenceId, expectedUpdatedAt: concurrentPreview.expectedUpdatedAt,
      localDate: addCivilDays(targetDate, 6), startTime: '21:00', endTime: '22:00',
      operationId: '33333333-3333-4333-8333-333333333333',
    }, afterSourceEnd),
  ]);
  assert.equal(competingMoves.filter((entry) => entry.status === 'fulfilled').length, 1, "competing special-session moves commit only one room-time claim");
  assert.equal(competingMoves.filter((entry) => entry.status === 'rejected').length, 1, "the conflicting special-session move leaves no partial schedule operation");
  await assert.rejects(() => makeups.previewSpecialCourseMakeupReschedule(runtime, actor(), {
    specialOccurrenceId: rescheduled.specialOccurrenceId, expectedUpdatedAt: reschedulePreview.expectedUpdatedAt,
    localDate: addCivilDays(targetDate, 4), startTime: '20:00', endTime: '21:00',
  }, afterSourceEnd), /Course make-up/, "a stale special-session preview is rejected");
  await assert.rejects(() => makeups.previewSpecialCourseMakeupReschedule(runtime, actor(), {
    specialOccurrenceId: rescheduled.specialOccurrenceId, localDate: targetDate, startTime: '14:00', endTime: '15:20',
  }, afterSourceEnd), /Course make-up/, "special-session rescheduling cannot overlap a published regular slot");
  const blockedDate = addCivilDays(targetDate, 4);
  sqlite(`INSERT INTO academic_year_break (
    id, academic_year_id, label, starts_on, ends_on, excludes_habitual_slots,
    exclude_from_generation, status, is_test, test_run_id, created_at, updated_at
  ) VALUES ('special-reschedule-break', 'year', 'Туршилтын амралт', '${blockedDate}', '${blockedDate}', 1,
    1, 'active', 1, 'makeup-test', '${now}', '${now}');`);
  await assert.rejects(() => makeups.previewSpecialCourseMakeupReschedule(runtime, actor(), {
    specialOccurrenceId: rescheduled.specialOccurrenceId, localDate: blockedDate, startTime: '19:00', endTime: '20:00',
  }, afterSourceEnd), /Course make-up/, "special-session rescheduling rejects an applicable closure date");

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

  const atTargetStart = new Date(`${targetDate}T14:00:00+08:00`);
  overview = await makeups.getCourseMakeupOverview(runtime, actor(), source(4), atTargetStart);
  assert.ok(!overview.selected.normalTargets.some((entry) => entry.classSessionId === 'target-class'),
    "a normal target beginning at the current Ulaanbaatar time is no longer an eligible future occurrence");

  // The shared capacity projection excludes a transferred-out enrollment, but
  // active operational reservations still occupy the target before a make-up
  // is assigned.
  sqlite(`UPDATE enrollment SET class_session_id = 'capacity-target' WHERE id = 'target-enrollment';`);
  overview = await makeups.getCourseMakeupOverview(runtime, actor(), source(4), afterSourceEnd);
  assert.ok(!overview.selected.normalTargets.some((entry) => entry.classSessionId === 'capacity-target'), "a current enrollment fills the normal make-up target");
  sqlite(`UPDATE enrollment SET transferred_out_at = '${now}' WHERE id = 'target-enrollment';`);
  overview = await makeups.getCourseMakeupOverview(runtime, actor(), source(4), afterSourceEnd);
  assert.equal(overview.selected.normalTargets.find((entry) => entry.classSessionId === 'capacity-target')?.remainingCapacity, 1, "a transferred-out enrollment releases the future make-up seat");

  sqlite(`
    INSERT INTO course_makeup_resolution (
      id, source_enrollment_id, source_class_session_id, source_curriculum_lesson_id,
      decision, status, decided_by_staff_account_id, decided_at, is_test, test_run_id, created_at, updated_at
    ) VALUES (
      'capacity-other-lesson-resolution', 'enrollment-4', 'source-class', 'lesson-2',
      'assigned', 'active', 'teacher-staff', '${now}', 1, 'makeup-test', '${now}', '${now}'
    );
    INSERT INTO course_makeup_assignment (
      id, resolution_id, target_kind, target_class_session_id, target_curriculum_lesson_id,
      status, assigned_by_staff_account_id, assigned_at, is_test, test_run_id, created_at, updated_at
    ) VALUES (
      'capacity-other-lesson-assignment', 'capacity-other-lesson-resolution', 'normal_class', 'capacity-target', 'lesson-2',
      'active', 'teacher-staff', '${now}', 1, 'makeup-test', '${now}', '${now}'
    );
  `);
  overview = await makeups.getCourseMakeupOverview(runtime, actor(), source(4), afterSourceEnd);
  assert.equal(overview.selected.normalTargets.find((entry) => entry.classSessionId === 'capacity-target')?.remainingCapacity, 1, "a make-up assignment for another target lesson does not consume this lesson's seat");

  const held = createDraftSeat('hold');
  sqlite(`INSERT INTO registration_capacity_hold (
    id, registration_draft_child_id, class_session_id, hold_type, status, deadline_at,
    is_test, test_run_id, created_at, updated_at
  ) VALUES ('capacity-hold', '${held.childId}', 'capacity-target', 'initial_payment', 'active',
    '${addCivilDays(today, 30)}T00:00:00.000Z', 1, 'makeup-test', '${now}', '${now}');`);
  overview = await makeups.getCourseMakeupOverview(runtime, actor(), source(4), afterSourceEnd);
  assert.ok(!overview.selected.normalTargets.some((entry) => entry.classSessionId === 'capacity-target'), "an active initial-payment hold blocks normal make-up capacity");
  sqlite(`UPDATE registration_capacity_hold SET status = 'released', released_at = '${now}' WHERE id = 'capacity-hold';`);
  overview = await makeups.getCourseMakeupOverview(runtime, actor(), source(4), afterSourceEnd);
  assert.ok(overview.selected.normalTargets.some((entry) => entry.classSessionId === 'capacity-target'), "a released hold no longer blocks the target");

  const expired = createDraftSeat('expired');
  sqlite(`INSERT INTO registration_capacity_hold (
    id, registration_draft_child_id, class_session_id, hold_type, status, deadline_at,
    released_at, is_test, test_run_id, created_at, updated_at
  ) VALUES ('capacity-expired-hold', '${expired.childId}', 'capacity-target', 'provisional_email_confirmation', 'expired',
    '${addCivilDays(today, -1)}T00:00:00.000Z', '${now}', 1, 'makeup-test', '${addCivilDays(today, -2)}T00:00:00.000Z', '${now}');`);
  overview = await makeups.getCourseMakeupOverview(runtime, actor(), source(4), afterSourceEnd);
  assert.ok(overview.selected.normalTargets.some((entry) => entry.classSessionId === 'capacity-target'), "an expired hold is not counted as capacity");

  const offered = createDraftSeat('offer');
  sqlite(`INSERT INTO registration_draft_waitlist_entry (
    id, registration_draft_child_id, class_session_id, status, is_test, test_run_id, created_at, updated_at
  ) VALUES ('capacity-waitlist', '${offered.childId}', 'capacity-target', 'offered', 1, 'makeup-test', '${now}', '${now}');
  INSERT INTO waitlist_seat_offer (
    id, waitlist_entry_id, registration_draft_child_id, class_session_id, status, response_token_hash,
    offered_at, respond_by_at, is_test, test_run_id, created_at, updated_at
  ) VALUES ('capacity-offer', 'capacity-waitlist', '${offered.childId}', 'capacity-target', 'active', '${"a".repeat(64)}',
    '${now}', '${addCivilDays(today, 1)}T00:00:00.000Z', 1, 'makeup-test', '${now}', '${now}');`);
  overview = await makeups.getCourseMakeupOverview(runtime, actor(), source(4), afterSourceEnd);
  assert.ok(!overview.selected.normalTargets.some((entry) => entry.classSessionId === 'capacity-target'), "an active waitlist offer blocks normal make-up capacity");
  sqlite(`UPDATE waitlist_seat_offer SET status = 'closed', resolved_at = '${now}' WHERE id = 'capacity-offer';`);

  sqlite(`INSERT INTO class_transfer (
    id, source_enrollment_id, source_application_child_id, source_class_session_id, target_class_session_id,
    status, reason, created_by_staff_account_id, idempotency_key, source_pricing_snapshot_json,
    target_pricing_snapshot_json, source_effective_charge_mnt, target_effective_charge_mnt,
    recognized_paid_mnt, required_difference_mnt, resulting_credit_mnt,
    is_test, test_run_id, created_at, updated_at
  ) VALUES ('capacity-transfer', 'enrollment-5', 'application-student-5', 'source-class', 'capacity-target',
    'pending_difference', 'test', 'teacher-staff', 'capacity-transfer-key', '{}', '{}', 0, 0, 0, 0, 0,
    1, 'makeup-test', '${now}', '${now}');
  INSERT INTO class_transfer_target_reservation (
    id, class_transfer_id, class_session_id, status, is_test, test_run_id, created_at, updated_at
  ) VALUES ('capacity-transfer-reservation', 'capacity-transfer', 'capacity-target', 'active', 1, 'makeup-test', '${now}', '${now}');`);
  overview = await makeups.getCourseMakeupOverview(runtime, actor(), source(4), afterSourceEnd);
  assert.ok(!overview.selected.normalTargets.some((entry) => entry.classSessionId === 'capacity-target'), "an active transfer reservation blocks normal make-up capacity");
  sqlite(`UPDATE class_transfer_target_reservation SET status = 'released', released_at = '${now}' WHERE id = 'capacity-transfer-reservation';`);

  // A capacity change after the teacher's target list loads is rechecked by
  // the D1 trigger in the same batch as resolution/assignment creation.
  const racing = createDraftSeat('race');
  let reservationInserted = false;
  const racingRuntime = {
    ...runtime,
    DB: {
      prepare: database.prepare.bind(database),
      batch: async (statements) => {
        if (!reservationInserted) {
          reservationInserted = true;
          sqlite(`INSERT INTO registration_capacity_hold (
            id, registration_draft_child_id, class_session_id, hold_type, status, deadline_at,
            is_test, test_run_id, created_at, updated_at
          ) VALUES ('capacity-race-hold', '${racing.childId}', 'capacity-target', 'initial_payment', 'active',
            '${addCivilDays(today, 30)}T00:00:00.000Z', 1, 'makeup-test', '${now}', '${now}');`);
        }
        return database.batch(statements);
      },
    },
  };
  await assert.rejects(() => makeups.assignCourseMakeupToNormalClass(racingRuntime, actor(), { ...source(4), targetClassSessionId: 'capacity-target' }, afterSourceEnd), /Course make-up/, "the insert-time capacity trigger rejects a stale available target");
  assert.equal(count(database, 'course_makeup_resolution', "source_enrollment_id = 'enrollment-4' AND source_curriculum_lesson_id = 'lesson-1' AND status = 'active'"), 0, "a rejected booking leaves the source absence available");
  sqlite(`UPDATE registration_capacity_hold SET status = 'released', released_at = '${now}' WHERE id = 'capacity-race-hold';`);

  const race = await Promise.allSettled([
    makeups.assignCourseMakeupToNormalClass(runtime, actor(), { ...source(4), targetClassSessionId: 'capacity-target' }, afterSourceEnd),
    makeups.assignCourseMakeupToNormalClass(runtime, actor(), { ...source(5), targetClassSessionId: 'capacity-target' }, afterSourceEnd),
  ]);
  assert.equal(race.filter((entry) => entry.status === 'fulfilled').length, 1, "competing normal bookings consume the final capacity once");
  assert.equal(race.filter((entry) => entry.status === 'rejected').length, 1, "the competing booking is rejected rather than overbooking");
  assert.equal(count(database, 'course_makeup_assignment', "target_class_session_id = 'capacity-target' AND target_curriculum_lesson_id = 'lesson-1' AND status = 'active'"), 1, "active make-up occupancy is scoped to the exact target lesson");

  // A named lesson can be retired for the current academic year without
  // deleting its absences. Restore re-evaluates the same durable sources,
  // then the grouped normal booking consumes capacity atomically and replays.
  sqlite(`
    INSERT INTO class_session (id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, activity_offering_id, is_test, test_run_id, created_at, updated_at)
      VALUES ('group-target', 'year', 'stage_1', 'Бүлгийн зорилтот анги', 'Ням', '20:00', '21:20', 2, 'available', 'offering', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO class_meeting_rule (class_session_id, recurrence_kind, first_date, weekly_weekday, start_time, end_time, created_at, updated_at)
      VALUES ('group-target', 'weekly', '${addCivilDays(targetDate, 21)}', 'Ням', '20:00', '21:20', '${now}', '${now}');
    INSERT INTO class_calendar (id, class_session_id, timezone, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('group-target-calendar', 'group-target', 'Asia/Ulaanbaatar', 'active', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO class_calendar_revision (id, class_calendar_id, curriculum_program_id, revision_number, status, first_candidate_date, locked_through_sequence, is_test, test_run_id, created_at, updated_at)
      VALUES ('group-target-revision', 'group-target-calendar', 'program', 1, 'draft', '${addCivilDays(targetDate, 21)}', 0, 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO class_calendar_slot (id, class_calendar_revision_id, local_date, start_time, end_time, slot_source, status, curriculum_lesson_id, is_test, test_run_id, created_at, updated_at)
      VALUES ('group-target-slot', 'group-target-revision', '${addCivilDays(targetDate, 21)}', '20:00', '21:20', 'generated', 'scheduled', 'lesson-1', 1, 'makeup-test', '${now}', '${now}');
    UPDATE class_calendar_revision SET status = 'published', published_at = '${now}' WHERE id = 'group-target-revision';
    INSERT INTO student (id, surname, given_name, gender, date_of_birth, status, is_test, test_run_id, created_at, updated_at) VALUES
      ('student-7', 'Бүлэг', 'Долоо', 'not_specified', '2015-01-07', 'active', 1, 'makeup-test', '${now}', '${now}'),
      ('student-8', 'Бүлэг', 'Найм', 'not_specified', '2015-01-08', 'active', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO pre_registration (id, guardian_id, academic_year_id, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('prereg-student-7', 'guardian', 'year', 'completed', 1, 'makeup-test', '${now}', '${now}'),
      ('prereg-student-8', 'guardian', 'year', 'completed', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO application_child (id, pre_registration_id, student_id, current_grade, returning_status, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('application-student-7', 'prereg-student-7', 'student-7', 5, 'new', 'enrolled', 1, 'makeup-test', '${now}', '${now}'),
      ('application-student-8', 'prereg-student-8', 'student-8', 5, 'new', 'enrolled', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO enrollment (id, application_child_id, student_id, academic_year_id, class_session_id, status, confirmed_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('enrollment-7', 'application-student-7', 'student-7', 'year', 'source-class', 'confirmed', '${confirmedAt}', 1, 'makeup-test', '${now}', '${now}'),
      ('enrollment-8', 'application-student-8', 'student-8', 'year', 'source-class', 'confirmed', '${confirmedAt}', 1, 'makeup-test', '${now}', '${now}');
  `);
  const groupIdentity = { academicYearId: 'year', curriculumProgramId: 'program', curriculumLessonId: 'lesson-1' };
  const retirePreview = await makeups.previewCourseMakeupLessonRetirement(runtime, actor(), groupIdentity, afterSourceEnd);
  assert.ok(retirePreview.sources.some((entry) => entry.enrollmentId === 'enrollment-7') && retirePreview.sources.some((entry) => entry.enrollmentId === 'enrollment-8'), "retirement previews the lesson's current waiting sources without selecting children");
  const retired = await makeups.retireCourseMakeupLesson(runtime, actor(), {
    ...groupIdentity, expectedFingerprint: retirePreview.fingerprint, operationId: '44444444-4444-4444-8444-444444444444',
  }, afterSourceEnd);
  const retiredReplay = await makeups.retireCourseMakeupLesson(runtime, actor(), {
    ...groupIdentity, expectedFingerprint: retirePreview.fingerprint, operationId: '44444444-4444-4444-8444-444444444444',
  }, afterSourceEnd);
  assert.deepEqual(retiredReplay, retired, "a lost-response retirement retry returns its original lesson result");
  overview = await makeups.getCourseMakeupOverview(runtime, actor(), undefined, afterSourceEnd);
  assert.ok(!overview.unresolved.some((entry) => entry.enrollmentId === 'enrollment-7'), "retired lessons leave the active waiting pool without erasing their absence");
  assert.ok(overview.archived.some((group) => group.entries.some((entry) => entry.enrollmentId === 'enrollment-7')), "retired lesson sources remain visible in the archive");
  await assert.rejects(() => makeups.previewCourseMakeupGroupNormalBooking(runtime, actor(), { sources: [source(7), source(8)] }, afterSourceEnd), /Course make-up/, "retirement is enforced at the server booking preview rather than only hidden in the page");
  const staleRestorePreview = await makeups.previewCourseMakeupLessonRestore(runtime, actor(), groupIdentity, afterSourceEnd);
  sqlite(`UPDATE course_makeup_lesson_state SET revision = revision + 1, updated_at = '${now}' WHERE id = ${quote(retired.lessonStateId)};`);
  await assert.rejects(() => makeups.restoreCourseMakeupLesson(runtime, actor(), {
    ...groupIdentity, expectedFingerprint: staleRestorePreview.fingerprint, operationId: '54444444-4444-4444-8444-444444444444',
  }, afterSourceEnd), /Course make-up/, "a changed retirement state rejects its stale restore review");
  const restorePreview = await makeups.previewCourseMakeupLessonRestore(runtime, actor(), groupIdentity, afterSourceEnd);
  await makeups.restoreCourseMakeupLesson(runtime, actor(), {
    ...groupIdentity, expectedFingerprint: restorePreview.fingerprint, operationId: '55555555-5555-4555-8555-555555555555',
  }, afterSourceEnd);
  const groupedPreview = await makeups.previewCourseMakeupGroupNormalBooking(runtime, actor(), { sources: [source(7), source(8)] }, afterSourceEnd);
  const groupedTarget = groupedPreview.targets.find((target) => target.classSessionId === 'group-target');
  assert.equal(groupedTarget?.remainingCapacity, 2, "grouped preview offers only a target with capacity for every selected child");
  assert.ok(!groupedPreview.targets.some((target) => target.classSessionId === 'target-class'),
    "a class whose later slot teaches another lesson is not treated as a group make-up destination");
  sqlite(`UPDATE class_session SET capacity = 1 WHERE id IN ('group-target', 'target-class', 'review-target');`);
  const capacityLimitedPreview = await makeups.previewCourseMakeupGroupNormalBooking(runtime, actor(), { sources: [source(7), source(8)] }, afterSourceEnd);
  assert.equal(capacityLimitedPreview.targets.length, 0, "a target with too few seats is not offered for a partial group booking");
  assert.equal(capacityLimitedPreview.insufficientTargets.find((target) => target.classSessionId === 'group-target')?.remainingCapacity, 1,
    "the preview reports actual spare seats when they cannot fit the complete selected group");
  sqlite(`UPDATE class_session SET capacity = 2 WHERE id IN ('group-target', 'target-class'); UPDATE class_session SET capacity = 3 WHERE id = 'review-target';`);
  const staleCapacityPreview = await makeups.previewCourseMakeupGroupNormalBooking(runtime, actor(), { sources: [source(7), source(8)] }, afterSourceEnd);
  sqlite(`UPDATE class_session SET capacity = 1 WHERE id = 'group-target';`);
  await assert.rejects(() => makeups.assignCourseMakeupGroupToNormalClass(runtime, actor(), {
    sources: [source(7), source(8)], expectedFingerprint: staleCapacityPreview.fingerprint,
    targetClassSessionId: 'group-target', operationId: '65656565-6565-4565-8565-656565656565',
  }, afterSourceEnd), /Course make-up/, "confirmation rechecks a stale group-capacity result before writing");
  assert.equal(count(database, 'course_makeup_assignment', "target_class_session_id = 'group-target' AND status = 'active'"), 0,
    "a stale capacity rejection leaves every selected source available");
  sqlite(`UPDATE class_session SET capacity = 2 WHERE id = 'group-target';`);
  const groupBookingInput = {
    sources: [source(7), source(8)], expectedFingerprint: groupedPreview.fingerprint,
    targetClassSessionId: 'group-target', operationId: '66666666-6666-4666-8666-666666666666',
  };
  const groupBooking = await makeups.assignCourseMakeupGroupToNormalClass(runtime, actor(), groupBookingInput, afterSourceEnd);
  assert.equal(groupBooking.assignmentIds.length, 2, "one grouped normal operation creates one assignment per selected source");
  assert.deepEqual(await makeups.assignCourseMakeupGroupToNormalClass(runtime, actor(), groupBookingInput, afterSourceEnd), groupBooking,
    "a retry after the grouped booking returns the original result without duplicate assignments");
  assert.equal(count(database, 'course_makeup_assignment', "target_class_session_id = 'group-target' AND status = 'active'"), 2, "batch booking never silently books only part of the selected group");
  for (const assignmentId of groupBooking.assignmentIds) {
    await makeups.cancelCourseMakeupAssignment(runtime, actor(), { assignmentId }, afterSourceEnd);
  }
  const cachedAvailability = await makeups.getCourseMakeupGroupAvailability(runtime, actor(), { sources: [source(7), source(8)] }, afterSourceEnd);
  assert.ok(cachedAvailability.targets.some((target) => target.kind === "normal_class" && target.classSessionId === 'group-target'
    && target.eligibleSourceKeys.length === 2), "one shared availability response retains per-child eligibility for a normal destination");
  const groupTarget = cachedAvailability.targets.find((target) => target.kind === 'normal_class' && target.classSessionId === 'group-target');
  await assert.rejects(() => makeups.previewCourseMakeupGroupDestinationBooking(runtime, actor(), {
    sources: [source(7), source(8)], targetKind: 'normal_class', targetClassSessionId: 'group-target', targetSlotId: 'wrong-slot',
  }, afterSourceEnd), /Course make-up/, "an existing normal destination must name its current occurrence, not only its class");
  const existingPreview = await makeups.previewCourseMakeupGroupDestinationBooking(runtime, actor(), {
    sources: [source(7), source(8)], targetKind: 'normal_class', targetClassSessionId: 'group-target',
    targetSlotId: groupTarget?.slotId,
  }, afterSourceEnd);
  const existingInput = {
    sources: [source(7), source(8)], expectedFingerprint: existingPreview.fingerprint,
    targetKind: 'normal_class', targetClassSessionId: 'group-target', targetSlotId: existingPreview.target.slotId,
    operationId: '67676767-6767-4676-8676-676767676767',
  };
  const existingBooking = await makeups.assignCourseMakeupGroupToExistingDestination(runtime, actor(), existingInput, afterSourceEnd);
  assert.equal(existingBooking.assignmentIds.length, 2, "one reviewed existing-session operation assigns every selected learner");
  assert.deepEqual(await makeups.assignCourseMakeupGroupToExistingDestination(runtime, actor(), existingInput, afterSourceEnd), existingBooking,
    "a lost-response existing-session retry returns the recorded result without duplicate assignments");
  const cancellationPreview = await makeups.previewCourseMakeupAssignmentCancellation(runtime, actor(), { assignmentId: existingBooking.assignmentIds[0] }, afterSourceEnd);
  const cancellationInput = { assignmentId: existingBooking.assignmentIds[0], expectedFingerprint: cancellationPreview.fingerprint, operationId: '68686868-6868-4686-8686-686868686868' };
  const cancelled = await makeups.cancelCourseMakeupAssignment(runtime, actor(), cancellationInput, afterSourceEnd);
  assert.deepEqual(await makeups.cancelCourseMakeupAssignment(runtime, actor(), cancellationInput, afterSourceEnd), cancelled,
    "individual cancellation replays its durable result instead of cancelling a later assignment");
  await makeups.cancelCourseMakeupAssignment(runtime, actor(), { assignmentId: existingBooking.assignmentIds[1] }, afterSourceEnd);
  const specialGroupPreview = await makeups.previewCourseMakeupGroupSpecialBooking(runtime, actor(), { sources: [source(7), source(8)] }, afterSourceEnd);
  const specialGroupInput = {
    sources: [source(7), source(8)], expectedFingerprint: specialGroupPreview.fingerprint,
    localDate: addCivilDays(targetDate, 30), startTime: '19:00', endTime: '20:20', capacity: 2,
    note: 'Бүлгийн тусгай нөхөх', operationId: '77777777-7777-4777-8777-777777777777',
  };
  const groupSpecial = await makeups.createCourseMakeupGroupSpecialOccurrence(runtime, actor(), specialGroupInput, afterSourceEnd);
  assert.equal(groupSpecial.assignmentIds.length, 2, "one reviewed special creation atomically creates and books every selected source");
  assert.deepEqual(await makeups.createCourseMakeupGroupSpecialOccurrence(runtime, actor(), specialGroupInput, afterSourceEnd), groupSpecial,
    "a retry after grouped special creation returns the original session and assignments");
  assert.equal(count(database, 'course_makeup_special_occurrence', `id = ${quote(groupSpecial.specialOccurrenceId)} AND status = 'active'`), 1,
    "an idempotent special retry cannot leave a second empty session");
  for (const assignmentId of groupSpecial.assignmentIds) {
    await makeups.cancelCourseMakeupAssignment(runtime, actor(), { assignmentId }, afterSourceEnd);
  }
  const noFutureDate = addCivilDays(targetDate, 40);
  sqlite(`
    INSERT INTO class_session (id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, activity_offering_id, is_test, test_run_id, created_at, updated_at)
      VALUES ('different-lesson-target', 'year', 'stage_1', 'Өөр хичээлийн зорилт', 'Даваа', '22:00', '23:20', 10, 'available', 'offering', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO class_calendar (id, class_session_id, timezone, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('different-lesson-calendar', 'different-lesson-target', 'Asia/Ulaanbaatar', 'active', 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO class_calendar_revision (id, class_calendar_id, curriculum_program_id, revision_number, status, first_candidate_date, locked_through_sequence, is_test, test_run_id, created_at, updated_at)
      VALUES ('different-lesson-revision', 'different-lesson-calendar', 'program', 1, 'draft', '${addCivilDays(noFutureDate, 1)}', 0, 1, 'makeup-test', '${now}', '${now}');
    INSERT INTO class_calendar_slot (id, class_calendar_revision_id, local_date, start_time, end_time, slot_source, status, curriculum_lesson_id, is_test, test_run_id, created_at, updated_at)
      VALUES ('different-lesson-slot', 'different-lesson-revision', '${addCivilDays(noFutureDate, 1)}', '22:00', '23:20', 'generated', 'scheduled', 'lesson-2', 1, 'makeup-test', '${now}', '${now}');
    UPDATE class_calendar_revision SET status = 'published', published_at = '${now}' WHERE id = 'different-lesson-revision';
  `);
  const noFuturePreview = await makeups.previewCourseMakeupGroupNormalBooking(runtime, actor(), { sources: [source(7), source(8)] }, new Date(`${noFutureDate}T12:00:00+08:00`));
  assert.equal(noFuturePreview.targets.length, 0, "no future matching named lesson leaves the normal booking action unavailable");
  assert.equal(noFuturePreview.insufficientTargets.length, 0, "a later slot for a different named lesson is not reported as a matching target");

  const page = readFileSync("src/pages/staff/makeups.astro", "utf8");
  const built = readFileSync("dist/staff/makeups/index.html", "utf8");
  assert.doesNotMatch(page, /data-no-makeup/, "the active make-up pool no longer persists an individual refusal from a child row");
  assert.match(page, /Архиваас гаргах/);
  assert.doesNotMatch(page, /Дахин нээх/, "lesson-level archive recovery replaces the obsolete per-child reopen control");
  assert.match(page, /Түр шилжих/);
  assert.match(page, /Шинэ цаг/);
  assert.match(page, /Архивлах/);
  assert.match(page, /Сул суудал/);
  assert.doesNotMatch(page, /урилга|Messenger|и-мэйл илгээ/, "make-up planning does not claim communication");
  assert.doesNotMatch(built, /Тест Нэг|Ижил хичээл/, "static make-up page contains no student or private lesson fixture");

  console.log("ok make-up case lifecycle, attendance review, rebooking reconciliation, shared capacity, special-session rescheduling, and calendar reflow following");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
