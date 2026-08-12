import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const tempDir = mkdtempSync(path.join(tmpdir(), "naranerdem-staff-program-calendar-"));
const databasePath = path.join(tempDir, "staff-program-calendar.sqlite3");
const bundlePath = path.join(tempDir, "staff-program-calendar.mjs");
const routerBundlePath = path.join(tempDir, "router.mjs");

function quote(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function bindSql(sql, values) {
  let index = 0;
  const bound = sql.replaceAll("?", () => quote(values[index++]));
  assert.equal(index, values.length, "all test bindings are consumed");
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
  async run() { const rows = this.database.query(`${this.sql}; SELECT changes() AS changes`, this.values); return { success: true, results: [], meta: { changes: Number(rows.at(-1)?.changes ?? 0) } }; }
}

class SqliteD1 {
  prepare(sql) { return new Statement(this, sql); }
  query(sql, values = []) { const value = sqlite(`${bindSql(sql, values)};`, true); return value ? JSON.parse(value) : []; }
  async batch(statements) {
    const changes = statements.map((statement, index) => `${bindSql(statement.sql, statement.values)};\nINSERT INTO _batch_changes VALUES (${index}, changes());`).join("\n");
    const output = sqlite(`CREATE TEMP TABLE _batch_changes (idx INTEGER, changes INTEGER); BEGIN IMMEDIATE; ${changes} COMMIT; SELECT idx, changes FROM _batch_changes ORDER BY idx;`, true);
    return (output ? JSON.parse(output) : []).map((row) => ({ success: true, results: [], meta: { changes: Number(row.changes) } }));
  }
}

function count(database, table, where = "1 = 1") { return Number(database.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)[0].count); }
function actor(role) { return { staffAccountId: `${role}-staff`, displayName: role, roles: [role], capabilities: role === "accountant" ? ["payment.view"] : ["program.view", "program.manage", "calendar.view", "calendar.manage"], sessionId: "test", sessionExpiresAt: "2030-01-01T00:00:00.000Z", sessionAbsoluteExpiresAt: "2030-01-01T00:00:00.000Z" }; }
function env(database) { return { APP_ENV: "staging", REGISTRATION_WRITE_ENABLED: "true", APP_ORIGIN: "https://staging.example.test", EMAIL_ENABLED: "true", AUTH_EMAIL_ENABLED: "true", STAFF_AUTH_EMAIL_ENABLED: "true", EMAIL_FROM: "test@example.invalid", DB: database }; }

try {
  const migrations = readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort();
  sqlite(migrations.map((file) => readFileSync(path.join("migrations", file), "utf8")).join("\n"));
  const bundled = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/staff/program-calendar.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${bundlePath}`], { encoding: "utf8" });
  if (bundled.status !== 0) throw new Error(bundled.stderr);
  const routerBundled = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/api/router.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${routerBundlePath}`], { encoding: "utf8" });
  if (routerBundled.status !== 0) throw new Error(routerBundled.stderr);
  const service = await import(pathToFileURL(bundlePath).href);
  const { handleApiRequest } = await import(pathToFileURL(routerBundlePath).href);
  const database = new SqliteD1(); const runtime = env(database); const now = "2026-08-12T01:00:00.000Z";
  sqlite(`
    INSERT INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_current, is_test, test_run_id, created_at, updated_at)
      VALUES ('year-2026', '2026–2027', 'draft', '2026-09-01', '2027-06-01', 1, 1, 'staff-program-test', '${now}', '${now}');
    INSERT INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_current, is_test, test_run_id, created_at, updated_at)
      VALUES ('year-2025', '2025–2026', 'archived', '2025-09-01', '2026-06-01', 0, 1, 'staff-program-test', '${now}', '${now}');
    INSERT INTO curriculum_program (id, academic_year_id, stage_code, revision_number, display_name, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('old-program', 'year-2025', 'stage_1', 1, 'Өмнөх хөтөлбөр', 'draft', 1, 'staff-program-test', '${now}', '${now}');
    INSERT INTO curriculum_lesson (id, curriculum_program_id, sequence_number, title, status, is_test, test_run_id, created_at, updated_at) VALUES
      ('old-lesson-1', 'old-program', 1, 'Туршилт 1', 'active', 1, 'staff-program-test', '${now}', '${now}'),
      ('old-lesson-2', 'old-program', 2, 'Туршилт 2', 'active', 1, 'staff-program-test', '${now}', '${now}'),
      ('old-lesson-3', 'old-program', 3, 'Туршилт 3', 'active', 1, 'staff-program-test', '${now}', '${now}');
    UPDATE curriculum_program SET status = 'published' WHERE id = 'old-program';
    INSERT INTO class_session (id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('class-1', 'year-2026', 'stage_1', 'Бямба өглөө', 'Бямба', '10:00', '11:20', 12, 'available', 1, 'staff-program-test', '${now}', '${now}');
  `);

  const unauthenticated = await handleApiRequest(new Request("https://staging.example.test/api/staff/program-calendar"), runtime);
  assert.equal(unauthenticated.status, 401, "unauthenticated callers cannot read staff setup data");

  const programsPage = readFileSync("src/pages/staff/programs.astro", "utf8");
  const holidaysPage = readFileSync("src/pages/staff/holidays.astro", "utf8");
  const schedulePage = readFileSync("src/pages/staff/schedule.astro", "utf8");
  const settingsPage = readFileSync("src/pages/staff/settings/index.astro", "utf8");
  const legacyPage = readFileSync("src/pages/staff/program-calendar.astro", "utf8");
  assert.match(programsPage, /Хөтөлбөр нийтлэх/, "program tool uses the ordinary publish action");
  assert.match(holidaysPage, /Амралтын хугацаа нэмэх/, "holiday tool is a separate focused screen");
  assert.match(schedulePage, /Анги нэмэх/);
  assert.match(schedulePage, /Хуваарь нийтлэх/);
  assert.doesNotMatch(schedulePage, /Ангийн нэр|Facebook бүлгийн холбоос|value="draft"|value="cancelled"/, "ordinary class editing hides legacy technical fields and states");
  assert.match(settingsPage, /Шат бүрт нэг холбоос хадгална/, "Facebook configuration is stage scoped");
  assert.match(legacyPage, /url=\/staff\/schedule\//, "old bookmark redirects to the schedule tool");

  await assert.rejects(() => service.copyPreviousProgram(runtime, actor("accountant"), { academicYearId: "year-2026", stageCode: "stage_1" }), /Program and calendar/);
  await assert.rejects(() => service.saveAcademicYearStageSetting(runtime, actor("accountant"), { academicYearId: "year-2026", stageCode: "stage_1", facebookGroupUrl: "https://facebook.com/groups/one" }), /Program and calendar/);
  await service.saveAcademicYearStageSetting(runtime, actor("teacher"), { academicYearId: "year-2026", stageCode: "stage_1", facebookGroupUrl: "https://facebook.com/groups/stage-one" });
  await service.saveAcademicYearStageSetting(runtime, actor("teacher"), { academicYearId: "year-2026", stageCode: "stage_2", facebookGroupUrl: "https://facebook.com/groups/stage-two" });
  await service.saveAcademicYearStageSetting(runtime, actor("teacher"), { academicYearId: "year-2025", stageCode: "stage_1", facebookGroupUrl: "https://facebook.com/groups/stage-one-previous" });
  await assert.rejects(() => service.saveAcademicYearStageSetting(runtime, actor("teacher"), { academicYearId: "year-2026", stageCode: "stage_3", facebookGroupUrl: "javascript:alert(1)" }), /Program and calendar/);
  assert.equal(count(database, "academic_year_stage_setting", "academic_year_id = 'year-2026'"), 2, "each current-year stage has one independent setting");
  assert.equal(database.query("SELECT facebook_group_url AS url FROM academic_year_stage_setting WHERE academic_year_id = 'year-2025' AND stage_code = 'stage_1'")[0].url, "https://facebook.com/groups/stage-one-previous", "historical annual stage setting remains separate");

  await service.createProgramDraft(runtime, actor("teacher"), { academicYearId: "year-2026", stageCode: "stage_3", displayName: "" });
  assert.equal(database.query("SELECT display_name AS displayName FROM curriculum_program WHERE academic_year_id = 'year-2026' AND stage_code = 'stage_3' AND status = 'draft'")[0].displayName, "3-р шатны хөтөлбөр", "a new teacher draft receives a normal editable default name");
  await service.saveClassSession(runtime, actor("teacher"), { academicYearId: "year-2026", stageCode: "stage_1", weekday: "Мягмар", startTime: "16:00", endTime: "17:20", capacity: 8, registrationOpen: true });
  const newClass = database.query("SELECT id, display_label AS displayLabel, status, updated_at AS updatedAt FROM class_session WHERE weekday = 'Мягмар' AND start_time = '16:00'")[0];
  assert.equal(newClass.displayLabel, "1-р шат · Мягмар 16:00", "class labels are generated from normal teaching details");
  assert.equal(newClass.status, "closed", "a new class starts with registration safely closed");
  await service.saveClassSession(runtime, actor("teacher"), { id: newClass.id, expectedUpdatedAt: newClass.updatedAt, academicYearId: "year-2026", stageCode: "stage_1", weekday: "Мягмар", startTime: "16:00", endTime: "17:20", capacity: 8, registrationOpen: true });
  assert.equal(database.query(`SELECT status FROM class_session WHERE id = ${quote(newClass.id)}`)[0].status, "available", "teacher-facing open registration maps to the available catalog state");
  const openedClass = database.query(`SELECT updated_at AS updatedAt FROM class_session WHERE id = ${quote(newClass.id)}`)[0];
  await service.deleteClassSession(runtime, actor("teacher"), { classSessionId: newClass.id, expectedUpdatedAt: openedClass.updatedAt });
  assert.equal(count(database, "class_session", `id = ${quote(newClass.id)}`), 0, "an unused class can be deleted");
  await service.createProgramDraft(runtime, actor("admin"), { academicYearId: "year-2026", stageCode: "stage_2", displayName: "Админы ноорог" });
  assert.equal(count(database, "curriculum_program", "academic_year_id = 'year-2026' AND stage_code = 'stage_2' AND status = 'draft'"), 1, "admin may create a program draft");
  await service.copyPreviousProgram(runtime, actor("teacher"), { academicYearId: "year-2026", stageCode: "stage_1" });
  const copied = database.query("SELECT id, updated_at AS updatedAt FROM curriculum_program WHERE academic_year_id = 'year-2026' AND status = 'draft'")[0];
  assert.equal(count(database, "curriculum_lesson", "curriculum_program_id = 'old-program'"), 3);
  assert.equal(count(database, "curriculum_lesson", `curriculum_program_id = ${quote(copied.id)}`), 3);
  assert.equal(count(database, "curriculum_lesson", `curriculum_program_id = ${quote(copied.id)} AND id LIKE 'old-%'`), 0, "copied program has new lesson identities");
  await service.saveProgramDraft(runtime, actor("teacher"), { programId: copied.id, expectedUpdatedAt: copied.updatedAt, displayName: "2026 оны хөтөлбөр", lessons: [{ title: "Нэгдүгээр хичээл" }, { title: "Хоёрдугаар хичээл" }, { title: "Гуравдугаар хичээл" }] });
  await assert.rejects(() => service.saveProgramDraft(runtime, actor("teacher"), { programId: copied.id, expectedUpdatedAt: copied.updatedAt, displayName: "Хуучин хүсэлт", lessons: [{ title: "X" }] }), /Program and calendar/);
  const saved = database.query(`SELECT updated_at AS updatedAt FROM curriculum_program WHERE id = ${quote(copied.id)}`)[0];
  await service.publishProgramDraft(runtime, actor("teacher"), { programId: copied.id, expectedUpdatedAt: saved.updatedAt });
  assert.equal(count(database, "curriculum_program", `id = ${quote(copied.id)} AND status = 'published'`), 1);
  await service.generateCalendarDraft(runtime, actor("teacher"), { classSessionId: "class-1", programId: copied.id, firstCandidateDate: "2026-09-05" });
  let draft = database.query("SELECT id, updated_at AS updatedAt FROM class_calendar_revision WHERE status = 'draft'")[0];
  assert.equal(count(database, "class_calendar_slot", `class_calendar_revision_id = ${quote(draft.id)} AND status = 'scheduled'`), 3);
  await assert.rejects(() => service.deleteClassSession(runtime, actor("teacher"), { classSessionId: "class-1", expectedUpdatedAt: now }), /Program and calendar/, "a referenced class cannot be deleted");
  await service.changeCalendarDraft(runtime, actor("teacher"), { revisionId: draft.id, expectedUpdatedAt: draft.updatedAt, kind: "exclude", localDate: "2026-09-12", reasonLabel: "Тест" });
  draft = database.query(`SELECT id, updated_at AS updatedAt FROM class_calendar_revision WHERE id = ${quote(draft.id)}`)[0];
  await service.publishCalendarDraft(runtime, actor("teacher"), { revisionId: draft.id, expectedUpdatedAt: draft.updatedAt });
  assert.equal(count(database, "class_calendar_revision", "status = 'published'"), 1);
  await service.createCalendarChangeDraft(runtime, actor("teacher"), { classSessionId: "class-1" });
  draft = database.query("SELECT id, updated_at AS updatedAt FROM class_calendar_revision WHERE status = 'draft'")[0];
  await service.setCalendarDeliveredPrefix(runtime, actor("teacher"), { revisionId: draft.id, expectedUpdatedAt: draft.updatedAt, lockedThroughSequence: 1 });
  draft = database.query(`SELECT id, updated_at AS updatedAt FROM class_calendar_revision WHERE id = ${quote(draft.id)}`)[0];
  const futureSlot = database.query(`SELECT slot.id FROM class_calendar_slot AS slot INNER JOIN curriculum_lesson AS lesson ON lesson.id = slot.curriculum_lesson_id WHERE slot.class_calendar_revision_id = ${quote(draft.id)} AND lesson.sequence_number = 2`)[0];
  await service.cancelFutureCalendarSlot(runtime, actor("teacher"), { revisionId: draft.id, expectedUpdatedAt: draft.updatedAt, slotId: futureSlot.id });
  assert.equal(count(database, "class_calendar_slot", `class_calendar_revision_id = ${quote(draft.id)} AND status = 'cancelled'`), 1, "future cancellation remains visible history");
  assert.ok(count(database, "audit_event", "action LIKE 'program_%' OR action LIKE 'calendar_%'") >= 7, "meaningful staff actions are audited");
  const overview = await service.getProgramCalendarOverview(runtime);
  assert.equal(overview.classes.find((entry) => entry.id === "class-1").displayLabel, "1-р шат · Бямба 10:00", "teacher overview ignores a legacy manual class label");
  assert.equal(overview.classes.find((entry) => entry.id === "class-1").canDelete, false, "reference checks keep linked classes out of the delete path");
  assert.equal(overview.stageSettings.filter((entry) => entry.academicYearId === "year-2026" && entry.stageCode === "stage_1").length, 1, "stage settings remain one-per-year-and-stage");
  console.log("ok staff program/calendar permissions, stage settings, class safety, revisions, draft generation, reflow, concurrency, and audit tests");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
