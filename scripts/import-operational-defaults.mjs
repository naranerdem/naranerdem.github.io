import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { operationalDefaults } from "../src/config/operational-defaults.mjs";

const keyPattern = /^[a-z0-9-]+$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

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
  expect(Array.isArray(defaults.academicYears) && Array.isArray(defaults.schoolCalendarPeriods), "academicYears and schoolCalendarPeriods must be arrays");
  expect(!Object.hasOwn(defaults, "programs"), "private Program curricula are not public operational defaults");
  const academicYears = new Map();
  for (const year of defaults.academicYears) {
    expect(year && typeof year.key === "string" && keyPattern.test(year.key), "each academic year needs a stable lowercase key");
    expect(!academicYears.has(year.key), `duplicate academic-year key ${year.key}`);
    expect(typeof year.label === "string" && year.label.trim(), `academic year ${year.key} needs a label`);
    expect(validDate(year.startsOn) && validDate(year.endsOn) && year.endsOn >= year.startsOn, `academic year ${year.key} has an invalid period`);
    academicYears.set(year.key, year);
  }
  const periodKeys = new Set();
  for (const period of defaults.schoolCalendarPeriods) {
    expect(period && typeof period.key === "string" && keyPattern.test(period.key), "each school period needs a stable lowercase key");
    expect(!periodKeys.has(period.key), `duplicate school-period key ${period.key}`); periodKeys.add(period.key);
    expect(academicYears.has(period.academicYearKey), `school period ${period.key} needs an imported annual academicYearKey`);
    expect(typeof period.label === "string" && period.label.trim(), `school period ${period.key} needs a label`);
    expect(validDate(period.startsOn) && validDate(period.endsOn) && period.endsOn >= period.startsOn, `school period ${period.key} needs a valid period`);
    expect(typeof period.excludeFromGeneration === "boolean", `school period ${period.key} needs excludeFromGeneration`);
    expect(typeof period.warnOnOverlap === "boolean", `school period ${period.key} needs warnOnOverlap`);
  }
}

function academicYearSql(year, version, timestamp) {
  const yearId = `operational-default-year-${year.key}`;
  const matchingYear = `(SELECT id FROM academic_year WHERE starts_on = ${quote(year.startsOn)} AND ends_on = ${quote(year.endsOn)} ORDER BY is_current DESC, id LIMIT 1)`;
  return [
    `INSERT INTO academic_year (id, public_label, registration_status, starts_on, ends_on, is_current, is_test, test_run_id, created_at, updated_at)
      SELECT ${quote(yearId)}, ${quote(year.label)}, 'draft', ${quote(year.startsOn)}, ${quote(year.endsOn)}, 1, 0, NULL, ${quote(timestamp)}, ${quote(timestamp)}
      WHERE NOT EXISTS (SELECT 1 FROM academic_year WHERE starts_on = ${quote(year.startsOn)} AND ends_on = ${quote(year.endsOn)});`,
    `INSERT OR IGNORE INTO operational_default_import (template_key, template_version, template_kind, imported_at)
      SELECT ${quote(`academic-year:${year.key}`)}, ${quote(version)}, 'school_calendar_period', ${quote(timestamp)}
      WHERE EXISTS (SELECT 1 FROM academic_year WHERE id = ${matchingYear});`,
  ];
}

export function buildOperationalDefaultsImport(defaults, timestamp = new Date().toISOString()) {
  validateOperationalDefaults(defaults);
  const lines = ["-- Explicit operational-default import. Never run automatically during deployment.", "PRAGMA foreign_keys = ON;"];
  for (const year of defaults.academicYears) lines.push(...academicYearSql(year, defaults.version, timestamp));
  for (const period of defaults.schoolCalendarPeriods) {
    const marker = `school-period:${period.key}`;
    const year = defaults.academicYears.find((entry) => entry.key === period.academicYearKey);
    const yearId = `(SELECT id FROM academic_year WHERE starts_on = ${quote(year.startsOn)} AND ends_on = ${quote(year.endsOn)} ORDER BY is_current DESC, id LIMIT 1)`;
    const legacyBehavior = period.excludeFromGeneration ? "exclude_by_default" : "warn_only";
    lines.push(`INSERT INTO academic_year_break (id, academic_year_id, label, starts_on, ends_on, excludes_habitual_slots, generation_behavior, exclude_from_generation, warn_on_overlap, source_note, status, is_test, test_run_id, created_at, updated_at)
      SELECT ${quote(`operational-default-school-period-${period.key}`)}, ${yearId}, ${quote(period.label)}, ${quote(period.startsOn)}, ${quote(period.endsOn)}, ${period.excludeFromGeneration ? 1 : 0}, ${quote(legacyBehavior)}, ${period.excludeFromGeneration ? 1 : 0}, ${period.warnOnOverlap ? 1 : 0}, 'Imported operational default', 'active', 0, NULL, ${quote(timestamp)}, ${quote(timestamp)}
      WHERE NOT EXISTS (SELECT 1 FROM operational_default_import WHERE template_key = ${quote(marker)})
        AND ${yearId} IS NOT NULL
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
  const total = operationalDefaults.schoolCalendarPeriods.length;
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
    console.log(`Importing ${operationalDefaults.schoolCalendarPeriods.length} public school-period template(s) into ${environment}. Existing stable imports are skipped.`);
    const result = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", wranglerArgs, { stdio: "inherit" });
    if (result.status !== 0) process.exitCode = result.status ?? 1;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
