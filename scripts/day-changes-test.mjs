import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const tempDir = mkdtempSync(path.join(tmpdir(), "naranerdem-day-changes-"));
const databasePath = path.join(tempDir, "day-changes.sqlite3");
const bundlePath = path.join(tempDir, "day-changes.mjs");
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
    input: `.timeout 5000\nPRAGMA foreign_keys=ON;\n${sql}`, encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`sqlite3 failed\n${result.stderr}\n${sql}`);
  return result.stdout.trim();
}
class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.database.query(this.sql, this.values)[0] ?? null; }
  async all() { return { success: true, results: this.database.query(this.sql, this.values) }; }
  async run() { const rows = this.database.query(`${this.sql}; SELECT changes() AS changes`, this.values); return { success: true, results: [], meta: { changes: Number(rows.at(-1)?.changes ?? 0) } }; }
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
function addDays(value, days) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
function mongolianWeekday(value) {
  return ["Ням", "Даваа", "Мягмар", "Лхагва", "Пүрэв", "Баасан", "Бямба"][new Date(`${value}T00:00:00Z`).getUTCDay()];
}
function actor(role = "teacher") {
  return { staffAccountId: `${role}-staff`, displayName: role, roles: [role], capabilities: role === "accountant" ? ["payment.view"] : ["calendar.view", "calendar.manage"], sessionId: "test", sessionExpiresAt: "2030-01-01T00:00:00.000Z", sessionAbsoluteExpiresAt: "2030-01-01T00:00:00.000Z" };
}
function count(database, table, where = "1 = 1") { return Number(database.query(`SELECT COUNT(*) AS value FROM ${table} WHERE ${where}`)[0].value); }
function currentSlot(database, classId, lessonId) {
  return database.query(`SELECT slot.id, slot.local_date AS localDate, slot.start_time AS startTime
    FROM class_calendar_slot AS slot
    INNER JOIN class_calendar_revision AS revision ON revision.id = slot.class_calendar_revision_id AND revision.status = 'published'
    INNER JOIN class_calendar AS calendar ON calendar.id = revision.class_calendar_id
    WHERE calendar.class_session_id = ? AND slot.curriculum_lesson_id = ? AND slot.status = 'scheduled'`, [classId, lessonId])[0];
}

try {
  const page = readFileSync("src/pages/staff/day-changes.astro", "utf8");
  assert.match(page, /Цуцлаад орлуулах өдөр нэмэх/, "individual cancellation explains the replacement-slot model");
  assert.match(page, /name="replacementDate" type="date" \/>/, "an individual replacement date starts blank");
  assert.match(page, /Энэ өдрийн бүх хичээл/, "the whole-day action describes its scope");
  const migrations = readdirSync("migrations").filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
  sqlite(migrations.map((file) => readFileSync(path.join("migrations", file), "utf8")).join("\n"));
  const built = spawnSync(esbuild, ["src/server/staff/day-changes.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${bundlePath}`], { encoding: "utf8" });
  if (built.status !== 0) throw new Error(built.stderr);
  const service = await import(pathToFileURL(bundlePath).href);
  const database = new SqliteD1();
  const runtime = { APP_ENV: "staging", DB: database };
  const now = new Date().toISOString();
  const today = localToday();
  const firstDate = addDays(today, -7);
  const sourceDate = addDays(today, 7);
  const replacementDate = addDays(today, 10);
  const thirdDate = addDays(today, 14);
  const laterReplacement = addDays(today, 17);
  const confirmedAt = new Date(`${addDays(today, -30)}T00:00:00+08:00`).toISOString();
  const weekday = mongolianWeekday(today);
  const classes = ["class-a", "class-b", "class-c"];

  sqlite(`
    INSERT INTO staff_account (id, email_normalized, display_name, status, is_test, test_run_id, created_at, updated_at) VALUES
      ('teacher-staff', 'teacher@example.invalid', 'Тест Багш', 'active', 1, 'day-change-test', '${now}', '${now}'),
      ('accountant-staff', 'accountant@example.invalid', 'Тест Нягтлан', 'active', 1, 'day-change-test', '${now}', '${now}');
    INSERT INTO staff_account_email (id, staff_account_id, email, email_normalized, is_primary, created_at, updated_at) VALUES
      ('teacher-email', 'teacher-staff', 'teacher@example.invalid', 'teacher@example.invalid', 1, '${now}', '${now}'),
      ('accountant-email', 'accountant-staff', 'accountant@example.invalid', 'accountant@example.invalid', 1, '${now}', '${now}');
    INSERT INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_current, is_test, test_run_id, created_at, updated_at)
      VALUES ('year', 'Өдрийн өөрчлөлтийн тест', 'closed', '${addDays(today, -60)}', '${addDays(today, 120)}', 1, 1, 'day-change-test', '${now}', '${now}');
    INSERT INTO curriculum_program_family (id, kind, display_name, annual_stage_code, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('family', 'annual_course', '1-р шат', 'stage_1', 'active', 1, 'day-change-test', '${now}', '${now}');
    INSERT INTO curriculum_program (id, program_family_id, academic_year_id, stage_code, revision_number, display_name, program_kind, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('program', 'family', 'year', 'stage_1', 1, 'Өдрийн тест хөтөлбөр', 'annual_course', 'draft', 1, 'day-change-test', '${now}', '${now}');
    INSERT INTO curriculum_lesson (id, curriculum_program_id, sequence_number, title, status, is_test, test_run_id, created_at, updated_at) VALUES
      ('lesson-1', 'program', 1, 'Нэгдүгээр хичээл', 'active', 1, 'day-change-test', '${now}', '${now}'),
      ('lesson-2', 'program', 2, 'Хоёрдугаар хичээл', 'active', 1, 'day-change-test', '${now}', '${now}'),
      ('lesson-3', 'program', 3, 'Гуравдугаар хичээл', 'active', 1, 'day-change-test', '${now}', '${now}'),
      ('lesson-4', 'program', 4, 'Дөрөвдүгээр хичээл', 'active', 1, 'day-change-test', '${now}', '${now}');
    UPDATE curriculum_program SET status = 'published', published_at = '${now}' WHERE id = 'program';
    UPDATE curriculum_program_family SET current_published_program_id = 'program' WHERE id = 'family';
    INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, starts_on, curriculum_program_id, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('offering', 'annual_course', 'Өдрийн тест сургалт', 'year', 'stage_1', '${firstDate}', 'program', 1, 'paid', 'active', 1, 'day-change-test', '${now}', '${now}');
    INSERT INTO class_session (id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, activity_offering_id, is_test, test_run_id, created_at, updated_at) VALUES
      ('class-a', 'year', 'stage_1', 'А анги', '${weekday}', '10:00', '11:20', 10, 'available', 'offering', 1, 'day-change-test', '${now}', '${now}'),
      ('class-b', 'year', 'stage_1', 'Б анги', '${weekday}', '13:00', '14:20', 10, 'available', 'offering', 1, 'day-change-test', '${now}', '${now}'),
      ('class-c', 'year', 'stage_1', 'В анги', '${weekday}', '16:00', '17:20', 10, 'available', 'offering', 1, 'day-change-test', '${now}', '${now}'),
      ('makeup-source', 'year', 'stage_1', 'Нөхөх эх анги', '${weekday}', '08:00', '09:20', 10, 'available', 'offering', 1, 'day-change-test', '${now}', '${now}');
    INSERT INTO class_meeting_rule (class_session_id, recurrence_kind, first_date, weekly_weekday, start_time, end_time, created_at, updated_at) VALUES
      ('class-a', 'weekly', '${firstDate}', '${weekday}', '10:00', '11:20', '${now}', '${now}'),
      ('class-b', 'weekly', '${firstDate}', '${weekday}', '13:00', '14:20', '${now}', '${now}'),
      ('class-c', 'weekly', '${firstDate}', '${weekday}', '16:00', '17:20', '${now}', '${now}'),
      ('makeup-source', 'weekly', '${addDays(today, -28)}', '${weekday}', '08:00', '09:20', '${now}', '${now}');
    INSERT INTO class_calendar (id, class_session_id, timezone, status, is_test, test_run_id, created_at, updated_at) VALUES
      ('calendar-a', 'class-a', 'Asia/Ulaanbaatar', 'active', 1, 'day-change-test', '${now}', '${now}'),
      ('calendar-b', 'class-b', 'Asia/Ulaanbaatar', 'active', 1, 'day-change-test', '${now}', '${now}'),
      ('calendar-c', 'class-c', 'Asia/Ulaanbaatar', 'active', 1, 'day-change-test', '${now}', '${now}'),
      ('calendar-makeup', 'makeup-source', 'Asia/Ulaanbaatar', 'active', 1, 'day-change-test', '${now}', '${now}');
    INSERT INTO class_calendar_revision (id, class_calendar_id, curriculum_program_id, revision_number, status, first_candidate_date, locked_through_sequence, is_test, test_run_id, created_at, updated_at) VALUES
      ('revision-a', 'calendar-a', 'program', 1, 'draft', '${firstDate}', 0, 1, 'day-change-test', '${now}', '${now}'),
      ('revision-b', 'calendar-b', 'program', 1, 'draft', '${firstDate}', 0, 1, 'day-change-test', '${now}', '${now}'),
      ('revision-c', 'calendar-c', 'program', 1, 'draft', '${firstDate}', 0, 1, 'day-change-test', '${now}', '${now}'),
      ('revision-makeup', 'calendar-makeup', 'program', 1, 'draft', '${addDays(today, -28)}', 0, 1, 'day-change-test', '${now}', '${now}');
  `);
  for (const [letter, start, end] of [["a", "10:00", "11:20"], ["b", "13:00", "14:20"], ["c", "16:00", "17:20"]]) {
    sqlite(`INSERT INTO class_calendar_slot (id, class_calendar_revision_id, local_date, start_time, end_time, slot_source, status, curriculum_lesson_id, is_test, test_run_id, created_at, updated_at) VALUES
      ('slot-${letter}-1', 'revision-${letter}', '${firstDate}', '${start}', '${end}', 'generated', 'scheduled', 'lesson-1', 1, 'day-change-test', '${now}', '${now}'),
      ('slot-${letter}-2', 'revision-${letter}', '${today}', '${start}', '${end}', 'generated', 'scheduled', 'lesson-2', 1, 'day-change-test', '${now}', '${now}'),
      ('slot-${letter}-3', 'revision-${letter}', '${sourceDate}', '${start}', '${end}', 'generated', 'scheduled', 'lesson-3', 1, 'day-change-test', '${now}', '${now}'),
      ('slot-${letter}-4', 'revision-${letter}', '${thirdDate}', '${start}', '${end}', 'generated', 'scheduled', 'lesson-4', 1, 'day-change-test', '${now}', '${now}');
    UPDATE class_calendar_revision SET status = 'published', published_at = '${now}' WHERE id = 'revision-${letter}';`);
  }
  sqlite(`
    INSERT INTO class_calendar_slot (id, class_calendar_revision_id, local_date, start_time, end_time, slot_source, status, curriculum_lesson_id, is_test, test_run_id, created_at, updated_at) VALUES
      ('makeup-slot-1', 'revision-makeup', '${addDays(today, -28)}', '08:00', '09:20', 'generated', 'scheduled', 'lesson-1', 1, 'day-change-test', '${now}', '${now}'),
      ('makeup-slot-2', 'revision-makeup', '${addDays(today, -21)}', '08:00', '09:20', 'generated', 'scheduled', 'lesson-2', 1, 'day-change-test', '${now}', '${now}'),
      ('makeup-slot-3', 'revision-makeup', '${addDays(today, -14)}', '08:00', '09:20', 'generated', 'scheduled', 'lesson-3', 1, 'day-change-test', '${now}', '${now}'),
      ('makeup-slot-4', 'revision-makeup', '${addDays(today, -7)}', '08:00', '09:20', 'generated', 'scheduled', 'lesson-4', 1, 'day-change-test', '${now}', '${now}');
    UPDATE class_calendar_revision SET status = 'published', published_at = '${now}' WHERE id = 'revision-makeup';
    INSERT INTO guardian_account (id, full_name, primary_phone, primary_phone_normalized, email, email_normalized, home_address, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('guardian', 'Тест Асран', '99000000', '99000000', 'guardian@example.invalid', 'guardian@example.invalid', 'Тест', 'active', 1, 'day-change-test', '${now}', '${now}');
    INSERT INTO student (id, surname, given_name, gender, date_of_birth, status, is_test, test_run_id, created_at, updated_at) VALUES
      ('student-source', 'Тест', 'Нөхөх', 'not_specified', '2015-01-01', 'active', 1, 'day-change-test', '${now}', '${now}'),
      ('student-c', 'Тест', 'Ирц', 'not_specified', '2015-01-02', 'active', 1, 'day-change-test', '${now}', '${now}');
    INSERT INTO pre_registration (id, guardian_id, academic_year_id, status, is_test, test_run_id, created_at, updated_at) VALUES
      ('prereg-source', 'guardian', 'year', 'completed', 1, 'day-change-test', '${now}', '${now}'),
      ('prereg-c', 'guardian', 'year', 'completed', 1, 'day-change-test', '${now}', '${now}');
    INSERT INTO application_child (id, pre_registration_id, student_id, current_grade, returning_status, status, is_test, test_run_id, created_at, updated_at) VALUES
      ('application-source', 'prereg-source', 'student-source', 5, 'new', 'enrolled', 1, 'day-change-test', '${now}', '${now}'),
      ('application-c', 'prereg-c', 'student-c', 5, 'new', 'enrolled', 1, 'day-change-test', '${now}', '${now}');
    INSERT INTO enrollment (id, application_child_id, student_id, academic_year_id, class_session_id, status, confirmed_at, is_test, test_run_id, created_at, updated_at) VALUES
      ('enrollment-source', 'application-source', 'student-source', 'year', 'makeup-source', 'confirmed', '${confirmedAt}', 1, 'day-change-test', '${now}', '${now}'),
      ('enrollment-c', 'application-c', 'student-c', 'year', 'class-c', 'confirmed', '${confirmedAt}', 1, 'day-change-test', '${now}', '${now}');
    INSERT INTO course_attendance (id, enrollment_id, class_session_id, curriculum_lesson_id, attendance_status, recorded_calendar_slot_id, scheduled_local_date, first_recorded_at, updated_at, recorded_by_staff_account_id, updated_by_staff_account_id, is_test, test_run_id, created_at)
      VALUES ('attendance-c', 'enrollment-c', 'class-c', 'lesson-3', 'present', 'slot-c-3', '${sourceDate}', '${now}', '${now}', 'teacher-staff', 'teacher-staff', 1, 'day-change-test', '${now}');
    INSERT INTO course_makeup_resolution (id, source_enrollment_id, source_class_session_id, source_curriculum_lesson_id, decision, status, decided_by_staff_account_id, decided_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('makeup-resolution', 'enrollment-source', 'makeup-source', 'lesson-3', 'assigned', 'active', 'teacher-staff', '${now}', 1, 'day-change-test', '${now}', '${now}');
    INSERT INTO course_makeup_assignment (id, resolution_id, target_kind, target_class_session_id, target_curriculum_lesson_id, status, assigned_by_staff_account_id, assigned_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('makeup-assignment', 'makeup-resolution', 'normal_class', 'class-b', 'lesson-3', 'active', 'teacher-staff', '${now}', 1, 'day-change-test', '${now}', '${now}');
  `);

  await assert.rejects(() => service.getDailyChangesOverview(runtime, actor("accountant"), sourceDate), /Daily schedule/, "accountant cannot access daily changes");
  const initialOverview = await service.getDailyChangesOverview(runtime, actor(), sourceDate);
  assert.equal(initialOverview.occurrences.filter((entry) => entry.localDate === sourceDate && entry.status === "scheduled").length, 3);
  const initialRevisionCount = count(database, "class_calendar_revision");
  await assert.rejects(
    () => service.applyDailyChange(runtime, actor(), { kind: "day-cancel", sourceDate }),
    (caught) => caught instanceof service.DayChangeError
      && caught.code === "attendance_protected"
      && /В анги/.test(caught.blockingClassLabel),
    "one attendance-protected class blocks the entire day and identifies the blocker",
  );
  assert.equal(count(database, "class_calendar_revision"), initialRevisionCount, "blocked whole-day operation writes no revisions");
  assert.equal(count(database, "class_calendar_slot", `local_date = ${quote(sourceDate)} AND status = 'scheduled'`), 3, "blocked whole-day operation changes no class");

  sqlite(`UPDATE course_attendance SET attendance_status = NULL, updated_at = '${now}' WHERE id = 'attendance-c';`);
  const preview = await service.previewDailyChange(runtime, actor(), { kind: "day-move", sourceDate, replacementDate });
  assert.equal(preview.affectedClassCount, 3, "whole-day preview lists every affected class");
  await service.applyDailyChange(runtime, actor(), { kind: "day-move", sourceDate, replacementDate });
  assert.equal(count(database, "class_calendar_revision", "status = 'published'"), 4, "every class retains exactly one current revision including unrelated make-up source");
  assert.equal(count(database, "class_calendar_revision", "status = 'superseded'"), 3, "all three original day revisions remain historical");
  for (const classId of classes) assert.equal(currentSlot(database, classId, "lesson-3").localDate, replacementDate, `${classId} lesson 3 moved atomically`);
  assert.equal(currentSlot(database, "class-b", "lesson-3").localDate, replacementDate, "normal make-up target follows class + lesson to replacement date");
  assert.equal(count(database, "course_makeup_assignment", "id = 'makeup-assignment' AND status = 'active'"), 1, "day move neither duplicates nor loses make-up assignment");
  assert.equal(count(database, "course_attendance", "attendance_status IS NOT NULL"), 0, "calendar operation does not mutate attendance");

  const classAReplacementSlot = currentSlot(database, "class-a", "lesson-3");
  await service.applyDailyChange(runtime, actor(), { kind: "single-cancel", slotId: classAReplacementSlot.id });
  assert.equal(currentSlot(database, "class-a", "lesson-3").localDate, thirdDate, "single cancellation reflows the affected class only");
  assert.equal(currentSlot(database, "class-b", "lesson-3").localDate, replacementDate, "single cancellation leaves peers unchanged");
  const singleCurrent = database.query("SELECT revision.id FROM class_calendar_revision AS revision INNER JOIN class_calendar AS calendar ON calendar.id = revision.class_calendar_id WHERE calendar.class_session_id = 'class-a' AND revision.status = 'published'")[0];
  assert.equal(count(database, "class_calendar_slot", `class_calendar_revision_id = ${quote(singleCurrent.id)} AND local_date = ${quote(replacementDate)} AND status = 'cancelled'`), 1, "cancelled occurrence is retained in the new revision");

  const extraDate = addDays(sourceDate, 4);
  await service.applyDailyChange(runtime, actor(), { kind: "extra", classSessionId: "class-a", localDate: extraDate });
  assert.equal(currentSlot(database, "class-a", "lesson-3").localDate, extraDate, "extra day is ordered without submitting a lesson number");

  const dayCancelPreview = await service.previewDailyChange(runtime, actor(), { kind: "day-cancel", sourceDate: thirdDate });
  assert.equal(dayCancelPreview.affectedClassCount, 3);
  await service.applyDailyChange(runtime, actor(), { kind: "day-cancel", sourceDate: thirdDate });
  assert.equal(count(database, "class_calendar_slot", `local_date = ${quote(thirdDate)} AND status = 'cancelled' AND class_calendar_revision_id IN (SELECT revision.id FROM class_calendar_revision AS revision WHERE revision.status = 'published')`), 3, "whole-day cancellation writes every class together");
  await service.applyDailyChange(runtime, actor(), { kind: "day-replace", sourceDate: thirdDate, replacementDate: laterReplacement });
  for (const classId of classes) assert.ok(database.query(`SELECT 1 AS value FROM class_calendar_slot AS slot INNER JOIN class_calendar_revision AS revision ON revision.id = slot.class_calendar_revision_id INNER JOIN class_calendar AS calendar ON calendar.id = revision.class_calendar_id WHERE revision.status = 'published' AND calendar.class_session_id = ? AND slot.local_date = ? AND slot.status = 'scheduled'`, [classId, laterReplacement]).length, `${classId} receives the all-class replacement slot`);
  assert.equal(count(database, "audit_event", "action IN ('course_day_moved', 'course_occurrence_cancelled', 'course_extra_day_added', 'course_day_cancelled', 'course_day_replacement_added')"), 5, "daily operations create one coarse audit event each");

  const rendered = readFileSync("dist/staff/day-changes/index.html", "utf8");
  assert.match(page, /Өдрийг бүхэлд нь цуцлах/);
  assert.match(page, /Өдрийг шилжүүлэх/);
  assert.match(page, /Орлуулах өдөр оруулах/);
  assert.match(page, /Нэмэлт өдөр оруулах/);
  assert.match(page, /changedLessonCount/, "teacher sees consequence count before saving");
  assert.doesNotMatch(page, /и-мэйл|Messenger|мэдэгдэл илгээ/, "daily schedule changes send no communication");
  assert.doesNotMatch(rendered, /А анги|Хоёрдугаар хичээл/, "static daily page includes no private fixture data");

  console.log("ok atomic daily cancellation, move, replacement, extra slots, attendance protection, and make-up reflow following");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
