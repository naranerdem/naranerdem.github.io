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

function fakeLessons(programId, count = 30) {
  return Array.from({ length: count }, (_, index) => ({
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
    ) VALUES (${quote(spec.programId)}, ${quote(spec.academicYearId ?? academicYearId)}, ${quote(spec.stageCode)}, 1,
      ${quote(spec.displayName ?? `Туршилтын ${spec.stageNumber}-р шатны хөтөлбөр`)}, 'draft', 1,
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
    `INSERT INTO class_calendar_revision (
      id, class_calendar_id, curriculum_program_id, revision_number, status,
      first_candidate_date, locked_through_sequence, based_on_revision_id,
      is_test, test_run_id, created_at, updated_at
    ) SELECT ${quote(revisionId)}, ${quote(calendarId)}, ${quote(spec.programId)}, 1, 'draft',
      ${quote(spec.firstCandidateDate)}, 0, NULL, 1, ${quote(fixtureRunId)},
      ${quote(fixtureTimestamp)}, ${quote(fixtureTimestamp)}
    WHERE NOT EXISTS (SELECT 1 FROM class_calendar_revision WHERE id = ${quote(revisionId)});`,
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
  const summerYearId = "staging-summer-context-2027";
  const summerOfferingId = "staging-offering-summer-2027";
  const summerProgram = {
    stageNumber: 1,
    stageCode: "stage_1",
    academicYearId: summerYearId,
    programId: "staging-summer-program-2027",
    displayName: "Туршилтын зуны сургалтын хөтөлбөр",
    lessons: fakeLessons("staging-summer-program-2027", 12),
  };
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
    recurrenceKind: "weekly",
    lastCandidateDate: null,
    useAcademicYearBreaks: true,
    programId: byStage.get(classSession.stageCode).programId,
    lessons: byStage.get(classSession.stageCode).lessons,
  }));
  const summerClasses = [
    {
      classSessionId: "staging-summer-weekdays-morning",
      stageCode: "stage_1",
      firstCandidateDate: "2027-06-01",
      lastCandidateDate: "2027-06-16",
      recurrenceKind: "weekdays",
      startTime: "10:00",
      endTime: "11:30",
    },
    {
      classSessionId: "staging-summer-daily-afternoon",
      stageCode: "stage_1",
      firstCandidateDate: "2027-06-15",
      lastCandidateDate: "2027-06-26",
      recurrenceKind: "daily",
      startTime: "13:00",
      endTime: "14:30",
    },
  ].map((classSession) => ({ ...classSession, useAcademicYearBreaks: false, programId: summerProgram.programId, lessons: summerProgram.lessons }));

  const lines = [
    "-- Deliberately fake, non-PII staging program/calendar fixtures.",
    "-- Generated by scripts/seed-staging-calendar.mjs; never apply to production.",
    "PRAGMA foreign_keys = ON;",
    `INSERT OR IGNORE INTO academic_year (
      id, public_label, registration_status, starts_on, ends_on, is_current,
      is_test, test_run_id, created_at, updated_at
    ) VALUES (${quote(summerYearId)}, 'Туршилтын зуны дотоод бүлэг', 'draft',
      '2027-06-01', '2027-06-30', 0, 1, ${quote(fixtureRunId)},
      ${quote(fixtureTimestamp)}, ${quote(fixtureTimestamp)});`,
  ];
  for (const program of [...programs, summerProgram]) lines.push(...programSql(program));
  for (const program of programs) {
    lines.push(`UPDATE activity_offering SET curriculum_program_id = ${quote(program.programId)},
      updated_at = ${quote(fixtureTimestamp)}
      WHERE id = ${quote(`annual-offering-${academicYearId}-${program.stageCode}`)}
        AND curriculum_program_id IS NULL;`);
  }
  lines.push(`INSERT OR IGNORE INTO activity_offering (
    id, kind, title, academic_year_id, stage_code, level_label, starts_on, ends_on,
    curriculum_program_id, use_academic_year_breaks, charge_mode, facebook_group_url,
    note, status, is_test, test_run_id, created_at, updated_at
  ) VALUES (${quote(summerOfferingId)}, 'summer_course', 'Туршилтын зуны сургалт',
    ${quote(summerYearId)}, NULL, NULL, '2027-06-01', '2027-06-26',
    ${quote(summerProgram.programId)}, 0, 'paid',
    'https://example.invalid/naran-erdem/summer-2027',
    'Deliberately fake staging summer offering.', 'active', 1, ${quote(fixtureRunId)},
    ${quote(fixtureTimestamp)}, ${quote(fixtureTimestamp)});`);
  lines.push(`INSERT OR IGNORE INTO class_session (
    id, academic_year_id, stage_code, display_label, weekday, start_time, end_time,
    capacity, status, facebook_group_url, is_test_only, is_test, test_run_id,
    created_at, updated_at, activity_offering_id
  ) VALUES
    ('staging-summer-weekdays-morning', ${quote(summerYearId)}, 'stage_1',
      '6/1–6/16 · 10:00–11:30', 'Ажлын өдөр 6/1', '10:00', '11:30', 12, 'closed', NULL,
      1, 1, ${quote(fixtureRunId)}, ${quote(fixtureTimestamp)}, ${quote(fixtureTimestamp)}, ${quote(summerOfferingId)}),
    ('staging-summer-daily-afternoon', ${quote(summerYearId)}, 'stage_1',
      '6/15–6/26 · 13:00–14:30', 'Өдөр бүр 6/15', '13:00', '14:30', 12, 'closed', NULL,
      1, 1, ${quote(fixtureRunId)}, ${quote(fixtureTimestamp)}, ${quote(fixtureTimestamp)}, ${quote(summerOfferingId)});`);
  lines.push(`INSERT OR IGNORE INTO class_meeting_rule (
    class_session_id, recurrence_kind, first_date, last_date, weekly_weekday,
    start_time, end_time, created_at, updated_at
  ) VALUES
    ('staging-summer-weekdays-morning', 'weekdays', '2027-06-01', '2027-06-16', NULL,
      '10:00', '11:30', ${quote(fixtureTimestamp)}, ${quote(fixtureTimestamp)}),
    ('staging-summer-daily-afternoon', 'daily', '2027-06-15', '2027-06-26', NULL,
      '13:00', '14:30', ${quote(fixtureTimestamp)}, ${quote(fixtureTimestamp)});`);
  lines.push(`INSERT OR IGNORE INTO activity_offering (
    id, kind, title, academic_year_id, stage_code, level_label, starts_on, ends_on,
    curriculum_program_id, use_academic_year_breaks, charge_mode, facebook_group_url,
    note, status, is_test, test_run_id, created_at, updated_at
  ) VALUES ('staging-offering-telescope-event', 'event', 'Туршилтын од ажиглалт',
    NULL, NULL, NULL, '2027-06-20', '2027-06-20', NULL, 0, 'free', NULL,
    'Deliberately fake staging event.', 'active', 1, ${quote(fixtureRunId)},
    ${quote(fixtureTimestamp)}, ${quote(fixtureTimestamp)});`);
  lines.push(`INSERT OR IGNORE INTO offering_event_occurrence (
    id, activity_offering_id, local_date, start_time, end_time, capacity,
    registration_status, is_test, test_run_id, created_at, updated_at
  ) VALUES ('staging-telescope-event-occurrence', 'staging-offering-telescope-event',
    '2027-06-20', '20:00', '22:30', 12, 'closed', 1, ${quote(fixtureRunId)},
    ${quote(fixtureTimestamp)}, ${quote(fixtureTimestamp)});`);
  for (const period of breaks) {
    lines.push(`INSERT OR IGNORE INTO academic_year_break (
      id, academic_year_id, label, starts_on, ends_on, excludes_habitual_slots,
      source_note, status, is_test, test_run_id, created_at, updated_at
    ) VALUES (${quote(period.id)}, ${quote(academicYearId)}, ${quote(period.label)},
      ${quote(period.startsOn)}, ${quote(period.endsOn)}, ${period.excludesHabitualSlots ? 1 : 0},
      ${quote("Deliberately fake staging planning input.")}, 'active', 1, ${quote(fixtureRunId)},
      ${quote(fixtureTimestamp)}, ${quote(fixtureTimestamp)});`);
  }
  for (const classSession of [...classes, ...summerClasses]) {
    const schedule = generateCalendarSchedule({
      lessons: classSession.lessons,
      firstCandidateDate: classSession.firstCandidateDate,
      lastCandidateDate: classSession.lastCandidateDate,
      recurrenceKind: classSession.recurrenceKind,
      habitualWeekday: classSession.habitualWeekday,
      startTime: classSession.startTime,
      endTime: classSession.endTime,
      breaks: classSession.useAcademicYearBreaks ? breaks : [],
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
