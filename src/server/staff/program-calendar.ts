import type { D1PreparedStatement, WorkerEnv } from "../env";
import {
  generateCalendarSchedule,
  reflowCancelledFutureSchedule,
  type AcademicYearBreak,
  type CalendarOverride,
  type CalendarSlot,
  type ExtraTeachingSlot,
  type ProgramLesson,
} from "../services/program-calendar";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

const STAGES = ["stage_1", "stage_2", "stage_3"] as const;
type StageCode = typeof STAGES[number];
const WEEKDAYS = ["Даваа", "Мягмар", "Лхагва", "Пүрэв", "Баасан", "Бямба", "Ням"] as const;

export class ProgramCalendarError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "invalid" | "conflict" | "immutable" | "referenced") {
    super("Program and calendar operation failed.");
    this.name = "ProgramCalendarError";
  }
}

interface YearRow {
  id: string;
  label: string;
  startsOn: string | null;
  endsOn: string | null;
  isCurrent: number;
  isTest: number;
  testRunId: string | null;
}

interface ProgramRow {
  id: string;
  academicYearId: string;
  stageCode: StageCode;
  revisionNumber: number;
  displayName: string;
  status: "draft" | "published" | "superseded" | "archived";
  isTest: number;
  testRunId: string | null;
  updatedAt: string;
}

interface LessonRow {
  id: string;
  programId: string;
  sequenceNumber: number;
  title: string;
  internalNote: string | null;
}

interface ClassRow {
  id: string;
  academicYearId: string;
  stageCode: StageCode;
  displayLabel: string;
  weekday: string;
  startTime: string;
  endTime: string;
  capacity: number;
  status: "draft" | "available" | "full" | "closed" | "cancelled";
  isTest: number;
  testRunId: string | null;
  updatedAt: string;
  calendarId: string | null;
}

interface StageSettingRow {
  id: string;
  academicYearId: string;
  stageCode: StageCode;
  facebookGroupUrl: string | null;
  isTest: number;
  testRunId: string | null;
  updatedAt: string;
}

interface BreakRow {
  id: string;
  academicYearId: string;
  label: string;
  startsOn: string;
  endsOn: string;
  excludesHabitualSlots: number;
  sourceNote: string | null;
  status: "active" | "archived";
  isTest: number;
  testRunId: string | null;
  updatedAt: string;
}

interface RevisionRow {
  id: string;
  calendarId: string;
  classSessionId: string;
  programId: string;
  revisionNumber: number;
  status: "draft" | "published" | "superseded" | "archived";
  firstCandidateDate: string;
  lockedThroughSequence: number;
  basedOnRevisionId: string | null;
  isTest: number;
  testRunId: string | null;
  updatedAt: string;
}

interface OverrideRow {
  id: string;
  revisionId: string;
  localDate: string;
  behavior: "exclude" | "restore";
  reasonLabel: string | null;
}

interface SlotRow {
  id: string;
  revisionId: string;
  localDate: string;
  startTime: string;
  endTime: string;
  slotSource: "generated" | "manual_extra" | "manual_restore";
  status: "scheduled" | "no_class" | "cancelled";
  lessonId: string | null;
  lessonSequence: number | null;
  lessonTitle: string | null;
  cancelledLessonSequence: number | null;
  cancelledLessonTitle: string | null;
  reasonLabel: string | null;
}

export interface ProgramLessonInput { id?: string; title: string; internalNote?: string | null }
export interface ProgramSaveInput { programId: string; expectedUpdatedAt: string; displayName: string; lessons: ProgramLessonInput[] }
export interface ClassSaveInput {
  id?: string;
  expectedUpdatedAt?: string;
  academicYearId: string;
  stageCode: string;
  weekday: string;
  startTime: string;
  endTime: string;
  capacity: number;
  registrationOpen?: boolean;
}
export interface BreakSaveInput {
  id?: string;
  expectedUpdatedAt?: string;
  academicYearId: string;
  label: string;
  startsOn: string;
  endsOn: string;
  sourceNote?: string | null;
}

export interface StageSettingSaveInput {
  academicYearId: string;
  stageCode: string;
  facebookGroupUrl?: string | null;
  expectedUpdatedAt?: string;
}

function requireCapability(actor: StaffPrincipal, capability: "program.manage" | "calendar.manage"): void {
  if (!hasStaffCapability(actor, capability)) throw new ProgramCalendarError("forbidden");
}

function validStage(value: string): value is StageCode {
  return STAGES.includes(value as StageCode);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function text(value: unknown, max = 160): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function optionalText(value: unknown, max = 500): string | null {
  const result = text(value, max);
  return result || null;
}

function stageLabel(stage: StageCode): string {
  return ({ stage_1: "1-р шат", stage_2: "2-р шат", stage_3: "3-р шат" })[stage];
}

function defaultProgramName(stage: StageCode): string {
  return ({
    stage_1: "1-р шатны хөтөлбөр",
    stage_2: "2-р шатны хөтөлбөр",
    stage_3: "3-р шатны хөтөлбөр",
  })[stage];
}

function classDisplayLabel(stage: StageCode, weekday: string, startTime: string): string {
  return `${stageLabel(stage)} · ${weekday} ${startTime}`;
}

function registrationOpen(status: ClassRow["status"]): boolean {
  return status === "available" || status === "full";
}

function validOptionalUrl(value: string | null): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function now(): string { return new Date().toISOString(); }
function id(): string { return crypto.randomUUID(); }

function operationFlags(env: WorkerEnv, source?: { isTest: number; testRunId: string | null }) {
  if (source) return { isTest: source.isTest, testRunId: source.testRunId };
  return env.APP_ENV === "staging"
    ? { isTest: 1, testRunId: "staff-program-calendar" }
    : { isTest: 0, testRunId: null };
}

function audit(
  env: WorkerEnv,
  actor: StaffPrincipal,
  action: string,
  subjectType: string,
  subjectId: string,
  metadata: Record<string, unknown>,
  flags: { isTest: number; testRunId: string | null },
  occurredAt = now(),
): D1PreparedStatement {
  return env.DB.prepare(`
    INSERT INTO audit_event (
      id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
      metadata_json, environment, is_test, test_run_id, created_at
    ) VALUES (?, ?, 'staff', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id(), occurredAt, actor.staffAccountId, action, subjectType, subjectId,
    JSON.stringify(metadata), env.APP_ENV, flags.isTest, flags.testRunId, occurredAt,
  );
}

async function one<T>(_env: WorkerEnv, statement: D1PreparedStatement, missing = "not_found"): Promise<T> {
  const row = await statement.first<T>();
  if (!row) throw new ProgramCalendarError(missing as ProgramCalendarError["code"]);
  return row;
}

async function revisionForUpdate(env: WorkerEnv, revisionId: string): Promise<RevisionRow> {
  return one<RevisionRow>(env, env.DB.prepare(`
    SELECT id, class_calendar_id AS calendarId, curriculum_program_id AS programId,
      revision_number AS revisionNumber, status, first_candidate_date AS firstCandidateDate,
      locked_through_sequence AS lockedThroughSequence, based_on_revision_id AS basedOnRevisionId,
      is_test AS isTest, test_run_id AS testRunId, updated_at AS updatedAt
    FROM class_calendar_revision WHERE id = ?
  `).bind(revisionId));
}

function toProgramLesson(row: LessonRow): ProgramLesson {
  return { id: row.id, sequenceNumber: row.sequenceNumber, title: row.title };
}

function toSlot(row: SlotRow): CalendarSlot {
  return {
    id: row.id,
    localDate: row.localDate,
    startTime: row.startTime,
    endTime: row.endTime,
    slotSource: row.slotSource,
    status: row.status,
    lesson: row.lessonId && row.lessonSequence && row.lessonTitle
      ? { id: row.lessonId, sequenceNumber: row.lessonSequence, title: row.lessonTitle }
      : null,
    cancelledLessonSequence: row.cancelledLessonSequence,
    cancelledLessonTitle: row.cancelledLessonTitle,
    reasonLabel: row.reasonLabel,
  };
}

async function lessonsForProgram(env: WorkerEnv, programId: string): Promise<LessonRow[]> {
  const result = await env.DB.prepare(`
    SELECT id, curriculum_program_id AS programId, sequence_number AS sequenceNumber, title,
      internal_note AS internalNote
    FROM curriculum_lesson WHERE curriculum_program_id = ? AND status = 'active'
    ORDER BY sequence_number
  `).bind(programId).all<LessonRow>();
  return result.results;
}

async function classForCalendar(env: WorkerEnv, calendarId: string): Promise<ClassRow> {
  return one<ClassRow>(env, env.DB.prepare(`
    SELECT class_session.id, class_session.academic_year_id AS academicYearId,
      class_session.stage_code AS stageCode, class_session.display_label AS displayLabel,
      class_session.weekday, class_session.start_time AS startTime, class_session.end_time AS endTime,
      class_session.capacity, class_session.status,
      class_session.is_test AS isTest, class_session.test_run_id AS testRunId,
      class_session.updated_at AS updatedAt, class_calendar.id AS calendarId
    FROM class_calendar INNER JOIN class_session ON class_session.id = class_calendar.class_session_id
    WHERE class_calendar.id = ?
  `).bind(calendarId));
}

async function classHasReferences(env: WorkerEnv, classSessionId: string): Promise<boolean> {
  const row = await env.DB.prepare(`
    SELECT CASE WHEN
      EXISTS (SELECT 1 FROM enrollment WHERE class_session_id = ?)
      OR EXISTS (SELECT 1 FROM application_child WHERE selected_class_session_id = ?)
      OR EXISTS (SELECT 1 FROM waitlist_entry WHERE class_session_id = ?)
      OR EXISTS (SELECT 1 FROM registration_draft_child
        WHERE selected_class_session_id = ? OR preferred_waitlist_class_session_id = ?)
      OR EXISTS (SELECT 1 FROM registration_capacity_hold WHERE class_session_id = ?)
      OR EXISTS (SELECT 1 FROM registration_draft_waitlist_entry WHERE class_session_id = ?)
      OR EXISTS (SELECT 1 FROM class_calendar WHERE class_session_id = ?)
    THEN 1 ELSE 0 END AS found
  `).bind(
    classSessionId, classSessionId, classSessionId, classSessionId,
    classSessionId, classSessionId, classSessionId, classSessionId,
  ).first<{ found: number }>();
  return row?.found === 1;
}

async function breaksForYear(env: WorkerEnv, academicYearId: string): Promise<AcademicYearBreak[]> {
  const result = await env.DB.prepare(`
    SELECT id, label, starts_on AS startsOn, ends_on AS endsOn,
      excludes_habitual_slots AS excludesHabitualSlots
    FROM academic_year_break WHERE academic_year_id = ? AND status = 'active'
    ORDER BY starts_on, ends_on
  `).bind(academicYearId).all<AcademicYearBreak>();
  return result.results.map((row) => ({ ...row, excludesHabitualSlots: Boolean(row.excludesHabitualSlots) }));
}

async function overridesForRevision(env: WorkerEnv, revisionId: string): Promise<CalendarOverride[]> {
  const result = await env.DB.prepare(`
    SELECT id, local_date AS localDate, behavior, reason_label AS reasonLabel
    FROM class_calendar_revision_override WHERE class_calendar_revision_id = ? ORDER BY local_date
  `).bind(revisionId).all<CalendarOverride>();
  return result.results.map((row) => ({ ...row, reasonLabel: row.reasonLabel ?? undefined }));
}

async function slotsForRevision(env: WorkerEnv, revisionId: string): Promise<SlotRow[]> {
  const result = await env.DB.prepare(`
    SELECT slot.id, slot.class_calendar_revision_id AS revisionId, slot.local_date AS localDate,
      slot.start_time AS startTime, slot.end_time AS endTime, slot.slot_source AS slotSource,
      slot.status, slot.curriculum_lesson_id AS lessonId, lesson.sequence_number AS lessonSequence,
      lesson.title AS lessonTitle, slot.cancelled_lesson_sequence AS cancelledLessonSequence,
      slot.cancelled_lesson_title AS cancelledLessonTitle, slot.reason_label AS reasonLabel
    FROM class_calendar_slot AS slot
    LEFT JOIN curriculum_lesson AS lesson ON lesson.id = slot.curriculum_lesson_id
    WHERE slot.class_calendar_revision_id = ? ORDER BY slot.local_date, slot.start_time, slot.end_time, slot.id
  `).bind(revisionId).all<SlotRow>();
  return result.results;
}

function insertSlots(env: WorkerEnv, revisionId: string, slots: readonly CalendarSlot[], flags: { isTest: number; testRunId: string | null }, time: string): D1PreparedStatement[] {
  return slots.map((slot) => env.DB.prepare(`
    INSERT INTO class_calendar_slot (
      id, class_calendar_revision_id, local_date, start_time, end_time, slot_source,
      status, curriculum_lesson_id, cancelled_lesson_sequence, cancelled_lesson_title,
      reason_label, is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id(), revisionId, slot.localDate, slot.startTime, slot.endTime, slot.slotSource, slot.status,
    slot.lesson?.id ?? null, slot.cancelledLessonSequence, slot.cancelledLessonTitle,
    slot.reasonLabel, flags.isTest, flags.testRunId, time, time,
  ));
}

async function replaceDraftSlots(
  env: WorkerEnv,
  revision: RevisionRow,
  slots: readonly CalendarSlot[],
  actor: StaffPrincipal,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const time = now();
  const flags = operationFlags(env, revision);
  const result = await env.DB.batch([
    env.DB.prepare("DELETE FROM class_calendar_slot WHERE class_calendar_revision_id = ?").bind(revision.id),
    ...insertSlots(env, revision.id, slots, flags, time),
    env.DB.prepare("UPDATE class_calendar_revision SET updated_at = ? WHERE id = ? AND status = 'draft'").bind(time, revision.id),
    audit(env, actor, action, "class_calendar_revision", revision.id, metadata, flags, time),
  ]);
  if ((result.at(-2)?.meta?.changes ?? 0) !== 1) throw new ProgramCalendarError("conflict");
}

export async function getProgramCalendarOverview(env: WorkerEnv): Promise<Record<string, unknown>> {
  const [years, programs, lessons, classes, breaks, revisions, overrides, slots, stageSettings] = await Promise.all([
    env.DB.prepare(`SELECT id, public_label AS label, starts_on AS startsOn, ends_on AS endsOn,
      is_current AS isCurrent, is_test AS isTest, test_run_id AS testRunId
      FROM academic_year ORDER BY is_current DESC, starts_on DESC, public_label`).all<YearRow>(),
    env.DB.prepare(`SELECT id, academic_year_id AS academicYearId, stage_code AS stageCode,
      revision_number AS revisionNumber, display_name AS displayName, status, is_test AS isTest,
      test_run_id AS testRunId, updated_at AS updatedAt
      FROM curriculum_program ORDER BY academic_year_id, stage_code, revision_number DESC`).all<ProgramRow>(),
    env.DB.prepare(`SELECT id, curriculum_program_id AS programId, sequence_number AS sequenceNumber,
      title, internal_note AS internalNote FROM curriculum_lesson WHERE status = 'active'
      ORDER BY curriculum_program_id, sequence_number`).all<LessonRow>(),
    env.DB.prepare(`SELECT class_session.id, class_session.academic_year_id AS academicYearId,
      class_session.stage_code AS stageCode, class_session.display_label AS displayLabel,
      class_session.weekday, class_session.start_time AS startTime, class_session.end_time AS endTime,
      class_session.capacity, class_session.status,
      class_session.is_test AS isTest, class_session.test_run_id AS testRunId,
      class_session.updated_at AS updatedAt, class_calendar.id AS calendarId
      FROM class_session LEFT JOIN class_calendar ON class_calendar.class_session_id = class_session.id
      ORDER BY class_session.academic_year_id, class_session.stage_code, class_session.weekday, class_session.start_time`).all<ClassRow>(),
    env.DB.prepare(`SELECT id, academic_year_id AS academicYearId, label, starts_on AS startsOn,
      ends_on AS endsOn, excludes_habitual_slots AS excludesHabitualSlots, source_note AS sourceNote,
      status, is_test AS isTest, test_run_id AS testRunId, updated_at AS updatedAt
      FROM academic_year_break ORDER BY academic_year_id, starts_on`).all<BreakRow>(),
    env.DB.prepare(`SELECT revision.id, revision.class_calendar_id AS calendarId,
      calendar.class_session_id AS classSessionId, revision.curriculum_program_id AS programId,
      revision.revision_number AS revisionNumber, revision.status,
      revision.first_candidate_date AS firstCandidateDate,
      revision.locked_through_sequence AS lockedThroughSequence,
      revision.based_on_revision_id AS basedOnRevisionId, revision.is_test AS isTest,
      revision.test_run_id AS testRunId, revision.updated_at AS updatedAt
      FROM class_calendar_revision AS revision INNER JOIN class_calendar AS calendar ON calendar.id = revision.class_calendar_id
      ORDER BY calendar.class_session_id, revision.revision_number DESC`).all<RevisionRow>(),
    env.DB.prepare(`SELECT id, class_calendar_revision_id AS revisionId, local_date AS localDate,
      behavior, reason_label AS reasonLabel FROM class_calendar_revision_override ORDER BY revisionId, localDate`).all<OverrideRow>(),
    env.DB.prepare(`SELECT slot.id, slot.class_calendar_revision_id AS revisionId, slot.local_date AS localDate,
      slot.start_time AS startTime, slot.end_time AS endTime, slot.slot_source AS slotSource, slot.status,
      slot.curriculum_lesson_id AS lessonId, lesson.sequence_number AS lessonSequence, lesson.title AS lessonTitle,
      slot.cancelled_lesson_sequence AS cancelledLessonSequence, slot.cancelled_lesson_title AS cancelledLessonTitle,
      slot.reason_label AS reasonLabel FROM class_calendar_slot AS slot
      LEFT JOIN curriculum_lesson AS lesson ON lesson.id = slot.curriculum_lesson_id
      ORDER BY revisionId, localDate, startTime, endTime`).all<SlotRow>(),
    env.DB.prepare(`SELECT id, academic_year_id AS academicYearId, stage_code AS stageCode,
      facebook_group_url AS facebookGroupUrl, is_test AS isTest, test_run_id AS testRunId,
      updated_at AS updatedAt FROM academic_year_stage_setting
      ORDER BY academic_year_id, stage_code`).all<StageSettingRow>(),
  ]);
  const lessonsByProgram = new Map<string, LessonRow[]>();
  for (const lesson of lessons.results) lessonsByProgram.set(lesson.programId, [...(lessonsByProgram.get(lesson.programId) ?? []), lesson]);
  const overridesByRevision = new Map<string, OverrideRow[]>();
  for (const override of overrides.results) overridesByRevision.set(override.revisionId, [...(overridesByRevision.get(override.revisionId) ?? []), override]);
  const slotsByRevision = new Map<string, SlotRow[]>();
  for (const slot of slots.results) slotsByRevision.set(slot.revisionId, [...(slotsByRevision.get(slot.revisionId) ?? []), slot]);
  const classesWithTeacherDetails = await Promise.all(classes.results.map(async (entry) => ({
    ...entry,
    displayLabel: classDisplayLabel(entry.stageCode, entry.weekday, entry.startTime),
    registrationOpen: registrationOpen(entry.status),
    canDelete: !(await classHasReferences(env, entry.id)),
  })));
  return {
    years: years.results,
    programs: programs.results.map((program) => ({ ...program, lessons: lessonsByProgram.get(program.id) ?? [] })),
    classes: classesWithTeacherDetails,
    breaks: breaks.results,
    stageSettings: stageSettings.results,
    revisions: revisions.results.map((revision) => ({
      ...revision,
      overrides: overridesByRevision.get(revision.id) ?? [],
      slots: slotsByRevision.get(revision.id) ?? [],
    })),
    stages: STAGES,
    weekdays: WEEKDAYS,
  };
}

export async function createProgramDraft(
  env: WorkerEnv, actor: StaffPrincipal, input: { academicYearId: string; stageCode: string; displayName: string },
): Promise<void> {
  requireCapability(actor, "program.manage");
  if (!validStage(input.stageCode)) throw new ProgramCalendarError("invalid");
  const year = await one<YearRow>(env, env.DB.prepare("SELECT id, public_label AS label, starts_on AS startsOn, ends_on AS endsOn, is_current AS isCurrent, is_test AS isTest, test_run_id AS testRunId FROM academic_year WHERE id = ?").bind(input.academicYearId));
  const existing = await env.DB.prepare("SELECT id FROM curriculum_program WHERE academic_year_id = ? AND stage_code = ? AND status = 'draft'").bind(year.id, input.stageCode).first<{ id: string }>();
  if (existing) throw new ProgramCalendarError("conflict");
  const next = await env.DB.prepare("SELECT COALESCE(MAX(revision_number), 0) + 1 AS value FROM curriculum_program WHERE academic_year_id = ? AND stage_code = ?").bind(year.id, input.stageCode).first<{ value: number }>();
  const time = now(); const programId = id(); const flags = operationFlags(env, year);
  const displayName = text(input.displayName) || defaultProgramName(input.stageCode);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO curriculum_program (id, academic_year_id, stage_code, revision_number, display_name, status, is_test, test_run_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`)
      .bind(programId, year.id, input.stageCode, next?.value ?? 1, displayName, flags.isTest, flags.testRunId, time, time),
    audit(env, actor, "program_draft_created", "curriculum_program", programId, { stageCode: input.stageCode, academicYearId: year.id }, flags, time),
  ]);
}

export async function copyPreviousProgram(env: WorkerEnv, actor: StaffPrincipal, input: { academicYearId: string; stageCode: string }): Promise<void> {
  requireCapability(actor, "program.manage");
  if (!validStage(input.stageCode)) throw new ProgramCalendarError("invalid");
  const year = await one<YearRow>(env, env.DB.prepare("SELECT id, public_label AS label, starts_on AS startsOn, ends_on AS endsOn, is_current AS isCurrent, is_test AS isTest, test_run_id AS testRunId FROM academic_year WHERE id = ?").bind(input.academicYearId));
  const source = await env.DB.prepare(`
    SELECT program.id, program.academic_year_id AS academicYearId, program.stage_code AS stageCode,
      program.revision_number AS revisionNumber, program.display_name AS displayName, program.status,
      program.is_test AS isTest, program.test_run_id AS testRunId, program.updated_at AS updatedAt
    FROM curriculum_program AS program INNER JOIN academic_year ON academic_year.id = program.academic_year_id
    WHERE program.stage_code = ? AND program.status = 'published'
      AND COALESCE(academic_year.starts_on, '') < COALESCE(?, '9999-12-31')
    ORDER BY academic_year.starts_on DESC, program.revision_number DESC LIMIT 1
  `).bind(input.stageCode, year.startsOn).first<ProgramRow>();
  if (!source) throw new ProgramCalendarError("not_found");
  const sourceLessons = await lessonsForProgram(env, source.id);
  if (!sourceLessons.length) throw new ProgramCalendarError("invalid");
  const existing = await env.DB.prepare("SELECT id FROM curriculum_program WHERE academic_year_id = ? AND stage_code = ? AND status = 'draft'").bind(year.id, input.stageCode).first<{ id: string }>();
  if (existing) throw new ProgramCalendarError("conflict");
  const next = await env.DB.prepare("SELECT COALESCE(MAX(revision_number), 0) + 1 AS value FROM curriculum_program WHERE academic_year_id = ? AND stage_code = ?").bind(year.id, input.stageCode).first<{ value: number }>();
  const time = now(); const programId = id(); const flags = operationFlags(env, year);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO curriculum_program (id, academic_year_id, stage_code, revision_number, display_name, status, is_test, test_run_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`)
      .bind(programId, year.id, input.stageCode, next?.value ?? 1, source.displayName, flags.isTest, flags.testRunId, time, time),
    ...sourceLessons.map((lesson) => env.DB.prepare(`INSERT INTO curriculum_lesson (id, curriculum_program_id, sequence_number, title, internal_note, status, is_test, test_run_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
      .bind(id(), programId, lesson.sequenceNumber, lesson.title, lesson.internalNote, flags.isTest, flags.testRunId, time, time)),
    audit(env, actor, "program_draft_copied", "curriculum_program", programId, { sourceProgramId: source.id, academicYearId: year.id }, flags, time),
  ]);
}

export async function saveProgramDraft(env: WorkerEnv, actor: StaffPrincipal, input: ProgramSaveInput): Promise<void> {
  requireCapability(actor, "program.manage");
  const name = text(input.displayName); const entries = Array.isArray(input.lessons) ? input.lessons : [];
  if (!name || !input.expectedUpdatedAt || entries.length < 1 || entries.length > 80) throw new ProgramCalendarError("invalid");
  const program = await one<ProgramRow>(env, env.DB.prepare(`SELECT id, academic_year_id AS academicYearId, stage_code AS stageCode, revision_number AS revisionNumber, display_name AS displayName, status, is_test AS isTest, test_run_id AS testRunId, updated_at AS updatedAt FROM curriculum_program WHERE id = ?`).bind(input.programId));
  if (program.status !== "draft") throw new ProgramCalendarError("immutable");
  if (program.updatedAt !== input.expectedUpdatedAt) throw new ProgramCalendarError("conflict");
  const existing = await lessonsForProgram(env, program.id); const known = new Set(existing.map((lesson) => lesson.id));
  const inputIds = new Set<string>();
  const normalized = entries.map((entry, index) => {
    const title = text(entry?.title); const lessonId = text(entry?.id, 80);
    if (!title || (lessonId && (!known.has(lessonId) || inputIds.has(lessonId)))) throw new ProgramCalendarError("invalid");
    if (lessonId) inputIds.add(lessonId);
    return { id: lessonId || id(), title, internalNote: optionalText(entry?.internalNote), sequenceNumber: index + 1, existing: Boolean(lessonId) };
  });
  const time = now(); const flags = operationFlags(env, program);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`UPDATE curriculum_program SET display_name = ?, updated_at = ? WHERE id = ? AND status = 'draft' AND updated_at = ?`)
      .bind(name, time, program.id, input.expectedUpdatedAt),
    // Temporarily move existing sequence values out of the unique range before reordering.
    env.DB.prepare("UPDATE curriculum_lesson SET sequence_number = sequence_number + 1000, updated_at = ? WHERE curriculum_program_id = ?").bind(time, program.id),
  ];
  for (const lesson of existing.filter((entry) => !inputIds.has(entry.id))) statements.push(env.DB.prepare("DELETE FROM curriculum_lesson WHERE id = ?").bind(lesson.id));
  for (const lesson of normalized.filter((entry) => entry.existing)) statements.push(env.DB.prepare("UPDATE curriculum_lesson SET sequence_number = ?, title = ?, internal_note = ?, updated_at = ? WHERE id = ?").bind(lesson.sequenceNumber, lesson.title, lesson.internalNote, time, lesson.id));
  for (const lesson of normalized.filter((entry) => !entry.existing)) statements.push(env.DB.prepare(`INSERT INTO curriculum_lesson (id, curriculum_program_id, sequence_number, title, internal_note, status, is_test, test_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
    .bind(lesson.id, program.id, lesson.sequenceNumber, lesson.title, lesson.internalNote, flags.isTest, flags.testRunId, time, time));
  statements.push(audit(env, actor, "program_draft_saved", "curriculum_program", program.id, { lessonCount: normalized.length }, flags, time));
  const result = await env.DB.batch(statements);
  if ((result[0]?.meta?.changes ?? 0) !== 1) throw new ProgramCalendarError("conflict");
}

export async function publishProgramDraft(env: WorkerEnv, actor: StaffPrincipal, input: { programId: string; expectedUpdatedAt: string }): Promise<void> {
  requireCapability(actor, "program.manage");
  const program = await one<ProgramRow>(env, env.DB.prepare(`SELECT id, academic_year_id AS academicYearId, stage_code AS stageCode, revision_number AS revisionNumber, display_name AS displayName, status, is_test AS isTest, test_run_id AS testRunId, updated_at AS updatedAt FROM curriculum_program WHERE id = ?`).bind(input.programId));
  if (program.status !== "draft") throw new ProgramCalendarError("immutable");
  if (program.updatedAt !== input.expectedUpdatedAt || !(await lessonsForProgram(env, program.id)).length) throw new ProgramCalendarError("conflict");
  const time = now(); const flags = operationFlags(env, program);
  const result = await env.DB.batch([
    env.DB.prepare("UPDATE curriculum_program SET status = 'superseded', updated_at = ? WHERE academic_year_id = ? AND stage_code = ? AND status = 'published'").bind(time, program.academicYearId, program.stageCode),
    env.DB.prepare("UPDATE curriculum_program SET status = 'published', updated_at = ? WHERE id = ? AND status = 'draft' AND updated_at = ?").bind(time, program.id, input.expectedUpdatedAt),
    audit(env, actor, "program_published", "curriculum_program", program.id, { stageCode: program.stageCode, academicYearId: program.academicYearId }, flags, time),
  ]);
  if ((result[1]?.meta?.changes ?? 0) !== 1) throw new ProgramCalendarError("conflict");
}

export async function saveClassSession(env: WorkerEnv, actor: StaffPrincipal, input: ClassSaveInput): Promise<void> {
  requireCapability(actor, "calendar.manage");
  const stage = text(input.stageCode); const weekday = text(input.weekday);
  if (!validStage(stage) || !WEEKDAYS.includes(weekday as typeof WEEKDAYS[number]) || !validTime(input.startTime) || !validTime(input.endTime)
    || input.startTime >= input.endTime || !Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 80
    || (input.registrationOpen !== undefined && typeof input.registrationOpen !== "boolean")) throw new ProgramCalendarError("invalid");
  await one<YearRow>(env, env.DB.prepare("SELECT id, public_label AS label, starts_on AS startsOn, ends_on AS endsOn, is_current AS isCurrent, is_test AS isTest, test_run_id AS testRunId FROM academic_year WHERE id = ?").bind(input.academicYearId));
  const time = now(); const label = classDisplayLabel(stage, weekday, input.startTime);
  if (!input.id) {
    const flags = operationFlags(env);
    const classId = id();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO class_session (id, academic_year_id, stage_code, display_label, weekday, start_time, end_time, capacity, status, facebook_group_url, is_test_only, is_test, test_run_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'closed', NULL, 0, ?, ?, ?, ?)`)
        .bind(classId, input.academicYearId, stage, label, weekday, input.startTime, input.endTime, input.capacity, flags.isTest, flags.testRunId, time, time),
      audit(env, actor, "class_session_created", "class_session", classId, { stageCode: stage, academicYearId: input.academicYearId, registrationOpen: false }, flags, time),
    ]);
    return;
  }
  const current = await one<ClassRow>(env, env.DB.prepare(`SELECT class_session.id, class_session.academic_year_id AS academicYearId, class_session.stage_code AS stageCode, class_session.display_label AS displayLabel, class_session.weekday, class_session.start_time AS startTime, class_session.end_time AS endTime, class_session.capacity, class_session.status, class_session.is_test AS isTest, class_session.test_run_id AS testRunId, class_session.updated_at AS updatedAt, class_calendar.id AS calendarId FROM class_session LEFT JOIN class_calendar ON class_calendar.class_session_id = class_session.id WHERE class_session.id = ?`).bind(input.id));
  if (!input.expectedUpdatedAt || current.updatedAt !== input.expectedUpdatedAt) throw new ProgramCalendarError("conflict");
  const referenced = await classHasReferences(env, current.id);
  const structuralChange = current.academicYearId !== input.academicYearId || current.stageCode !== stage || current.weekday !== weekday || current.startTime !== input.startTime || current.endTime !== input.endTime || current.capacity !== input.capacity;
  if (referenced && structuralChange) throw new ProgramCalendarError("immutable");
  const status = input.registrationOpen === undefined
    ? current.status
    : input.registrationOpen ? "available" : "closed";
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE class_session SET academic_year_id = ?, stage_code = ?, display_label = ?, weekday = ?, start_time = ?, end_time = ?, capacity = ?, status = ?, updated_at = ? WHERE id = ? AND updated_at = ?`)
      .bind(input.academicYearId, stage, label, weekday, input.startTime, input.endTime, input.capacity, status, time, current.id, input.expectedUpdatedAt),
    audit(env, actor, "class_session_saved", "class_session", current.id, { registrationOpen: registrationOpen(status) }, operationFlags(env, current), time),
  ]);
  if ((result[0]?.meta?.changes ?? 0) !== 1) throw new ProgramCalendarError("conflict");
}

export async function deleteClassSession(env: WorkerEnv, actor: StaffPrincipal, input: { classSessionId: string; expectedUpdatedAt: string }): Promise<void> {
  requireCapability(actor, "calendar.manage");
  const current = await one<ClassRow>(env, env.DB.prepare(`SELECT class_session.id, class_session.academic_year_id AS academicYearId, class_session.stage_code AS stageCode, class_session.display_label AS displayLabel, class_session.weekday, class_session.start_time AS startTime, class_session.end_time AS endTime, class_session.capacity, class_session.status, class_session.is_test AS isTest, class_session.test_run_id AS testRunId, class_session.updated_at AS updatedAt, class_calendar.id AS calendarId FROM class_session LEFT JOIN class_calendar ON class_calendar.class_session_id = class_session.id WHERE class_session.id = ?`).bind(input.classSessionId));
  if (!input.expectedUpdatedAt || current.updatedAt !== input.expectedUpdatedAt) throw new ProgramCalendarError("conflict");
  if (await classHasReferences(env, current.id)) throw new ProgramCalendarError("referenced");
  const time = now();
  const result = await env.DB.batch([
    env.DB.prepare("DELETE FROM class_session WHERE id = ? AND updated_at = ?").bind(current.id, input.expectedUpdatedAt),
    audit(env, actor, "class_session_deleted", "class_session", current.id, {}, operationFlags(env, current), time),
  ]);
  if ((result[0]?.meta?.changes ?? 0) !== 1) throw new ProgramCalendarError("conflict");
}

export async function saveAcademicYearBreak(env: WorkerEnv, actor: StaffPrincipal, input: BreakSaveInput): Promise<void> {
  requireCapability(actor, "calendar.manage");
  const label = text(input.label); if (!label || !validDate(input.startsOn) || !validDate(input.endsOn) || input.endsOn < input.startsOn) throw new ProgramCalendarError("invalid");
  await one<YearRow>(env, env.DB.prepare("SELECT id, public_label AS label, starts_on AS startsOn, ends_on AS endsOn, is_current AS isCurrent, is_test AS isTest, test_run_id AS testRunId FROM academic_year WHERE id = ?").bind(input.academicYearId));
  const time = now();
  if (!input.id) {
    const flags = operationFlags(env); const breakId = id();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO academic_year_break (id, academic_year_id, label, starts_on, ends_on, excludes_habitual_slots, source_note, status, is_test, test_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
        .bind(breakId, input.academicYearId, label, input.startsOn, input.endsOn, 1, optionalText(input.sourceNote), flags.isTest, flags.testRunId, time, time),
      audit(env, actor, "academic_year_break_created", "academic_year_break", breakId, { academicYearId: input.academicYearId }, flags, time),
    ]);
    return;
  }
  const existing = await one<BreakRow>(env, env.DB.prepare(`SELECT id, academic_year_id AS academicYearId, label, starts_on AS startsOn, ends_on AS endsOn, excludes_habitual_slots AS excludesHabitualSlots, source_note AS sourceNote, status, is_test AS isTest, test_run_id AS testRunId, updated_at AS updatedAt FROM academic_year_break WHERE id = ?`).bind(input.id));
  if (!input.expectedUpdatedAt || existing.updatedAt !== input.expectedUpdatedAt || existing.status !== "active") throw new ProgramCalendarError("conflict");
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE academic_year_break SET label = ?, starts_on = ?, ends_on = ?, excludes_habitual_slots = 1, source_note = ?, updated_at = ? WHERE id = ? AND status = 'active' AND updated_at = ?`).bind(label, input.startsOn, input.endsOn, optionalText(input.sourceNote), time, existing.id, input.expectedUpdatedAt),
    audit(env, actor, "academic_year_break_saved", "academic_year_break", existing.id, {}, operationFlags(env, existing), time),
  ]);
  if ((result[0]?.meta?.changes ?? 0) !== 1) throw new ProgramCalendarError("conflict");
}

export async function removeAcademicYearBreak(env: WorkerEnv, actor: StaffPrincipal, input: { breakId: string; expectedUpdatedAt: string }): Promise<void> {
  requireCapability(actor, "calendar.manage");
  const current = await one<BreakRow>(env, env.DB.prepare(`SELECT id, academic_year_id AS academicYearId, label, starts_on AS startsOn, ends_on AS endsOn, excludes_habitual_slots AS excludesHabitualSlots, source_note AS sourceNote, status, is_test AS isTest, test_run_id AS testRunId, updated_at AS updatedAt FROM academic_year_break WHERE id = ?`).bind(input.breakId));
  if (current.status !== "active" || current.updatedAt !== input.expectedUpdatedAt) throw new ProgramCalendarError("conflict");
  const time = now(); const result = await env.DB.batch([
    env.DB.prepare("UPDATE academic_year_break SET status = 'archived', updated_at = ? WHERE id = ? AND status = 'active' AND updated_at = ?").bind(time, current.id, input.expectedUpdatedAt),
    audit(env, actor, "academic_year_break_removed", "academic_year_break", current.id, {}, operationFlags(env, current), time),
  ]); if ((result[0]?.meta?.changes ?? 0) !== 1) throw new ProgramCalendarError("conflict");
}

export async function saveAcademicYearStageSetting(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: StageSettingSaveInput,
): Promise<void> {
  requireCapability(actor, "calendar.manage");
  const stage = text(input.stageCode);
  const facebookGroupUrl = optionalText(input.facebookGroupUrl, 500);
  if (!validStage(stage) || !validOptionalUrl(facebookGroupUrl)) throw new ProgramCalendarError("invalid");
  const year = await one<YearRow>(env, env.DB.prepare("SELECT id, public_label AS label, starts_on AS startsOn, ends_on AS endsOn, is_current AS isCurrent, is_test AS isTest, test_run_id AS testRunId FROM academic_year WHERE id = ?").bind(input.academicYearId));
  const existing = await env.DB.prepare(`SELECT id, academic_year_id AS academicYearId, stage_code AS stageCode, facebook_group_url AS facebookGroupUrl, is_test AS isTest, test_run_id AS testRunId, updated_at AS updatedAt FROM academic_year_stage_setting WHERE academic_year_id = ? AND stage_code = ?`).bind(year.id, stage).first<StageSettingRow>();
  if (existing && (!input.expectedUpdatedAt || existing.updatedAt !== input.expectedUpdatedAt)) throw new ProgramCalendarError("conflict");
  const time = now();
  if (!existing) {
    const settingId = id(); const flags = operationFlags(env, year);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO academic_year_stage_setting (id, academic_year_id, stage_code, facebook_group_url, is_test, test_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(settingId, year.id, stage, facebookGroupUrl, flags.isTest, flags.testRunId, time, time),
      audit(env, actor, "academic_year_stage_setting_saved", "academic_year_stage_setting", settingId, { academicYearId: year.id, stageCode: stage }, flags, time),
    ]);
    return;
  }
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE academic_year_stage_setting SET facebook_group_url = ?, updated_at = ? WHERE id = ? AND updated_at = ?`).bind(facebookGroupUrl, time, existing.id, input.expectedUpdatedAt),
    audit(env, actor, "academic_year_stage_setting_saved", "academic_year_stage_setting", existing.id, { academicYearId: year.id, stageCode: stage }, operationFlags(env, existing), time),
  ]);
  if ((result[0]?.meta?.changes ?? 0) !== 1) throw new ProgramCalendarError("conflict");
}

async function nextRevisionNumber(env: WorkerEnv, calendarId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COALESCE(MAX(revision_number), 0) + 1 AS value FROM class_calendar_revision WHERE class_calendar_id = ?").bind(calendarId).first<{ value: number }>();
  return row?.value ?? 1;
}

export async function generateCalendarDraft(env: WorkerEnv, actor: StaffPrincipal, input: { classSessionId: string; programId: string; firstCandidateDate: string }): Promise<void> {
  requireCapability(actor, "calendar.manage");
  if (!validDate(input.firstCandidateDate)) throw new ProgramCalendarError("invalid");
  const classSession = await one<ClassRow>(env, env.DB.prepare(`SELECT class_session.id, class_session.academic_year_id AS academicYearId, class_session.stage_code AS stageCode, class_session.display_label AS displayLabel, class_session.weekday, class_session.start_time AS startTime, class_session.end_time AS endTime, class_session.capacity, class_session.status, class_session.is_test AS isTest, class_session.test_run_id AS testRunId, class_session.updated_at AS updatedAt, class_calendar.id AS calendarId FROM class_session LEFT JOIN class_calendar ON class_calendar.class_session_id = class_session.id WHERE class_session.id = ?`).bind(input.classSessionId));
  const program = await one<ProgramRow>(env, env.DB.prepare(`SELECT id, academic_year_id AS academicYearId, stage_code AS stageCode, revision_number AS revisionNumber, display_name AS displayName, status, is_test AS isTest, test_run_id AS testRunId, updated_at AS updatedAt FROM curriculum_program WHERE id = ?`).bind(input.programId));
  if (program.status !== "published" || program.academicYearId !== classSession.academicYearId || program.stageCode !== classSession.stageCode) throw new ProgramCalendarError("invalid");
  const draft = classSession.calendarId ? await env.DB.prepare("SELECT id FROM class_calendar_revision WHERE class_calendar_id = ? AND status = 'draft'").bind(classSession.calendarId).first<{ id: string }>() : null;
  if (draft) throw new ProgramCalendarError("conflict");
  const lessons = (await lessonsForProgram(env, program.id)).map(toProgramLesson); if (!lessons.length) throw new ProgramCalendarError("invalid");
  const breaks = await breaksForYear(env, classSession.academicYearId); const flags = operationFlags(env, classSession); const time = now();
  const calendarId = classSession.calendarId ?? id(); const revisionId = id();
  const schedule = generateCalendarSchedule({ lessons, firstCandidateDate: input.firstCandidateDate, habitualWeekday: classSession.weekday, startTime: classSession.startTime, endTime: classSession.endTime, breaks });
  const statements: D1PreparedStatement[] = [];
  if (!classSession.calendarId) statements.push(env.DB.prepare(`INSERT INTO class_calendar (id, class_session_id, timezone, status, is_test, test_run_id, created_at, updated_at) VALUES (?, ?, 'Asia/Ulaanbaatar', 'active', ?, ?, ?, ?)`).bind(calendarId, classSession.id, flags.isTest, flags.testRunId, time, time));
  statements.push(
    env.DB.prepare(`INSERT INTO class_calendar_revision (id, class_calendar_id, curriculum_program_id, revision_number, status, first_candidate_date, locked_through_sequence, based_on_revision_id, is_test, test_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, 0, NULL, ?, ?, ?, ?)`)
      .bind(revisionId, calendarId, program.id, await nextRevisionNumber(env, calendarId), input.firstCandidateDate, flags.isTest, flags.testRunId, time, time),
    ...insertSlots(env, revisionId, schedule, flags, time),
    audit(env, actor, "calendar_draft_generated", "class_calendar_revision", revisionId, { classSessionId: classSession.id, programId: program.id, slotCount: schedule.length }, flags, time),
  );
  await env.DB.batch(statements);
}

export async function createCalendarChangeDraft(env: WorkerEnv, actor: StaffPrincipal, input: { classSessionId: string }): Promise<void> {
  requireCapability(actor, "calendar.manage");
  const current = await one<RevisionRow>(env, env.DB.prepare(`SELECT revision.id, revision.class_calendar_id AS calendarId, revision.curriculum_program_id AS programId, revision.revision_number AS revisionNumber, revision.status, revision.first_candidate_date AS firstCandidateDate, revision.locked_through_sequence AS lockedThroughSequence, revision.based_on_revision_id AS basedOnRevisionId, revision.is_test AS isTest, revision.test_run_id AS testRunId, revision.updated_at AS updatedAt FROM class_calendar_revision AS revision INNER JOIN class_calendar ON class_calendar.id = revision.class_calendar_id WHERE class_calendar.class_session_id = ? AND revision.status = 'published'`).bind(input.classSessionId));
  const existingDraft = await env.DB.prepare("SELECT id FROM class_calendar_revision WHERE class_calendar_id = ? AND status = 'draft'").bind(current.calendarId).first<{ id: string }>(); if (existingDraft) throw new ProgramCalendarError("conflict");
  const oldSlots = await slotsForRevision(env, current.id); const oldOverrides = await overridesForRevision(env, current.id); const time = now(); const flags = operationFlags(env, current); const revisionId = id();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO class_calendar_revision (id, class_calendar_id, curriculum_program_id, revision_number, status, first_candidate_date, locked_through_sequence, based_on_revision_id, is_test, test_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(revisionId, current.calendarId, current.programId, await nextRevisionNumber(env, current.calendarId), current.firstCandidateDate, current.lockedThroughSequence, current.id, flags.isTest, flags.testRunId, time, time),
    ...oldOverrides.map((override) => env.DB.prepare(`INSERT INTO class_calendar_revision_override (id, class_calendar_revision_id, local_date, behavior, reason_label, is_test, test_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id(), revisionId, override.localDate, override.behavior, override.reasonLabel, flags.isTest, flags.testRunId, time, time)),
    ...oldSlots.map((slot) => env.DB.prepare(`INSERT INTO class_calendar_slot (id, class_calendar_revision_id, local_date, start_time, end_time, slot_source, status, curriculum_lesson_id, cancelled_lesson_sequence, cancelled_lesson_title, reason_label, is_test, test_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id(), revisionId, slot.localDate, slot.startTime, slot.endTime, slot.slotSource, slot.status, slot.lessonId, slot.cancelledLessonSequence, slot.cancelledLessonTitle, slot.reasonLabel, flags.isTest, flags.testRunId, time, time)),
    audit(env, actor, "calendar_change_draft_created", "class_calendar_revision", revisionId, { basedOnRevisionId: current.id }, flags, time),
  ]);
}

async function rebuiltDraftSchedule(env: WorkerEnv, revision: RevisionRow, addedExtra?: ExtraTeachingSlot): Promise<CalendarSlot[]> {
  const classSession = await classForCalendar(env, revision.calendarId);
  const lessons = (await lessonsForProgram(env, revision.programId)).map(toProgramLesson);
  const breaks = await breaksForYear(env, classSession.academicYearId);
  const overrides = await overridesForRevision(env, revision.id);
  const oldSlots = await slotsForRevision(env, revision.id);
  const extraSlots: ExtraTeachingSlot[] = oldSlots.filter((slot) => slot.slotSource === "manual_extra" && slot.status === "scheduled").map((slot) => ({ id: slot.id, localDate: slot.localDate, startTime: slot.startTime, endTime: slot.endTime, reasonLabel: slot.reasonLabel ?? undefined }));
  if (addedExtra) extraSlots.push(addedExtra);
  return generateCalendarSchedule({ lessons, firstCandidateDate: revision.firstCandidateDate, habitualWeekday: classSession.weekday, startTime: classSession.startTime, endTime: classSession.endTime, breaks, overrides, extraSlots });
}

export async function changeCalendarDraft(env: WorkerEnv, actor: StaffPrincipal, input: { revisionId: string; expectedUpdatedAt: string; kind: "exclude" | "restore" | "extra"; localDate: string; startTime?: string; endTime?: string; reasonLabel?: string | null }): Promise<void> {
  requireCapability(actor, "calendar.manage");
  if (!validDate(input.localDate) || !input.expectedUpdatedAt || !["exclude", "restore", "extra"].includes(input.kind)) throw new ProgramCalendarError("invalid");
  const revision = await revisionForUpdate(env, input.revisionId); if (revision.status !== "draft") throw new ProgramCalendarError("immutable"); if (revision.updatedAt !== input.expectedUpdatedAt) throw new ProgramCalendarError("conflict");
  const classSession = await classForCalendar(env, revision.calendarId); const time = now(); const flags = operationFlags(env, revision);
  if (input.kind === "extra" && (!validTime(input.startTime ?? "") || !validTime(input.endTime ?? "") || (input.startTime ?? "") >= (input.endTime ?? ""))) throw new ProgramCalendarError("invalid");
  let extra: ExtraTeachingSlot | undefined;
  if (input.kind === "extra") {
    const existing = await slotsForRevision(env, revision.id);
    if (existing.some((slot) => slot.localDate === input.localDate && slot.startTime === input.startTime && slot.endTime === input.endTime)) throw new ProgramCalendarError("conflict");
    extra = { id: id(), localDate: input.localDate, startTime: input.startTime as string, endTime: input.endTime as string, reasonLabel: optionalText(input.reasonLabel) ?? undefined };
  } else {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO class_calendar_revision_override (id, class_calendar_revision_id, local_date, behavior, reason_label, is_test, test_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(class_calendar_revision_id, local_date) DO UPDATE SET behavior = excluded.behavior, reason_label = excluded.reason_label, updated_at = excluded.updated_at`)
        .bind(id(), revision.id, input.localDate, input.kind, optionalText(input.reasonLabel), flags.isTest, flags.testRunId, time, time),
    ]);
  }
  const refreshed = await revisionForUpdate(env, revision.id);
  const rebuilt = await rebuiltDraftSchedule(env, refreshed, extra);
  await replaceDraftSlots(env, refreshed, rebuilt, actor, input.kind === "extra" ? "calendar_extra_added" : `calendar_override_${input.kind}`, { localDate: input.localDate, classSessionId: classSession.id });
}

export async function setCalendarDeliveredPrefix(env: WorkerEnv, actor: StaffPrincipal, input: { revisionId: string; expectedUpdatedAt: string; lockedThroughSequence: number }): Promise<void> {
  requireCapability(actor, "calendar.manage");
  const revision = await revisionForUpdate(env, input.revisionId); if (revision.status !== "draft" || revision.updatedAt !== input.expectedUpdatedAt || !Number.isInteger(input.lockedThroughSequence) || input.lockedThroughSequence < revision.lockedThroughSequence) throw new ProgramCalendarError("invalid");
  const count = (await lessonsForProgram(env, revision.programId)).length; if (input.lockedThroughSequence > count) throw new ProgramCalendarError("invalid");
  const time = now(); const result = await env.DB.batch([
    env.DB.prepare("UPDATE class_calendar_revision SET locked_through_sequence = ?, updated_at = ? WHERE id = ? AND status = 'draft' AND updated_at = ?").bind(input.lockedThroughSequence, time, revision.id, input.expectedUpdatedAt),
    audit(env, actor, "calendar_delivered_prefix_confirmed", "class_calendar_revision", revision.id, { lockedThroughSequence: input.lockedThroughSequence }, operationFlags(env, revision), time),
  ]); if ((result[0]?.meta?.changes ?? 0) !== 1) throw new ProgramCalendarError("conflict");
}

export async function cancelFutureCalendarSlot(env: WorkerEnv, actor: StaffPrincipal, input: { revisionId: string; expectedUpdatedAt: string; slotId: string; replacement?: { localDate: string; startTime: string; endTime: string; reasonLabel?: string | null } }): Promise<void> {
  requireCapability(actor, "calendar.manage");
  const revision = await revisionForUpdate(env, input.revisionId); if (revision.status !== "draft" || revision.updatedAt !== input.expectedUpdatedAt) throw new ProgramCalendarError("conflict");
  const classSession = await classForCalendar(env, revision.calendarId); const lessons = (await lessonsForProgram(env, revision.programId)).map(toProgramLesson); const breaks = await breaksForYear(env, classSession.academicYearId); const overrides = await overridesForRevision(env, revision.id); const slots = (await slotsForRevision(env, revision.id)).map(toSlot);
  const replacementSlots = input.replacement ? [{ id: id(), localDate: input.replacement.localDate, startTime: input.replacement.startTime, endTime: input.replacement.endTime, reasonLabel: optionalText(input.replacement.reasonLabel) ?? undefined }] : undefined;
  if (replacementSlots && (!validDate(replacementSlots[0].localDate) || !validTime(replacementSlots[0].startTime) || !validTime(replacementSlots[0].endTime) || replacementSlots[0].startTime >= replacementSlots[0].endTime)) throw new ProgramCalendarError("invalid");
  const result = reflowCancelledFutureSchedule({ lessons, firstCandidateDate: revision.firstCandidateDate, habitualWeekday: classSession.weekday, startTime: classSession.startTime, endTime: classSession.endTime, breaks, overrides, existingSlots: slots, lockedThroughSequence: revision.lockedThroughSequence, cancelSlotId: input.slotId, replacementSlots });
  await replaceDraftSlots(env, revision, result.slots, actor, "calendar_future_slot_cancelled", { slotId: input.slotId, changedFutureLessonAssignments: result.changedFutureLessonAssignments, newFinalLessonDate: result.newFinalLessonDate, hasReplacement: Boolean(replacementSlots?.length) });
}

export async function publishCalendarDraft(env: WorkerEnv, actor: StaffPrincipal, input: { revisionId: string; expectedUpdatedAt: string }): Promise<void> {
  requireCapability(actor, "calendar.manage");
  const revision = await revisionForUpdate(env, input.revisionId); if (revision.status !== "draft" || revision.updatedAt !== input.expectedUpdatedAt) throw new ProgramCalendarError("conflict");
  const lessons = await lessonsForProgram(env, revision.programId); const slots = await slotsForRevision(env, revision.id); const active = slots.filter((slot) => slot.status === "scheduled");
  if (!(await env.DB.prepare("SELECT id FROM curriculum_program WHERE id = ? AND status = 'published'").bind(revision.programId).first<{ id: string }>()) || active.length !== lessons.length || new Set(active.map((slot) => slot.lessonId)).size !== lessons.length || active.some((slot) => !slot.lessonId)) throw new ProgramCalendarError("invalid");
  const time = now(); const flags = operationFlags(env, revision); const result = await env.DB.batch([
    env.DB.prepare("UPDATE class_calendar_revision SET status = 'superseded', superseded_at = ?, updated_at = ? WHERE class_calendar_id = ? AND status = 'published'").bind(time, time, revision.calendarId),
    env.DB.prepare("UPDATE class_calendar_revision SET status = 'published', published_at = ?, updated_at = ? WHERE id = ? AND status = 'draft' AND updated_at = ?").bind(time, time, revision.id, input.expectedUpdatedAt),
    audit(env, actor, "calendar_published", "class_calendar_revision", revision.id, { calendarId: revision.calendarId, slotCount: slots.length }, flags, time),
  ]); if ((result[1]?.meta?.changes ?? 0) !== 1) throw new ProgramCalendarError("conflict");
}
