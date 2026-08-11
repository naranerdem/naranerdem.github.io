import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (process.argv.length !== 2) {
  throw new Error("This fixture command has no arguments and is staging-only. It never targets production.");
}

const fixtureRunId = "staging-calendar-fixture";
const fixtureTimestamp = "2026-08-11T00:00:00Z";
const academicYearId = "staging-fixture-2026-27";
const tempDir = mkdtempSync(path.join(tmpdir(), "naranerdem-staging-calendar-"));
const bundlePath = path.join(tempDir, "program-calendar.mjs");
const sqlPath = path.join(tempDir, "staging-calendar-fixtures.sql");
const esbuild = path.resolve("node_modules/esbuild/bin/esbuild");

function quote(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function bundleScheduleGenerator() {
  const result = spawnSync(esbuild, [
    "src/server/services/program-calendar.ts",
    "--bundle",
    "--format=esm",
    "--platform=node",
    `--outfile=${bundlePath}`,
  ], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Could not build the local calendar generator\n${result.stdout}\n${result.stderr}`);
}

function fakeLessons(programId) {
  return Array.from({ length: 30 }, (_, index) => ({
    id: `${programId}-lesson-${String(index + 1).padStart(2, "0")}`,
    sequenceNumber: index + 1,
    title: `Туршилтын хичээл ${String(index + 1).padStart(2, "0")}`,
  }));
}

function programSql(spec) {
  const lines = [
    `INSERT OR IGNORE INTO curriculum_program (
      id, academic_year_id, stage_code, revision_number, display_name, status,
      is_test, test_run_id, created_at, updated_at
    ) VALUES (${quote(spec.programId)}, ${quote(academicYearId)}, ${quote(spec.stageCode)}, 1,
      ${quote(`Туршилтын ${spec.stageNumber}-р шатны хөтөлбөр`)}, 'draft', 1,
      ${quote(fixtureRunId)}, ${quote(fixtureTimestamp)}, ${quote(fixtureTimestamp)});`,
  ];

  for (const lesson of spec.lessons) {
    lines.push(`INSERT INTO curriculum_lesson (
      id, curriculum_program_id, sequence_number, title, internal_note, status,
      is_test, test_run_id, created_at, updated_at
    ) SELECT ${quote(lesson.id)}, ${quote(spec.programId)}, ${lesson.sequenceNumber}, ${quote(lesson.title)},
      ${quote("Deliberately fake staging lesson; not Naran Erdem curriculum content.")}, 'active', 1,
      ${quote(fixtureRunId)}, ${quote(fixtureTimestamp)}, ${quote(fixtureTimestamp)}
    WHERE (SELECT status FROM curriculum_program WHERE id = ${quote(spec.programId)}) = 'draft';`);
  }
  lines.push(`UPDATE curriculum_program
    SET status = 'published', updated_at = ${quote(fixtureTimestamp)}
    WHERE id = ${quote(spec.programId)} AND status = 'draft';`);
  return lines;
}

function calendarSql(spec, schedule) {
  const calendarId = `staging-calendar-${spec.classSessionId}`;
  const revisionId = `${calendarId}-revision-1`;
  const lines = [
    `INSERT OR IGNORE INTO class_calendar (
      id, class_session_id, timezone, status, is_test, test_run_id, created_at, updated_at
    ) VALUES (${quote(calendarId)}, ${quote(spec.classSessionId)}, 'Asia/Ulaanbaatar', 'active', 1,
      ${quote(fixtureRunId)}, ${quote(fixtureTimestamp)}, ${quote(fixtureTimestamp)});`,
    `INSERT OR IGNORE INTO class_calendar_revision (
      id, class_calendar_id, curriculum_program_id, revision_number, status,
      first_candidate_date, locked_through_sequence, based_on_revision_id,
      is_test, test_run_id, created_at, updated_at
    ) VALUES (${quote(revisionId)}, ${quote(calendarId)}, ${quote(spec.programId)}, 1, 'draft',
      ${quote(spec.firstCandidateDate)}, 0, NULL, 1, ${quote(fixtureRunId)},
      ${quote(fixtureTimestamp)}, ${quote(fixtureTimestamp)});`,
  ];

  for (const override of spec.overrides ?? []) {
    lines.push(`INSERT INTO class_calendar_revision_override (
      id, class_calendar_revision_id, local_date, behavior, reason_label,
      is_test, test_run_id, created_at, updated_at
    ) SELECT ${quote(`${revisionId}-override-${override.id}`)}, ${quote(revisionId)},
      ${quote(override.localDate)}, ${quote(override.behavior)}, ${quote(override.reasonLabel ?? null)},
      1, ${quote(fixtureRunId)}, ${quote(fixtureTimestamp)}, ${quote(fixtureTimestamp)}
    WHERE (SELECT status FROM class_calendar_revision WHERE id = ${quote(revisionId)}) = 'draft';`);
  }

  for (const [index, slot] of schedule.entries()) {
    lines.push(`INSERT INTO class_calendar_slot (
      id, class_calendar_revision_id, local_date, start_time, end_time, slot_source,
      status, curriculum_lesson_id, cancelled_lesson_sequence, cancelled_lesson_title,
      reason_label, is_test, test_run_id, created_at, updated_at
    ) SELECT ${quote(`${revisionId}-slot-${String(index + 1).padStart(2, "0")}`)}, ${quote(revisionId)},
      ${quote(slot.localDate)}, ${quote(slot.startTime)}, ${quote(slot.endTime)}, ${quote(slot.slotSource)},
      ${quote(slot.status)}, ${quote(slot.lesson?.id ?? null)}, NULL, NULL, ${quote(slot.reasonLabel)},
      1, ${quote(fixtureRunId)}, ${quote(fixtureTimestamp)}, ${quote(fixtureTimestamp)}
    WHERE (SELECT status FROM class_calendar_revision WHERE id = ${quote(revisionId)}) = 'draft';`);
  }
  lines.push(`UPDATE class_calendar_revision
    SET status = 'published', published_at = ${quote(fixtureTimestamp)}, updated_at = ${quote(fixtureTimestamp)}
    WHERE id = ${quote(revisionId)} AND status = 'draft';`);
  return lines;
}

try {
  bundleScheduleGenerator();
  const { generateCalendarSchedule } = await import(pathToFileURL(bundlePath).href);

  const programs = [1, 2, 3].map((stageNumber) => ({
    stageNumber,
    stageCode: `stage_${stageNumber}`,
    programId: `staging-calendar-program-stage-${stageNumber}`,
  })).map((program) => ({ ...program, lessons: fakeLessons(program.programId) }));
  const byStage = new Map(programs.map((program) => [program.stageCode, program]));
  const breaks = [
    {
      id: "staging-short-break",
      label: "Туршилтын богино завсарлага",
      startsOn: "2026-10-24",
      endsOn: "2026-10-26",
      excludesHabitualSlots: true,
    },
    {
      id: "staging-winter-break",
      label: "Туршилтын өвлийн завсарлага",
      startsOn: "2026-12-20",
      endsOn: "2027-01-10",
      excludesHabitualSlots: true,
    },
  ];
  const classes = [
    {
      classSessionId: "staging-fixture-stage-1-saturday",
      stageCode: "stage_1",
      firstCandidateDate: "2026-09-05",
      habitualWeekday: "Бямба",
      startTime: "10:00",
      endTime: "11:20",
    },
    {
      classSessionId: "staging-fixture-stage-1-afternoon",
      stageCode: "stage_1",
      firstCandidateDate: "2026-09-05",
      habitualWeekday: "Бямба",
      startTime: "14:00",
      endTime: "15:20",
    },
    {
      classSessionId: "staging-fixture-stage-2-sunday",
      stageCode: "stage_2",
      firstCandidateDate: "2026-09-06",
      habitualWeekday: "Ням",
      startTime: "10:00",
      endTime: "11:20",
      overrides: [{ id: "november-class-exclusion", localDate: "2026-11-15", behavior: "exclude", reasonLabel: "Туршилтын ангийн завсарлага" }],
      extraSlots: [{ id: "november-extra", localDate: "2026-11-18", startTime: "17:00", endTime: "18:20", reasonLabel: "Туршилтын нэмэлт хичээл" }],
    },
    {
      classSessionId: "staging-fixture-stage-2-tuesday",
      stageCode: "stage_2",
      firstCandidateDate: "2026-09-08",
      habitualWeekday: "Мягмар",
      startTime: "16:00",
      endTime: "17:20",
    },
    {
      classSessionId: "staging-fixture-stage-3-sunday",
      stageCode: "stage_3",
      firstCandidateDate: "2026-09-06",
      habitualWeekday: "Ням",
      startTime: "13:00",
      endTime: "15:00",
      overrides: [{ id: "winter-restore", localDate: "2026-12-27", behavior: "restore", reasonLabel: "Туршилтын нөхөх хичээл" }],
    },
    {
      classSessionId: "staging-fixture-stage-3-tuesday",
      stageCode: "stage_3",
      firstCandidateDate: "2026-09-08",
      habitualWeekday: "Мягмар",
      startTime: "18:00",
      endTime: "19:20",
    },
  ].map((classSession) => ({
    ...classSession,
    programId: byStage.get(classSession.stageCode).programId,
    lessons: byStage.get(classSession.stageCode).lessons,
  }));

  const lines = [
    "-- Deliberately fake, non-PII staging program/calendar fixtures.",
    "-- Generated by scripts/seed-staging-calendar.mjs; never apply to production.",
    "PRAGMA foreign_keys = ON;",
  ];
  for (const program of programs) lines.push(...programSql(program));
  for (const period of breaks) {
    lines.push(`INSERT OR IGNORE INTO academic_year_break (
      id, academic_year_id, label, starts_on, ends_on, excludes_habitual_slots,
      source_note, status, is_test, test_run_id, created_at, updated_at
    ) VALUES (${quote(period.id)}, ${quote(academicYearId)}, ${quote(period.label)},
      ${quote(period.startsOn)}, ${quote(period.endsOn)}, ${period.excludesHabitualSlots ? 1 : 0},
      ${quote("Deliberately fake staging planning input.")}, 'active', 1, ${quote(fixtureRunId)},
      ${quote(fixtureTimestamp)}, ${quote(fixtureTimestamp)});`);
  }
  for (const classSession of classes) {
    const schedule = generateCalendarSchedule({
      lessons: classSession.lessons,
      firstCandidateDate: classSession.firstCandidateDate,
      habitualWeekday: classSession.habitualWeekday,
      startTime: classSession.startTime,
      endTime: classSession.endTime,
      breaks,
      overrides: classSession.overrides,
      extraSlots: classSession.extraSlots,
    });
    lines.push(...calendarSql(classSession, schedule));
  }
  writeFileSync(sqlPath, `${lines.join("\n\n")}\n`, "utf8");

  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(command, [
    "wrangler", "d1", "execute", "DB", "--env", "staging", "--remote", "--file", sqlPath,
  ], { encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
