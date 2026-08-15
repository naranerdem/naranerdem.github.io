import type { D1PreparedStatement, WorkerEnv } from "../env";
import {
  calendarWarnings,
  generateCalendarSchedule,
  reflowCancelledFutureSchedule,
  SchedulePlanningError,
  type AcademicYearBreak,
  type CalendarOverride,
  type CalendarSlot,
  type ExtraTeachingSlot,
  type MeetingRecurrenceKind,
  type OfferingBreak,
  type ProgramLesson,
} from "../services/program-calendar";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";
import { attendanceProtectedThroughSequence } from "./course-attendance";

export class DayChangeError extends Error {
  constructor(
    public readonly code: "forbidden" | "invalid" | "not_found" | "conflict" | "attendance_protected" | "history_protected",
    public readonly blockingClassLabel?: string,
  ) {
    super("Daily schedule change failed.");
    this.name = "DayChangeError";
  }
}

interface DailyOccurrenceRow {
  slotId: string;
  revisionId: string;
  revisionUpdatedAt: string;
  classSessionId: string;
  curriculumLessonId: string;
  localDate: string;
  startTime: string;
  endTime: string;
  status: "scheduled" | "cancelled";
  lessonSequence: number;
  lessonTitle: string;
  offeringId: string;
  offeringTitle: string;
  offeringKind: "annual_course" | "summer_course";
  stageCode: string;
  classLabel: string;
  attendanceCount: number;
  isTest: number;
  testRunId: string | null;
}

interface CalendarContextRow {
  revisionId: string;
  revisionNumber: number;
  revisionUpdatedAt: string;
  calendarId: string;
  programId: string;
  firstCandidateDate: string;
  lockedThroughSequence: number;
  classSessionId: string;
  academicYearId: string;
  stageCode: string;
  classLabel: string;
  classStatus: string;
  offeringId: string;
  offeringTitle: string;
  offeringKind: "annual_course" | "summer_course";
  offeringEndsOn: string | null;
  useAcademicYearBreaks: number;
  recurrenceKind: MeetingRecurrenceKind;
  firstDate: string;
  lastDate: string | null;
  weeklyWeekday: string | null;
  startTime: string;
  endTime: string;
  isTest: number;
  testRunId: string | null;
}

interface SlotRow {
  id: string;
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

interface PlannedRevision {
  context: CalendarContextRow;
  slots: CalendarSlot[];
  overrides: CalendarOverride[];
  changedFutureLessonAssignments: number;
  warningLabels: string[];
  protectedThroughSequence: number;
}

interface SchoolPeriodRow {
  id: string;
  label: string;
  startsOn: string;
  endsOn: string;
  excludesHabitualSlots: number;
  generationBehavior: "exclude_by_default" | "warn_only";
  excludeFromGeneration: number;
  warnOnOverlap: number;
}

function id(): string { return crypto.randomUUID(); }
function now(): string { return new Date().toISOString(); }
function clean(value: unknown, max = 160): string { return typeof value === "string" ? value.trim().slice(0, max) : ""; }

function localDateTime(at = new Date()): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ulaanbaatar", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function addDays(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function requireManage(actor: StaffPrincipal): void {
  if (!hasStaffCapability(actor, "calendar.manage")) throw new DayChangeError("forbidden");
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

function audit(
  env: WorkerEnv,
  actor: StaffPrincipal,
  action: string,
  subjectId: string,
  metadata: Record<string, unknown>,
  flags: { isTest: number; testRunId: string | null },
  occurredAt: string,
): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO audit_event (
    id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at
  ) VALUES (?, ?, 'staff', ?, ?, 'course_schedule_operation', ?, ?, ?, ?, ?, ?)`).bind(
    id(), occurredAt, actor.staffAccountId, action, subjectId, JSON.stringify(metadata),
    env.APP_ENV, flags.isTest, flags.testRunId, occurredAt,
  );
}

const OCCURRENCE_SELECT = `SELECT slot.id AS slotId,
    revision.id AS revisionId,
    revision.updated_at AS revisionUpdatedAt,
    class_session.id AS classSessionId,
    lesson.id AS curriculumLessonId,
    slot.local_date AS localDate,
    slot.start_time AS startTime,
    slot.end_time AS endTime,
    slot.status,
    lesson.sequence_number AS lessonSequence,
    lesson.title AS lessonTitle,
    offering.id AS offeringId,
    offering.title AS offeringTitle,
    offering.kind AS offeringKind,
    class_session.stage_code AS stageCode,
    class_session.display_label AS classLabel,
    (SELECT COUNT(*) FROM course_attendance AS attendance
      WHERE attendance.class_session_id = class_session.id
        AND attendance.curriculum_lesson_id = lesson.id
        AND attendance.attendance_status IS NOT NULL) AS attendanceCount,
    MAX(slot.is_test, class_session.is_test, offering.is_test) AS isTest,
    COALESCE(slot.test_run_id, class_session.test_run_id, offering.test_run_id) AS testRunId
  FROM class_calendar_slot AS slot
  INNER JOIN class_calendar_revision AS revision
    ON revision.id = slot.class_calendar_revision_id AND revision.status = 'published'
  INNER JOIN class_calendar AS calendar ON calendar.id = revision.class_calendar_id
  INNER JOIN class_session ON class_session.id = calendar.class_session_id
  INNER JOIN activity_offering AS offering ON offering.id = class_session.activity_offering_id
  LEFT JOIN curriculum_lesson AS lesson
    ON lesson.curriculum_program_id = revision.curriculum_program_id
    AND (lesson.id = slot.curriculum_lesson_id
      OR (slot.status = 'cancelled' AND lesson.sequence_number = slot.cancelled_lesson_sequence))
  WHERE offering.status = 'active'
    AND offering.kind IN ('annual_course', 'summer_course')
    AND slot.status IN ('scheduled', 'cancelled')`;

export async function getDailyChangesOverview(
  env: WorkerEnv,
  actor: StaffPrincipal,
  selectedDate?: string,
  at = new Date(),
) {
  requireManage(actor);
  const local = localDateTime(at);
  const date = selectedDate || local.date;
  if (!validDate(date)) throw new DayChangeError("invalid");
  const through = addDays(date, 14);
  const result = await env.DB.prepare(`${OCCURRENCE_SELECT}
    AND slot.local_date BETWEEN ? AND ?
    GROUP BY slot.id, lesson.id
    ORDER BY slot.local_date, slot.start_time, offering.title, class_session.display_label`).bind(
    date, through,
  ).all<DailyOccurrenceRow>();
  const classes = await env.DB.prepare(`SELECT class_session.id AS classSessionId,
      class_session.display_label AS classLabel, offering.title AS offeringTitle,
      COALESCE(meeting.start_time, class_session.start_time) AS startTime,
      COALESCE(meeting.end_time, class_session.end_time) AS endTime
    FROM class_session
    INNER JOIN activity_offering AS offering ON offering.id = class_session.activity_offering_id
    INNER JOIN class_calendar AS calendar ON calendar.class_session_id = class_session.id
    INNER JOIN class_calendar_revision AS revision
      ON revision.class_calendar_id = calendar.id AND revision.status = 'published'
    LEFT JOIN class_meeting_rule AS meeting ON meeting.class_session_id = class_session.id
    WHERE offering.status = 'active' AND offering.kind IN ('annual_course', 'summer_course')
      AND class_session.status != 'cancelled'
    ORDER BY offering.title, class_session.display_label`).all<{
      classSessionId: string; classLabel: string; offeringTitle: string; startTime: string; endTime: string;
    }>();
  return { today: local.date, selectedDate: date, throughDate: through, occurrences: result.results, classes: classes.results };
}

async function contextForClass(env: WorkerEnv, classSessionId: string): Promise<CalendarContextRow> {
  const row = await env.DB.prepare(`SELECT revision.id AS revisionId,
      revision.revision_number AS revisionNumber,
      revision.updated_at AS revisionUpdatedAt,
      calendar.id AS calendarId,
      revision.curriculum_program_id AS programId,
      revision.first_candidate_date AS firstCandidateDate,
      revision.locked_through_sequence AS lockedThroughSequence,
      class_session.id AS classSessionId,
      class_session.academic_year_id AS academicYearId,
      class_session.stage_code AS stageCode,
      class_session.display_label AS classLabel,
      class_session.status AS classStatus,
      offering.id AS offeringId,
      offering.title AS offeringTitle,
      offering.kind AS offeringKind,
      offering.ends_on AS offeringEndsOn,
      offering.use_academic_year_breaks AS useAcademicYearBreaks,
      COALESCE(meeting.recurrence_kind, 'weekly') AS recurrenceKind,
      COALESCE(meeting.first_date, revision.first_candidate_date) AS firstDate,
      meeting.last_date AS lastDate,
      COALESCE(meeting.weekly_weekday, class_session.weekday) AS weeklyWeekday,
      COALESCE(meeting.start_time, class_session.start_time) AS startTime,
      COALESCE(meeting.end_time, class_session.end_time) AS endTime,
      MAX(revision.is_test, class_session.is_test, offering.is_test) AS isTest,
      COALESCE(revision.test_run_id, class_session.test_run_id, offering.test_run_id) AS testRunId
    FROM class_calendar_revision AS revision
    INNER JOIN class_calendar AS calendar ON calendar.id = revision.class_calendar_id
    INNER JOIN class_session ON class_session.id = calendar.class_session_id
    INNER JOIN activity_offering AS offering ON offering.id = class_session.activity_offering_id
    LEFT JOIN class_meeting_rule AS meeting ON meeting.class_session_id = class_session.id
    WHERE class_session.id = ? AND revision.status = 'published'
      AND offering.status = 'active' AND offering.kind IN ('annual_course', 'summer_course')
    GROUP BY revision.id`).bind(classSessionId).first<CalendarContextRow>();
  if (!row) throw new DayChangeError("not_found");
  const draft = await env.DB.prepare(`SELECT 1 AS value FROM class_calendar_revision
    WHERE class_calendar_id = ? AND status = 'draft'`).bind(row.calendarId).first();
  if (draft) throw new DayChangeError("conflict");
  return row;
}

async function slotsForContext(env: WorkerEnv, context: CalendarContextRow): Promise<CalendarSlot[]> {
  const result = await env.DB.prepare(`SELECT slot.id,
      slot.local_date AS localDate, slot.start_time AS startTime, slot.end_time AS endTime,
      slot.slot_source AS slotSource, slot.status, slot.curriculum_lesson_id AS lessonId,
      lesson.sequence_number AS lessonSequence, lesson.title AS lessonTitle,
      slot.cancelled_lesson_sequence AS cancelledLessonSequence,
      slot.cancelled_lesson_title AS cancelledLessonTitle, slot.reason_label AS reasonLabel
    FROM class_calendar_slot AS slot
    LEFT JOIN curriculum_lesson AS lesson ON lesson.id = slot.curriculum_lesson_id
    WHERE slot.class_calendar_revision_id = ?
    ORDER BY slot.local_date, slot.start_time, slot.end_time, slot.id`).bind(
    context.revisionId,
  ).all<SlotRow>();
  return result.results.map(toSlot);
}

async function lessonsForContext(env: WorkerEnv, context: CalendarContextRow): Promise<ProgramLesson[]> {
  const result = await env.DB.prepare(`SELECT id, sequence_number AS sequenceNumber, title
    FROM curriculum_lesson WHERE curriculum_program_id = ? AND status = 'active'
    ORDER BY sequence_number`).bind(context.programId).all<ProgramLesson>();
  return result.results;
}

async function overridesForContext(env: WorkerEnv, context: CalendarContextRow): Promise<CalendarOverride[]> {
  const result = await env.DB.prepare(`SELECT id, local_date AS localDate, behavior, reason_label AS reasonLabel
    FROM class_calendar_revision_override WHERE class_calendar_revision_id = ?
    ORDER BY local_date`).bind(context.revisionId).all<CalendarOverride>();
  return result.results;
}

async function schoolPeriods(env: WorkerEnv, context: CalendarContextRow): Promise<AcademicYearBreak[]> {
  if (context.offeringKind !== "annual_course" || !context.useAcademicYearBreaks) return [];
  const result = await env.DB.prepare(`SELECT id, label, starts_on AS startsOn, ends_on AS endsOn,
      excludes_habitual_slots AS excludesHabitualSlots,
      generation_behavior AS generationBehavior,
      exclude_from_generation AS excludeFromGeneration,
      warn_on_overlap AS warnOnOverlap
    FROM academic_year_break WHERE academic_year_id = ? AND status = 'active'
    ORDER BY starts_on, ends_on`).bind(context.academicYearId).all<SchoolPeriodRow>();
  return result.results.map((period) => ({
    ...period,
    excludesHabitualSlots: Boolean(period.excludesHabitualSlots),
    excludeFromGeneration: Boolean(period.excludeFromGeneration),
    warnOnOverlap: Boolean(period.warnOnOverlap),
  }));
}

async function offeringPeriods(env: WorkerEnv, context: CalendarContextRow): Promise<OfferingBreak[]> {
  const result = await env.DB.prepare(`SELECT id, label, starts_on AS startsOn, ends_on AS endsOn
    FROM activity_offering_break WHERE activity_offering_id = ? ORDER BY starts_on, ends_on`).bind(
    context.offeringId,
  ).all<OfferingBreak>();
  return result.results;
}

function planningInput(context: CalendarContextRow) {
  return {
    firstCandidateDate: context.firstDate,
    plannedEndDate: context.lastDate ?? context.offeringEndsOn,
    recurrenceKind: context.recurrenceKind,
    habitualWeekday: context.weeklyWeekday ?? undefined,
    startTime: context.startTime,
    endTime: context.endTime,
  };
}

async function protectedThrough(env: WorkerEnv, context: CalendarContextRow, slots: readonly CalendarSlot[], today: string): Promise<number> {
  const pastPublished = slots.filter((slot) => slot.status === "scheduled" && slot.localDate < today)
    .reduce((highest, slot) => Math.max(highest, slot.lesson?.sequenceNumber ?? 0), 0);
  const attendance = await attendanceProtectedThroughSequence(env, context.classSessionId, context.programId);
  return Math.max(context.lockedThroughSequence, pastPublished, attendance);
}

async function commonPlanningData(env: WorkerEnv, context: CalendarContextRow) {
  const [slots, lessons, overrides, schoolCalendarPeriods, offeringBreaks] = await Promise.all([
    slotsForContext(env, context), lessonsForContext(env, context), overridesForContext(env, context),
    schoolPeriods(env, context), offeringPeriods(env, context),
  ]);
  return { slots, lessons, overrides, schoolCalendarPeriods, offeringBreaks };
}

function warningLabels(slots: readonly CalendarSlot[], input: { schoolCalendarPeriods: AcademicYearBreak[]; plannedEndDate?: string | null }): string[] {
  return calendarWarnings(slots, input).map((warning) => warning.kind === "school_period_overlap"
    ? warning.label
    : `Төлөвлөсөн хугацаа: ${warning.finalLessonDate}`);
}

async function planCancellation(
  env: WorkerEnv,
  occurrence: DailyOccurrenceRow,
  replacementDate: string | null,
  at: Date,
): Promise<PlannedRevision> {
  if (occurrence.status !== "scheduled") throw new DayChangeError("invalid");
  const local = localDateTime(at);
  if (occurrence.localDate < local.date
    || (occurrence.localDate === local.date && occurrence.endTime <= local.time)) {
    throw new DayChangeError("history_protected");
  }
  if (occurrence.attendanceCount > 0) throw new DayChangeError("attendance_protected");
  if (replacementDate && (!validDate(replacementDate) || replacementDate <= local.date)) throw new DayChangeError("invalid");
  const context = await contextForClass(env, occurrence.classSessionId);
  const data = await commonPlanningData(env, context);
  const lock = await protectedThrough(env, context, data.slots, local.date);
  const replacementSlots: ExtraTeachingSlot[] = replacementDate ? [{
    id: id(), localDate: replacementDate, startTime: occurrence.startTime,
    endTime: occurrence.endTime, reasonLabel: "Орлуулах хичээл",
  }] : [];
  try {
    const result = reflowCancelledFutureSchedule({
      lessons: data.lessons,
      ...planningInput(context),
      schoolCalendarPeriods: data.schoolCalendarPeriods,
      offeringBreaks: data.offeringBreaks,
      overrides: data.overrides,
      existingSlots: data.slots,
      lockedThroughSequence: lock,
      cancelSlotId: occurrence.slotId,
      replacementSlots,
    });
    return {
      context,
      slots: result.slots,
      overrides: data.overrides,
      changedFutureLessonAssignments: result.changedFutureLessonAssignments,
      protectedThroughSequence: lock,
      warningLabels: warningLabels(result.slots, {
        schoolCalendarPeriods: data.schoolCalendarPeriods,
        plannedEndDate: planningInput(context).plannedEndDate,
      }),
    };
  } catch (caught) {
    if (caught instanceof SchedulePlanningError) throw new DayChangeError(caught.code === "insufficient_slots" ? "conflict" : "invalid");
    throw caught;
  }
}

async function planCancellationForOccurrence(
  env: WorkerEnv,
  occurrence: DailyOccurrenceRow,
  replacementDate: string | null,
  at: Date,
): Promise<PlannedRevision> {
  try {
    return await planCancellation(env, occurrence, replacementDate, at);
  } catch (caught) {
    if (caught instanceof DayChangeError && !caught.blockingClassLabel) {
      throw new DayChangeError(caught.code, `${occurrence.offeringTitle} · ${occurrence.classLabel}`);
    }
    throw caught;
  }
}

async function planExtras(
  env: WorkerEnv,
  context: CalendarContextRow,
  extras: ExtraTeachingSlot[],
  at: Date,
): Promise<PlannedRevision> {
  const local = localDateTime(at);
  if (!extras.length || extras.some((extra) => !validDate(extra.localDate) || extra.localDate <= local.date)) {
    throw new DayChangeError("invalid");
  }
  const data = await commonPlanningData(env, context);
  const duplicateTimes = new Set(data.slots.map((slot) => `${slot.localDate}|${slot.startTime}|${slot.endTime}`));
  if (extras.some((extra) => duplicateTimes.has(`${extra.localDate}|${extra.startTime}|${extra.endTime}`))) {
    throw new DayChangeError("conflict");
  }
  if (extras.some((extra) => data.offeringBreaks.some((period) => period.startsOn <= extra.localDate && extra.localDate <= period.endsOn))) {
    throw new DayChangeError("conflict");
  }
  const cancelledSlots = data.slots.filter((slot) => slot.status === "cancelled");
  const cancelledHabitualDates = new Set(cancelledSlots.filter((slot) => slot.slotSource !== "manual_extra").map((slot) => slot.localDate));
  const overrides = [
    ...data.overrides.filter((entry) => !cancelledHabitualDates.has(entry.localDate)),
    ...[...cancelledHabitualDates].map((localDate) => ({ id: `cancelled-${localDate}`, localDate, behavior: "exclude" as const })),
  ];
  const activeExtras: ExtraTeachingSlot[] = data.slots
    .filter((slot) => slot.slotSource === "manual_extra" && slot.status === "scheduled")
    .map((slot) => ({ id: slot.id, localDate: slot.localDate, startTime: slot.startTime, endTime: slot.endTime, reasonLabel: slot.reasonLabel ?? undefined }));
  let rebuilt: CalendarSlot[];
  try {
    rebuilt = generateCalendarSchedule({
      lessons: data.lessons,
      ...planningInput(context),
      schoolCalendarPeriods: data.schoolCalendarPeriods,
      offeringBreaks: data.offeringBreaks,
      overrides,
      extraSlots: [...activeExtras, ...extras],
    });
  } catch (caught) {
    if (caught instanceof SchedulePlanningError) throw new DayChangeError(caught.code === "insufficient_slots" ? "conflict" : "invalid");
    throw caught;
  }
  const cancelledTimes = new Set(cancelledSlots.map((slot) => `${slot.localDate}|${slot.startTime}|${slot.endTime}`));
  rebuilt = [...rebuilt.filter((slot) => !cancelledTimes.has(`${slot.localDate}|${slot.startTime}|${slot.endTime}`)), ...cancelledSlots]
    .sort((left, right) => left.localDate.localeCompare(right.localDate) || left.startTime.localeCompare(right.startTime) || left.endTime.localeCompare(right.endTime));
  if (extras.some((extra) => !rebuilt.some((slot) => slot.id === extra.id && slot.status === "scheduled"))) {
    throw new DayChangeError("invalid");
  }
  const lock = await protectedThrough(env, context, data.slots, local.date);
  for (const oldSlot of data.slots.filter((slot) => slot.status === "scheduled" && (slot.lesson?.sequenceNumber ?? 0) <= lock)) {
    const next = rebuilt.find((slot) => slot.status === "scheduled" && slot.lesson?.id === oldSlot.lesson?.id);
    if (!next || next.localDate !== oldSlot.localDate || next.startTime !== oldSlot.startTime || next.endTime !== oldSlot.endTime) {
      throw new DayChangeError("history_protected");
    }
  }
  const changed = data.lessons.filter((lesson) => lesson.sequenceNumber > lock).filter((lesson) => {
    const before = data.slots.find((slot) => slot.status === "scheduled" && slot.lesson?.id === lesson.id);
    const after = rebuilt.find((slot) => slot.status === "scheduled" && slot.lesson?.id === lesson.id);
    return before?.localDate !== after?.localDate || before?.startTime !== after?.startTime;
  }).length;
  return {
    context,
    slots: rebuilt,
    overrides: data.overrides,
    changedFutureLessonAssignments: changed,
    protectedThroughSequence: lock,
    warningLabels: warningLabels(rebuilt, {
      schoolCalendarPeriods: data.schoolCalendarPeriods,
      plannedEndDate: planningInput(context).plannedEndDate,
    }),
  };
}

async function occurrencesOnDate(env: WorkerEnv, localDate: string, status: "scheduled" | "cancelled"): Promise<DailyOccurrenceRow[]> {
  const result = await env.DB.prepare(`${OCCURRENCE_SELECT}
    AND slot.local_date = ? AND slot.status = ?
    GROUP BY slot.id, lesson.id
    ORDER BY slot.start_time, offering.title, class_session.display_label`).bind(
    localDate, status,
  ).all<DailyOccurrenceRow>();
  return result.results;
}

function ensureDistinctClasses(occurrences: DailyOccurrenceRow[]): void {
  if (new Set(occurrences.map((entry) => entry.classSessionId)).size !== occurrences.length) {
    throw new DayChangeError("conflict");
  }
}

async function plansForAction(
  env: WorkerEnv,
  input: Record<string, unknown>,
  at: Date,
): Promise<{ action: string; subjectId: string; plans: PlannedRevision[]; metadata: Record<string, unknown> }> {
  const kind = clean(input.kind);
  const sourceDate = clean(input.sourceDate, 10);
  const replacementDate = clean(input.replacementDate, 10) || null;
  if (kind === "single-cancel") {
    const occurrence = await env.DB.prepare(`${OCCURRENCE_SELECT} AND slot.id = ? GROUP BY slot.id, lesson.id`)
      .bind(clean(input.slotId)).first<DailyOccurrenceRow>();
    if (!occurrence) throw new DayChangeError("not_found");
    const plan = await planCancellationForOccurrence(env, occurrence, replacementDate, at);
    return {
      action: replacementDate ? "course_occurrence_moved" : "course_occurrence_cancelled",
      subjectId: occurrence.slotId,
      plans: [plan],
      metadata: { sourceDate: occurrence.localDate, replacementDate, classSessionIds: [occurrence.classSessionId] },
    };
  }
  if (kind === "day-cancel" || kind === "day-move") {
    if (!validDate(sourceDate) || (kind === "day-move" && !replacementDate)) throw new DayChangeError("invalid");
    const occurrences = await occurrencesOnDate(env, sourceDate, "scheduled");
    if (!occurrences.length) throw new DayChangeError("not_found");
    ensureDistinctClasses(occurrences);
    const plans = await Promise.all(occurrences.map((entry) => planCancellationForOccurrence(
      env, entry, kind === "day-move" ? replacementDate : null, at,
    )));
    return {
      action: kind === "day-move" ? "course_day_moved" : "course_day_cancelled",
      subjectId: sourceDate,
      plans,
      metadata: { sourceDate, replacementDate: kind === "day-move" ? replacementDate : null, classSessionIds: occurrences.map((entry) => entry.classSessionId) },
    };
  }
  if (kind === "day-replace") {
    if (!validDate(sourceDate) || !replacementDate) throw new DayChangeError("invalid");
    const occurrences = await occurrencesOnDate(env, sourceDate, "cancelled");
    if (!occurrences.length) throw new DayChangeError("not_found");
    ensureDistinctClasses(occurrences);
    const plans = await Promise.all(occurrences.map(async (entry) => {
      try {
        const context = await contextForClass(env, entry.classSessionId);
        return await planExtras(env, context, [{ id: id(), localDate: replacementDate, startTime: entry.startTime, endTime: entry.endTime, reasonLabel: "Орлуулах хичээл" }], at);
      } catch (caught) {
        if (caught instanceof DayChangeError && !caught.blockingClassLabel) {
          throw new DayChangeError(caught.code, `${entry.offeringTitle} · ${entry.classLabel}`);
        }
        throw caught;
      }
    }));
    return {
      action: "course_day_replacement_added",
      subjectId: sourceDate,
      plans,
      metadata: { sourceDate, replacementDate, classSessionIds: occurrences.map((entry) => entry.classSessionId) },
    };
  }
  if (kind === "extra") {
    const classSessionId = clean(input.classSessionId);
    const localDate = clean(input.localDate, 10);
    const context = await contextForClass(env, classSessionId);
    const startTime = clean(input.startTime, 5) || context.startTime;
    const endTime = clean(input.endTime, 5) || context.endTime;
    const plan = await planExtras(env, context, [{ id: id(), localDate, startTime, endTime, reasonLabel: clean(input.note) || "Нэмэлт өдөр" }], at);
    return {
      action: "course_extra_day_added",
      subjectId: classSessionId,
      plans: [plan],
      metadata: { classSessionIds: [classSessionId], localDate },
    };
  }
  throw new DayChangeError("invalid");
}

function insertRevisionStatements(
  env: WorkerEnv,
  plan: PlannedRevision,
  time: string,
): { statements: D1PreparedStatement[]; newRevisionId: string } {
  const newRevisionId = id();
  const flags = { isTest: plan.context.isTest, testRunId: plan.context.testRunId };
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`INSERT INTO class_calendar_revision (
      id, class_calendar_id, curriculum_program_id, revision_number, status,
      first_candidate_date, locked_through_sequence, based_on_revision_id,
      is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`).bind(
      newRevisionId, plan.context.calendarId, plan.context.programId,
      plan.context.revisionNumber + 1, plan.context.firstCandidateDate,
      plan.protectedThroughSequence, plan.context.revisionId,
      flags.isTest, flags.testRunId, time, time,
    ),
    ...plan.overrides.map((override) => env.DB.prepare(`INSERT INTO class_calendar_revision_override (
      id, class_calendar_revision_id, local_date, behavior, reason_label,
      is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      id(), newRevisionId, override.localDate, override.behavior, override.reasonLabel ?? null,
      flags.isTest, flags.testRunId, time, time,
    )),
    ...plan.slots.map((slot) => env.DB.prepare(`INSERT INTO class_calendar_slot (
      id, class_calendar_revision_id, local_date, start_time, end_time, slot_source,
      status, curriculum_lesson_id, cancelled_lesson_sequence, cancelled_lesson_title,
      reason_label, is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      id(), newRevisionId, slot.localDate, slot.startTime, slot.endTime, slot.slotSource,
      slot.status, slot.lesson?.id ?? null, slot.cancelledLessonSequence,
      slot.cancelledLessonTitle, slot.reasonLabel, flags.isTest, flags.testRunId, time, time,
    )),
    env.DB.prepare(`UPDATE class_calendar_revision
      SET status = 'superseded', superseded_at = ?, updated_at = ?
      WHERE id = ? AND status = 'published' AND updated_at = ?`).bind(
      time, time, plan.context.revisionId, plan.context.revisionUpdatedAt,
    ),
    env.DB.prepare(`UPDATE class_calendar_revision
      SET status = 'published', published_at = ?, updated_at = ?
      WHERE id = ? AND status = 'draft'`).bind(time, time, newRevisionId),
  ];
  return { statements, newRevisionId };
}

export async function previewDailyChange(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: Record<string, unknown>,
  at = new Date(),
) {
  requireManage(actor);
  const planned = await plansForAction(env, input, at);
  return {
    affectedClassCount: planned.plans.length,
    changedLessonCount: planned.plans.reduce((total, plan) => total + plan.changedFutureLessonAssignments, 0),
    classes: planned.plans.map((plan) => ({
      classSessionId: plan.context.classSessionId,
      classLabel: plan.context.classLabel,
      offeringTitle: plan.context.offeringTitle,
    })),
    warnings: [...new Set(planned.plans.flatMap((plan) => plan.warningLabels))],
  };
}

export async function applyDailyChange(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: Record<string, unknown>,
  at = new Date(),
): Promise<{ revisionIds: string[] }> {
  requireManage(actor);
  const planned = await plansForAction(env, input, at);
  const time = now();
  const statements: D1PreparedStatement[] = [];
  const revisionIds: string[] = [];
  for (const plan of planned.plans) {
    const built = insertRevisionStatements(env, plan, time);
    statements.push(...built.statements);
    revisionIds.push(built.newRevisionId);
  }
  const flags = {
    isTest: planned.plans.some((plan) => plan.context.isTest) ? 1 : 0,
    testRunId: planned.plans.every((plan) => plan.context.testRunId === planned.plans[0].context.testRunId)
      ? planned.plans[0].context.testRunId : null,
  };
  statements.push(audit(env, actor, planned.action, planned.subjectId, {
    ...planned.metadata,
    revisionIds,
    changedLessonCount: planned.plans.reduce((total, plan) => total + plan.changedFutureLessonAssignments, 0),
  }, flags, time));
  try {
    const result = await env.DB.batch(statements);
    const publishResults = result.filter((_entry, index) => {
      let cursor = 0;
      for (const plan of planned.plans) {
        const planLength = insertRevisionStatementsLength(plan);
        const publishIndex = cursor + planLength - 1;
        if (index === publishIndex) return true;
        cursor += planLength;
      }
      return false;
    });
    if (publishResults.some((entry) => (entry.meta?.changes ?? 0) !== 1)) throw new DayChangeError("conflict");
  } catch (caught) {
    if (caught instanceof DayChangeError) throw caught;
    const message = caught instanceof Error ? caught.message : String(caught);
    if (/UNIQUE constraint|published|draft/i.test(message)) throw new DayChangeError("conflict");
    throw caught;
  }
  return { revisionIds };
}

function insertRevisionStatementsLength(plan: PlannedRevision): number {
  return 1 + plan.overrides.length + plan.slots.length + 2;
}
