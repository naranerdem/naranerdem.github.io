import type { WorkerEnv } from "../env";

export interface AcademicYearShell {
  id: string;
  label: string;
  startsOn: string;
  endsOn: string;
  isTest: number;
  testRunId: string | null;
}

type ShellFlags = Pick<AcademicYearShell, "isTest" | "testRunId">;

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function shellForStartYear(startYear: number): Omit<AcademicYearShell, "isTest" | "testRunId"> {
  const endYear = startYear + 1;
  return {
    id: `academic-year-${startYear}-${String(endYear).slice(-2)}`,
    label: `${startYear}–${endYear} хичээлийн жил`,
    startsOn: `${startYear}-09-01`,
    endsOn: `${endYear}-06-01`,
  };
}

/** The existing annual-school convention is September 1 through June 1. */
export function annualAcademicYearShellForDate(date: string): Omit<AcademicYearShell, "isTest" | "testRunId"> | null {
  if (!validDate(date)) return null;
  const year = Number(date.slice(0, 4));
  const monthDay = date.slice(5);
  if (monthDay >= "09-01") return shellForStartYear(year);
  if (monthDay <= "06-01") return shellForStartYear(year - 1);
  return null;
}

export function annualStartDateForToday(month: number, day: number, today = new Date()): string {
  const currentYear = today.getUTCFullYear();
  const candidate = `${currentYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!validDate(candidate)) throw new Error("Invalid annual start-date setting.");
  const todayText = today.toISOString().slice(0, 10);
  return candidate >= todayText ? candidate : `${currentYear + 1}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export async function ensureAnnualAcademicYearShell(
  env: WorkerEnv,
  startsOn: string,
  flags: ShellFlags,
): Promise<{ year: AcademicYearShell; created: boolean }> {
  const existing = await env.DB.prepare(`SELECT id, public_label AS label, starts_on AS startsOn,
    ends_on AS endsOn, is_test AS isTest, test_run_id AS testRunId
    FROM academic_year WHERE starts_on IS NOT NULL AND ends_on IS NOT NULL
      AND starts_on <= ? AND ends_on >= ?
    ORDER BY is_current DESC, starts_on DESC LIMIT 1`).bind(startsOn, startsOn).first<AcademicYearShell>();
  if (existing) return { year: existing, created: false };

  const shell = annualAcademicYearShellForDate(startsOn);
  if (!shell) throw new Error("The annual start date is outside the school-year convention.");
  const time = new Date().toISOString();
  const result = await env.DB.prepare(`INSERT OR IGNORE INTO academic_year (
    id, public_label, registration_status, starts_on, ends_on, is_current,
    is_test, test_run_id, created_at, updated_at
  ) VALUES (?, ?, 'draft', ?, ?, 0, ?, ?, ?, ?)`).bind(
    shell.id, shell.label, shell.startsOn, shell.endsOn,
    flags.isTest, flags.testRunId, time, time,
  ).run();
  const year = await env.DB.prepare(`SELECT id, public_label AS label, starts_on AS startsOn,
    ends_on AS endsOn, is_test AS isTest, test_run_id AS testRunId
    FROM academic_year WHERE id = ?`).bind(shell.id).first<AcademicYearShell>();
  if (!year) throw new Error("Academic-year shell creation failed.");
  return { year, created: (result.meta?.changes ?? 0) === 1 };
}
