import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { operationalDefaults } from "../src/config/operational-defaults.mjs";

const keyPattern = /^[a-z0-9-]+$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const programKinds = new Set(["annual_course", "summer_course"]);
const schoolBehaviors = new Set(["exclude_by_default", "warn_only"]);

function quote(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function expect(value, message) {
  if (!value) throw new Error(`Invalid operational default: ${message}`);
}

function validDate(value) {
  return typeof value === "string" && datePattern.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

export function validateOperationalDefaults(defaults) {
  expect(defaults && Number.isInteger(defaults.version) && defaults.version > 0, "version is required");
  expect(Array.isArray(defaults.programs) && Array.isArray(defaults.schoolCalendarPeriods), "programs and schoolCalendarPeriods must be arrays");
  const keys = new Set();
  const academicYears = new Map();
  for (const program of defaults.programs) {
    expect(program && typeof program.key === "string" && keyPattern.test(program.key), "each program needs a stable lowercase key");
    expect(!keys.has(program.key), `duplicate program key ${program.key}`); keys.add(program.key);
    expect(programKinds.has(program.kind), `unsupported program kind ${program.kind}`);
    expect(typeof program.displayName === "string" && program.displayName.trim(), `program ${program.key} needs a displayName`);
    expect(Array.isArray(program.lessons) && program.lessons.length > 0, `program ${program.key} needs lessons`);
    program.lessons.forEach((lesson, index) => expect(lesson && typeof lesson.title === "string" && lesson.title.trim(), `program ${program.key} lesson ${index + 1} needs a title`));
    if (program.kind === "annual_course") {
      expect(["stage_1", "stage_2", "stage_3"].includes(program.stageCode), `annual program ${program.key} needs a stageCode`);
      if (program.academicYear) {
        expect(keyPattern.test(program.academicYear.key), `annual program ${program.key} has an invalid academicYear key`);
        expect(typeof program.academicYear.label === "string" && program.academicYear.label.trim(), `annual program ${program.key} has an invalid academicYear label`);
        expect(validDate(program.academicYear.startsOn) && validDate(program.academicYear.endsOn) && program.academicYear.endsOn >= program.academicYear.startsOn, `annual program ${program.key} has an invalid academicYear period`);
        academicYears.set(program.academicYear.key, program.academicYear);
      }
    }
  }
  const periodKeys = new Set();
  for (const period of defaults.schoolCalendarPeriods) {
    expect(period && typeof period.key === "string" && keyPattern.test(period.key), "each school period needs a stable lowercase key");
    expect(!periodKeys.has(period.key), `duplicate school-period key ${period.key}`); periodKeys.add(period.key);
    expect(academicYears.has(period.academicYearKey), `school period ${period.key} needs an imported annual academicYearKey`);
    expect(typeof period.label === "string" && period.label.trim(), `school period ${period.key} needs a label`);
    expect(validDate(period.startsOn) && validDate(period.endsOn) && period.endsOn >= period.startsOn, `school period ${period.key} needs a valid period`);
    expect(schoolBehaviors.has(period.generationBehavior), `school period ${period.key} has an unsupported generationBehavior`);
  }
}

function programSql(program, version, timestamp) {
  const marker = `program:${program.key}`;
  const programId = `operational-default-program-${program.key}`;
  const annual = program.kind === "annual_course";
  const familyId = annual ? `annual-program-${program.stageCode}` : `operational-default-summer-family-${program.key}`;
  const yearId = annual
    ? (program.academicYear ? `operational-default-year-${program.academicYear.key}` : "operational-default-program-library")
    : `operational-default-summer-context-${program.key}`;
  const stageCode = annual ? program.stageCode : "stage_1";
  const yearLabel = annual ? (program.academicYear?.label ?? "Хөтөлбөрийн сангийн дотоод тохиргоо") : "Зуны хөтөлбөрийн дотоод тохиргоо";
  const startsOn = program.academicYear?.startsOn ?? null;
  const endsOn = program.academicYear?.endsOn ?? null;
  const publish = program.publish === true;
  const lines = [
    `INSERT OR IGNORE INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_current, is_test, test_run_id, created_at, updated_at)
      VALUES (${quote(yearId)}, ${quote(yearLabel)}, 'draft', ${quote(startsOn)}, ${quote(endsOn)}, 0, 0, NULL, ${quote(timestamp)}, ${quote(timestamp)});`,
    `INSERT OR IGNORE INTO curriculum_program_family (id, kind, display_name, annual_stage_code, current_published_program_id, status, is_test, test_run_id, created_at, updated_at)
      VALUES (${quote(familyId)}, ${quote(program.kind)}, ${quote(program.displayName)}, ${quote(annual ? stageCode : null)}, NULL, 'active', 0, NULL, ${quote(timestamp)}, ${quote(timestamp)});`,
    `INSERT INTO curriculum_program (id, program_family_id, academic_year_id, stage_code, revision_number, display_name, program_kind, status, based_on_program_id, is_test, test_run_id, created_at, updated_at)
      SELECT ${quote(programId)}, ${quote(familyId)}, ${quote(yearId)}, ${quote(stageCode)},
        COALESCE((SELECT MAX(revision_number) + 1 FROM curriculum_program WHERE program_family_id = ${quote(familyId)}), 1),
        ${quote(program.displayName)}, ${quote(program.kind)}, 'draft', NULL, 0, NULL, ${quote(timestamp)}, ${quote(timestamp)}
      WHERE NOT EXISTS (SELECT 1 FROM operational_default_import WHERE template_key = ${quote(marker)})
        AND NOT EXISTS (SELECT 1 FROM curriculum_program WHERE id = ${quote(programId)});`,
    ...program.lessons.map((lesson, index) => `INSERT INTO curriculum_lesson (id, curriculum_program_id, sequence_number, title, internal_note, status, is_test, test_run_id, created_at, updated_at)
      SELECT ${quote(`${programId}-lesson-${String(index + 1).padStart(2, "0")}`)}, ${quote(programId)}, ${index + 1}, ${quote(lesson.title)}, ${quote(lesson.internalNote ?? null)}, 'active', 0, NULL, ${quote(timestamp)}, ${quote(timestamp)}
      WHERE EXISTS (SELECT 1 FROM curriculum_program WHERE id = ${quote(programId)} AND status = 'draft')
        AND NOT EXISTS (SELECT 1 FROM operational_default_import WHERE template_key = ${quote(marker)});`),
    ...(publish ? [
      `UPDATE curriculum_program SET status = 'superseded', updated_at = ${quote(timestamp)}
        WHERE id = (SELECT current_published_program_id FROM curriculum_program_family WHERE id = ${quote(familyId)})
          AND id != ${quote(programId)} AND status = 'published';`,
      `UPDATE curriculum_program SET status = 'published', published_at = ${quote(timestamp)}, updated_at = ${quote(timestamp)}
        WHERE id = ${quote(programId)} AND status = 'draft'
          AND EXISTS (SELECT 1 FROM curriculum_lesson WHERE curriculum_program_id = ${quote(programId)});`,
      `UPDATE curriculum_program_family SET current_published_program_id = ${quote(programId)}, updated_at = ${quote(timestamp)}
        WHERE id = ${quote(familyId)}
          AND EXISTS (SELECT 1 FROM curriculum_program WHERE id = ${quote(programId)} AND status = 'published');`,
    ] : []),
    `INSERT OR IGNORE INTO operational_default_import (template_key, template_version, template_kind, imported_at)
      SELECT ${quote(marker)}, ${version}, 'program', ${quote(timestamp)}
      WHERE EXISTS (SELECT 1 FROM curriculum_program WHERE id = ${quote(programId)});`,
  ];
  return lines;
}

export function buildOperationalDefaultsImport(defaults, timestamp = new Date().toISOString()) {
  validateOperationalDefaults(defaults);
  const lines = ["-- Explicit operational-default import. Never run automatically during deployment.", "PRAGMA foreign_keys = ON;"];
  for (const program of defaults.programs) lines.push(...programSql(program, defaults.version, timestamp));
  for (const period of defaults.schoolCalendarPeriods) {
    const marker = `school-period:${period.key}`;
    const yearId = `operational-default-year-${period.academicYearKey}`;
    lines.push(`INSERT INTO academic_year_break (id, academic_year_id, label, starts_on, ends_on, excludes_habitual_slots, generation_behavior, source_note, status, is_test, test_run_id, created_at, updated_at)
      SELECT ${quote(`operational-default-school-period-${period.key}`)}, ${quote(yearId)}, ${quote(period.label)}, ${quote(period.startsOn)}, ${quote(period.endsOn)}, ${period.generationBehavior === "exclude_by_default" ? 1 : 0}, ${quote(period.generationBehavior)}, 'Imported operational default', 'active', 0, NULL, ${quote(timestamp)}, ${quote(timestamp)}
      WHERE NOT EXISTS (SELECT 1 FROM operational_default_import WHERE template_key = ${quote(marker)})
        AND NOT EXISTS (SELECT 1 FROM academic_year_break WHERE id = ${quote(`operational-default-school-period-${period.key}`)});`);
    lines.push(`INSERT OR IGNORE INTO operational_default_import (template_key, template_version, template_kind, imported_at)
      SELECT ${quote(marker)}, ${defaults.version}, 'school_calendar_period', ${quote(timestamp)}
      WHERE EXISTS (SELECT 1 FROM academic_year_break WHERE id = ${quote(`operational-default-school-period-${period.key}`)});`);
  }
  return `${lines.join("\n\n")}\n`;
}

function commandArgs() {
  const args = process.argv.slice(2);
  const environment = args.find((arg) => arg.startsWith("--env="))?.slice("--env=".length);
  if (!environment || !["staging", "production"].includes(environment)) throw new Error("Use --env=staging or --env=production.");
  if (environment === "production" && !args.includes("--confirm-production")) throw new Error("Production import requires --confirm-production.");
  if (args.some((arg) => !arg.startsWith("--env=") && arg !== "--confirm-production")) throw new Error("Unsupported import option.");
  return environment;
}

function run() {
  const environment = commandArgs();
  validateOperationalDefaults(operationalDefaults);
  const total = operationalDefaults.programs.length + operationalDefaults.schoolCalendarPeriods.length;
  if (!total) {
    console.log(`No operational defaults are configured; ${environment} was not changed.`);
    return;
  }
  const tempDir = mkdtempSync(path.join(tmpdir(), "naranerdem-operational-defaults-"));
  const sqlPath = path.join(tempDir, "operational-defaults.sql");
  try {
    writeFileSync(sqlPath, buildOperationalDefaultsImport(operationalDefaults), "utf8");
    const wranglerArgs = ["wrangler", "d1", "execute", "DB", "--remote", "--file", sqlPath];
    if (environment === "staging") wranglerArgs.push("--env", "staging");
    console.log(`Importing ${operationalDefaults.programs.length} program template(s) and ${operationalDefaults.schoolCalendarPeriods.length} school-period template(s) into ${environment}. Existing stable imports are skipped.`);
    const result = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", wranglerArgs, { stdio: "inherit" });
    if (result.status !== 0) process.exitCode = result.status ?? 1;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
