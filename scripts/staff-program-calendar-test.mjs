import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const tempDir = mkdtempSync(path.join(tmpdir(), "naranerdem-staff-program-calendar-"));
const databasePath = path.join(tempDir, "staff-program-calendar.sqlite3");
const bundlePath = path.join(tempDir, "staff-program-calendar.mjs");
const offeringBundlePath = path.join(tempDir, "staff-offerings.mjs");
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
function ulaanbaatarToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ulaanbaatar", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function addCivilDays(value, days) {
  const [year, month, day] = value.split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return `${result.getUTCFullYear()}-${String(result.getUTCMonth() + 1).padStart(2, "0")}-${String(result.getUTCDate()).padStart(2, "0")}`;
}
function civilWeekday(value) {
  const [year, month, day] = value.split("-").map(Number);
  return ["Ням", "Даваа", "Мягмар", "Лхагва", "Пүрэв", "Баасан", "Бямба"][new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

try {
  const migrations = readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort();
  const offeringMigration = "0010_activity_offerings_and_meeting_rules.sql";
  const offeringMigrationIndex = migrations.indexOf(offeringMigration);
  assert.ok(offeringMigrationIndex > 0, "migration 0010 is present");
  sqlite(migrations.slice(0, offeringMigrationIndex).map((file) => readFileSync(path.join("migrations", file), "utf8")).join("\n"));
  sqlite(`
    INSERT INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_current, is_test, test_run_id, created_at, updated_at)
      VALUES ('backfill-year', 'Буцаан нөхөх тест', 'draft', '2024-09-01', '2025-06-01', 0, 1, 'staff-program-test', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
    INSERT INTO curriculum_program (id, academic_year_id, stage_code, revision_number, display_name, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('backfill-program', 'backfill-year', 'stage_1', 1, 'Буцаан нөхөх хөтөлбөр', 'draft', 1, 'staff-program-test', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
    INSERT INTO curriculum_lesson (id, curriculum_program_id, sequence_number, title, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('backfill-lesson', 'backfill-program', 1, 'Буцаан нөхөх хичээл', 'active', 1, 'staff-program-test', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
    UPDATE curriculum_program SET status = 'published' WHERE id = 'backfill-program';
    INSERT INTO academic_year_stage_setting (id, academic_year_id, stage_code, facebook_group_url, is_test, test_run_id, created_at, updated_at)
      VALUES ('backfill-setting', 'backfill-year', 'stage_1', 'https://facebook.com/groups/backfill', 1, 'staff-program-test', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
    INSERT INTO class_session (id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('backfill-class', 'backfill-year', 'stage_1', 'Хуучин анги', 'Бямба', '10:00', '11:20', 10, 'closed', 1, 'staff-program-test', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
    INSERT INTO class_calendar (id, class_session_id, timezone, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('backfill-calendar', 'backfill-class', 'Asia/Ulaanbaatar', 'active', 1, 'staff-program-test', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
    INSERT INTO class_calendar_revision (id, class_calendar_id, curriculum_program_id, revision_number, status, first_candidate_date, locked_through_sequence, is_test, test_run_id, created_at, updated_at)
      VALUES ('backfill-calendar-revision', 'backfill-calendar', 'backfill-program', 1, 'draft', '2024-09-07', 0, 1, 'staff-program-test', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
    INSERT INTO class_calendar_slot (id, class_calendar_revision_id, local_date, start_time, end_time, slot_source, status, curriculum_lesson_id, is_test, test_run_id, created_at, updated_at)
      VALUES ('backfill-calendar-slot', 'backfill-calendar-revision', '2024-09-07', '10:00', '11:20', 'generated', 'scheduled', 'backfill-lesson', 1, 'staff-program-test', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
    UPDATE class_calendar_revision SET status = 'published', published_at = '2024-01-01T00:00:00.000Z' WHERE id = 'backfill-calendar-revision';
    INSERT INTO curriculum_program (id, academic_year_id, stage_code, revision_number, display_name, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('backfill-current-program', 'backfill-year', 'stage_1', 2, 'Шинэ одоогийн хөтөлбөр', 'draft', 1, 'staff-program-test', '2024-02-01T00:00:00.000Z', '2024-02-01T00:00:00.000Z');
    INSERT INTO curriculum_lesson (id, curriculum_program_id, sequence_number, title, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('backfill-current-lesson', 'backfill-current-program', 1, 'Шинэ одоогийн хичээл', 'active', 1, 'staff-program-test', '2024-02-01T00:00:00.000Z', '2024-02-01T00:00:00.000Z');
    UPDATE curriculum_program SET status = 'superseded' WHERE id = 'backfill-program';
    UPDATE curriculum_program SET status = 'published' WHERE id = 'backfill-current-program';
  `);
  for (const migration of migrations.slice(offeringMigrationIndex)) {
    sqlite(readFileSync(path.join("migrations", migration), "utf8"));
  }
  const bundled = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/staff/program-calendar.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${bundlePath}`], { encoding: "utf8" });
  if (bundled.status !== 0) throw new Error(bundled.stderr);
  const offeringBundled = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/staff/offerings.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${offeringBundlePath}`], { encoding: "utf8" });
  if (offeringBundled.status !== 0) throw new Error(offeringBundled.stderr);
  const routerBundled = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/api/router.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${routerBundlePath}`], { encoding: "utf8" });
  if (routerBundled.status !== 0) throw new Error(routerBundled.stderr);
  const service = await import(pathToFileURL(bundlePath).href);
  const offeringService = await import(pathToFileURL(offeringBundlePath).href);
  const { handleApiRequest } = await import(pathToFileURL(routerBundlePath).href);
  const database = new SqliteD1(); const runtime = env(database); const now = "2026-08-12T01:00:00.000Z";
  const historyLesson13Date = addCivilDays(ulaanbaatarToday(), 1);
  const historyFirstDate = addCivilDays(historyLesson13Date, -84);
  const historyPeriodEnd = addCivilDays(historyFirstDate, 365);
  const historyWeekday = civilWeekday(historyLesson13Date);
  const migratedOffering = database.query("SELECT curriculum_program_id AS programId, facebook_group_url AS facebookGroupUrl FROM activity_offering WHERE id = 'annual-offering-backfill-year-stage_1'")[0];
  assert.equal(migratedOffering.programId, "backfill-current-program", "migration 0010 carries forward the current published annual program");
  assert.equal(migratedOffering.facebookGroupUrl, "https://facebook.com/groups/backfill", "migration 0010 copies the legacy annual Facebook URL");
  assert.equal(database.query("SELECT activity_offering_id AS offeringId FROM class_session WHERE id = 'backfill-class'")[0].offeringId, "annual-offering-backfill-year-stage_1", "migration 0010 preserves and attaches the existing ClassSession ID");
  assert.equal(count(database, "class_meeting_rule", "class_session_id = 'backfill-class' AND recurrence_kind = 'weekly'"), 1, "migration 0010 backfills one weekly meeting rule");
  await service.createCalendarChangeDraft(runtime, actor("teacher"), { classSessionId: "backfill-class" });
  const backfillChangeDraft = database.query("SELECT id, curriculum_program_id AS programId, based_on_revision_id AS basedOnRevisionId, updated_at AS updatedAt FROM class_calendar_revision WHERE class_calendar_id = 'backfill-calendar' AND status = 'draft'")[0];
  assert.equal(backfillChangeDraft.programId, "backfill-program", "a migrated change draft continues its exact historical program");
  assert.equal(backfillChangeDraft.basedOnRevisionId, "backfill-calendar-revision", "legacy continuity is limited to a direct published base revision");
  await service.publishCalendarDraft(runtime, actor("teacher"), { revisionId: backfillChangeDraft.id, expectedUpdatedAt: backfillChangeDraft.updatedAt });
  assert.equal(database.query("SELECT curriculum_program_id AS programId FROM class_calendar_revision WHERE id = " + quote(backfillChangeDraft.id))[0].programId, "backfill-program", "a historical-program change revision can be republished without replacing the Offering program");
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
    INSERT INTO curriculum_program (id, academic_year_id, stage_code, revision_number, display_name, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('current-program', 'year-2026', 'stage_1', 1, 'Одоогийн хөтөлбөр', 'draft', 1, 'staff-program-test', '${now}', '${now}');
    INSERT INTO curriculum_lesson (id, curriculum_program_id, sequence_number, title, status, is_test, test_run_id, created_at, updated_at) VALUES
      ('current-lesson-1', 'current-program', 1, 'Одоогийн туршилт 1', 'active', 1, 'staff-program-test', '${now}', '${now}'),
      ('current-lesson-2', 'current-program', 2, 'Одоогийн туршилт 2', 'active', 1, 'staff-program-test', '${now}', '${now}'),
      ('current-lesson-3', 'current-program', 3, 'Одоогийн туршилт 3', 'active', 1, 'staff-program-test', '${now}', '${now}');
    UPDATE curriculum_program SET status = 'published' WHERE id = 'current-program';
    INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, starts_on, ends_on, curriculum_program_id, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('offering-annual-stage-1', 'annual_course', '2026–2027 · 1-р шат', 'year-2026', 'stage_1', '2026-09-01', '2027-06-01', 'current-program', 1, 'paid', 'active', 1, 'staff-program-test', '${now}', '${now}');
    INSERT INTO class_session (id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, is_test, test_run_id, created_at, updated_at, activity_offering_id)
      VALUES ('class-1', 'year-2026', 'stage_1', 'Бямба өглөө', 'Бямба', '10:00', '11:20', 12, 'available', 1, 'staff-program-test', '${now}', '${now}', 'offering-annual-stage-1');
    INSERT INTO class_meeting_rule (class_session_id, recurrence_kind, first_date, last_date, weekly_weekday, start_time, end_time, created_at, updated_at)
      VALUES ('class-1', 'weekly', '2026-09-05', NULL, 'Бямба', '10:00', '11:20', '${now}', '${now}');
    INSERT INTO academic_year_stage_setting (id, academic_year_id, stage_code, facebook_group_url, is_test, test_run_id, created_at, updated_at) VALUES
      ('legacy-setting-1', 'year-2026', 'stage_1', 'https://facebook.com/groups/legacy-stage-one', 1, 'staff-program-test', '${now}', '${now}'),
      ('legacy-setting-2', 'year-2026', 'stage_2', 'https://facebook.com/groups/legacy-stage-two', 1, 'staff-program-test', '${now}', '${now}'),
      ('legacy-setting-old', 'year-2025', 'stage_1', 'https://facebook.com/groups/legacy-previous', 1, 'staff-program-test', '${now}', '${now}');
  `);

  const unauthenticated = await handleApiRequest(new Request("https://staging.example.test/api/staff/program-calendar"), runtime);
  assert.equal(unauthenticated.status, 401, "unauthenticated callers cannot read staff setup data");

    const programsPage = readFileSync("src/pages/staff/programs.astro", "utf8");
    const offeringsPage = readFileSync("src/pages/staff/offerings.astro", "utf8");
  const holidaysPage = readFileSync("src/pages/staff/holidays.astro", "utf8");
  const schedulePage = readFileSync("src/pages/staff/schedule.astro", "utf8");
  const settingsPage = readFileSync("src/pages/staff/settings/index.astro", "utf8");
  const legacyPage = readFileSync("src/pages/staff/program-calendar.astro", "utf8");
  const routerSource = readFileSync("src/server/api/router.ts", "utf8");
  assert.match(programsPage, /Хөтөлбөр нийтлэх/, "program tool uses the ordinary publish action");
  assert.match(offeringsPage, /Жилийн сургалт/);
  assert.match(offeringsPage, /Зуны сургалт/);
  assert.match(offeringsPage, /Арга хэмжээ/);
  assert.match(offeringsPage, /Үнэгүй/);
  assert.match(holidaysPage, /Амралтын хугацаа нэмэх/, "holiday tool is a separate focused screen");
  assert.match(schedulePage, /Анги нэмэх/);
  assert.match(schedulePage, /Хуваарь нийтлэх/);
  assert.doesNotMatch(schedulePage, /Ангийн нэр|Facebook бүлгийн холбоос|value="draft"|value="cancelled"|calendar-program|calendar-lock|Дууссан хичээл|баталж байна/, "ordinary schedule editing hides legacy program, lock, and technical fields");
  assert.match(schedulePage, /staff-danger-zone/, "unused class deletion lives inside class details");
  assert.match(settingsPage, /Сургалт бүрийн Facebook бүлэг/, "Facebook configuration is offering scoped");
  assert.match(legacyPage, /url=\/staff\/schedule\//, "old bookmark redirects to the schedule tool");
  assert.match(routerSource, /"programId" in payload \|\| "firstCandidateDate" in payload/, "calendar generation rejects caller-selected program and start-date substitutions");
  assert.doesNotMatch(routerSource, /stage-setting\.save/, "legacy stage settings have no competing mutation endpoint");

  await assert.rejects(() => service.copyPreviousProgram(runtime, actor("accountant"), { academicYearId: "year-2026", stageCode: "stage_1" }), /Program and calendar/);
  const annualOfferingBeforeFacebook = database.query("SELECT updated_at AS updatedAt FROM activity_offering WHERE id = 'offering-annual-stage-1'")[0];
  await assert.rejects(() => offeringService.saveOfferingFacebookGroup(runtime, actor("accountant"), { offeringId: "offering-annual-stage-1", expectedUpdatedAt: annualOfferingBeforeFacebook.updatedAt, facebookGroupUrl: "https://facebook.com/groups/one" }), /Offering operation/);
  await offeringService.saveOfferingFacebookGroup(runtime, actor("teacher"), { offeringId: "offering-annual-stage-1", expectedUpdatedAt: annualOfferingBeforeFacebook.updatedAt, facebookGroupUrl: "https://facebook.com/groups/current-offering" });
  assert.equal(database.query("SELECT facebook_group_url AS url FROM activity_offering WHERE id = 'offering-annual-stage-1'")[0].url, "https://facebook.com/groups/current-offering", "the Offering owns the current Facebook group");
  assert.equal(database.query("SELECT facebook_group_url AS url FROM academic_year_stage_setting WHERE id = 'legacy-setting-1'")[0].url, "https://facebook.com/groups/legacy-stage-one", "the legacy 0009 row remains history rather than a second write target");
  assert.equal(count(database, "academic_year_stage_setting", "academic_year_id = 'year-2026'"), 2, "legacy stage settings remain intact for compatibility");

  await assert.rejects(() => offeringService.saveActivityOffering(runtime, actor("accountant"), { kind: "event", title: "Тест", eventDate: "2027-06-20", eventStartTime: "20:00", eventEndTime: "22:00", eventCapacity: 10 }), /Offering operation/);
  await offeringService.saveActivityOffering(runtime, actor("teacher"), { kind: "event", title: "Туршилтын од ажиглалт", eventDate: "2027-06-20", eventStartTime: "20:00", eventEndTime: "22:30", eventCapacity: 12 });
  const eventOffering = database.query("SELECT id, charge_mode AS chargeMode, curriculum_program_id AS programId, updated_at AS updatedAt FROM activity_offering WHERE title = 'Туршилтын од ажиглалт'")[0];
  const eventOccurrence = database.query(`SELECT updated_at AS updatedAt, registration_status AS registrationStatus FROM offering_event_occurrence WHERE activity_offering_id = ${quote(eventOffering.id)}`)[0];
  assert.equal(eventOffering.chargeMode, "free", "event charge defaults to free");
  assert.equal(eventOffering.programId, null, "an event does not need a curriculum program");
  assert.equal(eventOccurrence.registrationStatus, "closed", "new event registration starts closed");
  await offeringService.saveActivityOffering(runtime, actor("teacher"), { id: eventOffering.id, expectedUpdatedAt: eventOffering.updatedAt, eventExpectedUpdatedAt: eventOccurrence.updatedAt, kind: "event", title: "Туршилтын од ажиглалт", eventDate: "2027-06-20", eventStartTime: "20:00", eventEndTime: "22:30", eventCapacity: 12, chargeMode: "paid", eventRegistrationOpen: false });
  assert.equal(database.query(`SELECT charge_mode AS chargeMode FROM activity_offering WHERE id = ${quote(eventOffering.id)}`)[0].chargeMode, "paid", "a closed event may be made paid without creating a payment obligation");
  const deletableEvent = database.query(`SELECT updated_at AS updatedAt FROM activity_offering WHERE id = ${quote(eventOffering.id)}`)[0];
  await offeringService.deleteUnusedEventOffering(runtime, actor("teacher"), { offeringId: eventOffering.id, expectedUpdatedAt: deletableEvent.updatedAt });
  assert.equal(count(database, "activity_offering", `id = ${quote(eventOffering.id)}`), 0, "an unused closed event can be deleted safely");
  await offeringService.saveActivityOffering(runtime, actor("teacher"), { kind: "event", title: "Хаалттай биш тест", eventDate: "2027-06-21", eventStartTime: "20:00", eventEndTime: "21:00", eventCapacity: 12 });
  const protectedEvent = database.query("SELECT id, updated_at AS updatedAt FROM activity_offering WHERE title = 'Хаалттай биш тест'")[0];
  const protectedOccurrence = database.query(`SELECT updated_at AS updatedAt FROM offering_event_occurrence WHERE activity_offering_id = ${quote(protectedEvent.id)}`)[0];
  await offeringService.saveActivityOffering(runtime, actor("teacher"), { id: protectedEvent.id, expectedUpdatedAt: protectedEvent.updatedAt, eventExpectedUpdatedAt: protectedOccurrence.updatedAt, kind: "event", title: "Хаалттай биш тест", eventDate: "2027-06-21", eventStartTime: "20:00", eventEndTime: "21:00", eventCapacity: 12, eventRegistrationOpen: true });
  const openEvent = database.query(`SELECT updated_at AS updatedAt FROM activity_offering WHERE id = ${quote(protectedEvent.id)}`)[0];
  await assert.rejects(() => offeringService.deleteUnusedEventOffering(runtime, actor("teacher"), { offeringId: protectedEvent.id, expectedUpdatedAt: openEvent.updatedAt }), /Offering operation/, "an event with an open durable operational state cannot be deleted");

  await assert.rejects(() => offeringService.saveActivityOffering(runtime, actor("teacher"), { kind: "annual_course", curriculumProgramId: "old-program", startsOn: "2025-09-01", endsOn: "2026-06-01", chargeMode: "free" }), /Offering operation/, "annual offerings reject a manual free charge mode");
  await offeringService.saveActivityOffering(runtime, actor("teacher"), { kind: "annual_course", startsOn: "2025-09-01", endsOn: "2026-06-01", curriculumProgramId: "old-program" });
  const annualDefault = database.query("SELECT charge_mode AS chargeMode, use_academic_year_breaks AS useBreaks FROM activity_offering WHERE academic_year_id = 'year-2025' AND stage_code = 'stage_1'")[0];
  assert.equal(annualDefault.chargeMode, "paid", "annual course charge defaults to paid");
  assert.equal(annualDefault.useBreaks, 1, "annual courses apply academic-year breaks by default");

  await assert.rejects(() => offeringService.saveActivityOffering(runtime, actor("teacher"), { kind: "summer_course", title: "Туршилтын зуны сургалт", startsOn: "2027-06-01", endsOn: "2027-06-26" }), /Offering operation/, "summer offerings require an existing published program");
  await service.createSummerProgramDraft(runtime, actor("teacher"), { displayName: "Туршилтын зуны хөтөлбөр" });
  const summerDraft = database.query("SELECT id, updated_at AS updatedAt FROM curriculum_program WHERE program_kind = 'summer_course' AND status = 'draft'")[0];
  const summerLessons = Array.from({ length: 14 }, (_, index) => ({ title: `Туршилтын хичээл ${String(index + 1).padStart(2, "0")}` }));
  await service.saveProgramDraft(runtime, actor("teacher"), { programId: summerDraft.id, expectedUpdatedAt: summerDraft.updatedAt, displayName: "Туршилтын зуны хөтөлбөр", lessons: summerLessons });
  const savedSummerDraft = database.query(`SELECT updated_at AS updatedAt FROM curriculum_program WHERE id = ${quote(summerDraft.id)}`)[0];
  await service.publishProgramDraft(runtime, actor("teacher"), { programId: summerDraft.id, expectedUpdatedAt: savedSummerDraft.updatedAt });
  await assert.rejects(() => offeringService.saveActivityOffering(runtime, actor("teacher"), { kind: "summer_course", title: "Туршилтын зуны сургалт", startsOn: "2027-06-01", endsOn: "2027-06-14", curriculumProgramId: summerDraft.id, chargeMode: "free" }), /Offering operation/, "summer offerings reject a manual free charge mode");
  await offeringService.saveActivityOffering(runtime, actor("teacher"), { kind: "summer_course", title: "Туршилтын зуны сургалт", startsOn: "2027-06-01", endsOn: "2027-06-14", curriculumProgramId: summerDraft.id, facebookGroupUrl: "https://facebook.com/groups/fake-summer" });
  const summerOffering = database.query("SELECT id, curriculum_program_id AS programId, academic_year_id AS academicYearId, charge_mode AS chargeMode, use_academic_year_breaks AS useBreaks FROM activity_offering WHERE title = 'Туршилтын зуны сургалт'")[0];
  assert.equal(summerOffering.chargeMode, "paid", "summer charge defaults to paid");
  assert.equal(summerOffering.useBreaks, 0, "summer does not inherit academic breaks by default");
  sqlite(`INSERT INTO academic_year_break (id, academic_year_id, label, starts_on, ends_on, excludes_habitual_slots, status, is_test, test_run_id, created_at, updated_at)
    VALUES ('summer-irrelevant-break', ${quote(summerOffering.academicYearId)}, 'Зуны үед үйлчлэхгүй', '2027-06-07', '2027-06-07', 1, 'active', 1, 'staff-program-test', '${now}', '${now}');`);
  await offeringService.saveOfferingBreak(runtime, actor("teacher"), { offeringId: summerOffering.id, label: "Туршилтын завсарлага", startsOn: "2027-06-07", endsOn: "2027-06-08" });
  await service.saveClassSession(runtime, actor("teacher"), { offeringId: summerOffering.id, firstDate: "2027-06-01", lastDate: "2027-06-14", academicYearId: "", stageCode: "", weekday: "", startTime: "10:00", endTime: "11:30", capacity: 12 });
  const summerWeekdayClass = database.query("SELECT class_session.id, class_session.updated_at AS updatedAt, class_meeting_rule.recurrence_kind AS recurrenceKind FROM class_session INNER JOIN class_meeting_rule ON class_meeting_rule.class_session_id = class_session.id WHERE class_session.activity_offering_id = " + quote(summerOffering.id) + " AND class_session.start_time = '10:00'")[0];
  assert.equal(summerWeekdayClass.recurrenceKind, "daily", "new summer classes default to daily recurrence");
  await service.generateCalendarDraft(runtime, actor("teacher"), { classSessionId: summerWeekdayClass.id });
  const summerDraftRevision = database.query(`SELECT revision.id, revision.updated_at AS updatedAt FROM class_calendar_revision AS revision INNER JOIN class_calendar AS calendar ON calendar.id = revision.class_calendar_id WHERE calendar.class_session_id = ${quote(summerWeekdayClass.id)} AND revision.status = 'draft'`)[0];
  assert.equal(database.query(`SELECT local_date AS localDate FROM class_calendar_slot WHERE class_calendar_revision_id = ${quote(summerDraftRevision.id)} AND status = 'scheduled' ORDER BY local_date DESC LIMIT 1`)[0].localDate, "2027-06-16", "a course break extends a daily summer plan beyond its soft end date");
  assert.equal(count(database, "class_calendar_slot", `class_calendar_revision_id = ${quote(summerDraftRevision.id)} AND local_date BETWEEN '2027-06-07' AND '2027-06-08' AND status = 'scheduled'`), 0, "an Offering break suppresses every daily candidate");
  await service.saveClassSession(runtime, actor("teacher"), { offeringId: summerOffering.id, recurrenceKind: "daily", firstDate: "2027-06-01", lastDate: "2027-06-14", academicYearId: "", stageCode: "", weekday: "", startTime: "13:00", endTime: "14:30", capacity: 12 });
  const summerDailyClass = database.query("SELECT id FROM class_session WHERE activity_offering_id = " + quote(summerOffering.id) + " AND start_time = '13:00'")[0];
  await service.generateCalendarDraft(runtime, actor("teacher"), { classSessionId: summerDailyClass.id });
  assert.equal(database.query(`SELECT COUNT(*) AS count FROM class_calendar_slot AS slot INNER JOIN class_calendar_revision AS revision ON revision.id = slot.class_calendar_revision_id INNER JOIN class_calendar AS calendar ON calendar.id = revision.class_calendar_id WHERE calendar.class_session_id = ${quote(summerDailyClass.id)} AND slot.local_date IN ('2027-06-05', '2027-06-06') AND slot.status = 'scheduled'`)[0].count, 2, "daily summer recurrence includes Saturday and Sunday");
  assert.equal(count(database, "class_calendar_slot", `local_date BETWEEN '2027-06-07' AND '2027-06-08' AND status = 'scheduled'`), 0, "the Offering break applies to both summer classes");
  await service.changeCalendarDraft(runtime, actor("teacher"), { revisionId: summerDraftRevision.id, expectedUpdatedAt: summerDraftRevision.updatedAt, kind: "exclude", localDate: "2027-06-11", reasonLabel: "Анги А" });
  assert.equal(count(database, "class_calendar_slot", `class_calendar_revision_id = ${quote(summerDraftRevision.id)} AND local_date = '2027-06-11' AND status = 'scheduled'`), 0, "a class-specific exception changes only Class A");
  assert.equal(count(database, "class_calendar_slot", `local_date = '2027-06-11' AND status = 'scheduled'`), 1, "Class B remains scheduled after Class A's exclusion");
  assert.equal(database.query(`SELECT COUNT(DISTINCT revision.curriculum_program_id) AS count FROM class_calendar_revision AS revision INNER JOIN class_calendar AS calendar ON calendar.id = revision.class_calendar_id INNER JOIN class_session AS class ON class.id = calendar.class_session_id WHERE class.activity_offering_id = ${quote(summerOffering.id)}`)[0].count, 1, "different summer classes inherit one Offering program");
  assert.equal(database.query(`SELECT facebook_group_url AS facebookGroupUrl FROM activity_offering WHERE id = ${quote(summerOffering.id)}`)[0].facebookGroupUrl, "https://facebook.com/groups/fake-summer", "the Offering is the shared Facebook-group authority");
  assert.equal(count(database, "class_session", `activity_offering_id = ${quote(summerOffering.id)} AND facebook_group_url IS NOT NULL`), 0, "class-level Facebook compatibility fields are not used by new setup");

  sqlite(`
    INSERT INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_current, is_test, test_run_id, created_at, updated_at)
      VALUES ('year-history', 'Түүх хамгаалах тест', 'draft', '2028-05-01', '2029-02-01', 0, 1, 'staff-program-test', '${now}', '${now}');
    INSERT INTO curriculum_program (id, academic_year_id, stage_code, revision_number, display_name, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('history-program', 'year-history', 'stage_1', 1, '30 хичээлийн тест', 'draft', 1, 'staff-program-test', '${now}', '${now}');
    WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 30)
    INSERT INTO curriculum_lesson (id, curriculum_program_id, sequence_number, title, status, is_test, test_run_id, created_at, updated_at)
      SELECT 'history-lesson-' || value, 'history-program', value, 'Түүхийн хичээл ' || value, 'active', 1, 'staff-program-test', '${now}', '${now}' FROM n;
    UPDATE curriculum_program SET status = 'published' WHERE id = 'history-program';
    INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, starts_on, ends_on, curriculum_program_id, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('history-offering', 'annual_course', 'Түүх хамгаалах тест · 1-р шат', 'year-history', 'stage_1', '${historyFirstDate}', '${historyPeriodEnd}', 'history-program', 1, 'paid', 'active', 1, 'staff-program-test', '${now}', '${now}');
    INSERT INTO class_session (id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, is_test, test_run_id, created_at, updated_at, activity_offering_id)
      VALUES ('history-class', 'year-history', 'stage_1', 'Түүхийн анги', '${historyWeekday}', '10:00', '11:20', 10, 'closed', 1, 'staff-program-test', '${now}', '${now}', 'history-offering');
    INSERT INTO class_meeting_rule (class_session_id, recurrence_kind, first_date, last_date, weekly_weekday, start_time, end_time, created_at, updated_at)
      VALUES ('history-class', 'weekly', '${historyFirstDate}', NULL, '${historyWeekday}', '10:00', '11:20', '${now}', '${now}');
  `);
  await service.generateCalendarDraft(runtime, actor("teacher"), { classSessionId: "history-class" });
  let historyRevision = database.query("SELECT revision.id, revision.updated_at AS updatedAt FROM class_calendar_revision AS revision INNER JOIN class_calendar AS calendar ON calendar.id = revision.class_calendar_id WHERE calendar.class_session_id = 'history-class' AND revision.status = 'draft'")[0];
  await service.publishCalendarDraft(runtime, actor("teacher"), { revisionId: historyRevision.id, expectedUpdatedAt: historyRevision.updatedAt });
  const historicalBefore = database.query(`SELECT lesson.sequence_number AS sequenceNumber, slot.local_date AS localDate FROM class_calendar_slot AS slot INNER JOIN curriculum_lesson AS lesson ON lesson.id = slot.curriculum_lesson_id INNER JOIN class_calendar_revision AS revision ON revision.id = slot.class_calendar_revision_id INNER JOIN class_calendar AS calendar ON calendar.id = revision.class_calendar_id WHERE calendar.class_session_id = 'history-class' AND revision.status = 'published' AND lesson.sequence_number <= 12 ORDER BY lesson.sequence_number`);
  const oldHistoryTail = database.query("SELECT MAX(slot.local_date) AS finalDate FROM class_calendar_slot AS slot INNER JOIN class_calendar_revision AS revision ON revision.id = slot.class_calendar_revision_id INNER JOIN class_calendar AS calendar ON calendar.id = revision.class_calendar_id WHERE calendar.class_session_id = 'history-class' AND revision.status = 'published' AND slot.status = 'scheduled'")[0].finalDate;
  await service.createCalendarChangeDraft(runtime, actor("teacher"), { classSessionId: "history-class" });
  historyRevision = database.query("SELECT revision.id, revision.updated_at AS updatedAt, revision.locked_through_sequence AS protectedThrough FROM class_calendar_revision AS revision INNER JOIN class_calendar AS calendar ON calendar.id = revision.class_calendar_id WHERE calendar.class_session_id = 'history-class' AND revision.status = 'draft'")[0];
  assert.equal(historyRevision.protectedThrough, 12, "past published dates automatically establish the interim historical boundary");
  const lesson13Slot = database.query(`SELECT slot.id FROM class_calendar_slot AS slot INNER JOIN curriculum_lesson AS lesson ON lesson.id = slot.curriculum_lesson_id WHERE slot.class_calendar_revision_id = ${quote(historyRevision.id)} AND lesson.sequence_number = 13`)[0];
  await service.cancelFutureCalendarSlot(runtime, actor("teacher"), { revisionId: historyRevision.id, expectedUpdatedAt: historyRevision.updatedAt, slotId: lesson13Slot.id });
  const historicalAfter = database.query(`SELECT lesson.sequence_number AS sequenceNumber, slot.local_date AS localDate FROM class_calendar_slot AS slot INNER JOIN curriculum_lesson AS lesson ON lesson.id = slot.curriculum_lesson_id WHERE slot.class_calendar_revision_id = ${quote(historyRevision.id)} AND lesson.sequence_number <= 12 ORDER BY lesson.sequence_number`);
  assert.deepEqual(historicalAfter, historicalBefore, "ordinary future cancellation does not rewrite past published history");
  const newHistoryTail = database.query(`SELECT MAX(local_date) AS finalDate FROM class_calendar_slot WHERE class_calendar_revision_id = ${quote(historyRevision.id)} AND status = 'scheduled'`)[0].finalDate;
  assert.ok(newHistoryTail > oldHistoryTail, "annual cancellation reflows the future sequence and extends the tail");

  await service.createProgramDraft(runtime, actor("teacher"), { academicYearId: "year-2026", stageCode: "stage_3", displayName: "" });
  assert.equal(database.query("SELECT display_name AS displayName FROM curriculum_program WHERE academic_year_id = 'year-2026' AND stage_code = 'stage_3' AND status = 'draft'")[0].displayName, "3-р шатны хөтөлбөр", "a new teacher draft receives a normal editable default name");
  await service.saveClassSession(runtime, actor("teacher"), { offeringId: "offering-annual-stage-1", recurrenceKind: "weekly", firstDate: "2026-09-08", weeklyWeekday: "Мягмар", academicYearId: "", stageCode: "", weekday: "", startTime: "16:00", endTime: "17:20", capacity: 8, registrationOpen: true });
  const newClass = database.query("SELECT id, display_label AS displayLabel, status, updated_at AS updatedAt FROM class_session WHERE weekday = 'Мягмар' AND start_time = '16:00'")[0];
  assert.equal(newClass.displayLabel, "1-р шат · Мягмар 16:00–17:20", "class labels are generated from normal teaching details without ambiguous duplicates");
  assert.equal(newClass.status, "closed", "a new class starts with registration safely closed");
  assert.equal(count(database, "class_meeting_rule", `class_session_id = ${quote(newClass.id)} AND recurrence_kind = 'weekly'`), 1, "new classes receive a typed meeting rule");
  assert.equal(database.query(`SELECT offering.curriculum_program_id AS programId FROM class_session AS class INNER JOIN activity_offering AS offering ON offering.id = class.activity_offering_id WHERE class.id = ${quote(newClass.id)}`)[0].programId, "current-program", "multiple annual classes inherit the same Offering program");
  await service.saveClassSession(runtime, actor("teacher"), { id: newClass.id, expectedUpdatedAt: newClass.updatedAt, offeringId: "offering-annual-stage-1", recurrenceKind: "weekly", firstDate: "2026-09-08", weeklyWeekday: "Мягмар", academicYearId: "", stageCode: "", weekday: "", startTime: "16:00", endTime: "17:20", capacity: 8, registrationOpen: true });
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
  await service.publishProgramDraft(runtime, actor("teacher"), { programId: copied.id, expectedUpdatedAt: saved.updatedAt, offeringId: "offering-annual-stage-1" });
  assert.equal(count(database, "curriculum_program", `id = ${quote(copied.id)} AND status = 'published'`), 1);
  await service.generateCalendarDraft(runtime, actor("teacher"), { classSessionId: "class-1" });
  let draft = database.query("SELECT revision.id, revision.updated_at AS updatedAt FROM class_calendar_revision AS revision INNER JOIN class_calendar AS calendar ON calendar.id = revision.class_calendar_id WHERE calendar.class_session_id = 'class-1' AND revision.status = 'draft'")[0];
  assert.equal(count(database, "class_calendar_slot", `class_calendar_revision_id = ${quote(draft.id)} AND status = 'scheduled'`), 3);
  await assert.rejects(() => service.deleteClassSession(runtime, actor("teacher"), { classSessionId: "class-1", expectedUpdatedAt: now }), /Program and calendar/, "a referenced class cannot be deleted");
  await service.changeCalendarDraft(runtime, actor("teacher"), { revisionId: draft.id, expectedUpdatedAt: draft.updatedAt, kind: "exclude", localDate: "2026-09-12", reasonLabel: "Тест" });
  draft = database.query(`SELECT id, updated_at AS updatedAt FROM class_calendar_revision WHERE id = ${quote(draft.id)}`)[0];
  await service.setCalendarDeliveredPrefix(runtime, actor("teacher"), { revisionId: draft.id, expectedUpdatedAt: draft.updatedAt, lockedThroughSequence: 1 });
  draft = database.query(`SELECT id, updated_at AS updatedAt FROM class_calendar_revision WHERE id = ${quote(draft.id)}`)[0];
  await service.publishCalendarDraft(runtime, actor("teacher"), { revisionId: draft.id, expectedUpdatedAt: draft.updatedAt });
  assert.equal(count(database, "class_calendar_revision", "status = 'published' AND class_calendar_id = (SELECT id FROM class_calendar WHERE class_session_id = 'class-1')"), 1);
  const usedOffering = database.query("SELECT updated_at AS updatedAt, starts_on AS startsOn, ends_on AS endsOn, curriculum_program_id AS programId FROM activity_offering WHERE id = 'offering-annual-stage-1'")[0];
  await offeringService.saveActivityOffering(runtime, actor("teacher"), { id: "offering-annual-stage-1", expectedUpdatedAt: usedOffering.updatedAt, kind: "annual_course", startsOn: usedOffering.startsOn, endsOn: usedOffering.endsOn, curriculumProgramId: usedOffering.programId, useAcademicYearBreaks: true, chargeMode: "paid", facebookGroupUrl: "https://facebook.com/groups/after-publication" });
  assert.equal(database.query("SELECT facebook_group_url AS url FROM activity_offering WHERE id = 'offering-annual-stage-1'")[0].url, "https://facebook.com/groups/after-publication", "a harmless Offering communication edit remains possible after calendar publication");
  const usedOfferingAfterCommunication = database.query("SELECT updated_at AS updatedAt FROM activity_offering WHERE id = 'offering-annual-stage-1'")[0];
  await assert.rejects(() => offeringService.saveActivityOffering(runtime, actor("teacher"), { id: "offering-annual-stage-1", expectedUpdatedAt: usedOfferingAfterCommunication.updatedAt, kind: "annual_course", startsOn: usedOffering.startsOn, endsOn: "2027-06-02", curriculumProgramId: usedOffering.programId, useAcademicYearBreaks: true, chargeMode: "paid" }), /Offering operation/, "a used Offering period cannot invalidate calendar history");
  await service.createCalendarChangeDraft(runtime, actor("teacher"), { classSessionId: "class-1" });
  draft = database.query("SELECT revision.id, revision.updated_at AS updatedAt, revision.locked_through_sequence AS protectedThrough FROM class_calendar_revision AS revision INNER JOIN class_calendar AS calendar ON calendar.id = revision.class_calendar_id WHERE calendar.class_session_id = 'class-1' AND revision.status = 'draft'")[0];
  assert.equal(draft.protectedThrough, 1, "an existing stored historical prefix remains protected even without a teacher lock control");
  const futureSlot = database.query(`SELECT slot.id FROM class_calendar_slot AS slot INNER JOIN curriculum_lesson AS lesson ON lesson.id = slot.curriculum_lesson_id WHERE slot.class_calendar_revision_id = ${quote(draft.id)} AND lesson.sequence_number = 2`)[0];
  await service.cancelFutureCalendarSlot(runtime, actor("teacher"), { revisionId: draft.id, expectedUpdatedAt: draft.updatedAt, slotId: futureSlot.id });
  assert.equal(count(database, "class_calendar_slot", `class_calendar_revision_id = ${quote(draft.id)} AND status = 'cancelled'`), 1, "future cancellation remains visible history");
  assert.ok(count(database, "audit_event", "action LIKE 'program_%' OR action LIKE 'calendar_%'") >= 7, "meaningful staff actions are audited");
  const overview = await service.getProgramCalendarOverview(runtime);
  assert.equal(overview.classes.find((entry) => entry.id === "class-1").displayLabel, "1-р шат · Бямба 10:00–11:20", "teacher overview ignores a legacy manual class label");
  assert.equal(overview.classes.find((entry) => entry.id === "class-1").offeringId, "offering-annual-stage-1", "class remains attached to its offering");
  assert.equal(overview.classes.find((entry) => entry.id === "class-1").canDelete, false, "reference checks keep linked classes out of the delete path");
  assert.equal(overview.stageSettings.filter((entry) => entry.academicYearId === "year-2026" && entry.stageCode === "stage_1").length, 1, "stage settings remain one-per-year-and-stage");
  console.log("ok staff Offering/program/calendar permissions, compatibility settings, class safety, recurrence, reflow, and audit tests");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
