import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tempDir = mkdtempSync(path.join(tmpdir(), "naranerdem-offering-guidance-"));
const databasePath = path.join(tempDir, "defaults.sqlite3");

function sqlite(sql, json = false) {
  const result = spawnSync("sqlite3", json ? ["-json", databasePath] : [databasePath], {
    input: `PRAGMA foreign_keys=ON;\n${sql}`,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

try {
  const importer = await import(pathToFileURL(path.resolve("scripts/import-operational-defaults.mjs")).href);
  const defaultsSource = readFileSync("src/config/operational-defaults.mjs", "utf8");
  const offeringsPageSource = readFileSync("src/pages/staff/offerings.astro", "utf8");
  const holidaysPageSource = readFileSync("src/pages/staff/holidays.astro", "utf8");
  const deploymentScripts = readFileSync("package.json", "utf8");
  const { operationalDefaults } = await import(pathToFileURL(path.resolve("src/config/operational-defaults.mjs")).href);
  assert.equal(operationalDefaults.programs.length, 3, "the approved annual Program baseline has exactly three logical families");
  assert.deepEqual(operationalDefaults.programs.map((program) => program.lessons.length), [30, 30, 23], "the approved lesson counts are preserved exactly");
  assert.ok(operationalDefaults.programs.every((program) => program.publish === true && program.kind === "annual_course"), "the approved annual baseline publishes current revisions explicitly");
  assert.match(defaultsSource, /schoolCalendarPeriods: Object\.freeze\(\[\]\)/, "no school-period dates were invented alongside the curriculum baseline");
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
  assert.match(holidaysPageSource, /Хуваарь үүсгэхдээ алгасана/, "school-period exclusions use teacher-facing wording");
  assert.match(holidaysPageSource, /Давхацвал анхааруулна/, "school-period warnings use teacher-facing wording");
  assert.doesNotMatch(deploymentScripts, /deploy[^\n]*seed:operational-defaults/, "operational-default imports never run during deployment");

  const fixture = {
    version: 1,
    programs: [{
      key: "annual-one", kind: "annual_course", displayName: "Туршилтын хөтөлбөр",
      academicYear: { key: "2027-28", label: "Туршилтын жил", startsOn: "2027-09-01", endsOn: "2028-06-01" },
      stageCode: "stage_1", lessons: [{ title: "Нэг" }, { title: "Хоёр" }],
    }],
    schoolCalendarPeriods: [{
      key: "winter", academicYearKey: "2027-28", label: "Туршилтын өвлийн амралт",
      startsOn: "2027-12-20", endsOn: "2028-01-10", generationBehavior: "exclude_by_default",
    }],
  };
  const sql = importer.buildOperationalDefaultsImport(fixture, "2026-08-13T00:00:00.000Z");
  assert.match(sql, /operational_default_import/, "imports have stable idempotency markers");
  assert.match(sql, /'draft'/, "imported programs remain editable drafts");
  assert.doesNotMatch(sql, /facebook\.com/i, "template import does not manage Facebook URLs");
  const migrations = readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort();
  sqlite(migrations.map((file) => readFileSync(path.join("migrations", file), "utf8")).join("\n"));
  sqlite(sql); sqlite(sql);
  const counts = JSON.parse(sqlite(`SELECT
    (SELECT COUNT(*) FROM curriculum_program WHERE id = 'operational-default-program-annual-one') AS programs,
    (SELECT COUNT(*) FROM curriculum_lesson WHERE curriculum_program_id = 'operational-default-program-annual-one') AS lessons,
    (SELECT COUNT(*) FROM academic_year_break WHERE id = 'operational-default-school-period-winter') AS periods,
    (SELECT COUNT(*) FROM operational_default_import) AS markers;`, true))[0];
  assert.deepEqual(counts, { programs: 1, lessons: 2, periods: 1, markers: 2 }, "a repeated explicit import creates no duplicates");
  sqlite("UPDATE curriculum_program SET status = 'published', display_name = 'Баталсан нэр' WHERE id = 'operational-default-program-annual-one';");
  sqlite(sql);
  assert.equal(JSON.parse(sqlite("SELECT display_name AS name, status FROM curriculum_program WHERE id = 'operational-default-program-annual-one';", true))[0].name, "Баталсан нэр", "later imports never overwrite published records");
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
