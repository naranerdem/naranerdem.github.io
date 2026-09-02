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
const annualDefaultBundlePath = path.join(tempDir, "annual-course-start-default.mjs");
const academicYearShellBundlePath = path.join(tempDir, "academic-year-shell.mjs");
const coursePricingBundlePath = path.join(tempDir, "course-pricing.mjs");
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
function actor(role) { return { staffAccountId: `${role}-staff`, displayName: role, roles: [role], capabilities: role === "accountant" ? ["payment.view"] : role === "admin" ? ["program.view", "program.manage", "calendar.view", "calendar.manage", "payment.manage", "admin.settings.manage", "content.manage"] : ["program.view", "program.manage", "calendar.view", "calendar.manage", "payment.manage", "content.manage"], sessionId: "test", sessionExpiresAt: "2030-01-01T00:00:00.000Z", sessionAbsoluteExpiresAt: "2030-01-01T00:00:00.000Z" }; }
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
  const schedulePage = readFileSync("src/pages/staff/schedule.astro", "utf8");
  const programsPage = readFileSync("src/pages/staff/programs.astro", "utf8");
  const staffDashboardPage = readFileSync("src/pages/staff.astro", "utf8");
  const programCalendarSource = readFileSync("src/server/staff/program-calendar.ts", "utf8");
  assert.match(schedulePage, /slot\.status === "scheduled" && slot\.lessonSequence/, "a planned no-class row cannot render a curriculum lesson");
  assert.match(programsPage, /Хичээл оруулаагүй байна[\s\S]*?>Засах</, "an empty summer Program exposes its edit action");
  assert.match(programsPage, /family\.kind === "summer_course" \? `<div class="staff-danger-zone">/, "only summer Programs expose removal controls");
  assert.match(programCalendarSource, /COALESCE\(class_meeting_rule\.start_time, class_session\.start_time\), class_session\.id/, "class ordering has a stable ID tie-breaker after weekday and start time");
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
  const annualDefaultBundled = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/staff/annual-course-start-default.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${annualDefaultBundlePath}`], { encoding: "utf8" });
  if (annualDefaultBundled.status !== 0) throw new Error(annualDefaultBundled.stderr);
  const academicYearShellBundled = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/staff/academic-year-shell.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${academicYearShellBundlePath}`], { encoding: "utf8" });
  if (academicYearShellBundled.status !== 0) throw new Error(academicYearShellBundled.stderr);
  const coursePricingBundled = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/staff/course-pricing.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${coursePricingBundlePath}`], { encoding: "utf8" });
  if (coursePricingBundled.status !== 0) throw new Error(coursePricingBundled.stderr);
  const routerBundled = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/api/router.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${routerBundlePath}`], { encoding: "utf8" });
  if (routerBundled.status !== 0) throw new Error(routerBundled.stderr);
  const service = await import(pathToFileURL(bundlePath).href);
  const offeringService = await import(pathToFileURL(offeringBundlePath).href);
  const annualDefaultService = await import(pathToFileURL(annualDefaultBundlePath).href);
  const academicYearShellService = await import(pathToFileURL(academicYearShellBundlePath).href);
  const coursePricingService = await import(pathToFileURL(coursePricingBundlePath).href);
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
  assert.equal(count(database, "class_calendar_revision", `id = ${quote(backfillChangeDraft.id)}`), 0, "an unchanged calendar draft is discarded instead of becoming a duplicate revision");
  assert.equal(database.query("SELECT curriculum_program_id AS programId FROM class_calendar_revision WHERE id = 'backfill-calendar-revision'")[0].programId, "backfill-program", "an unchanged calendar keeps its original published historical program");
  sqlite(`
    INSERT INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_current, is_test, test_run_id, created_at, updated_at)
      VALUES ('year-2026', '2026–2027', 'draft', '2026-09-01', '2027-06-01', 1, 1, 'staff-program-test', '${now}', '${now}');
    INSERT INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_current, is_test, test_run_id, created_at, updated_at)
      VALUES ('year-2025', '2025–2026', 'archived', '2025-09-01', '2026-06-01', 0, 1, 'staff-program-test', '${now}', '${now}');
    INSERT INTO curriculum_program (id, program_family_id, academic_year_id, stage_code, revision_number, display_name, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('old-program', 'annual-program-stage_1', 'year-2025', 'stage_1', 1, 'Өмнөх хөтөлбөр', 'draft', 1, 'staff-program-test', '${now}', '${now}');
    INSERT INTO curriculum_lesson (id, curriculum_program_id, sequence_number, title, status, is_test, test_run_id, created_at, updated_at) VALUES
      ('old-lesson-1', 'old-program', 1, 'Туршилт 1', 'active', 1, 'staff-program-test', '${now}', '${now}'),
      ('old-lesson-2', 'old-program', 2, 'Туршилт 2', 'active', 1, 'staff-program-test', '${now}', '${now}'),
      ('old-lesson-3', 'old-program', 3, 'Туршилт 3', 'active', 1, 'staff-program-test', '${now}', '${now}');
    UPDATE curriculum_program SET status = 'superseded' WHERE id = 'old-program';
    INSERT INTO curriculum_program (id, program_family_id, academic_year_id, stage_code, revision_number, display_name, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('current-program', 'annual-program-stage_1', 'year-2026', 'stage_1', 3, 'Одоогийн хөтөлбөр', 'draft', 1, 'staff-program-test', '${now}', '${now}');
    INSERT INTO curriculum_lesson (id, curriculum_program_id, sequence_number, title, status, is_test, test_run_id, created_at, updated_at) VALUES
      ('current-lesson-1', 'current-program', 1, 'Одоогийн туршилт 1', 'active', 1, 'staff-program-test', '${now}', '${now}'),
      ('current-lesson-2', 'current-program', 2, 'Одоогийн туршилт 2', 'active', 1, 'staff-program-test', '${now}', '${now}'),
      ('current-lesson-3', 'current-program', 3, 'Одоогийн туршилт 3', 'active', 1, 'staff-program-test', '${now}', '${now}');
    UPDATE curriculum_program SET status = 'superseded' WHERE id = 'backfill-current-program';
    UPDATE curriculum_program SET status = 'published', published_at = '${now}' WHERE id = 'current-program';
    UPDATE curriculum_program_family SET current_published_program_id = 'current-program' WHERE id = 'annual-program-stage_1';
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

  const pinnedBeforePublicInfo = database.query("SELECT current_published_program_id AS id FROM curriculum_program_family WHERE id = 'annual-program-stage_1'")[0].id;
  await service.saveProgramFamilyPublicInformation(runtime, actor("teacher"), { programFamilyId: "annual-program-stage_1", expectedUpdatedAt: database.query("SELECT updated_at AS value FROM curriculum_program_family WHERE id = 'annual-program-stage_1'")[0].value, recommendedGradeMin: "4", recommendedGradeMax: "6", publicShortDescription: "Товч", publicLongDescription: "Дэлгэрэнгүй" });
  const publicInfoFamily = database.query("SELECT recommended_grade_min AS min, recommended_grade_max AS max, current_published_program_id AS programId FROM curriculum_program_family WHERE id = 'annual-program-stage_1'")[0];
  assert.deepEqual([publicInfoFamily.min, publicInfoFamily.max], ["4", "6"], "Program-family public information persists independently");
  assert.equal(publicInfoFamily.programId, pinnedBeforePublicInfo, "public information does not move the curriculum pointer");
  assert.equal(database.query("SELECT curriculum_program_id AS id FROM activity_offering WHERE id = 'offering-annual-stage-1'")[0].id, pinnedBeforePublicInfo, "existing Offerings retain their pinned revision");
  await assert.rejects(service.saveProgramFamilyPublicInformation(runtime, actor("teacher"), { programFamilyId: "annual-program-stage_1", expectedUpdatedAt: database.query("SELECT updated_at AS value FROM curriculum_program_family WHERE id = 'annual-program-stage_1'")[0].value, recommendedGradeMin: "7", recommendedGradeMax: "4" }), /Program and calendar/);
  await assert.rejects(service.saveProgramFamilyPublicInformation(runtime, actor("accountant"), { programFamilyId: "annual-program-stage_1", expectedUpdatedAt: "x" }), /Program and calendar/);

  const offeringsPage = readFileSync("src/pages/staff/offerings.astro", "utf8");
  const holidaysPage = readFileSync("src/pages/staff/holidays.astro", "utf8");
  const settingsPage = readFileSync("src/pages/staff/settings/index.astro", "utf8");
  const infoPage = readFileSync("src/pages/staff/info.astro", "utf8");
  const legacyPage = readFileSync("src/pages/staff/program-calendar.astro", "utf8");
  const routerSource = readFileSync("src/server/api/router.ts", "utf8");
  assert.match(programsPage, />Хадгалах</, "program tool presents ordinary save wording");
  assert.match(programsPage, /params\.get\("program"\) \|\| params\.get\("family"\)/, "Program selection is carried explicitly in the URL");
  assert.doesNotMatch(programsPage, /families\(\)\[0\]/, "Program list does not arbitrarily select its first entry");
  assert.match(programsPage, /id="program-close"/, "a selected Program detail can return to the neutral list");
  assert.ok(programsPage.indexOf('id="program-list"') < programsPage.indexOf('id="program-editor"'), "Program detail remains below the complete Program lists");
  assert.match(programsPage, /Зуны хөтөлбөр нэмэх/, "ordinary program setup only creates summer program families");
  assert.ok(programsPage.indexOf("Зуны хөтөлбөр") < programsPage.lastIndexOf("Зуны хөтөлбөр нэмэх"), "the summer-program action remains inside the later summer section");
  assert.match(programsPage, /program\.publish[\s\S]*state\.edit = false/, "successful Program save returns to the ordinary Program view");
  assert.match(programsPage, /Зөвлөмжит анги/, "Program detail presents recommended grades directly");
  assert.match(programsPage, /Хичээлийн жагсаалт/, "curriculum editing is visibly attached to the lesson list");
  assert.doesNotMatch(programsPage, /program-long-dialog|program-long-description/, "routine Program editing does not expose the retired long-description editor");
  assert.match(infoPage, /querySelectorAll\("\[data-rule\]"\)/, "both rule edit buttons receive listeners");
  assert.match(programsPage, /Өмнө нь хичээл оруулах/, "the Program row menu supports insertion before a lesson");
  assert.match(programsPage, /data-staff-action-menu/, "Program row menus opt into the shared one-menu controller");
  assert.match(programsPage, /createStaffActionMenuController/, "Program page initializes shared action-menu behavior");
  assert.doesNotMatch(programsPage, /Эндээс өмнө хичээл оруулах/, "the Program row menu uses concise teacher wording");
  assert.match(programsPage, /Хичээл нэмэх/, "the Program editor keeps one append action");
  assert.doesNotMatch(programsPage, /<form id="program-form"/, "Program inline lesson forms are not nested inside an outer form");
  assert.match(programsPage, /Хадгалаагүй өөрчлөлтүүдийг устгах уу\?/, "Program batch cancellation confirms before discarding persisted edits");
  assert.match(programsPage, /program\.discard/, "Program batch cancellation uses the server-side draft discard operation");
  assert.doesNotMatch(programsPage, /Хөтөлбөр нийтлэх|Ноорог хөтөлбөр|Ноорог засварлаж байна|Нийтлэгдсэн хувилбар|window\.prompt/, "ordinary Program editing hides revision language and native prompt entry");
  assert.doesNotMatch(programsPage, /Хичээлийн жил/, "annual Program identity is not recreated per academic year");
  assert.match(offeringsPage, /Жилийн сургалт/);
  assert.match(offeringsPage, /Зуны сургалт/);
  assert.match(offeringsPage, /Арга хэмжээ/);
  assert.match(offeringsPage, /Үнэгүй/);
  assert.match(holidaysPage, /Амралтын хугацаа нэмэх/, "holiday tool is a separate focused screen");
  assert.match(holidaysPage, /year\.startsOn && year\.endsOn/, "dated academic-year shells remain visible even before holiday periods exist");
  assert.match(holidaysPage, /Дараагийн хичээлийн жил бэлтгэх/, "holiday tool can prepare a lightweight next academic-year shell");
  assert.match(holidaysPage, /Өмнөх жилээс хуулж эхлэх/, "holiday tool can start editable planning from the previous year");
  assert.match(offeringsPage, /Анги нэмэх/, "selected Offering details own class setup");
  assert.doesNotMatch(schedulePage, /Анги нэмэх|id="classes-title"/, "Schedule does not duplicate class setup beneath a calendar");
  assert.match(schedulePage, /id="schedule-overview"/, "Schedule opens with a class overview");
  assert.match(schedulePage, /data-open-class/, "Schedule overview opens one explicit class");
  assert.match(schedulePage, /params\.get\("class"\)/, "Schedule selection is carried explicitly in the URL");
  assert.doesNotMatch(schedulePage, /offerings\(\)\[0\]|classes\(\)\[0\]/, "Schedule does not arbitrarily select its first Offering or class");
  assert.match(schedulePage, /Бүх ангид хичээлгүй хугацаа оруулах/, "Offering-wide breaks are managed from Schedule");
  assert.match(schedulePage, /offering-break\.save/, "Schedule uses the existing Offering-break domain operation");
  assert.doesNotMatch(offeringsPage, /offering-break|Сургалтын завсарлага|Завсарлага нэмэх/, "Offering metadata editing does not expose break controls");
  assert.match(schedulePage, />Хадгалах</, "calendar save uses ordinary teacher wording");
  assert.match(schedulePage, /data-calendar-action/, "future lessons use compact row actions");
  assert.match(schedulePage, /Амралтын хуваарь тохируулаагүй байна/, "Schedule gives only a non-blocking notice when annual holiday planning is absent");
  assert.match(schedulePage, /data-staff-action-menu/, "Schedule row menus opt into the shared one-menu controller");
  assert.match(schedulePage, /createStaffActionMenuController/, "Schedule page initializes shared action-menu behavior");
  assert.match(schedulePage, /Нэмэлт хичээл оруулах/, "extra lessons are secondary schedule work");
  assert.doesNotMatch(schedulePage, /Өөрчлөх ноорог эхлүүлэх|Хуваарь нийтлэх|Ноорог хуваарь|Нийтлэгдсэн хуваарь|calendar-date-action|Өдөр, цаг өөрчлөх|replacement:/, "ordinary schedule editing hides draft, publish, and arbitrary date-move machinery");
  assert.match(schedulePage, /Энэ өдөр хичээллэх/, "a school-calendar skip has a natural class-level restore action");
  assert.match(schedulePage, /Хичээлтэй болгох/, "a future manually cancelled row exposes the natural reverse action");
  assert.match(schedulePage, /calendar\.restore-cancelled/, "manual no-class restoration uses its dedicated server-authoritative operation");
  assert.match(schedulePage, /beginCalendarAction[\s\S]*?catch \(error\)[\s\S]*?Хуваарийн өөрчлөлтийг эхлүүлж чадсангүй/, "a rejected change-draft request reports a visible Mongolian error instead of failing silently");
  assert.match(programCalendarSource, /holidayWarnings: slot\.status === "scheduled"[\s\S]*?: \[\]/, "only active teaching slots receive school-period overlap labels");
  assert.match(schedulePage, /Энэ өдрөөс хойших хичээлүүдийн огноо өөрчлөгдөнө\./, "schedule consequences avoid misleading exact reflow counts");
  assert.match(schedulePage, /Хадгалаагүй хуваарийн өөрчлөлтүүдийг устгах уу\?/, "calendar batch cancellation confirms before discarding persisted edits");
  assert.match(schedulePage, /calendar\.discard/, "calendar batch cancellation uses the server-side draft discard operation");
  assert.doesNotMatch(schedulePage, /Ангийн нэр|Facebook бүлгийн холбоос|value="draft"|value="cancelled"|calendar-program|calendar-lock|Дууссан хичээл|баталж байна/, "ordinary schedule editing hides legacy program, lock, and technical fields");
  assert.match(offeringsPage, /staff-danger-zone/, "unused class deletion lives inside selected Offering details");
  assert.doesNotMatch(settingsPage, /Facebook бүлгийн|offering-facebook\.save|facebook-form/, "Settings has no duplicate Offering Facebook editor");
  assert.match(settingsPage, /Жилийн сургалтын эхлэх өдрийн анхны утга/, "the global annual start default is an admin-only secondary setting");
  assert.match(settingsPage, /QR холбоос/, "admin settings contain the compact public QR destination section");
  assert.match(settingsPage, /public-qr-redirect-settings\.save/, "the QR section uses one dedicated typed settings action");
  assert.match(settingsPage, /Багшийн нүүр хуудас/, "admin settings include the compact teacher dashboard preferences");
  assert.match(staffDashboardPage, /\/api\/staff\/dashboard-preferences/, "teacher dashboard reads presentation preferences separately from authorization");
  assert.match(staffDashboardPage, /staff-setup-section/, "the setup section can be hidden as one presentation group");
  assert.match(staffDashboardPage, /staff-registration-link/, "registration card has an independent presentation target");
  assert.match(staffDashboardPage, /staff-information-link/, "information card has an independent presentation target");
  assert.match(offeringsPage, /annualCourseStartDefault/, "new annual Offerings use the configured start-date default");
  assert.match(offeringsPage, /Facebook бүлгийн холбоос/, "Offering creation and editing own the Facebook-group value");
  assert.match(offeringsPage, /async function runClass[\s\S]*state\.editingClass = "";[\s\S]*await refresh\(\);[\s\S]*Ангийн мэдээлэл хадгалагдсангүй/, "a failed class save discards the typed local value and reloads the authoritative class list");
  const staffSetupSource = readFileSync("src/scripts/staff-setup.js", "utf8");
  assert.match(staffSetupSource, /program-calendar[\s\S]*cache: "no-store"/, "program and class reads explicitly bypass browser cache");
  assert.match(offeringsPage, /Хоосон орхиж болно\./, "an Offering Facebook group is explicitly optional");
  assert.match(legacyPage, /url=\/staff\/schedule\//, "old bookmark redirects to the schedule tool");
  assert.match(routerSource, /"programId" in payload \|\| "firstCandidateDate" in payload/, "calendar generation rejects caller-selected program and start-date substitutions");
  assert.doesNotMatch(routerSource, /curriculumProgramId/, "ordinary Offering writes cannot select a raw curriculum revision");
  assert.doesNotMatch(routerSource, /stage-setting\.save/, "legacy stage settings have no competing mutation endpoint");
  assert.doesNotMatch(routerSource, /replacement: payload\.replacement/, "calendar cancellation no longer accepts arbitrary replacement slots");

  const originalAnnualDefault = await annualDefaultService.getAnnualCourseStartDefault(runtime);
  assert.deepEqual({ month: originalAnnualDefault.month, day: originalAnnualDefault.day }, { month: 10, day: 1 }, "annual Offering start defaults to October 1");
  await assert.rejects(() => annualDefaultService.updateAnnualCourseStartDefault(runtime, actor("teacher"), { month: 9, day: 25, expectedUpdatedAt: originalAnnualDefault.updatedAt }), /Annual course start default/);
  const changedAnnualDefault = await annualDefaultService.updateAnnualCourseStartDefault(runtime, actor("admin"), { month: 9, day: 25, expectedUpdatedAt: originalAnnualDefault.updatedAt });
  assert.deepEqual({ month: changedAnnualDefault.month, day: changedAnnualDefault.day }, { month: 9, day: 25 }, "an admin can change the annual start default");
  assert.equal(count(database, "audit_event", "action = 'annual_course_start_default_changed'"), 1, "a global default change is audited");

  await assert.rejects(() => service.startProgramFamilyDraft(runtime, actor("accountant"), { programFamilyId: "annual-program-stage_1" }), /Program and calendar/);
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

  await assert.rejects(() => offeringService.saveActivityOffering(runtime, actor("teacher"), { kind: "annual_course", annualStageCode: "stage_1", startsOn: "2025-09-01", endsOn: "2026-06-01", chargeMode: "free" }), /Offering operation/, "annual offerings reject a manual free charge mode");
  await offeringService.saveActivityOffering(runtime, actor("teacher"), { kind: "annual_course", annualStageCode: "stage_1", startsOn: "2025-09-01", endsOn: "2026-06-01" });
  const annualDefault = database.query("SELECT charge_mode AS chargeMode, use_academic_year_breaks AS useBreaks, default_class_duration_minutes AS duration FROM activity_offering WHERE academic_year_id = 'year-2025' AND stage_code = 'stage_1'")[0];
  assert.equal(annualDefault.chargeMode, "paid", "annual course charge defaults to paid");
  assert.equal(database.query("SELECT facebook_group_url AS facebookGroupUrl FROM activity_offering WHERE academic_year_id = 'year-2025' AND stage_code = 'stage_1'")[0].facebookGroupUrl, null, "an Offering may be created with no Facebook group");
  assert.equal(annualDefault.useBreaks, 1, "annual courses apply academic-year breaks by default");
  assert.equal(annualDefault.duration, 80, "new Stage 1 annual offerings default to 80 minutes");

  await assert.rejects(() => offeringService.saveActivityOffering(runtime, actor("teacher"), { kind: "summer_course", title: "Туршилтын зуны сургалт", startsOn: "2027-06-01", endsOn: "2027-06-26" }), /Offering operation/, "summer offerings require an existing published program");
  await service.createSummerProgramFamilyDraft(runtime, actor("teacher"), { displayName: "Туршилтын зуны хөтөлбөр" });
  const summerDraft = database.query("SELECT id, updated_at AS updatedAt FROM curriculum_program WHERE program_kind = 'summer_course' AND status = 'draft'")[0];
  const summerLessons = Array.from({ length: 14 }, (_, index) => ({ title: `Туршилтын хичээл ${String(index + 1).padStart(2, "0")}` }));
  await service.saveProgramDraft(runtime, actor("teacher"), { programId: summerDraft.id, expectedUpdatedAt: summerDraft.updatedAt, displayName: "Туршилтын зуны хөтөлбөр", lessons: summerLessons });
  const savedSummerDraft = database.query(`SELECT updated_at AS updatedAt FROM curriculum_program WHERE id = ${quote(summerDraft.id)}`)[0];
  await service.publishProgramFamilyDraft(runtime, actor("teacher"), { programId: summerDraft.id, expectedUpdatedAt: savedSummerDraft.updatedAt });
  const summerFamily = database.query(`SELECT program_family_id AS familyId FROM curriculum_program WHERE id = ${quote(summerDraft.id)}`)[0];
  await assert.rejects(() => offeringService.saveActivityOffering(runtime, actor("teacher"), { kind: "summer_course", title: "Туршилтын зуны сургалт", startsOn: "2027-06-01", endsOn: "2027-06-14", programFamilyId: summerFamily.familyId, chargeMode: "free" }), /Offering operation/, "summer offerings reject a manual free charge mode");
  await offeringService.saveActivityOffering(runtime, actor("teacher"), {
    kind: "summer_course", title: "Устгах зуны сургалт", startsOn: "2027-07-01", endsOn: "2027-07-05", programFamilyId: summerFamily.familyId,
    initialClasses: [{ recurrenceKind: "daily", startTime: "10:00", capacity: 8 }],
  });
  const removableCourse = database.query("SELECT id, updated_at AS updatedAt FROM activity_offering WHERE title = 'Устгах зуны сургалт'")[0];
  const removableClass = database.query(`SELECT id FROM class_session WHERE activity_offering_id = ${quote(removableCourse.id)}`)[0];
  await service.generateCalendarDraft(runtime, actor("teacher"), { classSessionId: removableClass.id });
  const removableCalendar = database.query(`SELECT calendar.id AS calendarId, revision.id AS revisionId, revision.updated_at AS updatedAt
    FROM class_calendar AS calendar
    INNER JOIN class_calendar_revision AS revision ON revision.class_calendar_id = calendar.id
    WHERE calendar.class_session_id = ${quote(removableClass.id)} AND revision.status = 'draft'`)[0];
  await service.publishCalendarDraft(runtime, actor("teacher"), { revisionId: removableCalendar.revisionId, expectedUpdatedAt: removableCalendar.updatedAt });
  assert.throws(() => sqlite(`DELETE FROM class_calendar_revision WHERE id = ${quote(removableCalendar.revisionId)}`), /published calendar revision cannot be deleted/, "a standalone published revision delete remains prohibited");
  assert.throws(() => sqlite(`UPDATE class_calendar_revision SET locked_through_sequence = 1 WHERE id = ${quote(removableCalendar.revisionId)}`), /published calendar revision identity is immutable/, "a standalone published revision mutation remains prohibited");
  await offeringService.deleteUnusedCourseOffering(runtime, actor("teacher"), { offeringId: removableCourse.id, expectedUpdatedAt: removableCourse.updatedAt });
  assert.equal(count(database, "activity_offering", `id = ${quote(removableCourse.id)}`), 0, "an unused course Offering can be deleted safely");
  assert.equal(count(database, "class_session", `id = ${quote(removableClass.id)}`), 0, "its unused class is deleted with the Offering");
  assert.equal(count(database, "class_meeting_rule", `class_session_id = ${quote(removableClass.id)}`), 0, "its meeting rule cascades with the unused class");
  assert.equal(count(database, "class_calendar", `id = ${quote(removableCalendar.calendarId)}`), 0, "its planning calendar is deleted only with the unused Offering aggregate");
  assert.equal(count(database, "class_calendar_revision", `id = ${quote(removableCalendar.revisionId)}`), 0, "its published planning revision is deleted with the unused Offering aggregate");
  assert.equal(count(database, "unused_offering_deletion_context"), 0, "the aggregate deletion context never persists");
  assert.equal(count(database, "audit_event", `action = 'activity_offering_deleted' AND subject_id = ${quote(removableCourse.id)}`), 1, "unused course deletion is audited");
  await offeringService.saveActivityOffering(runtime, actor("teacher"), { kind: "summer_course", title: "Туршилтын зуны сургалт", startsOn: "2027-06-01", endsOn: "2027-06-14", programFamilyId: summerFamily.familyId, facebookGroupUrl: "https://facebook.com/groups/fake-summer" });
  const summerOffering = database.query("SELECT id, curriculum_program_id AS programId, academic_year_id AS academicYearId, charge_mode AS chargeMode, use_academic_year_breaks AS useBreaks, default_class_duration_minutes AS duration FROM activity_offering WHERE title = 'Туршилтын зуны сургалт'")[0];
  assert.equal(summerOffering.chargeMode, "paid", "summer charge defaults to paid");
  assert.equal(summerOffering.useBreaks, 0, "summer does not inherit academic breaks by default");
  assert.equal(summerOffering.duration, 80, "new summer offerings default to 80 minutes");
  sqlite(`INSERT INTO academic_year_break (id, academic_year_id, label, starts_on, ends_on, excludes_habitual_slots, status, is_test, test_run_id, created_at, updated_at)
    VALUES ('summer-irrelevant-break', ${quote(summerOffering.academicYearId)}, 'Зуны үед үйлчлэхгүй', '2027-06-07', '2027-06-07', 1, 'active', 1, 'staff-program-test', '${now}', '${now}');`);
  await offeringService.saveOfferingBreak(runtime, actor("teacher"), { offeringId: summerOffering.id, label: "Туршилтын завсарлага", startsOn: "2027-06-07", endsOn: "2027-06-08" });
  await service.saveClassSession(runtime, actor("teacher"), { offeringId: summerOffering.id, firstDate: "2027-06-01", lastDate: "2027-06-14", academicYearId: "", stageCode: "", weekday: "", startTime: "10:00", endTime: "11:30", capacity: 12 });
  const summerWeekdayClass = database.query("SELECT class_session.id, class_session.updated_at AS updatedAt, class_meeting_rule.recurrence_kind AS recurrenceKind FROM class_session INNER JOIN class_meeting_rule ON class_meeting_rule.class_session_id = class_session.id WHERE class_session.activity_offering_id = " + quote(summerOffering.id) + " AND class_session.start_time = '10:00'")[0];
  assert.equal(summerWeekdayClass.recurrenceKind, "daily", "new summer classes default to daily recurrence");
  await service.saveClassSession(runtime, actor("teacher"), { offeringId: summerOffering.id, firstDate: "2027-06-01", lastDate: "2027-06-14", academicYearId: "", stageCode: "", weekday: "", startTime: "16:00", capacity: 12 });
  assert.equal(database.query("SELECT end_time AS endTime FROM class_session WHERE activity_offering_id = " + quote(summerOffering.id) + " AND start_time = '16:00'")[0].endTime, "17:20", "new class end time derives from its Offering duration");
  await service.generateCalendarDraft(runtime, actor("teacher"), { classSessionId: summerWeekdayClass.id });
  const summerDraftRevision = database.query(`SELECT revision.id, revision.updated_at AS updatedAt FROM class_calendar_revision AS revision INNER JOIN class_calendar AS calendar ON calendar.id = revision.class_calendar_id WHERE calendar.class_session_id = ${quote(summerWeekdayClass.id)} AND revision.status = 'draft'`)[0];
  const usedSummerOffering = database.query(`SELECT updated_at AS updatedAt FROM activity_offering WHERE id = ${quote(summerOffering.id)}`)[0];
  sqlite(`INSERT INTO registration_window (id, name, starts_on, ends_on, is_test, test_run_id, created_at, updated_at)
    VALUES ('protected-offering-window', 'Хамгаалсан цонх', '2027-01-01', '2027-01-31', 1, 'staff-program-test', '${now}', '${now}');
    INSERT INTO registration_window_offering (registration_window_id, activity_offering_id, created_at)
    VALUES ('protected-offering-window', ${quote(summerOffering.id)}, '${now}');`);
  await assert.rejects(() => offeringService.deleteUnusedCourseOffering(runtime, actor("teacher"), { offeringId: summerOffering.id, expectedUpdatedAt: usedSummerOffering.updatedAt }), /Offering operation/, "a course Offering with a registration reference cannot be deleted");
  assert.equal(database.query(`SELECT local_date AS localDate FROM class_calendar_slot WHERE class_calendar_revision_id = ${quote(summerDraftRevision.id)} AND status = 'scheduled' ORDER BY local_date DESC LIMIT 1`)[0].localDate, "2027-06-16", "a course break extends a daily summer plan beyond its soft end date");
  assert.equal(count(database, "class_calendar_slot", `class_calendar_revision_id = ${quote(summerDraftRevision.id)} AND local_date BETWEEN '2027-06-07' AND '2027-06-08' AND status = 'scheduled'`), 0, "an Offering break suppresses every daily candidate");
  await service.saveClassSession(runtime, actor("teacher"), { offeringId: summerOffering.id, recurrenceKind: "daily", firstDate: "2027-06-01", lastDate: "2027-06-14", academicYearId: "", stageCode: "", weekday: "", startTime: "13:00", endTime: "14:30", capacity: 12 });
  const summerDailyClass = database.query("SELECT id FROM class_session WHERE activity_offering_id = " + quote(summerOffering.id) + " AND start_time = '13:00'")[0];
  await service.generateCalendarDraft(runtime, actor("teacher"), { classSessionId: summerDailyClass.id });
  assert.equal(database.query(`SELECT COUNT(*) AS count FROM class_calendar_slot AS slot INNER JOIN class_calendar_revision AS revision ON revision.id = slot.class_calendar_revision_id INNER JOIN class_calendar AS calendar ON calendar.id = revision.class_calendar_id WHERE calendar.class_session_id = ${quote(summerDailyClass.id)} AND slot.local_date IN ('2027-06-05', '2027-06-06') AND slot.status = 'scheduled'`)[0].count, 2, "daily summer recurrence includes Saturday and Sunday");
  assert.equal(count(database, "class_calendar_slot", `local_date BETWEEN '2027-06-07' AND '2027-06-08' AND status = 'scheduled'`), 0, "the Offering break applies to both summer classes");
  await assert.rejects(() => service.changeCalendarDraft(runtime, actor("teacher"), { revisionId: summerDraftRevision.id, expectedUpdatedAt: summerDraftRevision.updatedAt, kind: "restore", localDate: "2027-06-07" }), /Program and calendar/, "one class cannot silently restore an Offering-wide break");
  await service.changeCalendarDraft(runtime, actor("teacher"), { revisionId: summerDraftRevision.id, expectedUpdatedAt: summerDraftRevision.updatedAt, kind: "exclude", localDate: "2027-06-11", reasonLabel: "Анги А" });
  assert.equal(count(database, "class_calendar_slot", `class_calendar_revision_id = ${quote(summerDraftRevision.id)} AND local_date = '2027-06-11' AND status = 'scheduled'`), 0, "a class-specific exception changes only Class A");
  assert.equal(count(database, "class_calendar_slot", `local_date = '2027-06-11' AND status = 'scheduled'`), 1, "Class B remains scheduled after Class A's exclusion");
  assert.equal(database.query(`SELECT COUNT(DISTINCT revision.curriculum_program_id) AS count FROM class_calendar_revision AS revision INNER JOIN class_calendar AS calendar ON calendar.id = revision.class_calendar_id INNER JOIN class_session AS class ON class.id = calendar.class_session_id WHERE class.activity_offering_id = ${quote(summerOffering.id)}`)[0].count, 1, "different summer classes inherit one Offering program");
  assert.equal(database.query(`SELECT facebook_group_url AS facebookGroupUrl FROM activity_offering WHERE id = ${quote(summerOffering.id)}`)[0].facebookGroupUrl, "https://facebook.com/groups/fake-summer", "the Offering is the shared Facebook-group authority");
  assert.equal(count(database, "class_session", `activity_offering_id = ${quote(summerOffering.id)} AND facebook_group_url IS NOT NULL`), 0, "class-level Facebook compatibility fields are not used by new setup");

  sqlite(`
    INSERT INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_current, is_test, test_run_id, created_at, updated_at)
      VALUES ('year-history', 'Түүх хамгаалах тест', 'draft', '2028-05-01', '2029-02-01', 0, 1, 'staff-program-test', '${now}', '${now}');
    INSERT INTO curriculum_program (id, program_family_id, academic_year_id, stage_code, revision_number, display_name, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('history-program', 'annual-program-stage_1', 'year-history', 'stage_1', 4, '30 хичээлийн тест', 'draft', 1, 'staff-program-test', '${now}', '${now}');
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

  await service.saveClassSession(runtime, actor("teacher"), { offeringId: "offering-annual-stage-1", recurrenceKind: "weekly", firstDate: "2026-09-08", weeklyWeekday: "Мягмар", academicYearId: "", stageCode: "", weekday: "", startTime: "16:00", endTime: "17:20", capacity: 8, registrationOpen: true });
  const newClass = database.query("SELECT id, display_label AS displayLabel, status, updated_at AS updatedAt FROM class_session WHERE weekday = 'Мягмар' AND start_time = '16:00'")[0];
  assert.equal(newClass.displayLabel, "1-р шат · Мягмар 16:00–17:20", "class labels are generated from normal teaching details without ambiguous duplicates");
  assert.equal(newClass.status, "closed", "a new class starts with registration safely closed");
  assert.equal(count(database, "class_meeting_rule", `class_session_id = ${quote(newClass.id)} AND recurrence_kind = 'weekly'`), 1, "new classes receive a typed meeting rule");
  assert.equal(database.query(`SELECT offering.curriculum_program_id AS programId FROM class_session AS class INNER JOIN activity_offering AS offering ON offering.id = class.activity_offering_id WHERE class.id = ${quote(newClass.id)}`)[0].programId, "current-program", "multiple annual classes inherit the same Offering program");
  await assert.rejects(() => service.saveClassSession(runtime, actor("teacher"), { id: newClass.id, expectedUpdatedAt: newClass.updatedAt, offeringId: "offering-annual-stage-1", recurrenceKind: "weekly", firstDate: "2026-09-08", weeklyWeekday: "Мягмар", academicYearId: "", stageCode: "", weekday: "", startTime: "16:00", endTime: "17:20", capacity: 8, registrationOpen: true }), /Course pricing operation/, "registration cannot open before payment terms are configured");
  const price = await coursePricingService.saveCoursePricing(runtime, actor("teacher"), {
    offeringId: "offering-annual-stage-1", oneTimeAmountMnt: 850000, twoInstallmentEnabled: false,
  });
  assert.equal(price.oneTimeAmountMnt, 850000, "course prices store whole MNT amounts");
  await assert.rejects(() => coursePricingService.saveCoursePricing(runtime, actor("teacher"), {
    offeringId: "offering-annual-stage-1", oneTimeAmountMnt: 850000, twoInstallmentEnabled: true,
    firstInstallmentAmountMnt: 0, secondInstallmentAmountMnt: 450000, secondInstallmentDueOn: "2026-11-01", expectedUpdatedAt: price.updatedAt,
  }), /Course pricing operation/, "two-installment terms require positive amounts");
  await assert.rejects(() => coursePricingService.saveCoursePricing(runtime, actor("teacher"), {
    offeringId: "offering-annual-stage-1", oneTimeAmountMnt: 850000, twoInstallmentEnabled: true,
    firstInstallmentAmountMnt: 450000, secondInstallmentAmountMnt: 450000, secondInstallmentDueOn: "not-a-date", expectedUpdatedAt: price.updatedAt,
  }), /Course pricing operation/, "two-installment terms require a valid due date");
  await assert.rejects(() => service.saveClassSession(runtime, actor("teacher"), { id: newClass.id, expectedUpdatedAt: newClass.updatedAt, offeringId: "offering-annual-stage-1", recurrenceKind: "weekly", firstDate: "2026-09-08", weeklyWeekday: "Мягмар", academicYearId: "", stageCode: "", weekday: "", startTime: "16:00", endTime: "17:20", capacity: 8, registrationOpen: true }), /Course pricing operation/, "pricing alone cannot open registration without bank instructions");
  sqlite(`UPDATE payment_collection_settings SET bank_name = 'Тест банк', account_holder_name = 'Тест эзэмшигч', account_number = '0000000000', updated_at = '${now}' WHERE singleton = 1;`);
  await service.saveClassSession(runtime, actor("teacher"), { id: newClass.id, expectedUpdatedAt: newClass.updatedAt, offeringId: "offering-annual-stage-1", recurrenceKind: "weekly", firstDate: "2026-09-08", weeklyWeekday: "Мягмар", academicYearId: "", stageCode: "", weekday: "", startTime: "16:00", endTime: "17:20", capacity: 8, registrationOpen: true });
  assert.equal(database.query(`SELECT status FROM class_session WHERE id = ${quote(newClass.id)}`)[0].status, "available", "teacher-facing open registration maps to the available catalog state");
  const openedClass = database.query(`SELECT updated_at AS updatedAt FROM class_session WHERE id = ${quote(newClass.id)}`)[0];
  await service.deleteClassSession(runtime, actor("teacher"), { classSessionId: newClass.id, expectedUpdatedAt: openedClass.updatedAt });
  assert.equal(count(database, "class_session", `id = ${quote(newClass.id)}`), 0, "an unused class can be deleted");
  sqlite(`INSERT INTO curriculum_program (
    id, program_family_id, academic_year_id, stage_code, revision_number, display_name,
    program_kind, status, based_on_program_id, is_test, test_run_id, created_at, updated_at
  ) VALUES ('isolated-staging-test-draft', 'annual-program-stage_1', 'year-2026', 'stage_1', 50, 'Тусгаарлагдсан тест', 'annual_course', 'draft', NULL, 1, 'staging-catalog-fixture', '${now}', '${now}');`);
  const cleanOverview = await service.getProgramCalendarOverview(runtime);
  assert.equal(cleanOverview.programFamilies.find((entry) => entry.id === "annual-program-stage_1").draftProgram, null, "an isolated staging test draft is hidden from ordinary Program work");
  await service.startProgramFamilyDraft(runtime, actor("teacher"), { programFamilyId: "annual-program-stage_1" });
  const copied = database.query("SELECT id, updated_at AS updatedAt FROM curriculum_program WHERE program_family_id = 'annual-program-stage_1' AND status = 'draft' AND based_on_program_id IS NOT NULL")[0];
  assert.equal(count(database, "curriculum_lesson", "curriculum_program_id = 'old-program'"), 3);
  assert.equal(count(database, "curriculum_lesson", `curriculum_program_id = ${quote(copied.id)}`), 3);
  assert.equal(count(database, "curriculum_lesson", `curriculum_program_id = ${quote(copied.id)} AND id LIKE 'old-%'`), 0, "copied program has new lesson identities");
  const thirdLesson = database.query(`SELECT id FROM curriculum_lesson WHERE curriculum_program_id = ${quote(copied.id)} AND sequence_number = 3`)[0];
  await service.insertProgramDraftLesson(runtime, actor("teacher"), { programId: copied.id, expectedUpdatedAt: copied.updatedAt, beforeLessonId: thirdLesson.id, title: "Нэмэлт хичээл" });
  let revisedDraft = database.query(`SELECT updated_at AS updatedAt FROM curriculum_program WHERE id = ${quote(copied.id)}`)[0];
  const persistedProgramOverview = await service.getProgramCalendarOverview(runtime);
  const persistedFamily = persistedProgramOverview.programFamilies.find((entry) => entry.id === "annual-program-stage_1");
  assert.equal(persistedFamily.currentProgram.id, "current-program", "a working Program edit leaves the current pointer unchanged before final save");
  assert.equal(persistedFamily.draftProgram.id, copied.id, "a working Program draft is recoverable from a fresh server overview");
  assert.equal(persistedFamily.draftProgram.lessons[2].title, "Нэмэлт хичээл", "an inserted Program lesson survives reload before final save");
  const insertedLesson = database.query(`SELECT id FROM curriculum_lesson WHERE curriculum_program_id = ${quote(copied.id)} AND title = 'Нэмэлт хичээл'`)[0];
  assert.deepEqual(database.query(`SELECT title FROM curriculum_lesson WHERE curriculum_program_id = ${quote(copied.id)} ORDER BY sequence_number`).map((entry) => entry.title), ["Одоогийн туршилт 1", "Одоогийн туршилт 2", "Нэмэлт хичээл", "Одоогийн туршилт 3"], "inserting before lesson C renumbers C and later lessons automatically");
  await service.insertProgramDraftLesson(runtime, actor("teacher"), { programId: copied.id, expectedUpdatedAt: revisedDraft.updatedAt, title: "Төгсгөлийн хичээл" });
  revisedDraft = database.query(`SELECT updated_at AS updatedAt FROM curriculum_program WHERE id = ${quote(copied.id)}`)[0];
  assert.deepEqual(database.query(`SELECT title FROM curriculum_lesson WHERE curriculum_program_id = ${quote(copied.id)} ORDER BY sequence_number`).map((entry) => entry.title), ["Одоогийн туршилт 1", "Одоогийн туршилт 2", "Нэмэлт хичээл", "Одоогийн туршилт 3", "Төгсгөлийн хичээл"], "append adds a lesson at the final sequence");
  await service.deleteProgramDraftLesson(runtime, actor("teacher"), { programId: copied.id, expectedUpdatedAt: revisedDraft.updatedAt, lessonId: insertedLesson.id });
  revisedDraft = database.query(`SELECT updated_at AS updatedAt FROM curriculum_program WHERE id = ${quote(copied.id)}`)[0];
  assert.deepEqual(database.query(`SELECT title FROM curriculum_lesson WHERE curriculum_program_id = ${quote(copied.id)} ORDER BY sequence_number`).map((entry) => entry.title), ["Одоогийн туршилт 1", "Одоогийн туршилт 2", "Одоогийн туршилт 3", "Төгсгөлийн хичээл"], "deleting a lesson shifts later lessons upward without gaps");
  const lastOriginalLesson = database.query(`SELECT id FROM curriculum_lesson WHERE curriculum_program_id = ${quote(copied.id)} AND title = 'Одоогийн туршилт 3'`)[0];
  await service.moveProgramDraftLesson(runtime, actor("teacher"), { programId: copied.id, expectedUpdatedAt: revisedDraft.updatedAt, lessonId: lastOriginalLesson.id, direction: "up" });
  revisedDraft = database.query(`SELECT updated_at AS updatedAt FROM curriculum_program WHERE id = ${quote(copied.id)}`)[0];
  assert.deepEqual(database.query(`SELECT title, sequence_number AS sequenceNumber FROM curriculum_lesson WHERE curriculum_program_id = ${quote(copied.id)} ORDER BY sequence_number`).map((entry) => [entry.title, entry.sequenceNumber]), [["Одоогийн туршилт 1", 1], ["Одоогийн туршилт 3", 2], ["Одоогийн туршилт 2", 3], ["Төгсгөлийн хичээл", 4]], "moving a lesson preserves contiguous sequence numbers");
  await service.renameProgramDraftLesson(runtime, actor("teacher"), { programId: copied.id, expectedUpdatedAt: revisedDraft.updatedAt, lessonId: lastOriginalLesson.id, title: "Шинэчилсэн хичээл" });
  revisedDraft = database.query(`SELECT updated_at AS updatedAt FROM curriculum_program WHERE id = ${quote(copied.id)}`)[0];
  assert.deepEqual(database.query(`SELECT sequence_number AS sequenceNumber FROM curriculum_lesson WHERE curriculum_program_id = ${quote(copied.id)} ORDER BY sequence_number`).map((entry) => entry.sequenceNumber), [1, 2, 3, 4], "lesson operations preserve one explicit sequence");
  await assert.rejects(() => service.renameProgramDraftLesson(runtime, actor("teacher"), { programId: copied.id, expectedUpdatedAt: copied.updatedAt, lessonId: "missing", title: "Хуучин хүсэлт" }), /Program and calendar/);
  const saved = database.query(`SELECT updated_at AS updatedAt FROM curriculum_program WHERE id = ${quote(copied.id)}`)[0];
  await service.publishProgramFamilyDraft(runtime, actor("teacher"), { programId: copied.id, expectedUpdatedAt: saved.updatedAt });
  assert.equal(count(database, "curriculum_program", `id = ${quote(copied.id)} AND status = 'published'`), 1);
  assert.equal(database.query("SELECT current_published_program_id AS programId FROM curriculum_program_family WHERE id = 'annual-program-stage_1'")[0].programId, copied.id, "final Program save moves only the family current pointer");
  assert.equal(count(database, "curriculum_program", "id = 'current-program' AND status = 'superseded'"), 1, "the prior Program revision remains immutable history after save");
  assert.equal(database.query("SELECT curriculum_program_id AS programId FROM activity_offering WHERE id = 'offering-annual-stage-1'")[0].programId, "current-program", "publishing a Program revision leaves existing Offerings pinned");
  const programRevisionCount = count(database, "curriculum_program", "program_family_id = 'annual-program-stage_1'");
  await service.startProgramFamilyDraft(runtime, actor("teacher"), { programFamilyId: "annual-program-stage_1" });
  const unchangedProgramDraft = database.query("SELECT id, updated_at AS updatedAt FROM curriculum_program WHERE program_family_id = 'annual-program-stage_1' AND status = 'draft' AND based_on_program_id IS NOT NULL")[0];
  await service.publishProgramFamilyDraft(runtime, actor("teacher"), { programId: unchangedProgramDraft.id, expectedUpdatedAt: unchangedProgramDraft.updatedAt });
  assert.equal(count(database, "curriculum_program", "program_family_id = 'annual-program-stage_1'"), programRevisionCount, "a no-op Program save creates no duplicate current revision");
  assert.equal(database.query("SELECT current_published_program_id AS programId FROM curriculum_program_family WHERE id = 'annual-program-stage_1'")[0].programId, copied.id, "a no-op Program save leaves the current pointer unchanged");
  await service.startProgramFamilyDraft(runtime, actor("teacher"), { programFamilyId: "annual-program-stage_1" });
  const discardedProgramDraft = database.query("SELECT id, updated_at AS updatedAt FROM curriculum_program WHERE program_family_id = 'annual-program-stage_1' AND status = 'draft' AND based_on_program_id IS NOT NULL")[0];
  await service.insertProgramDraftLesson(runtime, actor("teacher"), { programId: discardedProgramDraft.id, expectedUpdatedAt: discardedProgramDraft.updatedAt, title: "Устгах туршилтын хичээл" });
  const discardProgramVersion = database.query(`SELECT updated_at AS updatedAt FROM curriculum_program WHERE id = ${quote(discardedProgramDraft.id)}`)[0];
  await service.discardProgramFamilyDraft(runtime, actor("teacher"), { programFamilyId: "annual-program-stage_1", expectedUpdatedAt: discardProgramVersion.updatedAt });
  assert.equal(count(database, "curriculum_program", "program_family_id = 'annual-program-stage_1' AND status = 'draft' AND based_on_program_id IS NOT NULL"), 0, "whole Program cancel removes the persisted working draft");
  assert.equal(database.query("SELECT current_published_program_id AS programId FROM curriculum_program_family WHERE id = 'annual-program-stage_1'")[0].programId, copied.id, "whole Program cancel preserves the saved current pointer");
  sqlite(`INSERT INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_current, is_test, test_run_id, created_at, updated_at)
    VALUES ('year-current-save-test', 'Хадгалалтын тест', 'draft', '2027-09-01', '2028-06-01', 0, 1, 'staff-program-test', '${now}', '${now}');`);
  await offeringService.saveActivityOffering(runtime, actor("teacher"), { kind: "annual_course", annualStageCode: "stage_1", startsOn: "2027-09-01", endsOn: "2028-06-01" });
  assert.equal(count(database, "activity_offering", `curriculum_program_id = ${quote(copied.id)}`), 1, "a new annual Offering resolves the newly saved current Program");
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
  sqlite(`INSERT INTO guardian_account (id, full_name, primary_phone, primary_phone_normalized, email, email_normalized, home_address, status, is_test, test_run_id, created_at, updated_at)
    VALUES ('capacity-guardian', 'Тест асран', '99000000', '99000000', 'confirmed@example.test', 'confirmed@example.test', 'Хаяг', 'active', 1, 'staff-program-test', '${now}', '${now}');
    INSERT INTO student (id, surname, given_name, gender, date_of_birth, status, is_test, test_run_id, created_at, updated_at)
    VALUES ('capacity-student', 'Тест', 'Баталгаатай', 'not_specified', '2015-01-01', 'active', 1, 'staff-program-test', '${now}', '${now}');
    INSERT INTO pre_registration (id, guardian_id, academic_year_id, status, is_test, test_run_id, created_at, updated_at)
    VALUES ('capacity-pre-registration', 'capacity-guardian', 'year-2026', 'completed', 1, 'staff-program-test', '${now}', '${now}');
    INSERT INTO application_child (id, pre_registration_id, student_id, current_grade, returning_status, status, is_test, test_run_id, created_at, updated_at)
    VALUES ('capacity-application-child', 'capacity-pre-registration', 'capacity-student', 5, 'new', 'enrolled', 1, 'staff-program-test', '${now}', '${now}');
    INSERT INTO enrollment (id, application_child_id, student_id, academic_year_id, class_session_id, status, confirmed_at, is_test, test_run_id, created_at, updated_at)
    VALUES ('capacity-enrollment', 'capacity-application-child', 'capacity-student', 'year-2026', 'class-1', 'confirmed', '${now}', 1, 'staff-program-test', '${now}', '${now}');`);
  for (const suffix of ["one", "two"]) {
    sqlite(`INSERT INTO registration_draft (id, access_token_hash, academic_year_id, guardian_full_name, guardian_relationship, primary_phone, email, normalized_email, home_address, payment_plan_code, parent_rules_version, student_rules_version, status, expires_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('capacity-draft-${suffix}', '${suffix.padEnd(64, "a")}', 'year-2026', 'Тест асран', 'Ээж', '99000000', '${suffix}@example.test', '${suffix}@example.test', 'Хаяг', 'single', 'p', 's', 'awaiting_initial_payment', '2030-01-01T00:00:00.000Z', 1, 'staff-program-test', '${now}', '${now}');
      INSERT INTO registration_draft_child (id, registration_draft_id, position, surname, given_name, gender, date_of_birth, current_grade, returning_status, selected_stage_code, selected_class_session_id, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('capacity-child-${suffix}', 'capacity-draft-${suffix}', 0, 'Тест', '${suffix}', 'not_specified', '2015-01-01', '5', 'new', 'stage_1', 'class-1', 'awaiting_initial_payment', 1, 'staff-program-test', '${now}', '${now}');
      INSERT INTO registration_capacity_hold (id, registration_draft_child_id, class_session_id, hold_type, status, deadline_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('capacity-hold-${suffix}', 'capacity-child-${suffix}', 'class-1', 'initial_payment', 'active', '2030-01-01T00:00:00.000Z', 1, 'staff-program-test', '${now}', '${now}');`);
  }
  for (const suffix of ["a", "b"]) {
    sqlite(`INSERT INTO registration_draft (id, access_token_hash, academic_year_id, guardian_full_name, guardian_relationship, primary_phone, email, normalized_email, home_address, payment_plan_code, parent_rules_version, student_rules_version, status, expires_at, is_test, test_run_id, created_at, updated_at)
      VALUES ('capacity-wait-draft-${suffix}', '${suffix.padEnd(64, "b")}', 'year-2026', 'Тест асран', 'Ээж', '99000000', 'wait-${suffix}@example.test', 'wait-${suffix}@example.test', 'Хаяг', 'single', 'p', 's', 'waitlisted', '2030-01-01T00:00:00.000Z', 1, 'staff-program-test', '${now}', '${now}');
      INSERT INTO registration_draft_child (id, registration_draft_id, position, surname, given_name, gender, date_of_birth, current_grade, returning_status, selected_stage_code, preferred_waitlist_class_session_id, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('capacity-wait-child-${suffix}', 'capacity-wait-draft-${suffix}', 0, 'Тест', 'Хүлээлт ${suffix}', 'not_specified', '2015-01-01', '5', 'new', 'stage_1', 'class-1', 'waitlisted', 1, 'staff-program-test', '${now}', '${now}');
      INSERT INTO registration_draft_waitlist_entry (id, registration_draft_child_id, class_session_id, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('capacity-wait-entry-${suffix}', 'capacity-wait-child-${suffix}', 'class-1', 'active', 1, 'staff-program-test', '${now}', '${now}');`);
  }
  const classSave = (capacity) => ({ id: "class-1", expectedUpdatedAt: database.query("SELECT updated_at AS updatedAt FROM class_session WHERE id = 'class-1'")[0].updatedAt,
    offeringId: "offering-annual-stage-1", recurrenceKind: "weekly", firstDate: "2026-09-05", weeklyWeekday: "Бямба", academicYearId: "", stageCode: "", weekday: "", startTime: "10:00", endTime: "11:20", capacity, registrationOpen: true });
  const capacityBeforeConcurrentHold = database.query("SELECT capacity FROM class_session WHERE id = 'class-1'")[0].capacity;
  const lowerBoundaryBeforeRegistration = classSave(3);
  sqlite(`INSERT INTO registration_draft (id, access_token_hash, academic_year_id, guardian_full_name, guardian_relationship, primary_phone, email, normalized_email, home_address, payment_plan_code, parent_rules_version, student_rules_version, status, expires_at, is_test, test_run_id, created_at, updated_at)
    VALUES ('capacity-draft-race', '${"race".padEnd(64, "c")}', 'year-2026', 'Тест асран', 'Ээж', '99000000', 'race@example.test', 'race@example.test', 'Хаяг', 'single', 'p', 's', 'awaiting_initial_payment', '2030-01-01T00:00:00.000Z', 1, 'staff-program-test', '${now}', '${now}');
    INSERT INTO registration_draft_child (id, registration_draft_id, position, surname, given_name, gender, date_of_birth, current_grade, returning_status, selected_stage_code, selected_class_session_id, status, is_test, test_run_id, created_at, updated_at)
    VALUES ('capacity-child-race', 'capacity-draft-race', 0, 'Тест', 'Уралдаан', 'not_specified', '2015-01-01', '5', 'new', 'stage_1', 'class-1', 'awaiting_initial_payment', 1, 'staff-program-test', '${now}', '${now}');
    INSERT INTO registration_capacity_hold (id, registration_draft_child_id, class_session_id, hold_type, status, deadline_at, is_test, test_run_id, created_at, updated_at)
    VALUES ('capacity-hold-race', 'capacity-child-race', 'class-1', 'initial_payment', 'active', '2030-01-01T00:00:00.000Z', 1, 'staff-program-test', '${now}', '${now}');`);
  await assert.rejects(() => service.saveClassSession(runtime, actor("teacher"), lowerBoundaryBeforeRegistration), /Program and calendar/, "a capacity decrease rechecks consumption inside its conditional update when a registration hold arrives without changing the class version");
  assert.equal(database.query("SELECT capacity FROM class_session WHERE id = 'class-1'")[0].capacity, capacityBeforeConcurrentHold, "the stale lower-bound update cannot leave capacity below the newly consumed fourth seat");
  sqlite("UPDATE registration_capacity_hold SET status = 'released' WHERE id = 'capacity-hold-race';");
  await service.saveClassSession(runtime, actor("teacher"), classSave(3));
  assert.equal(database.query("SELECT capacity FROM class_session WHERE id = 'class-1'")[0].capacity, 3, "a referenced class may reduce capacity to its consumed lower bound");
  assert.equal(count(database, "registration_capacity_hold", "class_session_id = 'class-1' AND status = 'active'"), 2, "capacity reduction never releases existing holds");
  assert.equal(count(database, "enrollment", "class_session_id = 'class-1' AND status = 'confirmed'"), 1, "capacity reduction never releases confirmed enrollment");
  await assert.rejects(() => service.saveClassSession(runtime, actor("teacher"), classSave(2)), /Program and calendar/, "capacity cannot drop below confirmed, reserved, and offered seats");
  await service.saveClassSession(runtime, actor("teacher"), classSave(4));
  assert.equal(count(database, "waitlist_seat_offer", "class_session_id = 'class-1' AND status = 'active'"), 1, "a capacity increase reserves the first FIFO waitlist seat atomically");
  assert.equal(database.query("SELECT status FROM registration_draft_waitlist_entry WHERE id = 'capacity-wait-entry-a'")[0].status, "offered", "the first FIFO entry receives the offer");
  assert.equal(database.query("SELECT status FROM registration_draft_waitlist_entry WHERE id = 'capacity-wait-entry-b'")[0].status, "active", "the next FIFO entry remains waiting");
  const capacityDiagnostic = await (await import(pathToFileURL(path.join(tempDir, "capacity.mjs")).href).catch(async () => {
    const output = path.join(tempDir, "capacity.mjs"); const bundled = spawnSync(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/server/services/class-capacity.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${output}`], { encoding: "utf8" });
    if (bundled.status !== 0) throw new Error(bundled.stderr); return import(pathToFileURL(output).href);
  })).getClassCapacityDiagnostic(database, "staging", "class-1", new Date(now));
  assert.equal(capacityDiagnostic.projection.freeSeats, 0, "an offered waitlist seat keeps the newly increased public capacity unavailable");
  assert.equal(capacityDiagnostic.confirmed.length, 1, "the diagnostic exposes the confirmed enrollment contributor exactly once");
  assert.equal(capacityDiagnostic.reservedInitialPayment.length, 2, "the diagnostic exposes each active initial-payment contributor without changing data");
  assert.equal(capacityDiagnostic.offeredWaitlist.length, 1, "the diagnostic exposes the active waitlist offer exactly once");
  sqlite(`INSERT INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_current, is_test, test_run_id, created_at, updated_at)
    VALUES ('legacy-capacity-year', 'Хуучин суудлын тестийн жил', 'draft', '2026-09-01', '2027-06-01', 0, 1, 'staff-program-test', '${now}', '${now}');
    INSERT INTO activity_offering (id, kind, title, academic_year_id, stage_code, starts_on, ends_on, curriculum_program_id, use_academic_year_breaks, charge_mode, status, is_test, test_run_id, created_at, updated_at)
    VALUES ('legacy-capacity-offering', 'annual_course', 'Хуучин суудлын тест', 'legacy-capacity-year', 'stage_1', '2026-09-01', '2027-06-01', NULL, 1, 'paid', 'active', 1, 'staff-program-test', '${now}', '${now}');
    INSERT INTO class_session (id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, is_test, test_run_id, created_at, updated_at, activity_offering_id)
    VALUES ('legacy-capacity-class', 'legacy-capacity-year', 'stage_1', 'Хуучин суудлын анги', 'Бямба', '10:00', '11:20', 8, 'closed', 1, 'staff-program-test', '${now}', '${now}', 'legacy-capacity-offering');
    INSERT INTO class_meeting_rule (class_session_id, recurrence_kind, first_date, last_date, weekly_weekday, start_time, end_time, created_at, updated_at)
    VALUES ('legacy-capacity-class', 'weekly', '2026-09-05', NULL, 'Бямба', '10:00', '11:20', '${now}', '${now}');
    INSERT INTO class_calendar (id, class_session_id, timezone, status, is_test, test_run_id, created_at, updated_at)
    VALUES ('legacy-capacity-calendar', 'legacy-capacity-class', 'Asia/Ulaanbaatar', 'active', 1, 'staff-program-test', '${now}', '${now}');`);
  await service.saveClassSession(runtime, actor("teacher"), {
    id: "legacy-capacity-class", expectedUpdatedAt: now, offeringId: "legacy-capacity-offering",
    recurrenceKind: "weekly", firstDate: "2026-09-05", weeklyWeekday: "Бямба",
    academicYearId: "", stageCode: "", weekday: "", startTime: "10:00", endTime: "11:20",
    capacity: 3, registrationOpen: false,
  });
  assert.equal(database.query("SELECT capacity FROM class_session WHERE id = 'legacy-capacity-class'")[0].capacity, 3, "a referenced legacy class without a program pin can still receive a safe capacity correction");
  const legacyCapacityUpdatedAt = database.query("SELECT updated_at AS updatedAt FROM class_session WHERE id = 'legacy-capacity-class'")[0].updatedAt;
  await assert.rejects(() => service.saveClassSession(runtime, actor("teacher"), {
    id: "legacy-capacity-class", expectedUpdatedAt: legacyCapacityUpdatedAt, offeringId: "legacy-capacity-offering",
    recurrenceKind: "weekly", firstDate: "2026-09-05", weeklyWeekday: "Бямба",
    academicYearId: "", stageCode: "", weekday: "", startTime: "11:00", endTime: "12:20",
    capacity: 3, registrationOpen: false,
  }), /Program and calendar/, "a legacy Offering without a program pin cannot use capacity editing to alter its schedule");
  const usedOffering = database.query("SELECT updated_at AS updatedAt, starts_on AS startsOn, ends_on AS endsOn, curriculum_program_id AS programId FROM activity_offering WHERE id = 'offering-annual-stage-1'")[0];
  await offeringService.saveActivityOffering(runtime, actor("teacher"), { id: "offering-annual-stage-1", expectedUpdatedAt: usedOffering.updatedAt, kind: "annual_course", startsOn: usedOffering.startsOn, endsOn: usedOffering.endsOn, curriculumProgramId: usedOffering.programId, useAcademicYearBreaks: true, chargeMode: "paid", facebookGroupUrl: "https://facebook.com/groups/after-publication" });
  assert.equal(database.query("SELECT facebook_group_url AS url FROM activity_offering WHERE id = 'offering-annual-stage-1'")[0].url, "https://facebook.com/groups/after-publication", "a harmless Offering communication edit remains possible after calendar publication");
  const usedOfferingAfterCommunication = database.query("SELECT updated_at AS updatedAt FROM activity_offering WHERE id = 'offering-annual-stage-1'")[0];
  await assert.rejects(() => offeringService.saveActivityOffering(runtime, actor("teacher"), { id: "offering-annual-stage-1", expectedUpdatedAt: usedOfferingAfterCommunication.updatedAt, kind: "annual_course", startsOn: "2026-09-02", curriculumProgramId: usedOffering.programId, useAcademicYearBreaks: true, chargeMode: "paid" }), /Offering operation/, "a used Offering period cannot invalidate calendar history");
  sqlite(`INSERT INTO academic_year_break (id, academic_year_id, label, starts_on, ends_on, excludes_habitual_slots, status, is_test, test_run_id, created_at, updated_at)
    VALUES ('school-restore-break', 'year-2026', 'Өвлийн амралт', '2026-09-12', '2026-09-12', 1, 'active', 1, 'staff-program-test', '${now}', '${now}');`);
  await service.createCalendarChangeDraft(runtime, actor("teacher"), { classSessionId: "class-1" });
  draft = database.query("SELECT revision.id, revision.updated_at AS updatedAt, revision.locked_through_sequence AS protectedThrough FROM class_calendar_revision AS revision INNER JOIN class_calendar AS calendar ON calendar.id = revision.class_calendar_id WHERE calendar.class_session_id = 'class-1' AND revision.status = 'draft'")[0];
  assert.equal(draft.protectedThrough, 1, "an existing stored historical prefix remains protected even without a teacher lock control");
  const holidaySkippedOverview = await service.getProgramCalendarOverview(runtime);
  assert.equal(holidaySkippedOverview.revisions.find((entry) => entry.id === draft.id).slots.find((slot) => slot.localDate === "2026-09-12").schoolHolidayNoClass, true, "a school-calendar no-class row retains restore context without a redundant overlap warning");
  await service.changeCalendarDraft(runtime, actor("teacher"), { revisionId: draft.id, expectedUpdatedAt: draft.updatedAt, kind: "restore", localDate: "2026-09-12" });
  draft = database.query(`SELECT id, updated_at AS updatedAt, locked_through_sequence AS protectedThrough FROM class_calendar_revision WHERE id = ${quote(draft.id)}`)[0];
  assert.equal(count(database, "class_calendar_slot", `class_calendar_revision_id = ${quote(draft.id)} AND local_date = '2026-09-12' AND status = 'scheduled'`), 1, "a teacher may restore a school-calendar skipped date for one class");
  const restoredOverview = await service.getProgramCalendarOverview(runtime);
  assert.ok(restoredOverview.revisions.find((entry) => entry.id === draft.id).slots.find((slot) => slot.localDate === "2026-09-12").holidayWarnings.includes("Өвлийн амралт"), "a restored school-holiday lesson keeps its warning");
  const holidayRestoredMapping = database.query(`SELECT lesson.sequence_number AS sequenceNumber, slot.local_date AS localDate FROM class_calendar_slot AS slot INNER JOIN curriculum_lesson AS lesson ON lesson.id = slot.curriculum_lesson_id WHERE slot.class_calendar_revision_id = ${quote(draft.id)} AND slot.status = 'scheduled' ORDER BY lesson.sequence_number`);
  const holidayRestoredSlot = database.query(`SELECT id FROM class_calendar_slot WHERE class_calendar_revision_id = ${quote(draft.id)} AND local_date = '2026-09-12' AND status = 'scheduled'`)[0];
  await service.cancelFutureCalendarSlot(runtime, actor("teacher"), { revisionId: draft.id, expectedUpdatedAt: draft.updatedAt, slotId: holidayRestoredSlot.id });
  draft = database.query(`SELECT id, updated_at AS updatedAt, locked_through_sequence AS protectedThrough FROM class_calendar_revision WHERE id = ${quote(draft.id)}`)[0];
  const returnedHolidaySlot = database.query(`SELECT status, curriculum_lesson_id AS lessonId, cancelled_lesson_title AS cancelledLessonTitle, reason_label AS reasonLabel FROM class_calendar_slot WHERE class_calendar_revision_id = ${quote(draft.id)} AND local_date = '2026-09-12'`)[0];
  assert.deepEqual(returnedHolidaySlot, { status: "no_class", lessonId: null, cancelledLessonTitle: null, reasonLabel: "Өвлийн амралт" }, "returning a restored school-holiday slot to no-class restores the holiday reason instead of a displaced lesson title");
  const holidayReflowedMapping = database.query(`SELECT lesson.sequence_number AS sequenceNumber, slot.local_date AS localDate FROM class_calendar_slot AS slot INNER JOIN curriculum_lesson AS lesson ON lesson.id = slot.curriculum_lesson_id WHERE slot.class_calendar_revision_id = ${quote(draft.id)} AND slot.status = 'scheduled' ORDER BY lesson.sequence_number`);
  assert.notEqual(holidayReflowedMapping.find((entry) => entry.sequenceNumber === holidayRestoredMapping.find((entry) => entry.localDate === "2026-09-12")?.sequenceNumber)?.localDate, "2026-09-12", "the restored holiday lesson reflows forward when the date returns to no-class");
  assert.equal(Number(database.query(`SELECT COUNT(*) AS count FROM (SELECT curriculum_lesson_id FROM class_calendar_slot WHERE class_calendar_revision_id = ${quote(draft.id)} AND status = 'scheduled' GROUP BY curriculum_lesson_id HAVING COUNT(*) > 1)`)[0].count), 0, "returning a holiday date to no-class cannot duplicate a lesson");
  await service.changeCalendarDraft(runtime, actor("teacher"), { revisionId: draft.id, expectedUpdatedAt: draft.updatedAt, kind: "restore", localDate: "2026-09-12" });
  draft = database.query(`SELECT id, updated_at AS updatedAt, locked_through_sequence AS protectedThrough FROM class_calendar_revision WHERE id = ${quote(draft.id)}`)[0];
  assert.deepEqual(database.query(`SELECT lesson.sequence_number AS sequenceNumber, slot.local_date AS localDate FROM class_calendar_slot AS slot INNER JOIN curriculum_lesson AS lesson ON lesson.id = slot.curriculum_lesson_id WHERE slot.class_calendar_revision_id = ${quote(draft.id)} AND slot.status = 'scheduled' ORDER BY lesson.sequence_number`), holidayRestoredMapping, "restoring the holiday date again returns the exact original lesson mapping");
  const breakBeforeWarningChange = database.query("SELECT updated_at AS updatedAt FROM academic_year_break WHERE id = 'school-restore-break'")[0];
  const calendarSlotsBeforeWarningChange = database.query(`SELECT id, status FROM class_calendar_slot WHERE class_calendar_revision_id = ${quote(draft.id)} ORDER BY id`);
  await service.saveAcademicYearBreak(runtime, actor("teacher"), { id: "school-restore-break", expectedUpdatedAt: breakBeforeWarningChange.updatedAt, academicYearId: "year-2026", label: "Өвлийн амралт", startsOn: "2026-09-12", endsOn: "2026-09-12", excludeFromGeneration: true, warnOnOverlap: false });
  const warningSuppressedOverview = await service.getProgramCalendarOverview(runtime);
  assert.equal(warningSuppressedOverview.revisions.find((entry) => entry.id === draft.id).slots.find((slot) => slot.localDate === "2026-09-12").holidayWarnings.length, 0, "turning off overlap guidance removes the current warning without moving the lesson");
  assert.deepEqual(database.query(`SELECT id, status FROM class_calendar_slot WHERE class_calendar_revision_id = ${quote(draft.id)} ORDER BY id`), calendarSlotsBeforeWarningChange, "holiday guidance changes never rewrite explicit calendar slots");
  const breakBeforeRestoreWarning = database.query("SELECT updated_at AS updatedAt FROM academic_year_break WHERE id = 'school-restore-break'")[0];
  await service.saveAcademicYearBreak(runtime, actor("teacher"), { id: "school-restore-break", expectedUpdatedAt: breakBeforeRestoreWarning.updatedAt, academicYearId: "year-2026", label: "Өвлийн амралт", startsOn: "2026-09-12", endsOn: "2026-09-12", excludeFromGeneration: true, warnOnOverlap: true });
  assert.equal(restoredOverview.revisions.find((entry) => entry.classSessionId === "class-1" && entry.status === "published").id !== draft.id, true, "a saved calendar stays current until the working change is finally saved");
  await service.publishCalendarDraft(runtime, actor("teacher"), { revisionId: draft.id, expectedUpdatedAt: draft.updatedAt });
  assert.equal(database.query(`SELECT status FROM class_calendar_revision WHERE id = ${quote(draft.id)}`)[0].status, "published", "a saved holiday restore becomes the next immutable calendar revision");
  await service.createCalendarChangeDraft(runtime, actor("teacher"), { classSessionId: "class-1" });
  draft = database.query("SELECT revision.id, revision.updated_at AS updatedAt FROM class_calendar_revision AS revision INNER JOIN class_calendar AS calendar ON calendar.id = revision.class_calendar_id WHERE calendar.class_session_id = 'class-1' AND revision.status = 'draft'")[0];
  assert.equal(count(database, "class_calendar_revision_override", `class_calendar_revision_id = ${quote(draft.id)} AND behavior = 'restore'`), 1, "a later change draft safely copies an optional-note holiday restore as SQL NULL rather than an unsupported value");
  assert.equal(count(database, "class_calendar_revision", "status = 'draft' AND class_calendar_id = (SELECT id FROM class_calendar WHERE class_session_id = 'class-1')"), 1, "a later row action creates one recoverable internal calendar draft");
  await service.createCalendarChangeDraft(runtime, actor("teacher"), { classSessionId: "class-1" });
  assert.equal(count(database, "class_calendar_revision", "status = 'draft' AND class_calendar_id = (SELECT id FROM class_calendar WHERE class_session_id = 'class-1')"), 1, "reopening calendar editing resumes the existing working revision");
  const originalLessonMapping = database.query(`SELECT lesson.sequence_number AS sequenceNumber, slot.local_date AS localDate FROM class_calendar_slot AS slot INNER JOIN curriculum_lesson AS lesson ON lesson.id = slot.curriculum_lesson_id WHERE slot.class_calendar_revision_id = ${quote(draft.id)} AND slot.status = 'scheduled' ORDER BY lesson.sequence_number`);
  const futureSlot = database.query(`SELECT slot.id, slot.local_date AS localDate FROM class_calendar_slot AS slot INNER JOIN curriculum_lesson AS lesson ON lesson.id = slot.curriculum_lesson_id WHERE slot.class_calendar_revision_id = ${quote(draft.id)} AND lesson.sequence_number = 3`)[0];
  await service.cancelFutureCalendarSlot(runtime, actor("teacher"), { revisionId: draft.id, expectedUpdatedAt: draft.updatedAt, slotId: futureSlot.id });
  assert.equal(count(database, "class_calendar_slot", `class_calendar_revision_id = ${quote(draft.id)} AND status = 'cancelled'`), 1, "future cancellation remains visible history");
  const cancelledContext = database.query(`SELECT curriculum_lesson_id AS lessonId, cancelled_lesson_sequence AS sequenceNumber FROM class_calendar_slot WHERE class_calendar_revision_id = ${quote(draft.id)} AND status = 'cancelled'`)[0];
  assert.deepEqual(cancelledContext, { lessonId: null, sequenceNumber: 3 }, "a no-class context row does not retain a second authoritative lesson assignment");
  const reflowedLesson = database.query(`SELECT lesson.sequence_number AS sequenceNumber, slot.local_date AS localDate FROM class_calendar_slot AS slot INNER JOIN curriculum_lesson AS lesson ON lesson.id = slot.curriculum_lesson_id WHERE slot.class_calendar_revision_id = ${quote(draft.id)} AND slot.status = 'scheduled' ORDER BY lesson.sequence_number`);
  assert.deepEqual(reflowedLesson.map((entry) => entry.sequenceNumber), [1, 2, 3], "removing an active slot preserves the ordered Program lesson sequence");
  assert.notEqual(reflowedLesson.find((entry) => entry.sequenceNumber === 3)?.localDate, futureSlot.localDate, "the cancelled lesson reflows to a later active teaching slot instead of being deleted");
  const cancelledDraft = database.query(`SELECT updated_at AS updatedAt FROM class_calendar_revision WHERE id = ${quote(draft.id)}`)[0];
  await service.publishCalendarDraft(runtime, actor("teacher"), { revisionId: draft.id, expectedUpdatedAt: cancelledDraft.updatedAt });
  const cancelledPublishedOverview = await service.getProgramCalendarOverview(runtime);
  assert.equal(cancelledPublishedOverview.revisions.find((entry) => entry.classSessionId === "class-1" && entry.status === "published").slots.find((slot) => slot.status === "cancelled")?.cancelledLessonSequence, 3, "the manual no-class state survives save and overview reload before restoration");
  await service.createCalendarChangeDraft(runtime, actor("teacher"), { classSessionId: "class-1" });
  draft = database.query("SELECT revision.id, revision.updated_at AS updatedAt, revision.locked_through_sequence AS protectedThrough FROM class_calendar_revision AS revision INNER JOIN class_calendar AS calendar ON calendar.id = revision.class_calendar_id WHERE calendar.class_session_id = 'class-1' AND revision.status = 'draft'")[0];
  await service.restoreFutureCancelledCalendarSlot(runtime, actor("teacher"), { revisionId: draft.id, expectedUpdatedAt: draft.updatedAt, slotId: database.query(`SELECT id FROM class_calendar_slot WHERE class_calendar_revision_id = ${quote(draft.id)} AND status = 'cancelled'`)[0].id });
  const restoredMapping = database.query(`SELECT lesson.sequence_number AS sequenceNumber, slot.local_date AS localDate FROM class_calendar_slot AS slot INNER JOIN curriculum_lesson AS lesson ON lesson.id = slot.curriculum_lesson_id WHERE slot.class_calendar_revision_id = ${quote(draft.id)} AND slot.status = 'scheduled' ORDER BY lesson.sequence_number`);
  assert.deepEqual(restoredMapping, originalLessonMapping, "manual no-class restoration returns every lesson to its original ordered date");
  assert.equal(Number(database.query(`SELECT COUNT(*) AS count FROM (SELECT curriculum_lesson_id FROM class_calendar_slot WHERE class_calendar_revision_id = ${quote(draft.id)} AND status = 'scheduled' GROUP BY curriculum_lesson_id HAVING COUNT(*) > 1)`)[0].count), 0, "restoring a cancelled slot cannot duplicate a CurriculumLesson assignment");
  const restoredDraft = database.query(`SELECT updated_at AS updatedAt FROM class_calendar_revision WHERE id = ${quote(draft.id)}`)[0];
  await service.publishCalendarDraft(runtime, actor("teacher"), { revisionId: draft.id, expectedUpdatedAt: restoredDraft.updatedAt });
  const restoredPublishedOverview = await service.getProgramCalendarOverview(runtime);
  assert.deepEqual(restoredPublishedOverview.revisions.find((entry) => entry.classSessionId === "class-1" && entry.status === "published").slots.filter((slot) => slot.status === "scheduled").map((slot) => ({ sequenceNumber: slot.lessonSequence, localDate: slot.localDate })), originalLessonMapping, "the restored mapping survives calendar save and overview reload");
  await service.createCalendarChangeDraft(runtime, actor("teacher"), { classSessionId: "class-1" });
  draft = database.query("SELECT revision.id, revision.updated_at AS updatedAt, revision.locked_through_sequence AS protectedThrough FROM class_calendar_revision AS revision INNER JOIN class_calendar AS calendar ON calendar.id = revision.class_calendar_id WHERE calendar.class_session_id = 'class-1' AND revision.status = 'draft'")[0];
  const protectedSlot = database.query(`SELECT slot.id, lesson.sequence_number AS sequenceNumber, lesson.title AS lessonTitle FROM class_calendar_slot AS slot INNER JOIN curriculum_lesson AS lesson ON lesson.id = slot.curriculum_lesson_id WHERE slot.class_calendar_revision_id = ${quote(draft.id)} AND lesson.sequence_number = 1`)[0];
  sqlite(`UPDATE class_calendar_slot SET status = 'cancelled', curriculum_lesson_id = NULL, cancelled_lesson_sequence = ${protectedSlot.sequenceNumber}, cancelled_lesson_title = ${quote(protectedSlot.lessonTitle)} WHERE id = ${quote(protectedSlot.id)};`);
  await assert.rejects(() => service.restoreFutureCancelledCalendarSlot(runtime, actor("teacher"), { revisionId: draft.id, expectedUpdatedAt: draft.updatedAt, slotId: protectedSlot.id }), /Program and calendar/, "a historically protected no-class row cannot be restored through the future-slot action");
  sqlite(`UPDATE class_calendar_slot SET status = 'scheduled', curriculum_lesson_id = (SELECT id FROM curriculum_lesson WHERE sequence_number = 1 AND curriculum_program_id = (SELECT curriculum_program_id FROM class_calendar_revision WHERE id = ${quote(draft.id)})), cancelled_lesson_sequence = NULL, cancelled_lesson_title = NULL WHERE id = ${quote(protectedSlot.id)};`);
  const changedDraft = database.query(`SELECT updated_at AS updatedAt FROM class_calendar_revision WHERE id = ${quote(draft.id)}`)[0];
  await service.changeCalendarDraft(runtime, actor("teacher"), { revisionId: draft.id, expectedUpdatedAt: changedDraft.updatedAt, kind: "extra", localDate: "2026-09-16", startTime: "10:00", endTime: "11:20", reasonLabel: "Нөхөх хичээл" });
  const addedSlot = database.query(`SELECT lesson.sequence_number AS sequenceNumber, slot.local_date AS localDate FROM class_calendar_slot AS slot INNER JOIN curriculum_lesson AS lesson ON lesson.id = slot.curriculum_lesson_id WHERE slot.class_calendar_revision_id = ${quote(draft.id)} AND slot.status = 'scheduled' ORDER BY slot.local_date, slot.start_time`);
  assert.equal(addedSlot.find((entry) => entry.localDate === "2026-09-16")?.sequenceNumber, 3, "an extra dated slot joins chronological order after the retained restored holiday lesson");
  const changedCalendarDraft = database.query(`SELECT updated_at AS updatedAt FROM class_calendar_revision WHERE id = ${quote(draft.id)}`)[0];
  const previousCalendar = database.query("SELECT id FROM class_calendar_revision WHERE class_calendar_id = (SELECT id FROM class_calendar WHERE class_session_id = 'class-1') AND status = 'published'")[0];
  await service.publishCalendarDraft(runtime, actor("teacher"), { revisionId: draft.id, expectedUpdatedAt: changedCalendarDraft.updatedAt });
  assert.equal(database.query("SELECT status FROM class_calendar_revision WHERE id = " + quote(draft.id))[0].status, "published", "final calendar save publishes the persisted working revision");
  assert.equal(database.query("SELECT status FROM class_calendar_revision WHERE id = " + quote(previousCalendar.id))[0].status, "superseded", "final calendar save preserves the previous revision as history");
  await service.startProgramFamilyDraft(runtime, actor("teacher"), { programFamilyId: "annual-program-stage_1" });
  const staleDraft = database.query("SELECT id, updated_at AS updatedAt FROM curriculum_program WHERE program_family_id = 'annual-program-stage_1' AND status = 'draft' AND based_on_program_id IS NOT NULL")[0];
  sqlite(`
    INSERT INTO curriculum_program (id, program_family_id, academic_year_id, stage_code, revision_number, display_name, program_kind, status, based_on_program_id, is_test, test_run_id, created_at, updated_at)
      VALUES ('parallel-program', 'annual-program-stage_1', 'year-2026', 'stage_1', 90, 'Зэрэг засвар', 'annual_course', 'draft', ${quote(copied.id)}, 1, 'staff-program-test', '${now}', '${now}');
    INSERT INTO curriculum_lesson (id, curriculum_program_id, sequence_number, title, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('parallel-lesson', 'parallel-program', 1, 'Зэрэг хичээл', 'active', 1, 'staff-program-test', '${now}', '${now}');
    UPDATE curriculum_program SET status = 'superseded' WHERE id = ${quote(copied.id)};
    UPDATE curriculum_program SET status = 'published', published_at = '${now}' WHERE id = 'parallel-program';
    UPDATE curriculum_program_family SET current_published_program_id = 'parallel-program' WHERE id = 'annual-program-stage_1';
  `);
  await assert.rejects(() => service.publishProgramFamilyDraft(runtime, actor("teacher"), { programId: staleDraft.id, expectedUpdatedAt: staleDraft.updatedAt }), /Program and calendar/, "a stale draft cannot publish after another revision becomes current");
  await service.createSummerProgramFamilyDraft(runtime, actor("teacher"), { displayName: "Түр зуны ноорог" });
  const disposableSummer = database.query("SELECT id FROM curriculum_program_family WHERE display_name = 'Түр зуны ноорог'")[0];
  await service.deleteSummerProgramFamilyDraft(runtime, actor("teacher"), { programFamilyId: disposableSummer.id });
  assert.equal(count(database, "curriculum_program_family", `id = ${quote(disposableSummer.id)}`), 0, "an unreferenced summer draft family can be deleted safely");
  await service.createSummerProgramFamilyDraft(runtime, actor("teacher"), { displayName: "Ашигласан зуны хөтөлбөр" });
  const referencedDraft = database.query("SELECT id, updated_at AS updatedAt, program_family_id AS familyId FROM curriculum_program WHERE program_kind = 'summer_course' AND status = 'draft' ORDER BY created_at DESC LIMIT 1")[0];
  await service.insertProgramDraftLesson(runtime, actor("teacher"), { programId: referencedDraft.id, expectedUpdatedAt: referencedDraft.updatedAt, title: "Анхны хичээл" });
  const referencedSaved = database.query(`SELECT updated_at AS updatedAt FROM curriculum_program WHERE id = ${quote(referencedDraft.id)}`)[0];
  await service.publishProgramFamilyDraft(runtime, actor("teacher"), { programId: referencedDraft.id, expectedUpdatedAt: referencedSaved.updatedAt });
  await offeringService.saveActivityOffering(runtime, actor("teacher"), { kind: "summer_course", title: "Ашигласан зуны сургалт", startsOn: "2027-07-01", endsOn: "2027-07-10", programFamilyId: referencedDraft.familyId, defaultClassDurationMinutes: 95, initialClasses: [{ recurrenceKind: "daily", startTime: "14:00", capacity: 9 }] });
  const referencedOffering = database.query("SELECT id FROM activity_offering WHERE title = 'Ашигласан зуны сургалт'")[0];
  assert.equal(count(database, "class_session", `activity_offering_id = ${quote(referencedOffering.id)}`), 1, "offering and its requested initial class are created together");
  assert.equal(database.query(`SELECT end_time AS endTime FROM class_session WHERE activity_offering_id = ${quote(referencedOffering.id)}`)[0].endTime, "15:35", "initial class uses the teacher-selected Offering duration");
  await service.deleteSummerProgramFamilyDraft(runtime, actor("teacher"), { programFamilyId: referencedDraft.familyId });
  assert.equal(database.query(`SELECT status FROM curriculum_program_family WHERE id = ${quote(referencedDraft.familyId)}`)[0].status, "archived", "a referenced summer Program is retired instead of destroyed");
  sqlite(`
    UPDATE academic_year SET is_current = 0 WHERE is_current = 1;
    INSERT INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_current, is_test, test_run_id, created_at, updated_at)
      VALUES ('year-default-start-test', 'Анхны өдрийн тест', 'draft', '2028-09-01', '2029-06-01', 1, 1, 'staff-program-test', '${now}', '${now}');
  `);
  await offeringService.saveActivityOffering(runtime, actor("teacher"), {
    kind: "annual_course", annualStageCode: "stage_1", startsOn: "2035-10-01",
    initialClasses: [{ recurrenceKind: "weekly", weeklyWeekday: "Бямба", startTime: "10:00", capacity: 12 }],
  });
  const automaticShell = database.query("SELECT id, starts_on AS startsOn, ends_on AS endsOn FROM academic_year WHERE id = 'academic-year-2035-36'")[0];
  assert.deepEqual([automaticShell.startsOn, automaticShell.endsOn], ["2035-09-01", "2036-06-01"], "an annual Offering creates the missing dated academic-year shell without holiday periods");
  assert.equal(count(database, "academic_year_break", "academic_year_id = 'academic-year-2035-36'"), 0, "automatic shells do not fabricate holiday planning periods");
  await academicYearShellService.ensureAnnualAcademicYearShell(runtime, "2035-10-01", { isTest: 1, testRunId: "staff-program-test" });
  assert.equal(count(database, "academic_year", "id = 'academic-year-2035-36'"), 1, "repeated annual Offering saves reuse the deterministic academic-year shell");
  await Promise.all([
    academicYearShellService.ensureAnnualAcademicYearShell(runtime, "2037-10-01", { isTest: 1, testRunId: "staff-program-test" }),
    academicYearShellService.ensureAnnualAcademicYearShell(runtime, "2037-10-01", { isTest: 1, testRunId: "staff-program-test" }),
  ]);
  assert.equal(count(database, "academic_year", "id = 'academic-year-2037-38'"), 1, "concurrent shell resolution cannot create duplicate deterministic years");
  const shellClass = database.query("SELECT id FROM class_session WHERE academic_year_id = 'academic-year-2035-36' ORDER BY created_at LIMIT 1")[0];
  await service.generateCalendarDraft(runtime, actor("teacher"), { classSessionId: shellClass.id });
  const shellRevision = database.query("SELECT id FROM class_calendar_revision WHERE class_calendar_id IN (SELECT id FROM class_calendar WHERE class_session_id = " + quote(shellClass.id) + ")")[0];
  assert.equal(count(database, "class_calendar_slot", `class_calendar_revision_id = ${quote(shellRevision.id)} AND status = 'no_class'`), 0, "calendar generation without holiday periods has no automatic holiday exclusions");
  await offeringService.saveActivityOffering(runtime, actor("teacher"), {
    kind: "annual_course", annualStageCode: "stage_1", initialClasses: [{ recurrenceKind: "weekly", weeklyWeekday: "Бямба", startTime: "10:00", capacity: 12 }],
  });
  const defaultStartOffering = database.query("SELECT id, starts_on AS startsOn, ends_on AS endsOn, updated_at AS updatedAt FROM activity_offering WHERE academic_year_id = 'year-default-start-test'")[0];
  assert.equal(defaultStartOffering.startsOn, "2028-09-25", "a new annual Offering uses the admin-configured default start date");
  assert.equal(defaultStartOffering.endsOn, "2029-06-01", "annual Offering end remains the derived academic-year compatibility value");
  assert.equal(count(database, "class_session", `activity_offering_id = ${quote(defaultStartOffering.id)} AND status = 'closed'`), 1, "a newly created Offering atomically creates its requested closed class");
  await service.copyPreviousAcademicYearBreaks(runtime, actor("teacher"), { academicYearId: "year-default-start-test" });
  const copiedBreak = database.query("SELECT id, starts_on AS startsOn, exclude_from_generation AS excluded, warn_on_overlap AS warned FROM academic_year_break WHERE academic_year_id = 'year-default-start-test' ORDER BY starts_on LIMIT 1")[0];
  assert.ok(copiedBreak, "a dated shell with no periods can copy prior-year planning as editable rows");
  const sourceBreak = database.query("SELECT starts_on AS startsOn FROM academic_year_break WHERE academic_year_id = 'year-2026' ORDER BY starts_on LIMIT 1")[0];
  assert.equal(copiedBreak.startsOn.slice(0, 4), String(Number(sourceBreak.startsOn.slice(0, 4)) + 2), "copied holiday dates use the explicit calendar-year shift for review");
  const copiedUpdatedAt = database.query(`SELECT updated_at AS updatedAt FROM academic_year_break WHERE id = ${quote(copiedBreak.id)}`)[0].updatedAt;
  await service.saveAcademicYearBreak(runtime, actor("teacher"), { id: copiedBreak.id, expectedUpdatedAt: copiedUpdatedAt, academicYearId: "year-default-start-test", label: "Засаж шалгасан амралт", startsOn: copiedBreak.startsOn, endsOn: copiedBreak.startsOn, excludeFromGeneration: Boolean(copiedBreak.excluded), warnOnOverlap: Boolean(copiedBreak.warned) });
  assert.equal(database.query(`SELECT label FROM academic_year_break WHERE id = ${quote(copiedBreak.id)}`)[0].label, "Засаж шалгасан амралт", "copied holiday planning remains editable");
  assert.ok(count(database, "audit_event", "action LIKE 'program_%' OR action LIKE 'calendar_%'") >= 7, "meaningful staff actions are audited");
  const overview = await service.getProgramCalendarOverview(runtime);
  assert.equal(overview.publicSiteFont.font, "sans", "overview keeps the public font setting in its own field");
  assert.equal("showSetupSection" in overview.publicSiteFont, false, "public font is not confused with dashboard preferences");
  assert.equal(overview.teacherDashboardPreferences.showSetupSection, true, "overview keeps dashboard preferences in their own field");
  assert.equal("font" in overview.teacherDashboardPreferences, false, "dashboard preferences are not confused with the public font");
  assert.ok(Array.isArray(overview.courseRules) && overview.courseRules.every((rule) => typeof rule.code === "string" && typeof rule.versionId === "string"), "overview keeps course rules as rule documents");
  assert.equal(overview.classes.find((entry) => entry.id === "class-1").displayLabel, "1-р шат · Бямба 10:00–11:20", "teacher overview ignores a legacy manual class label");
  assert.equal(overview.classes.find((entry) => entry.id === "class-1").offeringId, "offering-annual-stage-1", "class remains attached to its offering");
  assert.equal(overview.classes.find((entry) => entry.id === "class-1").canDelete, false, "reference checks keep linked classes out of the delete path");
  assert.equal(overview.stageSettings.filter((entry) => entry.academicYearId === "year-2026" && entry.stageCode === "stage_1").length, 1, "stage settings remain one-per-year-and-stage");
  sqlite(`
    INSERT INTO class_session (id, activity_offering_id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, is_test, test_run_id, created_at, updated_at) VALUES
      ('ordering-tuesday-0710', 'offering-annual-stage-1', 'year-2026', 'stage_1', 'A', 'Мягмар', '07:10', '08:30', 10, 'closed', 1, 'staff-program-test', '${now}', '${now}'),
      ('ordering-tuesday-1310', 'offering-annual-stage-1', 'year-2026', 'stage_1', 'B', 'Мягмар', '13:10', '14:30', 10, 'closed', 1, 'staff-program-test', '${now}', '${now}'),
      ('ordering-thursday-1310', 'offering-annual-stage-1', 'year-2026', 'stage_1', 'C', 'Пүрэв', '13:10', '14:30', 10, 'closed', 1, 'staff-program-test', '${now}', '${now}'),
      ('ordering-saturday-1310', 'offering-annual-stage-1', 'year-2026', 'stage_1', 'D', 'Бямба', '13:10', '14:30', 10, 'closed', 1, 'staff-program-test', '${now}', '${now}');
  `);
  const orderedOverview = await service.getProgramCalendarOverview(runtime);
  assert.deepEqual(
    orderedOverview.classes.filter((entry) => entry.id.startsWith("ordering-")).map((entry) => entry.id),
    ['ordering-tuesday-0710', 'ordering-tuesday-1310', 'ordering-thursday-1310', 'ordering-saturday-1310'],
    "classes in one Offering use Monday-to-Sunday order, then time, then a stable ID tie-breaker",
  );
  console.log("ok staff Offering/program/calendar permissions, compatibility settings, class safety, recurrence, reflow, and audit tests");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
