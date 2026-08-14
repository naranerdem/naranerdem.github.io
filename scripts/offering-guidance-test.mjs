import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tempDir = mkdtempSync(path.join(tmpdir(), "naranerdem-offering-guidance-"));
const databasePath = path.join(tempDir, "defaults.sqlite3");
const backfillDatabasePath = path.join(tempDir, "backfill.sqlite3");

function sqliteAt(pathname, sql, json = false) {
  const result = spawnSync("sqlite3", json ? ["-json", pathname] : [pathname], {
    input: `PRAGMA foreign_keys=ON;\n${sql}`,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function sqlite(sql, json = false) { return sqliteAt(databasePath, sql, json); }

try {
  const importer = await import(pathToFileURL(path.resolve("scripts/import-operational-defaults.mjs")).href);
  const defaultsSource = readFileSync("src/config/operational-defaults.mjs", "utf8");
  const offeringsPageSource = readFileSync("src/pages/staff/offerings.astro", "utf8");
  const schedulePageSource = readFileSync("src/pages/staff/schedule.astro", "utf8");
  const holidaysPageSource = readFileSync("src/pages/staff/holidays.astro", "utf8");
  const deploymentScripts = readFileSync("package.json", "utf8");
  const { operationalDefaults } = await import(pathToFileURL(path.resolve("src/config/operational-defaults.mjs")).href);
  assert.equal(operationalDefaults.programs.length, 3, "the approved annual Program baseline has exactly three logical families");
  assert.deepEqual(operationalDefaults.programs.map((program) => program.lessons.length), [30, 30, 23], "the approved lesson counts are preserved exactly");
  assert.ok(operationalDefaults.programs.every((program) => program.publish === true && program.kind === "annual_course"), "the approved annual baseline publishes current revisions explicitly");
  assert.equal(operationalDefaults.academicYears.length, 1, "the real operational template has one explicit academic year");
  assert.deepEqual(operationalDefaults.schoolCalendarPeriods.map((period) => [period.label, period.startsOn, period.endsOn]), [
    ["Намрын амралт", "2026-10-31", "2026-11-08"],
    ["Өвлийн завсарлага", "2026-12-26", "2027-01-17"],
    ["Цагаан сарын үеийн бие даалт", "2027-02-08", "2027-02-12"],
    ["Хаврын амралт", "2027-03-20", "2027-03-28"],
    ["Бүгд Найрамдах Улс тунхагласан өдөр", "2026-11-26", "2026-11-26"],
    ["Олон улсын эмэгтэйчүүдийн өдөр", "2027-03-08", "2027-03-08"],
  ], "the approved Ulaanbaatar VI–IX operational calendar is exact");
  assert.ok(operationalDefaults.schoolCalendarPeriods.every((period) => period.excludeFromGeneration && period.warnOnOverlap), "every approved operational date is skipped initially and warned on overlap");
  assert.doesNotMatch(defaultsSource, /2026-12-21/, "winter guidance does not incorrectly begin on December 21");
  assert.doesNotMatch(defaultsSource, /@|facebook\.com/i, "default templates contain no personal data or Facebook URLs");
  const annualForm = offeringsPageSource.slice(offeringsPageSource.indexOf("function annualForm"), offeringsPageSource.indexOf("function summerForm"));
  const summerForm = offeringsPageSource.slice(offeringsPageSource.indexOf("function summerForm"), offeringsPageSource.indexOf("function eventForm"));
  assert.match(annualForm, /courseProgramField\(entry, "annual_course"\)/, "annual Offering creation selects its logical stage");
  assert.doesNotMatch(annualForm, /Хичээлийн жил|offering-charge|useAcademicYearBreaks/, "annual Offering creation has no redundant year, payment, or break controls");
  assert.match(offeringsPageSource, /offering-annual-stage/, "annual Offering creation submits a logical stage, not a raw revision ID");
  assert.match(summerForm, /courseProgramField\(entry, "summer_course"\)/, "summer Offering creation selects an existing logical Program");
  assert.doesNotMatch(summerForm, /offering-charge|Хөтөлбөрийг шинээр/, "summer Offering creation has neither a charge selector nor inline Program creation");
  assert.doesNotMatch(offeringsPageSource, /Хөтөлбөрийг шинээр бэлтгэнэ/, "the obsolete inline Program-creation wording is absent");
  assert.match(offeringsPageSource, /Арга хэмжээ устгах/, "unused event deletion is kept in event details");
  assert.match(offeringsPageSource, /function classManagement/, "Offering details own compact class management");
  assert.match(offeringsPageSource, /data-add-class/, "an Offering can add a class from its selected detail");
  assert.doesNotMatch(schedulePageSource, /id="classes-title"/, "Schedule no longer repeats class management below the calendar");
  assert.doesNotMatch(schedulePageSource, /data-add-class/, "Schedule only opens existing class calendars");
  assert.match(holidaysPageSource, /!entry\.isTest/, "ordinary Holidays hides isolated staging-only break fixtures");
  assert.match(holidaysPageSource, /id="break-exclude"/, "school-period exclusion uses an independent checkbox");
  assert.match(holidaysPageSource, /id="break-warn"/, "school-period warnings use an independent checkbox");
  assert.doesNotMatch(holidaysPageSource, /break-behavior|Imported operational default/, "teacher Holidays UI hides the legacy behavior selector and import provenance");
  assert.ok(offeringsPageSource.indexOf('id="offering-list"') < offeringsPageSource.indexOf('id="add-offering"'), "existing Offerings appear before the creation action");
  assert.doesNotMatch(deploymentScripts, /deploy[^\n]*seed:operational-defaults/, "operational-default imports never run during deployment");

  const fixture = {
    version: 1,
    academicYears: [{ key: "2027-28", label: "Туршилтын жил", startsOn: "2027-09-01", endsOn: "2028-06-01" }],
    programs: [{
      key: "annual-one", kind: "annual_course", displayName: "Туршилтын хөтөлбөр",
      academicYear: { key: "2027-28", label: "Туршилтын жил", startsOn: "2027-09-01", endsOn: "2028-06-01" },
      stageCode: "stage_1", lessons: [{ title: "Нэг" }, { title: "Хоёр" }],
    }],
    schoolCalendarPeriods: [{
      key: "winter", academicYearKey: "2027-28", label: "Туршилтын өвлийн амралт",
      startsOn: "2027-12-20", endsOn: "2028-01-10", excludeFromGeneration: true, warnOnOverlap: true,
    }],
  };
  const sql = importer.buildOperationalDefaultsImport(fixture, "2026-08-13T00:00:00.000Z");
  assert.match(sql, /operational_default_import/, "imports have stable idempotency markers");
  assert.match(sql, /'draft'/, "imported programs remain editable drafts");
  assert.doesNotMatch(sql, /facebook\.com/i, "template import does not manage Facebook URLs");
  const migrations = readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort();
  sqlite(migrations.map((file) => readFileSync(path.join("migrations", file), "utf8")).join("\n"));
  const guidanceMigration = "0015_independent_school_calendar_guidance.sql";
  const guidanceIndex = migrations.indexOf(guidanceMigration);
  sqliteAt(backfillDatabasePath, migrations.slice(0, guidanceIndex).map((file) => readFileSync(path.join("migrations", file), "utf8")).join("\n"));
  sqliteAt(backfillDatabasePath, `
    INSERT INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_current, is_test, test_run_id, created_at, updated_at)
      VALUES ('legacy-year', 'Legacy', 'draft', '2026-09-01', '2027-06-01', 0, 0, NULL, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
    INSERT INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_current, is_test, test_run_id, created_at, updated_at)
      VALUES ('legacy-other-year', 'Legacy other', 'draft', '2027-09-01', '2028-06-01', 0, 0, NULL, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
    INSERT INTO academic_year_break (id, academic_year_id, label, starts_on, ends_on, excludes_habitual_slots, generation_behavior, source_note, status, is_test, test_run_id, created_at, updated_at) VALUES
      ('legacy-exclude', 'legacy-year', 'Алгасах', '2026-10-01', '2026-10-01', 1, 'exclude_by_default', NULL, 'active', 0, NULL, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
      ('legacy-warn', 'legacy-year', 'Анхааруулах', '2026-10-02', '2026-10-02', 0, 'warn_only', NULL, 'active', 0, NULL, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
    INSERT INTO curriculum_program_family (id, kind, display_name, annual_stage_code, current_published_program_id, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('legacy-family', 'annual_course', 'Legacy program', 'stage_2', NULL, 'active', 0, NULL, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
    INSERT INTO curriculum_program (id, program_family_id, academic_year_id, stage_code, revision_number, display_name, program_kind, status, based_on_program_id, is_test, test_run_id, created_at, updated_at)
      VALUES ('legacy-current', 'legacy-family', 'legacy-year', 'stage_2', 1, 'Current', 'annual_course', 'draft', NULL, 0, NULL, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
    INSERT INTO curriculum_lesson (id, curriculum_program_id, sequence_number, title, status, is_test, test_run_id, created_at, updated_at) VALUES
      ('legacy-current-lesson', 'legacy-current', 1, 'Current lesson', 'active', 0, NULL, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
    UPDATE curriculum_program SET status = 'published' WHERE id = 'legacy-current';
    UPDATE curriculum_program_family SET current_published_program_id = 'legacy-current' WHERE id = 'legacy-family';
    INSERT INTO curriculum_program (id, program_family_id, academic_year_id, stage_code, revision_number, display_name, program_kind, status, based_on_program_id, is_test, test_run_id, created_at, updated_at)
      VALUES ('legacy-other', 'legacy-family', 'legacy-other-year', 'stage_2', 2, 'Other', 'annual_course', 'draft', 'legacy-current', 0, NULL, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
    INSERT INTO curriculum_lesson (id, curriculum_program_id, sequence_number, title, status, is_test, test_run_id, created_at, updated_at)
      VALUES ('legacy-other-lesson', 'legacy-other', 1, 'Other lesson', 'active', 0, NULL, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
    UPDATE curriculum_program SET status = 'published' WHERE id = 'legacy-other';
    UPDATE curriculum_program SET status = 'superseded' WHERE id = 'legacy-current';
  `);
  sqliteAt(backfillDatabasePath, readFileSync(path.join("migrations", guidanceMigration), "utf8"));
  const backfill = JSON.parse(sqliteAt(backfillDatabasePath, `SELECT id, exclude_from_generation AS excluded, warn_on_overlap AS warned FROM academic_year_break ORDER BY id;`, true));
  assert.deepEqual(backfill, [{ id: "legacy-exclude", excluded: 1, warned: 1 }, { id: "legacy-warn", excluded: 0, warned: 1 }], "0015 backfills both legacy guidance meanings without losing records");
  assert.deepEqual(JSON.parse(sqliteAt(backfillDatabasePath, `SELECT id, status FROM curriculum_program WHERE id IN ('legacy-current', 'legacy-other') ORDER BY id;`, true)), [{ id: "legacy-current", status: "published" }, { id: "legacy-other", status: "superseded" }], "0015 restores a current Program pointer whose revision was incorrectly superseded");
  sqlite(sql); sqlite(sql);
  const counts = JSON.parse(sqlite(`SELECT
    (SELECT COUNT(*) FROM curriculum_program WHERE id = 'operational-default-program-annual-one') AS programs,
    (SELECT COUNT(*) FROM curriculum_lesson WHERE curriculum_program_id = 'operational-default-program-annual-one') AS lessons,
    (SELECT COUNT(*) FROM academic_year_break WHERE id = 'operational-default-school-period-winter') AS periods,
    (SELECT COUNT(*) FROM operational_default_import) AS markers;`, true))[0];
  assert.deepEqual(counts, { programs: 1, lessons: 2, periods: 1, markers: 3 }, "a repeated explicit import creates no duplicates");
  sqlite("UPDATE curriculum_program SET status = 'published', display_name = 'Баталсан нэр' WHERE id = 'operational-default-program-annual-one';");
  sqlite(sql);
  assert.deepEqual(JSON.parse(sqlite("SELECT display_name AS name, status FROM curriculum_program WHERE id = 'operational-default-program-annual-one';", true))[0], { name: "Баталсан нэр", status: "published" }, "later imports never overwrite or supersede published records");
  sqlite("UPDATE academic_year_break SET label = 'Багшийн зассан амралт' WHERE id = 'operational-default-school-period-winter';");
  sqlite(sql);
  assert.equal(JSON.parse(sqlite("SELECT label FROM academic_year_break WHERE id = 'operational-default-school-period-winter';", true))[0].label, "Багшийн зассан амралт", "later imports never overwrite teacher-edited operational periods");
  const baselineSql = importer.buildOperationalDefaultsImport(operationalDefaults, "2026-08-13T00:00:01.000Z");
  sqlite(baselineSql);
  const baseline = JSON.parse(sqlite(`SELECT family.annual_stage_code AS stageCode, program.status, COUNT(lesson.id) AS lessons
    FROM curriculum_program_family AS family
    INNER JOIN curriculum_program AS program ON program.id = family.current_published_program_id
    LEFT JOIN curriculum_lesson AS lesson ON lesson.curriculum_program_id = program.id
    WHERE family.kind = 'annual_course'
    GROUP BY family.id ORDER BY family.annual_stage_code;`, true));
  assert.deepEqual(baseline.map((entry) => [entry.stageCode, entry.status, entry.lessons]), [["stage_1", "published", 30], ["stage_2", "published", 30], ["stage_3", "published", 23]], "baseline import creates three current published logical Programs");

  const productionRefusal = spawnSync(process.execPath, ["scripts/import-operational-defaults.mjs", "--env=production"], { encoding: "utf8" });
  assert.notEqual(productionRefusal.status, 0, "production import requires explicit confirmation");
  assert.match(productionRefusal.stderr, /--confirm-production/);
  console.log("ok offering guidance defaults are explicit, idempotent, and production-confirmed");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
