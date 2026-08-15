import type { D1PreparedStatement, WorkerEnv } from "../env";
import {
  calendarWarnings,
  generateCalendarPlan,
  generateCalendarSchedule,
  reflowCancelledFutureSchedule,
  SchedulePlanningError,
  type AcademicYearBreak,
  type CalendarWarning,
  type CalendarOverride,
  type CalendarSlot,
  type ExtraTeachingSlot,
  type MeetingRecurrenceKind,
  type OfferingBreak,
  type ProgramLesson,
} from "../services/program-calendar";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";
import { getAnnualCourseStartDefault } from "./annual-course-start-default";
import { getOfferingOverview } from "./offerings";
import { attendanceProtectedThroughSequence } from "./course-attendance";

const STAGES = ["stage_1", "stage_2", "stage_3"] as const;
type StageCode = typeof STAGES[number];
const WEEKDAYS = ["Даваа", "Мягмар", "Лхагва", "Пүрэв", "Баасан", "Бямба", "Ням"] as const;

export class ProgramCalendarError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "invalid" | "conflict" | "immutable" | "referenced" | "insufficient_slots") {
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
  programFamilyId: string;
  academicYearId: string;
  stageCode: StageCode;
  revisionNumber: number;
  displayName: string;
  programKind: "annual_course" | "summer_course";
  academicYearLabel?: string;
  academicYearStartsOn?: string | null;
  academicYearEndsOn?: string | null;
  status: "draft" | "published" | "superseded" | "archived";
  isTest: number;
  testRunId: string | null;
  basedOnProgramId: string | null;
  publishedAt: string | null;
  updatedAt: string;
}

interface ProgramFamilyRow {
  id: string;
  kind: "annual_course" | "summer_course";
  displayName: string;
  annualStageCode: StageCode | null;
  currentProgramId: string | null;
  status: "active" | "archived";
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
  offeringId: string | null;
  offeringKind: "annual_course" | "summer_course" | null;
  offeringTitle: string | null;
  offeringProgramId: string | null;
  offeringEndsOn: string | null;
  useAcademicYearBreaks: number;
  recurrenceKind: MeetingRecurrenceKind;
  firstDate: string;
  lastDate: string | null;
  weeklyWeekday: string | null;
}

interface OfferingContextRow {
  id: string;
  kind: "annual_course" | "summer_course" | "event";
  title: string;
  academicYearId: string | null;
  stageCode: StageCode | null;
  programId: string | null;
  programAcademicYearId: string | null;
  programStageCode: StageCode | null;
  programStatus: ProgramRow["status"] | null;
  useAcademicYearBreaks: number;
  startsOn: string | null;
  endsOn: string | null;
  defaultClassDurationMinutes: number | null;
  isTest: number;
  testRunId: string | null;
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
  generationBehavior: "exclude_by_default" | "warn_only";
  excludeFromGeneration: number;
  warnOnOverlap: number;
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
  endTime?: string;
  capacity: number;
  registrationOpen?: boolean;
  offeringId?: string;
  recurrenceKind?: string;
  firstDate?: string;
  lastDate?: string | null;
  weeklyWeekday?: string | null;
}
export interface BreakSaveInput {
  id?: string;
  expectedUpdatedAt?: string;
  academicYearId: string;
  label: string;
  startsOn: string;
  endsOn: string;
  excludeFromGeneration?: boolean;
  warnOnOverlap?: boolean;
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

function addMinutes(startTime: string, minutes: number): string {
  const [hours, minutesPart] = startTime.split(":").map(Number);
  const total = hours * 60 + minutesPart + minutes;
  if (total >= 24 * 60) throw new ProgramCalendarError("invalid");
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function durationMinutes(startTime: string, endTime: string): number {
  const [startHour, startMinute] = startTime.split(":").map(Number);
  const [endHour, endMinute] = endTime.split(":").map(Number);
  return endHour * 60 + endMinute - startHour * 60 - startMinute;
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

function shortDate(value: string): string {
  const [, month, day] = value.split("-").map(Number);
  return `${month}/${day}`;
}

function classDisplayLabel(entry: Pick<ClassRow, "stageCode" | "weekday" | "startTime" | "endTime" | "offeringKind" | "firstDate" | "lastDate">): string {
  if (entry.offeringKind === "summer_course") {
    return `${shortDate(entry.firstDate)}${entry.lastDate ? `–${shortDate(entry.lastDate)}` : ""} · ${entry.startTime}–${entry.endTime}`;
  }
  return `${stageLabel(entry.stageCode)} · ${entry.weekday} ${entry.startTime}–${entry.endTime}`;
}

function legacyWeekday(recurrence: MeetingRecurrenceKind, weeklyWeekday: string | null, firstDate: string): string {
  if (recurrence === "weekly") return weeklyWeekday as string;
  return `${recurrence === "weekdays" ? "Ажлын өдөр" : "Өдөр бүр"} ${shortDate(firstDate)}`;
}

function localToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ulaanbaatar",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function registrationOpen(status: ClassRow["status"]): boolean {
  return status === "available" || status === "full";
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
    lesson: row.status === "scheduled" && row.lessonId && row.lessonSequence && row.lessonTitle
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

const CLASS_SELECT = `SELECT class_session.id, class_session.academic_year_id AS academicYearId,
  class_session.stage_code AS stageCode, class_session.display_label AS displayLabel,
  COALESCE(class_meeting_rule.weekly_weekday, class_session.weekday) AS weekday,
  COALESCE(class_meeting_rule.start_time, class_session.start_time) AS startTime,
  COALESCE(class_meeting_rule.end_time, class_session.end_time) AS endTime,
  class_session.capacity, class_session.status,
  class_session.is_test AS isTest, class_session.test_run_id AS testRunId,
  class_session.updated_at AS updatedAt, class_calendar.id AS calendarId,
  class_session.activity_offering_id AS offeringId, activity_offering.kind AS offeringKind,
  activity_offering.title AS offeringTitle,
  activity_offering.curriculum_program_id AS offeringProgramId,
  activity_offering.ends_on AS offeringEndsOn,
  COALESCE(activity_offering.use_academic_year_breaks, 1) AS useAcademicYearBreaks,
  COALESCE(class_meeting_rule.recurrence_kind, 'weekly') AS recurrenceKind,
  COALESCE(class_meeting_rule.first_date, academic_year.starts_on, '1970-01-01') AS firstDate,
  class_meeting_rule.last_date AS lastDate,
  COALESCE(class_meeting_rule.weekly_weekday, class_session.weekday) AS weeklyWeekday
  FROM class_session
  INNER JOIN academic_year ON academic_year.id = class_session.academic_year_id
  LEFT JOIN class_calendar ON class_calendar.class_session_id = class_session.id
  LEFT JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
  LEFT JOIN class_meeting_rule ON class_meeting_rule.class_session_id = class_session.id`;

async function classById(env: WorkerEnv, classSessionId: string): Promise<ClassRow> {
  return one<ClassRow>(env, env.DB.prepare(`${CLASS_SELECT} WHERE class_session.id = ?`).bind(classSessionId));
}

async function classForCalendar(env: WorkerEnv, calendarId: string): Promise<ClassRow> {
  return one<ClassRow>(env, env.DB.prepare(`${CLASS_SELECT} WHERE class_calendar.id = ?`).bind(calendarId));
}

async function offeringContext(env: WorkerEnv, offeringId: string): Promise<OfferingContextRow> {
  return one<OfferingContextRow>(env, env.DB.prepare(`SELECT offering.id, offering.kind, offering.title,
    offering.academic_year_id AS academicYearId, offering.stage_code AS stageCode,
    offering.curriculum_program_id AS programId,
    program.academic_year_id AS programAcademicYearId, program.stage_code AS programStageCode,
    program.status AS programStatus, offering.use_academic_year_breaks AS useAcademicYearBreaks,
    offering.starts_on AS startsOn, offering.ends_on AS endsOn,
    offering.default_class_duration_minutes AS defaultClassDurationMinutes,
    offering.is_test AS isTest, offering.test_run_id AS testRunId
    FROM activity_offering AS offering
    LEFT JOIN curriculum_program AS program ON program.id = offering.curriculum_program_id
    WHERE offering.id = ? AND offering.status = 'active'`).bind(offeringId));
}

function scheduleInputForClass(classSession: ClassRow) {
  return {
    firstCandidateDate: classSession.firstDate,
    plannedEndDate: classSession.lastDate ?? classSession.offeringEndsOn,
    recurrenceKind: classSession.recurrenceKind,
    habitualWeekday: classSession.weeklyWeekday ?? undefined,
    startTime: classSession.startTime,
    endTime: classSession.endTime,
  };
}

async function applicableBreaks(env: WorkerEnv, classSession: ClassRow): Promise<AcademicYearBreak[]> {
  return classSession.offeringKind === "annual_course" && classSession.useAcademicYearBreaks
    ? breaksForYear(env, classSession.academicYearId)
    : [];
}

function mapPlanningError(caught: unknown): never {
  if (caught instanceof SchedulePlanningError && caught.code === "insufficient_slots") {
    throw new ProgramCalendarError("insufficient_slots");
  }
  throw caught;
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

async function offeringHasCalendar(env: WorkerEnv, offeringId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM class_session
    INNER JOIN class_calendar ON class_calendar.class_session_id = class_session.id
    INNER JOIN class_calendar_revision ON class_calendar_revision.class_calendar_id = class_calendar.id
    WHERE class_session.activity_offering_id = ?
  ) THEN 1 ELSE 0 END AS found`).bind(offeringId).first<{ found: number }>();
  return row?.found === 1;
}

async function breaksForYear(env: WorkerEnv, academicYearId: string): Promise<AcademicYearBreak[]> {
  const result = await env.DB.prepare(`
    SELECT id, label, starts_on AS startsOn, ends_on AS endsOn,
      excludes_habitual_slots AS excludesHabitualSlots,
      generation_behavior AS generationBehavior,
      exclude_from_generation AS excludeFromGeneration,
      warn_on_overlap AS warnOnOverlap
    FROM academic_year_break WHERE academic_year_id = ? AND status = 'active'
    ORDER BY starts_on, ends_on
  `).bind(academicYearId).all<AcademicYearBreak>();
  return result.results.map((row) => ({
    ...row,
    excludeFromGeneration: Boolean(row.excludeFromGeneration),
    warnOnOverlap: Boolean(row.warnOnOverlap),
  }));
}

async function offeringBreaksForOffering(env: WorkerEnv, offeringId: string): Promise<OfferingBreak[]> {
  const result = await env.DB.prepare(`SELECT id, label, starts_on AS startsOn, ends_on AS endsOn
    FROM activity_offering_break WHERE activity_offering_id = ? ORDER BY starts_on, ends_on`).bind(offeringId).all<OfferingBreak>();
  return result.results;
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
  preStatements: readonly D1PreparedStatement[] = [],
): Promise<void> {
  const time = now();
  const flags = operationFlags(env, revision);
  const result = await env.DB.batch([
    env.DB.prepare("DELETE FROM class_calendar_slot WHERE class_calendar_revision_id = ?").bind(revision.id),
    ...preStatements,
    ...insertSlots(env, revision.id, slots, flags, time),
    env.DB.prepare("UPDATE class_calendar_revision SET updated_at = ? WHERE id = ? AND status = 'draft'").bind(time, revision.id),
    audit(env, actor, action, "class_calendar_revision", revision.id, metadata, flags, time),
  ]);
  if ((result.at(-2)?.meta?.changes ?? 0) !== 1) throw new ProgramCalendarError("conflict");
}

export async function getProgramCalendarOverview(env: WorkerEnv): Promise<Record<string, unknown>> {
  const [years, families, programs, lessons, classes, breaks, revisions, overrides, slots, stageSettings, offeringSetup, annualCourseStartDefault] = await Promise.all([
    env.DB.prepare(`SELECT id, public_label AS label, starts_on AS startsOn, ends_on AS endsOn,
      is_current AS isCurrent, is_test AS isTest, test_run_id AS testRunId
      FROM academic_year ORDER BY is_current DESC, starts_on DESC, public_label`).all<YearRow>(),
    env.DB.prepare(`SELECT id, kind, display_name AS displayName,
      annual_stage_code AS annualStageCode, current_published_program_id AS currentProgramId,
      status, is_test AS isTest, test_run_id AS testRunId, updated_at AS updatedAt
      FROM curriculum_program_family ORDER BY kind, annual_stage_code, display_name`).all<ProgramFamilyRow>(),
    env.DB.prepare(`SELECT curriculum_program.id, curriculum_program.program_family_id AS programFamilyId,
      curriculum_program.academic_year_id AS academicYearId, curriculum_program.stage_code AS stageCode,
      curriculum_program.revision_number AS revisionNumber, curriculum_program.display_name AS displayName, curriculum_program.program_kind AS programKind, curriculum_program.status, curriculum_program.is_test AS isTest,
      curriculum_program.test_run_id AS testRunId, curriculum_program.based_on_program_id AS basedOnProgramId,
      curriculum_program.published_at AS publishedAt, curriculum_program.updated_at AS updatedAt,
      academic_year.public_label AS academicYearLabel,
      academic_year.starts_on AS academicYearStartsOn,
      academic_year.ends_on AS academicYearEndsOn
      FROM curriculum_program
      INNER JOIN academic_year ON academic_year.id = curriculum_program.academic_year_id
      ORDER BY curriculum_program.academic_year_id, curriculum_program.stage_code, curriculum_program.revision_number DESC`).all<ProgramRow>(),
    env.DB.prepare(`SELECT id, curriculum_program_id AS programId, sequence_number AS sequenceNumber,
      title, internal_note AS internalNote FROM curriculum_lesson WHERE status = 'active'
      ORDER BY curriculum_program_id, sequence_number`).all<LessonRow>(),
    env.DB.prepare(`${CLASS_SELECT}
      ORDER BY activity_offering.starts_on DESC, class_session.stage_code,
        class_meeting_rule.first_date, class_meeting_rule.start_time`).all<ClassRow>(),
    env.DB.prepare(`SELECT id, academic_year_id AS academicYearId, label, starts_on AS startsOn,
      ends_on AS endsOn, excludes_habitual_slots AS excludesHabitualSlots,
      generation_behavior AS generationBehavior,
      exclude_from_generation AS excludeFromGeneration,
      warn_on_overlap AS warnOnOverlap, source_note AS sourceNote,
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
    getOfferingOverview(env),
    getAnnualCourseStartDefault(env),
  ]);
  const lessonsByProgram = new Map<string, LessonRow[]>();
  for (const lesson of lessons.results) lessonsByProgram.set(lesson.programId, [...(lessonsByProgram.get(lesson.programId) ?? []), lesson]);
  const overridesByRevision = new Map<string, OverrideRow[]>();
  for (const override of overrides.results) overridesByRevision.set(override.revisionId, [...(overridesByRevision.get(override.revisionId) ?? []), override]);
  const slotsByRevision = new Map<string, SlotRow[]>();
  for (const slot of slots.results) slotsByRevision.set(slot.revisionId, [...(slotsByRevision.get(slot.revisionId) ?? []), slot]);
  const classesWithTeacherDetails = await Promise.all(classes.results.map(async (entry) => ({
    ...entry,
    displayLabel: classDisplayLabel(entry),
    registrationOpen: registrationOpen(entry.status),
    canDelete: !(await classHasReferences(env, entry.id)),
  })));
  const classById = new Map(classes.results.map((entry) => [entry.id, entry]));
  const offeringById = new Map((offeringSetup.offerings as Array<{ id: string; kind: string; endsOn?: string | null }>).map((entry) => [entry.id, entry]));
  const today = localToday();
  const programsWithLessons = programs.results.map((program) => ({ ...program, lessons: lessonsByProgram.get(program.id) ?? [] }));
  const programsByFamily = new Map<string, Array<(typeof programsWithLessons)[number]>>();
  for (const program of programsWithLessons) {
    programsByFamily.set(program.programFamilyId, [...(programsByFamily.get(program.programFamilyId) ?? []), program]);
  }
  const usedPrograms = await env.DB.prepare(`SELECT curriculum_program_id AS programId, COUNT(*) AS offeringCount
    FROM activity_offering WHERE curriculum_program_id IS NOT NULL GROUP BY curriculum_program_id`).all<{ programId: string; offeringCount: number }>();
  const usageByProgram = new Map(usedPrograms.results.map((entry) => [entry.programId, entry.offeringCount]));
  const programFamilies = families.results.map((family) => {
    const revisions = programsByFamily.get(family.id) ?? [];
    const currentProgram = revisions.find((program) => program.id === family.currentProgramId) ?? null;
    const draftProgram = revisions.find((program) => program.status === "draft"
      && !(program.programKind === "annual_course" && program.isTest === 1 && !program.basedOnProgramId)) ?? null;
    const history = revisions.filter((program) => program.id !== family.currentProgramId && program.status !== "draft" && program.status !== "archived")
      .map((program) => ({ ...program, offeringCount: usageByProgram.get(program.id) ?? 0 }));
    return {
      ...family,
      currentProgram,
      draftProgram,
      history,
      currentOfferingCount: currentProgram ? usageByProgram.get(currentProgram.id) ?? 0 : 0,
    };
  });
  return {
    years: years.results,
    programs: programsWithLessons,
    programFamilies,
    classes: classesWithTeacherDetails,
    breaks: breaks.results,
    stageSettings: stageSettings.results,
    offerings: offeringSetup.offerings,
    eventOccurrences: offeringSetup.eventOccurrences,
    offeringBreaks: offeringSetup.offeringBreaks,
    revisions: revisions.results.map((revision) => {
      const classSession = classById.get(revision.classSessionId);
      const offering = classSession?.offeringId ? offeringById.get(classSession.offeringId) : undefined;
      const schoolCalendarPeriods = classSession?.offeringKind === "annual_course"
        ? breaks.results.filter((period) => period.academicYearId === classSession.academicYearId && period.status === "active")
          .map((period) => ({
            ...period,
            excludesHabitualSlots: Boolean(period.excludesHabitualSlots),
            excludeFromGeneration: Boolean(period.excludeFromGeneration),
            warnOnOverlap: Boolean(period.warnOnOverlap),
          }))
        : [];
      const sharedOfferingBreaks = classSession?.offeringId
        ? (offeringSetup.offeringBreaks as Array<{ offeringId: string; startsOn: string; endsOn: string }>).filter((period) => period.offeringId === classSession.offeringId)
        : [];
      const revisionSlots = slotsByRevision.get(revision.id) ?? [];
      const warnings = classSession
        ? calendarWarnings(revisionSlots.map(toSlot), {
          schoolCalendarPeriods,
        plannedEndDate: offering?.kind === "summer_course" ? classSession.lastDate ?? offering.endsOn : null,
        })
        : [];
      return {
        ...revision,
        overrides: overridesByRevision.get(revision.id) ?? [],
        warnings,
        slots: revisionSlots.map((slot) => ({
          ...slot,
          lessonId: slot.status === "scheduled" ? slot.lessonId : null,
          lessonSequence: slot.status === "scheduled" ? slot.lessonSequence : null,
          lessonTitle: slot.status === "scheduled" ? slot.lessonTitle : null,
          holidayWarnings: schoolCalendarPeriods.filter((period) => period.warnOnOverlap && period.startsOn <= slot.localDate && slot.localDate <= period.endsOn).map((period) => period.label),
          isHistorical: slot.localDate < today,
          canCancel: revision.status === "draft"
            && slot.status === "scheduled"
            && slot.localDate >= today
            && (slot.lessonSequence ?? 0) > revision.lockedThroughSequence,
          canRestore: slot.status === "no_class"
            && slot.localDate >= today
            && !sharedOfferingBreaks.some((period) => period.startsOn <= slot.localDate && slot.localDate <= period.endsOn),
        })),
      };
    }),
    stages: STAGES,
    weekdays: WEEKDAYS,
    annualCourseStartDefault,
  };
}

async function familyById(env: WorkerEnv, familyId: string): Promise<ProgramFamilyRow> {
  return one<ProgramFamilyRow>(env, env.DB.prepare(`SELECT id, kind, display_name AS displayName,
    annual_stage_code AS annualStageCode, current_published_program_id AS currentProgramId,
    status, is_test AS isTest, test_run_id AS testRunId, updated_at AS updatedAt
    FROM curriculum_program_family WHERE id = ?`).bind(familyId));
}

async function programById(env: WorkerEnv, programId: string): Promise<ProgramRow> {
  return one<ProgramRow>(env, env.DB.prepare(`SELECT id, program_family_id AS programFamilyId,
    academic_year_id AS academicYearId, stage_code AS stageCode, revision_number AS revisionNumber,
    display_name AS displayName, program_kind AS programKind, status, is_test AS isTest,
    test_run_id AS testRunId, based_on_program_id AS basedOnProgramId,
    published_at AS publishedAt, updated_at AS updatedAt
    FROM curriculum_program WHERE id = ?`).bind(programId));
}

async function startFamilyDraft(
  env: WorkerEnv,
  actor: StaffPrincipal,
  familyId: string,
): Promise<void> {
  requireCapability(actor, "program.manage");
  const family = await familyById(env, familyId);
  const existing = await env.DB.prepare(`SELECT id FROM curriculum_program
    WHERE program_family_id = ? AND status = 'draft'
      AND NOT (program_kind = 'annual_course' AND is_test = 1 AND based_on_program_id IS NULL)`).bind(family.id).first<{ id: string }>();
  if (existing) return;
  if (!family.currentProgramId) throw new ProgramCalendarError("not_found");
  const source = await programById(env, family.currentProgramId);
  if (source.status !== "published") throw new ProgramCalendarError("conflict");
  const lessons = await lessonsForProgram(env, source.id);
  if (!lessons.length) throw new ProgramCalendarError("invalid");
  const next = await env.DB.prepare(`SELECT COALESCE(MAX(revision_number), 0) + 1 AS value
    FROM curriculum_program WHERE program_family_id = ?`).bind(family.id).first<{ value: number }>();
  const time = now(); const draftId = id(); const flags = operationFlags(env, source);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO curriculum_program (
      id, program_family_id, academic_year_id, stage_code, revision_number, display_name,
      program_kind, status, based_on_program_id, is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`)
      .bind(draftId, family.id, source.academicYearId, source.stageCode, next?.value ?? 1,
        source.displayName, source.programKind, source.id, flags.isTest, flags.testRunId, time, time),
    ...lessons.map((lesson) => env.DB.prepare(`INSERT INTO curriculum_lesson (
      id, curriculum_program_id, sequence_number, title, internal_note, status,
      is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
      .bind(id(), draftId, lesson.sequenceNumber, lesson.title, lesson.internalNote,
        flags.isTest, flags.testRunId, time, time)),
    audit(env, actor, "program_draft_started", "curriculum_program", draftId, {
      programFamilyId: family.id, sourceProgramId: source.id,
    }, flags, time),
  ]);
}

export async function startProgramFamilyDraft(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { programFamilyId: string },
): Promise<void> {
  await startFamilyDraft(env, actor, text(input.programFamilyId, 100));
}

export async function createSummerProgramFamilyDraft(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { displayName: string },
): Promise<void> {
  requireCapability(actor, "program.manage");
  const displayName = text(input.displayName);
  if (!displayName) throw new ProgramCalendarError("invalid");
  const familyId = id(); const programId = id(); const academicYearId = `summer-program-context-${programId}`;
  const time = now(); const flags = operationFlags(env);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO academic_year (
      id, public_label, registration_status, starts_on, ends_on, is_current,
      is_test, test_run_id, created_at, updated_at
    ) VALUES (?, 'Зуны хөтөлбөрийн дотоод тохиргоо', 'draft', NULL, NULL, 0, ?, ?, ?, ?)`)
      .bind(academicYearId, flags.isTest, flags.testRunId, time, time),
    env.DB.prepare(`INSERT INTO curriculum_program_family (
      id, kind, display_name, annual_stage_code, current_published_program_id,
      status, is_test, test_run_id, created_at, updated_at
    ) VALUES (?, 'summer_course', ?, NULL, NULL, 'active', ?, ?, ?, ?)`)
      .bind(familyId, displayName, flags.isTest, flags.testRunId, time, time),
    env.DB.prepare(`INSERT INTO curriculum_program (
      id, program_family_id, academic_year_id, stage_code, revision_number, display_name,
      program_kind, status, based_on_program_id, is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'stage_1', 1, ?, 'summer_course', 'draft', NULL, ?, ?, ?, ?)`)
      .bind(programId, familyId, academicYearId, displayName, flags.isTest, flags.testRunId, time, time),
    audit(env, actor, "summer_program_family_created", "curriculum_program_family", familyId, {
      draftProgramId: programId,
    }, flags, time),
  ]);
}

async function editableDraft(env: WorkerEnv, programId: string, expectedUpdatedAt: string): Promise<ProgramRow> {
  const program = await programById(env, programId);
  if (program.status !== "draft") throw new ProgramCalendarError("immutable");
  if (!expectedUpdatedAt || program.updatedAt !== expectedUpdatedAt) throw new ProgramCalendarError("conflict");
  return program;
}

async function touchDraft(
  env: WorkerEnv,
  actor: StaffPrincipal,
  program: ProgramRow,
  expectedUpdatedAt: string,
  action: string,
  metadata: Record<string, unknown>,
  statements: D1PreparedStatement[],
): Promise<void> {
  const time = now(); const flags = operationFlags(env, program);
  statements.push(
    env.DB.prepare(`UPDATE curriculum_program SET updated_at = ?
      WHERE id = ? AND status = 'draft' AND updated_at = ?`).bind(time, program.id, expectedUpdatedAt),
    audit(env, actor, action, "curriculum_program", program.id, metadata, flags, time),
  );
  const result = await env.DB.batch(statements);
  if ((result.at(-2)?.meta?.changes ?? 0) !== 1) throw new ProgramCalendarError("conflict");
}

export async function renameProgramDraft(
  env: WorkerEnv, actor: StaffPrincipal,
  input: { programId: string; expectedUpdatedAt: string; displayName: string },
): Promise<void> {
  requireCapability(actor, "program.manage");
  const name = text(input.displayName);
  if (!name) throw new ProgramCalendarError("invalid");
  const program = await editableDraft(env, input.programId, input.expectedUpdatedAt);
  const family = await familyById(env, program.programFamilyId);
  if (family.kind !== "summer_course") throw new ProgramCalendarError("immutable");
  const time = now(); const flags = operationFlags(env, program);
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE curriculum_program SET display_name = ?, updated_at = ?
      WHERE id = ? AND status = 'draft' AND updated_at = ?`).bind(name, time, program.id, input.expectedUpdatedAt),
    env.DB.prepare(`UPDATE curriculum_program_family SET display_name = ?, updated_at = ? WHERE id = ?`)
      .bind(name, time, family.id),
    audit(env, actor, "program_draft_renamed", "curriculum_program", program.id, { programFamilyId: family.id }, flags, time),
  ]);
  if ((result[0]?.meta?.changes ?? 0) !== 1) throw new ProgramCalendarError("conflict");
}

export async function renameProgramDraftLesson(
  env: WorkerEnv, actor: StaffPrincipal,
  input: { programId: string; expectedUpdatedAt: string; lessonId: string; title: string },
): Promise<void> {
  requireCapability(actor, "program.manage");
  const title = text(input.title, 200);
  if (!title) throw new ProgramCalendarError("invalid");
  const program = await editableDraft(env, input.programId, input.expectedUpdatedAt);
  const lesson = await env.DB.prepare(`SELECT id FROM curriculum_lesson
    WHERE id = ? AND curriculum_program_id = ? AND status = 'active'`).bind(input.lessonId, program.id).first<{ id: string }>();
  if (!lesson) throw new ProgramCalendarError("not_found");
  await touchDraft(env, actor, program, input.expectedUpdatedAt, "program_lesson_renamed", { lessonId: lesson.id }, [
    env.DB.prepare(`UPDATE curriculum_lesson SET title = ?, updated_at = ? WHERE id = ?`).bind(title, now(), lesson.id),
  ]);
}

export async function insertProgramDraftLesson(
  env: WorkerEnv, actor: StaffPrincipal,
  input: { programId: string; expectedUpdatedAt: string; beforeLessonId?: string; title: string },
): Promise<void> {
  requireCapability(actor, "program.manage");
  const title = text(input.title, 200);
  if (!title) throw new ProgramCalendarError("invalid");
  const program = await editableDraft(env, input.programId, input.expectedUpdatedAt);
  const lessons = await lessonsForProgram(env, program.id);
  const beforeIndex = input.beforeLessonId ? lessons.findIndex((lesson) => lesson.id === input.beforeLessonId) : lessons.length;
  if (input.beforeLessonId && beforeIndex < 0) throw new ProgramCalendarError("not_found");
  const sequenceNumber = beforeIndex + 1;
  const time = now(); const flags = operationFlags(env, program); const lessonId = id();
  await touchDraft(env, actor, program, input.expectedUpdatedAt, "program_lesson_inserted", { lessonId, sequenceNumber }, [
    env.DB.prepare(`UPDATE curriculum_lesson SET sequence_number = sequence_number + 1000, updated_at = ?
      WHERE curriculum_program_id = ? AND sequence_number >= ?`).bind(time, program.id, sequenceNumber),
    env.DB.prepare(`INSERT INTO curriculum_lesson (
      id, curriculum_program_id, sequence_number, title, internal_note, status,
      is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, NULL, 'active', ?, ?, ?, ?)`).bind(
      lessonId, program.id, sequenceNumber, title, flags.isTest, flags.testRunId, time, time,
    ),
    env.DB.prepare(`UPDATE curriculum_lesson SET sequence_number = sequence_number - 999, updated_at = ?
      WHERE curriculum_program_id = ? AND sequence_number >= 1000`).bind(time, program.id),
  ]);
}

async function programDraftMatchesCurrent(env: WorkerEnv, program: ProgramRow, family: ProgramFamilyRow): Promise<boolean> {
  if (!program.basedOnProgramId || family.currentProgramId !== program.basedOnProgramId) return false;
  const source = await programById(env, program.basedOnProgramId);
  if (source.displayName !== program.displayName) return false;
  const [sourceLessons, draftLessons] = await Promise.all([
    lessonsForProgram(env, source.id),
    lessonsForProgram(env, program.id),
  ]);
  return sourceLessons.length === draftLessons.length
    && sourceLessons.every((lesson, index) => lesson.title === draftLessons[index]?.title
      && (lesson.internalNote ?? null) === (draftLessons[index]?.internalNote ?? null));
}

export async function discardProgramFamilyDraft(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { programFamilyId: string; expectedUpdatedAt: string },
): Promise<void> {
  requireCapability(actor, "program.manage");
  const family = await familyById(env, text(input.programFamilyId, 100));
  const draft = await env.DB.prepare(`SELECT id, program_family_id AS programFamilyId,
    academic_year_id AS academicYearId, stage_code AS stageCode, revision_number AS revisionNumber,
    display_name AS displayName, program_kind AS programKind, status, is_test AS isTest,
    test_run_id AS testRunId, based_on_program_id AS basedOnProgramId,
    published_at AS publishedAt, updated_at AS updatedAt
    FROM curriculum_program WHERE program_family_id = ? AND status = 'draft'
      AND NOT (program_kind = 'annual_course' AND is_test = 1 AND based_on_program_id IS NULL)`)
    .bind(family.id).first<ProgramRow>();
  if (!draft) return;
  if (!input.expectedUpdatedAt || draft.updatedAt !== input.expectedUpdatedAt) throw new ProgramCalendarError("conflict");
  if (!draft.basedOnProgramId || family.currentProgramId !== draft.basedOnProgramId) throw new ProgramCalendarError("conflict");
  const time = now(); const flags = operationFlags(env, draft);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM curriculum_lesson WHERE curriculum_program_id = ?").bind(draft.id),
    env.DB.prepare("DELETE FROM curriculum_program WHERE id = ? AND status = 'draft'").bind(draft.id),
    audit(env, actor, "program_draft_discarded", "curriculum_program", draft.id, {
      programFamilyId: family.id, basedOnProgramId: draft.basedOnProgramId,
    }, flags, time),
  ]);
}

export async function deleteProgramDraftLesson(
  env: WorkerEnv, actor: StaffPrincipal,
  input: { programId: string; expectedUpdatedAt: string; lessonId: string },
): Promise<void> {
  requireCapability(actor, "program.manage");
  const program = await editableDraft(env, input.programId, input.expectedUpdatedAt);
  const lessons = await lessonsForProgram(env, program.id);
  const lesson = lessons.find((entry) => entry.id === input.lessonId);
  if (!lesson) throw new ProgramCalendarError("not_found");
  if (lessons.length < 2) throw new ProgramCalendarError("invalid");
  const time = now();
  await touchDraft(env, actor, program, input.expectedUpdatedAt, "program_lesson_deleted", { lessonId: lesson.id }, [
    env.DB.prepare(`UPDATE curriculum_lesson SET sequence_number = sequence_number + 1000, updated_at = ?
      WHERE curriculum_program_id = ? AND sequence_number > ?`).bind(time, program.id, lesson.sequenceNumber),
    env.DB.prepare("DELETE FROM curriculum_lesson WHERE id = ?").bind(lesson.id),
    env.DB.prepare(`UPDATE curriculum_lesson SET sequence_number = sequence_number - 1001, updated_at = ?
      WHERE curriculum_program_id = ? AND sequence_number >= 1000`).bind(time, program.id),
  ]);
}

export async function moveProgramDraftLesson(
  env: WorkerEnv, actor: StaffPrincipal,
  input: { programId: string; expectedUpdatedAt: string; lessonId: string; direction: string },
): Promise<void> {
  requireCapability(actor, "program.manage");
  const program = await editableDraft(env, input.programId, input.expectedUpdatedAt);
  const lessons = await lessonsForProgram(env, program.id);
  const index = lessons.findIndex((lesson) => lesson.id === input.lessonId);
  if (index < 0) throw new ProgramCalendarError("not_found");
  const targetIndex = input.direction === "up" ? index - 1 : input.direction === "down" ? index + 1 : -1;
  if (targetIndex < 0 || targetIndex >= lessons.length) throw new ProgramCalendarError("invalid");
  const source = lessons[index]; const target = lessons[targetIndex]; const time = now();
  const movingUp = targetIndex < index;
  const lower = Math.min(source.sequenceNumber, target.sequenceNumber);
  const upper = Math.max(source.sequenceNumber, target.sequenceNumber);
  await touchDraft(env, actor, program, input.expectedUpdatedAt, "program_lesson_moved", { lessonId: source.id, direction: input.direction }, [
    env.DB.prepare("UPDATE curriculum_lesson SET sequence_number = 100000 WHERE id = ?").bind(source.id),
    env.DB.prepare(`UPDATE curriculum_lesson SET sequence_number = sequence_number + 1000, updated_at = ?
      WHERE curriculum_program_id = ? AND sequence_number BETWEEN ? AND ?`).bind(time, program.id, lower, upper),
    env.DB.prepare(`UPDATE curriculum_lesson SET sequence_number = sequence_number - ?, updated_at = ?
      WHERE curriculum_program_id = ? AND sequence_number >= 1000`).bind(movingUp ? 999 : 1001, time, program.id),
    env.DB.prepare("UPDATE curriculum_lesson SET sequence_number = ?, updated_at = ? WHERE id = ?")
      .bind(target.sequenceNumber, time, source.id),
  ]);
}

export async function publishProgramFamilyDraft(
  env: WorkerEnv, actor: StaffPrincipal,
  input: { programId: string; expectedUpdatedAt: string },
): Promise<void> {
  requireCapability(actor, "program.manage");
  const program = await editableDraft(env, input.programId, input.expectedUpdatedAt);
  const family = await familyById(env, program.programFamilyId);
  if (family.currentProgramId !== program.basedOnProgramId) throw new ProgramCalendarError("conflict");
  if (!(await lessonsForProgram(env, program.id)).length) throw new ProgramCalendarError("invalid");
  if (await programDraftMatchesCurrent(env, program, family)) {
    await discardProgramFamilyDraft(env, actor, { programFamilyId: family.id, expectedUpdatedAt: input.expectedUpdatedAt });
    return;
  }
  const time = now(); const flags = operationFlags(env, program);
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE curriculum_program SET status = 'superseded', updated_at = ?
      WHERE id = ? AND status = 'published'`).bind(time, family.currentProgramId),
    env.DB.prepare(`UPDATE curriculum_program SET status = 'published', published_at = ?, updated_at = ?
      WHERE id = ? AND status = 'draft' AND updated_at = ?`).bind(time, time, program.id, input.expectedUpdatedAt),
    env.DB.prepare(`UPDATE curriculum_program_family SET current_published_program_id = ?, updated_at = ?
      WHERE id = ? AND current_published_program_id IS ?`).bind(program.id, time, family.id, program.basedOnProgramId),
    audit(env, actor, "program_published", "curriculum_program", program.id, {
      programFamilyId: family.id, replacedProgramId: program.basedOnProgramId,
    }, flags, time),
  ]);
  if ((result[1]?.meta?.changes ?? 0) !== 1 || (result[2]?.meta?.changes ?? 0) !== 1) throw new ProgramCalendarError("conflict");
}

export async function deleteSummerProgramFamilyDraft(
  env: WorkerEnv, actor: StaffPrincipal,
  input: { programFamilyId: string },
): Promise<void> {
  requireCapability(actor, "program.manage");
  const family = await familyById(env, input.programFamilyId);
  if (family.kind !== "summer_course") throw new ProgramCalendarError("immutable");
  const revisions = await env.DB.prepare(`SELECT id, status FROM curriculum_program WHERE program_family_id = ?`)
    .bind(family.id).all<{ id: string; status: ProgramRow["status"] }>();
  if (!revisions.results.length) throw new ProgramCalendarError("not_found");
  const referenced = await env.DB.prepare(`SELECT 1 FROM activity_offering
    WHERE curriculum_program_id IN (SELECT id FROM curriculum_program WHERE program_family_id = ?) LIMIT 1`).bind(family.id).first();
  const time = now(); const flags = operationFlags(env, family);
  if (referenced) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE curriculum_program_family SET status = 'archived', updated_at = ?
        WHERE id = ? AND kind = 'summer_course' AND status = 'active'`).bind(time, family.id),
      audit(env, actor, "summer_program_family_archived", "curriculum_program_family", family.id, {}, flags, time),
    ]);
    return;
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE curriculum_program_family SET current_published_program_id = NULL WHERE id = ?").bind(family.id),
    env.DB.prepare(`DELETE FROM curriculum_lesson WHERE curriculum_program_id IN (
      SELECT id FROM curriculum_program WHERE program_family_id = ?
    )`).bind(family.id),
    env.DB.prepare("DELETE FROM curriculum_program WHERE program_family_id = ?").bind(family.id),
    env.DB.prepare("DELETE FROM curriculum_program_family WHERE id = ? AND kind = 'summer_course'").bind(family.id),
    audit(env, actor, "summer_program_family_deleted", "curriculum_program_family", family.id, {}, flags, time),
  ]);
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
    env.DB.prepare(`INSERT INTO curriculum_program (id, academic_year_id, stage_code, revision_number, display_name, program_kind, status, is_test, test_run_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'annual_course', 'draft', ?, ?, ?, ?)`)
      .bind(programId, year.id, input.stageCode, next?.value ?? 1, displayName, flags.isTest, flags.testRunId, time, time),
    audit(env, actor, "program_draft_created", "curriculum_program", programId, { stageCode: input.stageCode, academicYearId: year.id }, flags, time),
  ]);
}

/** Summer programs are created here, before a summer Offering selects the published program. */
export async function createSummerProgramDraft(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { displayName: string },
): Promise<void> {
  requireCapability(actor, "program.manage");
  const displayName = text(input.displayName);
  if (!displayName) throw new ProgramCalendarError("invalid");
  const programId = id();
  const academicYearId = `summer-program-context-${programId}`;
  const time = now();
  const flags = operationFlags(env);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO academic_year (
      id, public_label, registration_status, starts_on, ends_on, is_current,
      is_test, test_run_id, created_at, updated_at
    ) VALUES (?, 'Зуны хөтөлбөрийн дотоод тохиргоо', 'draft', NULL, NULL, 0, ?, ?, ?, ?)`)
      .bind(academicYearId, flags.isTest, flags.testRunId, time, time),
    env.DB.prepare(`INSERT INTO curriculum_program (
      id, academic_year_id, stage_code, revision_number, display_name, program_kind,
      status, is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, 'stage_1', 1, ?, 'summer_course', 'draft', ?, ?, ?, ?)`)
      .bind(programId, academicYearId, displayName, flags.isTest, flags.testRunId, time, time),
    audit(env, actor, "summer_program_draft_created", "curriculum_program", programId, {
      academicYearId,
    }, flags, time),
  ]);
}

export async function copyPreviousProgram(env: WorkerEnv, actor: StaffPrincipal, input: { academicYearId: string; stageCode: string }): Promise<void> {
  requireCapability(actor, "program.manage");
  if (!validStage(input.stageCode)) throw new ProgramCalendarError("invalid");
  const year = await one<YearRow>(env, env.DB.prepare("SELECT id, public_label AS label, starts_on AS startsOn, ends_on AS endsOn, is_current AS isCurrent, is_test AS isTest, test_run_id AS testRunId FROM academic_year WHERE id = ?").bind(input.academicYearId));
  const source = await env.DB.prepare(`
    SELECT program.id, program.academic_year_id AS academicYearId, program.stage_code AS stageCode,
      program.revision_number AS revisionNumber, program.display_name AS displayName,
      program.program_kind AS programKind, program.status,
      program.is_test AS isTest, program.test_run_id AS testRunId, program.updated_at AS updatedAt
    FROM curriculum_program AS program INNER JOIN academic_year ON academic_year.id = program.academic_year_id
    WHERE program.stage_code = ? AND program.program_kind = 'annual_course' AND program.status = 'published'
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
    env.DB.prepare(`INSERT INTO curriculum_program (id, academic_year_id, stage_code, revision_number, display_name, program_kind, status, is_test, test_run_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'annual_course', 'draft', ?, ?, ?, ?)`)
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
  const program = await one<ProgramRow>(env, env.DB.prepare(`SELECT id, academic_year_id AS academicYearId, stage_code AS stageCode, revision_number AS revisionNumber, display_name AS displayName, program_kind AS programKind, status, is_test AS isTest, test_run_id AS testRunId, updated_at AS updatedAt FROM curriculum_program WHERE id = ?`).bind(input.programId));
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

export async function createOfferingProgramDraft(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { offeringId: string },
): Promise<void> {
  requireCapability(actor, "program.manage");
  const offering = await offeringContext(env, input.offeringId);
  if (offering.kind === "event" || !offering.programId || !offering.programAcademicYearId || !offering.programStageCode) {
    throw new ProgramCalendarError("invalid");
  }
  if (offering.programStatus === "draft") throw new ProgramCalendarError("conflict");
  if (await offeringHasCalendar(env, offering.id)) throw new ProgramCalendarError("immutable");
  const existing = await env.DB.prepare(`SELECT id FROM curriculum_program
    WHERE academic_year_id = ? AND stage_code = ? AND status = 'draft'`)
    .bind(offering.programAcademicYearId, offering.programStageCode).first<{ id: string }>();
  if (existing) throw new ProgramCalendarError("conflict");
  const source = await one<ProgramRow>(env, env.DB.prepare(`SELECT id, academic_year_id AS academicYearId,
    stage_code AS stageCode, revision_number AS revisionNumber, display_name AS displayName,
    program_kind AS programKind, status, is_test AS isTest, test_run_id AS testRunId, updated_at AS updatedAt
    FROM curriculum_program WHERE id = ? AND status = 'published'`).bind(offering.programId));
  const sourceLessons = await lessonsForProgram(env, source.id);
  const next = await env.DB.prepare(`SELECT COALESCE(MAX(revision_number), 0) + 1 AS value
    FROM curriculum_program WHERE academic_year_id = ? AND stage_code = ?`)
    .bind(source.academicYearId, source.stageCode).first<{ value: number }>();
  const draftId = id(); const time = now(); const provenance = operationFlags(env, offering);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO curriculum_program (
      id, academic_year_id, stage_code, revision_number, display_name, program_kind, status,
      is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`)
      .bind(draftId, source.academicYearId, source.stageCode, next?.value ?? 1,
        source.programKind,
        source.displayName, provenance.isTest, provenance.testRunId, time, time),
    ...sourceLessons.map((lesson) => env.DB.prepare(`INSERT INTO curriculum_lesson (
      id, curriculum_program_id, sequence_number, title, internal_note, status,
      is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
      .bind(id(), draftId, lesson.sequenceNumber, lesson.title, lesson.internalNote,
        provenance.isTest, provenance.testRunId, time, time)),
    audit(env, actor, "program_draft_created_for_offering", "curriculum_program", draftId, {
      offeringId: offering.id, sourceProgramId: source.id,
    }, provenance, time),
  ]);
}

export async function createProgramRevisionDraft(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { sourceProgramId: string },
): Promise<void> {
  requireCapability(actor, "program.manage");
  const source = await one<ProgramRow>(env, env.DB.prepare(`SELECT id, academic_year_id AS academicYearId,
    stage_code AS stageCode, revision_number AS revisionNumber, display_name AS displayName,
    program_kind AS programKind, status, is_test AS isTest, test_run_id AS testRunId, updated_at AS updatedAt
    FROM curriculum_program WHERE id = ? AND status = 'published'`).bind(input.sourceProgramId));
  const existing = await env.DB.prepare(`SELECT id FROM curriculum_program
    WHERE academic_year_id = ? AND stage_code = ? AND status = 'draft'`).bind(source.academicYearId, source.stageCode).first<{ id: string }>();
  if (existing) throw new ProgramCalendarError("conflict");
  const lessons = await lessonsForProgram(env, source.id);
  if (!lessons.length) throw new ProgramCalendarError("invalid");
  const next = await env.DB.prepare(`SELECT COALESCE(MAX(revision_number), 0) + 1 AS value
    FROM curriculum_program WHERE academic_year_id = ? AND stage_code = ?`).bind(source.academicYearId, source.stageCode).first<{ value: number }>();
  const draftId = id(); const time = now(); const flags = operationFlags(env, source);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO curriculum_program (
      id, academic_year_id, stage_code, revision_number, display_name, program_kind, status,
      is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`)
      .bind(draftId, source.academicYearId, source.stageCode, next?.value ?? 1, source.displayName,
        source.programKind, flags.isTest, flags.testRunId, time, time),
    ...lessons.map((lesson) => env.DB.prepare(`INSERT INTO curriculum_lesson (
      id, curriculum_program_id, sequence_number, title, internal_note, status,
      is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
      .bind(id(), draftId, lesson.sequenceNumber, lesson.title, lesson.internalNote,
        flags.isTest, flags.testRunId, time, time)),
    audit(env, actor, "program_draft_copied", "curriculum_program", draftId, { sourceProgramId: source.id }, flags, time),
  ]);
}

export async function publishProgramDraft(env: WorkerEnv, actor: StaffPrincipal, input: { programId: string; expectedUpdatedAt: string; offeringId?: string }): Promise<void> {
  requireCapability(actor, "program.manage");
  const program = await one<ProgramRow>(env, env.DB.prepare(`SELECT id, academic_year_id AS academicYearId, stage_code AS stageCode, revision_number AS revisionNumber, display_name AS displayName, program_kind AS programKind, status, is_test AS isTest, test_run_id AS testRunId, updated_at AS updatedAt FROM curriculum_program WHERE id = ?`).bind(input.programId));
  if (program.status !== "draft") throw new ProgramCalendarError("immutable");
  if (program.updatedAt !== input.expectedUpdatedAt || !(await lessonsForProgram(env, program.id)).length) throw new ProgramCalendarError("conflict");
  const offering = input.offeringId ? await offeringContext(env, input.offeringId) : null;
  if (offering) {
    if (offering.kind === "event"
      || program.programKind !== offering.kind
      || offering.programAcademicYearId !== program.academicYearId
      || offering.programStageCode !== program.stageCode) throw new ProgramCalendarError("invalid");
    if (offering.programId !== program.id && await offeringHasCalendar(env, offering.id)) throw new ProgramCalendarError("immutable");
  }
  const time = now(); const flags = operationFlags(env, program);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("UPDATE curriculum_program SET status = 'superseded', updated_at = ? WHERE academic_year_id = ? AND stage_code = ? AND status = 'published'").bind(time, program.academicYearId, program.stageCode),
    env.DB.prepare("UPDATE curriculum_program SET status = 'published', updated_at = ? WHERE id = ? AND status = 'draft' AND updated_at = ?").bind(time, program.id, input.expectedUpdatedAt),
  ];
  if (offering && offering.programId !== program.id) {
    statements.push(env.DB.prepare(`UPDATE activity_offering SET curriculum_program_id = ?, updated_at = ?
      WHERE id = ? AND curriculum_program_id = ?`).bind(program.id, time, offering.id, offering.programId));
  }
  statements.push(audit(env, actor, "program_published", "curriculum_program", program.id, {
    stageCode: program.stageCode, academicYearId: program.academicYearId, offeringId: offering?.id ?? null,
  }, flags, time));
  const result = await env.DB.batch(statements);
  if ((result[1]?.meta?.changes ?? 0) !== 1) throw new ProgramCalendarError("conflict");
}

export async function saveClassSession(env: WorkerEnv, actor: StaffPrincipal, input: ClassSaveInput): Promise<void> {
  requireCapability(actor, "calendar.manage");
  let requestedOfferingId = text(input.offeringId, 100);
  if (!requestedOfferingId && input.academicYearId && input.stageCode) {
    const compatible = await env.DB.prepare(`SELECT id FROM activity_offering
      WHERE kind = 'annual_course' AND academic_year_id = ? AND stage_code = ? AND status = 'active'`)
      .bind(input.academicYearId, input.stageCode).first<{ id: string }>();
    requestedOfferingId = compatible?.id ?? "";
  }
  if (!requestedOfferingId) throw new ProgramCalendarError("invalid");
  const offering = await offeringContext(env, requestedOfferingId);
  if (offering.kind === "event" || !offering.programId || !offering.programAcademicYearId || !offering.programStageCode) {
    throw new ProgramCalendarError("invalid");
  }
  const academicYearId = offering.academicYearId ?? offering.programAcademicYearId;
  const stage = offering.stageCode ?? offering.programStageCode;
  const recurrence = (text(input.recurrenceKind, 20) || (offering.kind === "summer_course" ? "daily" : "weekly")) as MeetingRecurrenceKind;
  const firstDate = text(input.firstDate, 10) || offering.startsOn || "";
  const lastDate = optionalText(input.lastDate, 10) ?? (offering.kind === "summer_course" ? offering.endsOn : null);
  const weeklyWeekday = recurrence === "weekly" ? text(input.weeklyWeekday ?? input.weekday, 20) : null;
  const endTime = text(input.endTime, 5) || addMinutes(input.startTime, offering.defaultClassDurationMinutes ?? 80);
  if (!["weekly", "weekdays", "daily"].includes(recurrence)
    || !validDate(firstDate) || (lastDate !== null && (!validDate(lastDate) || lastDate < firstDate))
    || (recurrence === "weekly" && !WEEKDAYS.includes(weeklyWeekday as typeof WEEKDAYS[number]))
    || !validTime(input.startTime) || !validTime(endTime) || input.startTime >= endTime
    || !Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 80
    || (input.registrationOpen !== undefined && typeof input.registrationOpen !== "boolean")) throw new ProgramCalendarError("invalid");
  const weekday = legacyWeekday(recurrence, weeklyWeekday, firstDate);
  const label = classDisplayLabel({
    stageCode: stage, weekday, startTime: input.startTime, endTime,
    offeringKind: offering.kind, firstDate, lastDate,
  });
  const time = now();
  if (!input.id) {
    const flags = operationFlags(env, offering);
    const classId = id();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO class_session (id, academic_year_id, stage_code, display_label,
        weekday, start_time, end_time, capacity, status, facebook_group_url,
        is_test_only, is_test, test_run_id, created_at, updated_at, activity_offering_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'closed', NULL, ?, ?, ?, ?, ?, ?)`)
        .bind(classId, academicYearId, stage, label, weekday, input.startTime, endTime,
          input.capacity, flags.isTest, flags.isTest, flags.testRunId, time, time, offering.id),
      env.DB.prepare(`INSERT INTO class_meeting_rule (
        class_session_id, recurrence_kind, first_date, last_date, weekly_weekday,
        start_time, end_time, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(classId, recurrence, firstDate, lastDate, weeklyWeekday, input.startTime, endTime, time, time),
      audit(env, actor, "class_session_created", "class_session", classId, {
        offeringId: offering.id, recurrenceKind: recurrence, registrationOpen: false,
      }, flags, time),
      audit(env, actor, "class_meeting_rule_created", "class_session", classId, { recurrenceKind: recurrence }, flags, time),
    ]);
    return;
  }
  const current = await classById(env, input.id);
  if (!input.expectedUpdatedAt || current.updatedAt !== input.expectedUpdatedAt) throw new ProgramCalendarError("conflict");
  const referenced = await classHasReferences(env, current.id);
  const structuralChange = current.offeringId !== offering.id || current.academicYearId !== academicYearId
    || current.stageCode !== stage || current.recurrenceKind !== recurrence
    || current.firstDate !== firstDate || current.lastDate !== lastDate
    || current.weeklyWeekday !== weeklyWeekday || current.startTime !== input.startTime
    || current.endTime !== endTime || current.capacity !== input.capacity;
  if (referenced && structuralChange) throw new ProgramCalendarError("immutable");
  const status = input.registrationOpen === undefined
    ? current.status
    : input.registrationOpen ? "available" : "closed";
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE class_session SET academic_year_id = ?, stage_code = ?, display_label = ?,
      weekday = ?, start_time = ?, end_time = ?, capacity = ?, status = ?,
      activity_offering_id = ?, updated_at = ? WHERE id = ? AND updated_at = ?`)
      .bind(academicYearId, stage, label, weekday, input.startTime, endTime,
        input.capacity, status, offering.id, time, current.id, input.expectedUpdatedAt),
    env.DB.prepare(`INSERT INTO class_meeting_rule (
      class_session_id, recurrence_kind, first_date, last_date, weekly_weekday,
      start_time, end_time, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(class_session_id) DO UPDATE SET recurrence_kind = excluded.recurrence_kind,
      first_date = excluded.first_date, last_date = excluded.last_date,
      weekly_weekday = excluded.weekly_weekday, start_time = excluded.start_time,
      end_time = excluded.end_time, updated_at = excluded.updated_at`)
      .bind(current.id, recurrence, firstDate, lastDate, weeklyWeekday, input.startTime, endTime, time, time),
    audit(env, actor, "class_session_saved", "class_session", current.id, {
      offeringId: offering.id, registrationOpen: registrationOpen(status), meetingRuleChanged: structuralChange,
    }, operationFlags(env, current), time),
    ...(structuralChange ? [audit(env, actor, "class_meeting_rule_changed", "class_session", current.id, { recurrenceKind: recurrence }, operationFlags(env, current), time)] : []),
  ]);
  if ((result[0]?.meta?.changes ?? 0) !== 1) throw new ProgramCalendarError("conflict");
}

export async function deleteClassSession(env: WorkerEnv, actor: StaffPrincipal, input: { classSessionId: string; expectedUpdatedAt: string }): Promise<void> {
  requireCapability(actor, "calendar.manage");
  const current = await classById(env, input.classSessionId);
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
  const excludeFromGeneration = input.excludeFromGeneration !== false;
  const warnOnOverlap = input.warnOnOverlap !== false;
  const generationBehavior = excludeFromGeneration ? "exclude_by_default" : "warn_only";
  await one<YearRow>(env, env.DB.prepare("SELECT id, public_label AS label, starts_on AS startsOn, ends_on AS endsOn, is_current AS isCurrent, is_test AS isTest, test_run_id AS testRunId FROM academic_year WHERE id = ?").bind(input.academicYearId));
  const time = now();
  if (!input.id) {
    const flags = operationFlags(env); const breakId = id();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO academic_year_break (id, academic_year_id, label, starts_on, ends_on, excludes_habitual_slots, generation_behavior, exclude_from_generation, warn_on_overlap, source_note, status, is_test, test_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?, ?, ?, ?)`)
        .bind(breakId, input.academicYearId, label, input.startsOn, input.endsOn, excludeFromGeneration ? 1 : 0, generationBehavior, excludeFromGeneration ? 1 : 0, warnOnOverlap ? 1 : 0, flags.isTest, flags.testRunId, time, time),
      audit(env, actor, "academic_year_break_created", "academic_year_break", breakId, { academicYearId: input.academicYearId }, flags, time),
    ]);
    return;
  }
  const existing = await one<BreakRow>(env, env.DB.prepare(`SELECT id, academic_year_id AS academicYearId, label, starts_on AS startsOn, ends_on AS endsOn, excludes_habitual_slots AS excludesHabitualSlots, generation_behavior AS generationBehavior, exclude_from_generation AS excludeFromGeneration, warn_on_overlap AS warnOnOverlap, source_note AS sourceNote, status, is_test AS isTest, test_run_id AS testRunId, updated_at AS updatedAt FROM academic_year_break WHERE id = ?`).bind(input.id));
  if (!input.expectedUpdatedAt || existing.updatedAt !== input.expectedUpdatedAt || existing.status !== "active") throw new ProgramCalendarError("conflict");
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE academic_year_break SET label = ?, starts_on = ?, ends_on = ?, excludes_habitual_slots = ?, generation_behavior = ?, exclude_from_generation = ?, warn_on_overlap = ?, updated_at = ? WHERE id = ? AND status = 'active' AND updated_at = ?`).bind(label, input.startsOn, input.endsOn, excludeFromGeneration ? 1 : 0, generationBehavior, excludeFromGeneration ? 1 : 0, warnOnOverlap ? 1 : 0, time, existing.id, input.expectedUpdatedAt),
    audit(env, actor, "academic_year_break_saved", "academic_year_break", existing.id, {}, operationFlags(env, existing), time),
  ]);
  if ((result[0]?.meta?.changes ?? 0) !== 1) throw new ProgramCalendarError("conflict");
}

export async function removeAcademicYearBreak(env: WorkerEnv, actor: StaffPrincipal, input: { breakId: string; expectedUpdatedAt: string }): Promise<void> {
  requireCapability(actor, "calendar.manage");
  const current = await one<BreakRow>(env, env.DB.prepare(`SELECT id, academic_year_id AS academicYearId, label, starts_on AS startsOn, ends_on AS endsOn, excludes_habitual_slots AS excludesHabitualSlots, generation_behavior AS generationBehavior, exclude_from_generation AS excludeFromGeneration, warn_on_overlap AS warnOnOverlap, source_note AS sourceNote, status, is_test AS isTest, test_run_id AS testRunId, updated_at AS updatedAt FROM academic_year_break WHERE id = ?`).bind(input.breakId));
  if (current.status !== "active" || current.updatedAt !== input.expectedUpdatedAt) throw new ProgramCalendarError("conflict");
  const time = now(); const result = await env.DB.batch([
    env.DB.prepare("UPDATE academic_year_break SET status = 'archived', updated_at = ? WHERE id = ? AND status = 'active' AND updated_at = ?").bind(time, current.id, input.expectedUpdatedAt),
    audit(env, actor, "academic_year_break_removed", "academic_year_break", current.id, {}, operationFlags(env, current), time),
  ]); if ((result[0]?.meta?.changes ?? 0) !== 1) throw new ProgramCalendarError("conflict");
}

async function nextRevisionNumber(env: WorkerEnv, calendarId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COALESCE(MAX(revision_number), 0) + 1 AS value FROM class_calendar_revision WHERE class_calendar_id = ?").bind(calendarId).first<{ value: number }>();
  return row?.value ?? 1;
}

export async function generateCalendarDraft(env: WorkerEnv, actor: StaffPrincipal, input: { classSessionId: string }): Promise<void> {
  requireCapability(actor, "calendar.manage");
  const classSession = await classById(env, input.classSessionId);
  if (!classSession.offeringId || !classSession.offeringProgramId) throw new ProgramCalendarError("invalid");
  const program = await programById(env, classSession.offeringProgramId);
  const family = await familyById(env, program.programFamilyId);
  const compatible = (program.programKind === "annual_course" && family.annualStageCode === classSession.stageCode)
    || (program.programKind === "summer_course" && program.academicYearId === classSession.academicYearId && program.stageCode === classSession.stageCode);
  if (!compatible || !["published", "superseded"].includes(program.status)) throw new ProgramCalendarError("invalid");
  const draft = classSession.calendarId ? await env.DB.prepare("SELECT id FROM class_calendar_revision WHERE class_calendar_id = ? AND status = 'draft'").bind(classSession.calendarId).first<{ id: string }>() : null;
  if (draft) throw new ProgramCalendarError("conflict");
  const lessons = (await lessonsForProgram(env, program.id)).map(toProgramLesson); if (!lessons.length) throw new ProgramCalendarError("invalid");
  const schoolCalendarPeriods = await applicableBreaks(env, classSession);
  const offeringBreaks = await offeringBreaksForOffering(env, classSession.offeringId);
  const flags = operationFlags(env, classSession); const time = now();
  const calendarId = classSession.calendarId ?? id(); const revisionId = id();
  let schedule: CalendarSlot[];
  let warnings: CalendarWarning[];
  try {
    const plan = generateCalendarPlan({ lessons, ...scheduleInputForClass(classSession), schoolCalendarPeriods, offeringBreaks });
    schedule = plan.slots;
    warnings = plan.warnings;
  } catch (caught) {
    mapPlanningError(caught);
  }
  const statements: D1PreparedStatement[] = [];
  if (!classSession.calendarId) statements.push(env.DB.prepare(`INSERT INTO class_calendar (id, class_session_id, timezone, status, is_test, test_run_id, created_at, updated_at) VALUES (?, ?, 'Asia/Ulaanbaatar', 'active', ?, ?, ?, ?)`).bind(calendarId, classSession.id, flags.isTest, flags.testRunId, time, time));
  statements.push(
    env.DB.prepare(`INSERT INTO class_calendar_revision (id, class_calendar_id, curriculum_program_id, revision_number, status, first_candidate_date, locked_through_sequence, based_on_revision_id, is_test, test_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, 0, NULL, ?, ?, ?, ?)`)
      .bind(revisionId, calendarId, program.id, await nextRevisionNumber(env, calendarId), classSession.firstDate, flags.isTest, flags.testRunId, time, time),
    ...insertSlots(env, revisionId, schedule, flags, time),
    audit(env, actor, "calendar_draft_generated", "class_calendar_revision", revisionId, { classSessionId: classSession.id, programId: program.id, slotCount: schedule.length, warningCount: warnings.length }, flags, time),
  );
  await env.DB.batch(statements);
}

export async function createCalendarChangeDraft(env: WorkerEnv, actor: StaffPrincipal, input: { classSessionId: string }): Promise<void> {
  requireCapability(actor, "calendar.manage");
  const current = await one<RevisionRow>(env, env.DB.prepare(`SELECT revision.id, revision.class_calendar_id AS calendarId, revision.curriculum_program_id AS programId, revision.revision_number AS revisionNumber, revision.status, revision.first_candidate_date AS firstCandidateDate, revision.locked_through_sequence AS lockedThroughSequence, revision.based_on_revision_id AS basedOnRevisionId, revision.is_test AS isTest, revision.test_run_id AS testRunId, revision.updated_at AS updatedAt FROM class_calendar_revision AS revision INNER JOIN class_calendar ON class_calendar.id = revision.class_calendar_id WHERE class_calendar.class_session_id = ? AND revision.status = 'published'`).bind(input.classSessionId));
  const existingDraft = await env.DB.prepare("SELECT id FROM class_calendar_revision WHERE class_calendar_id = ? AND status = 'draft'").bind(current.calendarId).first<{ id: string }>();
  if (existingDraft) return;
  const oldSlots = await slotsForRevision(env, current.id); const oldOverrides = await overridesForRevision(env, current.id); const time = now(); const flags = operationFlags(env, current); const revisionId = id();
  const pastPublishedSequence = oldSlots
    .filter((slot) => slot.status === "scheduled" && slot.localDate < localToday())
    .reduce((highest, slot) => Math.max(highest, slot.lessonSequence ?? 0), 0);
  const attendanceProtectedSequence = await attendanceProtectedThroughSequence(env, input.classSessionId, current.programId);
  // Attendance is an immediately correctable operational fact. Keep it as a
  // dynamic protection input instead of baking a cleared mark into a draft.
  const protectedThroughSequence = Math.max(current.lockedThroughSequence, pastPublishedSequence);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO class_calendar_revision (id, class_calendar_id, curriculum_program_id, revision_number, status, first_candidate_date, locked_through_sequence, based_on_revision_id, is_test, test_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(revisionId, current.calendarId, current.programId, await nextRevisionNumber(env, current.calendarId), current.firstCandidateDate, protectedThroughSequence, current.id, flags.isTest, flags.testRunId, time, time),
    ...oldOverrides.map((override) => env.DB.prepare(`INSERT INTO class_calendar_revision_override (id, class_calendar_revision_id, local_date, behavior, reason_label, is_test, test_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id(), revisionId, override.localDate, override.behavior, override.reasonLabel, flags.isTest, flags.testRunId, time, time)),
    ...oldSlots.map((slot) => env.DB.prepare(`INSERT INTO class_calendar_slot (id, class_calendar_revision_id, local_date, start_time, end_time, slot_source, status, curriculum_lesson_id, cancelled_lesson_sequence, cancelled_lesson_title, reason_label, is_test, test_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id(), revisionId, slot.localDate, slot.startTime, slot.endTime, slot.slotSource, slot.status, slot.lessonId, slot.cancelledLessonSequence, slot.cancelledLessonTitle, slot.reasonLabel, flags.isTest, flags.testRunId, time, time)),
    audit(env, actor, "calendar_change_draft_created", "class_calendar_revision", revisionId, {
      basedOnRevisionId: current.id,
      protectedHistoricalSequence: protectedThroughSequence,
      attendanceProtectedSequence,
      protectionBasis: "stored_lock_past_published_dates_and_current_attendance",
    }, flags, time),
  ]);
}

async function rebuiltDraftSchedule(
  env: WorkerEnv,
  revision: RevisionRow,
  addedExtra?: ExtraTeachingSlot,
  proposedOverride?: CalendarOverride,
): Promise<CalendarSlot[]> {
  const classSession = await classForCalendar(env, revision.calendarId);
  const attendanceProtectedSequence = await attendanceProtectedThroughSequence(env, classSession.id, revision.programId);
  const protectedThroughSequence = Math.max(revision.lockedThroughSequence, attendanceProtectedSequence);
  const lessons = (await lessonsForProgram(env, revision.programId)).map(toProgramLesson);
  const schoolCalendarPeriods = await applicableBreaks(env, classSession);
  const offeringBreaks = classSession.offeringId ? await offeringBreaksForOffering(env, classSession.offeringId) : [];
  let overrides = await overridesForRevision(env, revision.id);
  if (proposedOverride) {
    overrides = [...overrides.filter((entry) => entry.localDate !== proposedOverride.localDate), proposedOverride];
  }
  const oldSlots = await slotsForRevision(env, revision.id);
  const cancelledSlots = oldSlots.filter((slot) => slot.status === "cancelled").map(toSlot);
  const cancelledHabitualDates = new Set(oldSlots.filter((slot) => slot.status === "cancelled" && slot.slotSource !== "manual_extra").map((slot) => slot.localDate));
  overrides = [
    ...overrides.filter((entry) => !cancelledHabitualDates.has(entry.localDate)),
    ...[...cancelledHabitualDates].map((localDate) => ({ id: `cancelled-${localDate}`, localDate, behavior: "exclude" as const })),
  ];
  const extraSlots: ExtraTeachingSlot[] = oldSlots.filter((slot) => slot.slotSource === "manual_extra" && slot.status === "scheduled").map((slot) => ({ id: slot.id, localDate: slot.localDate, startTime: slot.startTime, endTime: slot.endTime, reasonLabel: slot.reasonLabel ?? undefined }));
  if (addedExtra) extraSlots.push(addedExtra);
  let rebuilt: CalendarSlot[];
  try {
    rebuilt = generateCalendarSchedule({ lessons, ...scheduleInputForClass(classSession), schoolCalendarPeriods, offeringBreaks, overrides, extraSlots });
  } catch (caught) {
    mapPlanningError(caught);
  }
  const cancelledTimes = new Set(cancelledSlots.map((slot) => `${slot.localDate}|${slot.startTime}|${slot.endTime}`));
  rebuilt = [...rebuilt.filter((slot) => !cancelledTimes.has(`${slot.localDate}|${slot.startTime}|${slot.endTime}`)), ...cancelledSlots]
    .sort((left, right) => left.localDate.localeCompare(right.localDate) || left.startTime.localeCompare(right.startTime) || left.endTime.localeCompare(right.endTime));
  for (const protectedSlot of oldSlots.filter((slot) => slot.status === "scheduled" && (slot.lessonSequence ?? 0) <= protectedThroughSequence)) {
    const match = rebuilt.find((slot) => slot.status === "scheduled" && slot.lesson?.id === protectedSlot.lessonId);
    if (!match || match.localDate !== protectedSlot.localDate || match.startTime !== protectedSlot.startTime || match.endTime !== protectedSlot.endTime) {
      throw new ProgramCalendarError("immutable");
    }
  }
  return rebuilt;
}

export async function changeCalendarDraft(env: WorkerEnv, actor: StaffPrincipal, input: { revisionId: string; expectedUpdatedAt: string; kind: "exclude" | "restore" | "extra"; localDate: string; startTime?: string; endTime?: string; reasonLabel?: string | null }): Promise<void> {
  requireCapability(actor, "calendar.manage");
  if (!validDate(input.localDate) || !input.expectedUpdatedAt || !["exclude", "restore", "extra"].includes(input.kind)) throw new ProgramCalendarError("invalid");
  const revision = await revisionForUpdate(env, input.revisionId); if (revision.status !== "draft") throw new ProgramCalendarError("immutable"); if (revision.updatedAt !== input.expectedUpdatedAt) throw new ProgramCalendarError("conflict");
  const classSession = await classForCalendar(env, revision.calendarId); const time = now(); const flags = operationFlags(env, revision);
  if (revision.basedOnRevisionId && input.localDate < localToday()) throw new ProgramCalendarError("immutable");
  const sharedOfferingBreaks = classSession.offeringId ? await offeringBreaksForOffering(env, classSession.offeringId) : [];
  if (input.kind === "restore" && sharedOfferingBreaks.some((period) => period.startsOn <= input.localDate && input.localDate <= period.endsOn)) throw new ProgramCalendarError("immutable");
  const extraEndTime = input.kind === "extra" && validTime(input.startTime ?? "")
    ? (validTime(input.endTime ?? "") ? input.endTime as string : addMinutes(input.startTime as string, durationMinutes(classSession.startTime, classSession.endTime)))
    : undefined;
  if (input.kind === "extra" && (!validTime(input.startTime ?? "") || !extraEndTime || (input.startTime ?? "") >= extraEndTime)) throw new ProgramCalendarError("invalid");
  let extra: ExtraTeachingSlot | undefined;
  let proposedOverride: CalendarOverride | undefined;
  const preStatements: D1PreparedStatement[] = [];
  if (input.kind === "extra") {
    const existing = await slotsForRevision(env, revision.id);
    if (existing.some((slot) => slot.localDate === input.localDate && slot.startTime === input.startTime && slot.endTime === extraEndTime)) throw new ProgramCalendarError("conflict");
    extra = { id: id(), localDate: input.localDate, startTime: input.startTime as string, endTime: extraEndTime as string, reasonLabel: optionalText(input.reasonLabel) ?? undefined };
  } else {
    proposedOverride = { id: id(), localDate: input.localDate, behavior: input.kind, reasonLabel: optionalText(input.reasonLabel) ?? undefined };
    preStatements.push(env.DB.prepare(`INSERT INTO class_calendar_revision_override (id, class_calendar_revision_id, local_date, behavior, reason_label, is_test, test_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(class_calendar_revision_id, local_date) DO UPDATE SET behavior = excluded.behavior, reason_label = excluded.reason_label, updated_at = excluded.updated_at`)
      .bind(proposedOverride.id, revision.id, input.localDate, input.kind, optionalText(input.reasonLabel), flags.isTest, flags.testRunId, time, time));
  }
  const rebuilt = await rebuiltDraftSchedule(env, revision, extra, proposedOverride);
  await replaceDraftSlots(env, revision, rebuilt, actor, input.kind === "extra" ? "calendar_extra_added" : `calendar_override_${input.kind}`, { localDate: input.localDate, classSessionId: classSession.id }, preStatements);
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

export async function cancelFutureCalendarSlot(env: WorkerEnv, actor: StaffPrincipal, input: { revisionId: string; expectedUpdatedAt: string; slotId: string }): Promise<void> {
  requireCapability(actor, "calendar.manage");
  const revision = await revisionForUpdate(env, input.revisionId); if (revision.status !== "draft" || revision.updatedAt !== input.expectedUpdatedAt) throw new ProgramCalendarError("conflict");
  const classSession = await classForCalendar(env, revision.calendarId); const lessons = (await lessonsForProgram(env, revision.programId)).map(toProgramLesson); const schoolCalendarPeriods = await applicableBreaks(env, classSession); const offeringBreaks = classSession.offeringId ? await offeringBreaksForOffering(env, classSession.offeringId) : []; const overrides = await overridesForRevision(env, revision.id); const slots = (await slotsForRevision(env, revision.id)).map(toSlot);
  const target = slots.find((slot) => slot.id === input.slotId);
  if (!target || target.localDate < localToday()) throw new ProgramCalendarError("immutable");
  const attendanceProtectedSequence = await attendanceProtectedThroughSequence(env, classSession.id, revision.programId);
  let result;
  try {
    result = reflowCancelledFutureSchedule({ lessons, ...scheduleInputForClass(classSession), schoolCalendarPeriods, offeringBreaks, overrides, existingSlots: slots, lockedThroughSequence: Math.max(revision.lockedThroughSequence, attendanceProtectedSequence), cancelSlotId: input.slotId });
  } catch (caught) {
    mapPlanningError(caught);
  }
  await replaceDraftSlots(env, revision, result.slots, actor, "calendar_future_slot_cancelled", { slotId: input.slotId, changedFutureLessonAssignments: result.changedFutureLessonAssignments, newFinalLessonDate: result.newFinalLessonDate });
}

function sameCalendarSlots(left: readonly SlotRow[], right: readonly SlotRow[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((slot, index) => {
    const other = right[index];
    return other
      && slot.localDate === other.localDate
      && slot.startTime === other.startTime
      && slot.endTime === other.endTime
      && slot.slotSource === other.slotSource
      && slot.status === other.status
      && slot.lessonId === other.lessonId
      && slot.cancelledLessonSequence === other.cancelledLessonSequence
      && slot.cancelledLessonTitle === other.cancelledLessonTitle
      && (slot.reasonLabel ?? null) === (other.reasonLabel ?? null);
  });
}

function sameCalendarOverrides(left: readonly CalendarOverride[], right: readonly CalendarOverride[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((override, index) => override.localDate === right[index]?.localDate
    && override.behavior === right[index]?.behavior
    && (override.reasonLabel ?? null) === (right[index]?.reasonLabel ?? null));
}

async function calendarDraftMatchesBase(env: WorkerEnv, revision: RevisionRow): Promise<boolean> {
  if (!revision.basedOnRevisionId) return false;
  const [baseSlots, draftSlots, baseOverrides, draftOverrides] = await Promise.all([
    slotsForRevision(env, revision.basedOnRevisionId),
    slotsForRevision(env, revision.id),
    overridesForRevision(env, revision.basedOnRevisionId),
    overridesForRevision(env, revision.id),
  ]);
  return sameCalendarSlots(baseSlots, draftSlots) && sameCalendarOverrides(baseOverrides, draftOverrides);
}

export async function discardCalendarDraft(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { revisionId: string; expectedUpdatedAt: string },
): Promise<void> {
  requireCapability(actor, "calendar.manage");
  const revision = await revisionForUpdate(env, input.revisionId);
  if (revision.status !== "draft" || revision.updatedAt !== input.expectedUpdatedAt) throw new ProgramCalendarError("conflict");
  const time = now(); const flags = operationFlags(env, revision);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM class_calendar_revision WHERE id = ? AND status = 'draft'").bind(revision.id),
    audit(env, actor, "calendar_draft_discarded", "class_calendar_revision", revision.id, {
      calendarId: revision.calendarId, basedOnRevisionId: revision.basedOnRevisionId,
    }, flags, time),
  ]);
}

export async function publishCalendarDraft(env: WorkerEnv, actor: StaffPrincipal, input: { revisionId: string; expectedUpdatedAt: string }): Promise<void> {
  requireCapability(actor, "calendar.manage");
  const revision = await revisionForUpdate(env, input.revisionId); if (revision.status !== "draft" || revision.updatedAt !== input.expectedUpdatedAt) throw new ProgramCalendarError("conflict");
  if (await calendarDraftMatchesBase(env, revision)) {
    await discardCalendarDraft(env, actor, input);
    return;
  }
  const lessons = await lessonsForProgram(env, revision.programId); const slots = await slotsForRevision(env, revision.id); const active = slots.filter((slot) => slot.status === "scheduled");
  const publishableProgram = await env.DB.prepare(`SELECT program.id FROM curriculum_program AS program
    WHERE program.id = ? AND (
      program.status = 'published'
      OR (program.status = 'superseded' AND (
        EXISTS (
          SELECT 1 FROM class_calendar
          INNER JOIN class_session ON class_session.id = class_calendar.class_session_id
          INNER JOIN activity_offering ON activity_offering.id = class_session.activity_offering_id
          WHERE class_calendar.id = ? AND activity_offering.curriculum_program_id = program.id
        )
        OR EXISTS (
          SELECT 1 FROM class_calendar_revision AS base_revision
          WHERE base_revision.id = ?
            AND base_revision.class_calendar_id = ?
            AND base_revision.curriculum_program_id = program.id
            AND base_revision.status IN ('published', 'superseded')
        )
      ))
    )`).bind(revision.programId, revision.calendarId, revision.basedOnRevisionId, revision.calendarId).first<{ id: string }>();
  if (!publishableProgram || active.length !== lessons.length || new Set(active.map((slot) => slot.lessonId)).size !== lessons.length || active.some((slot) => !slot.lessonId)) throw new ProgramCalendarError("invalid");
  const time = now(); const flags = operationFlags(env, revision); const result = await env.DB.batch([
    env.DB.prepare("UPDATE class_calendar_revision SET status = 'superseded', superseded_at = ?, updated_at = ? WHERE class_calendar_id = ? AND status = 'published'").bind(time, time, revision.calendarId),
    env.DB.prepare("UPDATE class_calendar_revision SET status = 'published', published_at = ?, updated_at = ? WHERE id = ? AND status = 'draft' AND updated_at = ?").bind(time, time, revision.id, input.expectedUpdatedAt),
    audit(env, actor, "calendar_published", "class_calendar_revision", revision.id, { calendarId: revision.calendarId, slotCount: slots.length }, flags, time),
  ]); if ((result[1]?.meta?.changes ?? 0) !== 1) throw new ProgramCalendarError("conflict");
}
