import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const directory = mkdtempSync(path.join(tmpdir(), "naranerdem-class-schedule-controls-"));
const databasePath = path.join(directory, "controls.sqlite3");
const bundlePath = path.join(directory, "program-calendar.mjs");

function quote(value) { return value == null ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`; }
function bind(sql, values) { let index = 0; const result = sql.replaceAll("?", () => quote(values[index++])); assert.equal(index, values.length); return result; }
function sqlite(sql, json = false) {
  const result = spawnSync("sqlite3", json ? ["-json", databasePath] : [databasePath], { input: `.bail on\nPRAGMA foreign_keys=ON;\n${sql}`, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${result.stderr}\n${sql}`);
  return result.stdout.trim();
}
class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.database.query(this.sql, this.values)[0] ?? null; }
  async all() { return { success: true, results: this.database.query(this.sql, this.values) }; }
}
class Database {
  prepare(sql) { return new Statement(this, sql); }
  query(sql, values = []) { const output = sqlite(`${bind(sql, values)};`, true); return output ? JSON.parse(output) : []; }
  async batch(statements) {
    const sql = statements.map((statement, index) => `${bind(statement.sql, statement.values)};\nINSERT INTO changes_for_test VALUES (${index}, changes());`).join("\n");
    const output = sqlite(`CREATE TEMP TABLE changes_for_test (index_value INTEGER, changes INTEGER); BEGIN IMMEDIATE; ${sql.replaceAll("changes_for_test VALUES", "changes_for_test (index_value, changes) VALUES")} COMMIT; SELECT index_value, changes FROM changes_for_test ORDER BY index_value;`, true);
    return (output ? JSON.parse(output) : []).map((row) => ({ success: true, results: [], meta: { changes: Number(row.changes) } }));
  }
}
function today() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ulaanbaatar", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function plusDays(date, days) { const [year, month, day] = date.split("-").map(Number); return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10); }

try {
  const migrations = readdirSync("migrations").filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
  assert.ok(migrations.includes("0063_class_schedule_controls.sql"));
  sqlite(migrations.map((file) => readFileSync(path.join("migrations", file), "utf8")).join("\n"));
  const built = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/staff/program-calendar.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${bundlePath}`], { encoding: "utf8" });
  if (built.status !== 0) throw new Error(built.stderr);
  const service = await import(pathToFileURL(bundlePath).href);
  const database = new Database();
  const runtime = { APP_ENV: "staging", DB: database };
  const actor = { staffAccountId: "staff", capabilities: ["calendar.manage"], roles: ["teacher"] };
  const now = "2026-09-21T00:00:00.000Z";
  const future = plusDays(today(), 7);

  sqlite(`
    INSERT INTO staff_account (id, email_normalized, display_name, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('staff', 'staff@example.invalid', 'Тест багш', 'active', 1, 'schedule-controls', '${now}', '${now}');
    INSERT INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_current, is_test, test_run_id, created_at, updated_at)
      VALUES ('year', 'Тест жил', 'closed', '${plusDays(today(), -30)}', '${plusDays(today(), 300)}', 1, 1, 'schedule-controls', '${now}', '${now}');
    INSERT INTO curriculum_program_family (id, kind, display_name, annual_stage_code, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('family', 'annual_course', 'Тест', 'stage_1', 'active', 1, 'schedule-controls', '${now}', '${now}');
    INSERT INTO curriculum_program (id, program_family_id, academic_year_id, stage_code, revision_number, display_name, program_kind, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('program', 'family', 'year', 'stage_1', 1, 'Тест хөтөлбөр', 'annual_course', 'draft', 1, 'schedule-controls', '${now}', '${now}');
    INSERT INTO curriculum_lesson (id, curriculum_program_id, sequence_number, title, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('lesson', 'program', 1, 'Тест хичээл', 'active', 1, 'schedule-controls', '${now}', '${now}');
    UPDATE curriculum_program SET status = 'published', published_at = '${now}' WHERE id = 'program';
    UPDATE curriculum_program_family SET current_published_program_id = 'program' WHERE id = 'family';
    INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, starts_on, curriculum_program_id, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('offering', 'annual_course', 'Тест сургалт', 'year', 'stage_1', '${future}', 'program', 1, 'paid', 'active', 1, 'schedule-controls', '${now}', '${now}');
    INSERT INTO class_session (id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, activity_offering_id, is_publicly_visible, is_test, test_run_id, created_at, updated_at) VALUES
      ('removable', 'year', 'stage_1', 'Хасах анги', 'Мягмар', '10:00', '11:20', 10, 'available', 'offering', 1, 1, 'schedule-controls', '${now}', '${now}'),
      ('blocked', 'year', 'stage_1', 'Хориглох анги', 'Лхагва', '14:00', '15:20', 10, 'available', 'offering', 1, 1, 'schedule-controls', '${now}', '${now}'),
      ('conflict', 'year', 'stage_1', 'Давхцах анги', 'Мягмар', '10:30', '11:50', 10, 'closed', 'offering', 0, 1, 'schedule-controls', '${now}', '${now}');
    INSERT INTO class_calendar (id, class_session_id, timezone, status, is_test, test_run_id, created_at, updated_at) VALUES
      ('removable-calendar', 'removable', 'Asia/Ulaanbaatar', 'active', 1, 'schedule-controls', '${now}', '${now}'),
      ('blocked-calendar', 'blocked', 'Asia/Ulaanbaatar', 'active', 1, 'schedule-controls', '${now}', '${now}'),
      ('conflict-calendar', 'conflict', 'Asia/Ulaanbaatar', 'active', 1, 'schedule-controls', '${now}', '${now}');
    INSERT INTO class_calendar_revision (id, class_calendar_id, curriculum_program_id, revision_number, status, first_candidate_date, locked_through_sequence, is_test, test_run_id, created_at, updated_at) VALUES
      ('removable-revision', 'removable-calendar', 'program', 1, 'draft', '${future}', 0, 1, 'schedule-controls', '${now}', '${now}'),
      ('blocked-revision', 'blocked-calendar', 'program', 1, 'draft', '${future}', 0, 1, 'schedule-controls', '${now}', '${now}'),
      ('conflict-revision', 'conflict-calendar', 'program', 1, 'draft', '${future}', 0, 1, 'schedule-controls', '${now}', '${now}');
    INSERT INTO class_calendar_slot (id, class_calendar_revision_id, local_date, start_time, end_time, slot_source, status, curriculum_lesson_id, is_test, test_run_id, created_at, updated_at) VALUES
      ('removable-slot', 'removable-revision', '${future}', '10:00', '11:20', 'generated', 'scheduled', 'lesson', 1, 'schedule-controls', '${now}', '${now}'),
      ('blocked-slot', 'blocked-revision', '${future}', '14:00', '15:20', 'generated', 'scheduled', 'lesson', 1, 'schedule-controls', '${now}', '${now}'),
      ('conflict-slot', 'conflict-revision', '${future}', '10:30', '11:50', 'generated', 'scheduled', 'lesson', 1, 'schedule-controls', '${now}', '${now}');
    UPDATE class_calendar_revision SET status = 'published', published_at = '${now}' WHERE id IN ('removable-revision', 'blocked-revision', 'conflict-revision');
  `);

  const removable = database.query("SELECT updated_at AS updatedAt FROM class_session WHERE id = 'removable'")[0];
  await assert.rejects(service.removeClassFromSchedule(runtime, actor, { classSessionId: "removable", expectedUpdatedAt: "stale" }),
    (error) => error?.code === "conflict", "a stale schedule-removal review cannot change the class");
  await service.removeClassFromSchedule(runtime, actor, { classSessionId: "removable", expectedUpdatedAt: removable.updatedAt });
  let state = database.query("SELECT schedule_state AS scheduleState, status, is_publicly_visible AS publicVisibility, updated_at AS updatedAt FROM class_session WHERE id = 'removable'")[0];
  assert.deepEqual([state.scheduleState, state.status, state.publicVisibility], ["removed", "closed", 0], "removal closes registration and hides public visibility without deleting schedule history");
  assert.equal(database.query("SELECT COUNT(*) AS count FROM course_attendance WHERE class_session_id = 'removable'")[0].count, 0, "removal creates no attendance or absence history for future slots");
  assert.throws(() => sqlite("INSERT INTO enrollment (id, application_child_id, student_id, academic_year_id, class_session_id, status, is_test, test_run_id, created_at, updated_at) VALUES ('blocked-write', 'missing', 'missing', 'year', 'removable', 'confirmed', 1, 'schedule-controls', '2026-09-21T00:00:00.000Z', '2026-09-21T00:00:00.000Z')"), /inactive class cannot accept enrollment/, "the database rejects a racing enrollment into a removed class");
  await assert.rejects(service.restoreClassToSchedule(runtime, actor, { classSessionId: "removable", expectedUpdatedAt: state.updatedAt }), /Program and calendar/, "restoration rejects an active-room conflict");
  sqlite("UPDATE class_session SET schedule_state = 'removed' WHERE id = 'conflict'");
  await service.restoreClassToSchedule(runtime, actor, { classSessionId: "removable", expectedUpdatedAt: state.updatedAt });
  state = database.query("SELECT schedule_state AS scheduleState, status, is_publicly_visible AS publicVisibility, updated_at AS updatedAt FROM class_session WHERE id = 'removable'")[0];
  assert.deepEqual([state.scheduleState, state.status, state.publicVisibility], ["active", "closed", 0], "restoration keeps registration closed and public visibility hidden");
  await service.removeClassFromSchedule(runtime, actor, { classSessionId: "removable", expectedUpdatedAt: state.updatedAt });
  state = database.query("SELECT updated_at AS updatedAt FROM class_session WHERE id = 'removable'")[0];
  await service.deleteClassSession(runtime, actor, { classSessionId: "removable", expectedUpdatedAt: state.updatedAt });
  assert.equal(database.query("SELECT COUNT(*) AS count FROM class_calendar WHERE class_session_id = 'removable'")[0].count, 0, "configuration-only calendar rows are removed with an unused inactive class");

  sqlite(`INSERT INTO guardian_account (id, full_name, primary_phone, primary_phone_normalized, email, email_normalized, home_address, status, is_test, test_run_id, created_at, updated_at) VALUES ('guardian', 'Тест', '99000000', '99000000', 'guardian@example.invalid', 'guardian@example.invalid', 'Тест', 'active', 1, 'schedule-controls', '${now}', '${now}');
    INSERT INTO student (id, surname, given_name, gender, date_of_birth, status, is_test, test_run_id, created_at, updated_at) VALUES ('student', 'Тест', 'Сурагч', 'not_specified', '2015-01-01', 'active', 1, 'schedule-controls', '${now}', '${now}');
    INSERT INTO pre_registration (id, guardian_id, academic_year_id, status, is_test, test_run_id, created_at, updated_at) VALUES ('pre', 'guardian', 'year', 'completed', 1, 'schedule-controls', '${now}', '${now}');
    INSERT INTO application_child (id, pre_registration_id, student_id, current_grade, returning_status, status, is_test, test_run_id, created_at, updated_at) VALUES ('app', 'pre', 'student', 5, 'new', 'enrolled', 1, 'schedule-controls', '${now}', '${now}');
    INSERT INTO enrollment (id, application_child_id, student_id, academic_year_id, class_session_id, status, confirmed_at, is_test, test_run_id, created_at, updated_at) VALUES ('enrollment', 'app', 'student', 'year', 'blocked', 'confirmed', '${now}', 1, 'schedule-controls', '${now}', '${now}');`);
  const blocked = database.query("SELECT updated_at AS updatedAt FROM class_session WHERE id = 'blocked'")[0];
  await assert.rejects(service.removeClassFromSchedule(runtime, actor, { classSessionId: "blocked", expectedUpdatedAt: blocked.updatedAt }), (error) => error?.code === "schedule_commitments" && error.blockers.includes("confirmed_enrollment"), "confirmed learners block removal without changing the class");
  await assert.rejects(service.deleteClassSession(runtime, actor, { classSessionId: "blocked", expectedUpdatedAt: blocked.updatedAt }),
    (error) => error?.code === "referenced", "a class with business history cannot be deleted even after a removal review");
  assert.equal(database.query("SELECT schedule_state AS value FROM class_session WHERE id = 'blocked'")[0].value, "active");
  console.log("ok class schedule removal, restore, durable guards, blockers, and configuration-only deletion");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
