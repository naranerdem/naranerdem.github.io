import type { D1PreparedStatement, WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";
import { getClassCapacityProjections } from "../services/class-capacity";

export class CourseMakeupError extends Error {
  constructor(public readonly code: "forbidden" | "invalid" | "not_found" | "not_eligible" | "capacity" | "conflict" | "attendance_recorded" | "stale") {
    super("Course make-up operation failed.");
    this.name = "CourseMakeupError";
  }
}

interface SourceIdentity {
  enrollmentId: string;
  classSessionId: string;
  curriculumLessonId: string;
}

interface SourceRow extends SourceIdentity {
  studentId: string;
  surname: string;
  givenName: string;
  sourceLocalDate: string;
  sourceStartTime: string;
  sourceEndTime: string;
  lessonSequence: number;
  lessonTitle: string;
  programTitle: string;
  offeringTitle: string;
  defaultClassDurationMinutes: number | null;
  stageCode: string;
  classWeekday: string;
  hasAbsenceNotice: number;
  isTest: number;
  testRunId: string | null;
}

interface NormalTargetRow {
  classSessionId: string;
  curriculumLessonId: string;
  localDate: string;
  startTime: string;
  endTime: string;
  offeringTitle: string;
  stageCode: string;
  classWeekday: string;
  capacity: number;
  makeupCount: number;
}

interface SpecialTargetRow {
  id: string;
  curriculumLessonId: string;
  localDate: string;
  startTime: string;
  endTime: string;
  capacity: number;
  assignedCount: number;
  note: string | null;
}

interface AssignmentRow {
  assignmentId: string;
  resolutionId: string;
  caseId: string;
  caseState: "open" | "closed" | "resolved" | "reconciliation";
  targetKind: "normal_class" | "special";
  sourceEnrollmentId: string;
  sourceClassSessionId: string;
  sourceCurriculumLessonId: string;
  sourceLocalDate: string | null;
  sourceStartTime: string | null;
  sourceEndTime: string | null;
  sourceClassLabel: string | null;
  studentName: string;
  lessonSequence: number;
  lessonTitle: string;
  targetClassSessionId: string | null;
  targetSpecialOccurrenceId: string | null;
  targetSlotId: string | null;
  targetLocalDate: string | null;
  targetStartTime: string | null;
  targetEndTime: string | null;
  targetOfferingTitle: string | null;
  targetStageCode: string | null;
  specialNote: string | null;
  destinationAttendanceStatus: "present" | "late" | "absent" | null;
  isTest: number;
  testRunId: string | null;
}

interface NoMakeupRow extends SourceRow {
  resolutionId: string;
}

interface CaseRow {
  id: string;
  currentResolutionId: string | null;
  state: "open" | "closed" | "resolved" | "reconciliation";
  isTest: number;
  testRunId: string | null;
}

function id(): string { return crypto.randomUUID(); }
function now(): string { return new Date().toISOString(); }
function clean(value: unknown, max = 160): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function optionalText(value: unknown, max = 600): string | null { return clean(value, max) || null; }

function localDateTime(at = new Date()): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ulaanbaatar",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validTime(value: string): boolean { return /^([01]\d|2[0-3]):[0-5]\d$/.test(value); }
function durationMinutes(startTime: string, endTime: string): number {
  const [startHour, startMinute] = startTime.split(":").map(Number);
  const [endHour, endMinute] = endTime.split(":").map(Number);
  return endHour * 60 + endMinute - startHour * 60 - startMinute;
}
function operationId(value: unknown): string | null {
  const candidate = clean(value, 80);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)
    ? candidate : null;
}
function addMinutes(startTime: string, minutes: number): string {
  const [hours, mins] = startTime.split(":").map(Number);
  const total = hours * 60 + mins + minutes;
  if (total >= 24 * 60) throw new CourseMakeupError("invalid");
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function stageLabel(value: string): string {
  return ({ stage_1: "1-р шат", stage_2: "2-р шат", stage_3: "3-р шат" } as Record<string, string>)[value] ?? value;
}

function requireCapability(actor: StaffPrincipal, capability: "makeup.view" | "makeup.manage"): void {
  if (!hasStaffCapability(actor, capability)) throw new CourseMakeupError("forbidden");
}

function sourceIdentity(input: Record<string, unknown>): SourceIdentity {
  const result = {
    enrollmentId: clean(input.enrollmentId),
    classSessionId: clean(input.classSessionId),
    curriculumLessonId: clean(input.curriculumLessonId),
  };
  if (!result.enrollmentId || !result.classSessionId || !result.curriculumLessonId) {
    throw new CourseMakeupError("invalid");
  }
  return result;
}

function audit(
  env: WorkerEnv,
  actor: StaffPrincipal,
  action: string,
  subjectType: string,
  subjectId: string,
  metadata: Record<string, unknown>,
  provenance: { isTest: number; testRunId: string | null },
  occurredAt: string,
): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO audit_event (
    id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at
  ) VALUES (?, ?, 'staff', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    id(), occurredAt, actor.staffAccountId, action, subjectType, subjectId,
    JSON.stringify(metadata), env.APP_ENV, provenance.isTest, provenance.testRunId, occurredAt,
  );
}

const SOURCE_SELECT = `
  SELECT enrollment.id AS enrollmentId,
    class_session.id AS classSessionId,
    lesson.id AS curriculumLessonId,
    student.id AS studentId,
    student.surname,
    student.given_name AS givenName,
    slot.local_date AS sourceLocalDate,
    slot.start_time AS sourceStartTime,
    slot.end_time AS sourceEndTime,
    lesson.sequence_number AS lessonSequence,
    lesson.title AS lessonTitle,
    program.display_name AS programTitle,
    offering.title AS offeringTitle,
    offering.default_class_duration_minutes AS defaultClassDurationMinutes,
    class_session.stage_code AS stageCode,
    COALESCE(meeting.weekly_weekday, class_session.weekday) AS classWeekday,
    CASE WHEN notice.id IS NULL THEN 0 ELSE 1 END AS hasAbsenceNotice,
    MAX(enrollment.is_test, class_session.is_test, offering.is_test) AS isTest,
    COALESCE(enrollment.test_run_id, class_session.test_run_id, offering.test_run_id) AS testRunId
  FROM class_calendar_slot AS slot
  INNER JOIN class_calendar_revision AS revision
    ON revision.id = slot.class_calendar_revision_id AND revision.status = 'published'
  INNER JOIN class_calendar AS calendar ON calendar.id = revision.class_calendar_id
  INNER JOIN class_session ON class_session.id = calendar.class_session_id
  INNER JOIN activity_offering AS offering ON offering.id = class_session.activity_offering_id
  INNER JOIN curriculum_lesson AS lesson ON lesson.id = slot.curriculum_lesson_id
  INNER JOIN curriculum_program AS program ON program.id = lesson.curriculum_program_id
  INNER JOIN enrollment ON enrollment.class_session_id = class_session.id
  INNER JOIN student ON student.id = enrollment.student_id
  LEFT JOIN class_meeting_rule AS meeting ON meeting.class_session_id = class_session.id
  LEFT JOIN course_attendance AS attendance
    ON attendance.enrollment_id = enrollment.id
    AND attendance.class_session_id = class_session.id
    AND attendance.curriculum_lesson_id = lesson.id
  LEFT JOIN course_absence_notice AS notice
    ON notice.enrollment_id = enrollment.id
    AND notice.class_session_id = class_session.id
    AND notice.curriculum_lesson_id = lesson.id
    AND notice.status = 'active'
  WHERE slot.status = 'scheduled'
    AND offering.kind IN ('annual_course', 'summer_course')
    AND enrollment.confirmed_at IS NOT NULL
    AND julianday(enrollment.confirmed_at) <= julianday(slot.local_date || ' 23:59:59', '-8 hours')
    AND (enrollment.cancelled_at IS NULL
      OR julianday(enrollment.cancelled_at) >= julianday(slot.local_date || ' 00:00:00', '-8 hours'))
    AND (attendance.attendance_status IS NULL OR attendance.attendance_status = 'absent')`;

function sourceKey(source: SourceIdentity): string {
  return `${source.enrollmentId}|${source.classSessionId}|${source.curriculumLessonId}`;
}

async function caseRows(env: WorkerEnv): Promise<Map<string, CaseRow>> {
  const result = await env.DB.prepare(`SELECT id, source_enrollment_id AS enrollmentId,
      source_class_session_id AS classSessionId, source_curriculum_lesson_id AS curriculumLessonId,
      current_resolution_id AS currentResolutionId, state,
      is_test AS isTest, test_run_id AS testRunId
    FROM course_makeup_case`).all<CaseRow & SourceIdentity>();
  return new Map(result.results.map((entry) => [sourceKey(entry), entry]));
}

async function caseForSource(env: WorkerEnv, source: SourceIdentity): Promise<CaseRow | null> {
  return env.DB.prepare(`SELECT id, current_resolution_id AS currentResolutionId, state,
      is_test AS isTest, test_run_id AS testRunId
    FROM course_makeup_case
    WHERE source_enrollment_id = ? AND source_class_session_id = ? AND source_curriculum_lesson_id = ?`).bind(
    source.enrollmentId, source.classSessionId, source.curriculumLessonId,
  ).first<CaseRow>();
}

async function currentAttemptState(
  env: WorkerEnv,
  caseRow: CaseRow | null,
  at = new Date(),
): Promise<"needs_action" | "scheduled" | "attendance_review" | "resolved" | "closed" | "reconciliation"> {
  if (!caseRow) return "needs_action";
  if (caseRow.state === "closed") return "closed";
  if (caseRow.state === "reconciliation") return "reconciliation";
  if (!caseRow.currentResolutionId) return caseRow.state === "resolved" ? "resolved" : "needs_action";
  const row = await env.DB.prepare(`SELECT resolution.decision, assignment.id AS assignmentId,
      COALESCE(normal_attendance.attendance_status, special_attendance.attendance_status) AS attendanceStatus,
      COALESCE(slot.local_date, special.local_date) AS localDate,
      COALESCE(slot.start_time, special.start_time) AS startTime,
      COALESCE(slot.end_time, special.end_time) AS endTime
    FROM course_makeup_resolution AS resolution
    LEFT JOIN course_makeup_assignment AS assignment
      ON assignment.resolution_id = resolution.id AND assignment.status = 'active'
    LEFT JOIN class_calendar AS calendar ON calendar.class_session_id = assignment.target_class_session_id
    LEFT JOIN class_calendar_revision AS revision
      ON revision.class_calendar_id = calendar.id AND revision.status = 'published'
    LEFT JOIN class_calendar_slot AS slot
      ON slot.class_calendar_revision_id = revision.id
      AND slot.curriculum_lesson_id = assignment.target_curriculum_lesson_id AND slot.status = 'scheduled'
    LEFT JOIN course_makeup_special_occurrence AS special
      ON special.id = assignment.target_special_occurrence_id AND special.status = 'active'
    LEFT JOIN course_makeup_attendance AS normal_attendance
      ON normal_attendance.course_makeup_assignment_id = assignment.id
    LEFT JOIN course_makeup_special_attendance AS special_attendance
      ON special_attendance.course_makeup_assignment_id = assignment.id
    WHERE resolution.id = ? AND resolution.status = 'active'`).bind(caseRow.currentResolutionId).first<{
      decision: "no_makeup" | "assigned"; assignmentId: string | null;
      attendanceStatus: "present" | "late" | "absent" | null;
      localDate: string | null; startTime: string | null; endTime: string | null;
    }>();
  if (!row) return caseRow.state === "resolved" ? "resolved" : "needs_action";
  if (row.decision === "no_makeup") return "closed";
  if (!row.assignmentId || !row.localDate || !row.startTime || !row.endTime) return "needs_action";
  if (row.attendanceStatus === "present" || row.attendanceStatus === "late") return "resolved";
  if (row.attendanceStatus === "absent") return "needs_action";
  const local = localDateTime(at);
  return row.localDate < local.date || (row.localDate === local.date && row.endTime <= local.time)
    ? "attendance_review" : "scheduled";
}

async function unresolvedSources(env: WorkerEnv, at = new Date()): Promise<SourceRow[]> {
  const local = localDateTime(at);
  const result = await env.DB.prepare(`${SOURCE_SELECT}
    AND (slot.local_date < ? OR (slot.local_date = ? AND slot.end_time <= ?))
    GROUP BY enrollment.id, class_session.id, lesson.id
    ORDER BY slot.local_date DESC, slot.start_time, program.display_name,
      lesson.sequence_number, student.surname COLLATE NOCASE, student.given_name COLLATE NOCASE`)
    .bind(local.date, local.date, local.time).all<SourceRow>();
  const cases = await caseRows(env);
  const states = await Promise.all(result.results.map(async (source) => ({
    source, state: await currentAttemptState(env, cases.get(sourceKey(source)) ?? null, at),
  })));
  return states.filter((entry) => entry.state === "needs_action").map((entry) => entry.source);
}

async function unresolvedSource(
  env: WorkerEnv,
  source: SourceIdentity,
  at = new Date(),
): Promise<SourceRow> {
  const local = localDateTime(at);
  const row = await env.DB.prepare(`${SOURCE_SELECT}
    AND enrollment.id = ? AND class_session.id = ? AND lesson.id = ?
    AND (slot.local_date < ? OR (slot.local_date = ? AND slot.end_time <= ?))
    GROUP BY enrollment.id, class_session.id, lesson.id`).bind(
    source.enrollmentId, source.classSessionId, source.curriculumLessonId,
    local.date, local.date, local.time,
  ).first<SourceRow>();
  if (!row || await currentAttemptState(env, await caseForSource(env, row), at) !== "needs_action") {
    throw new CourseMakeupError("not_eligible");
  }
  return row;
}

async function normalTargets(
  env: WorkerEnv,
  source: SourceIdentity,
  at = new Date(),
): Promise<Array<NormalTargetRow & { remainingCapacity: number; classLabel: string }>> {
  const local = localDateTime(at);
  const result = await env.DB.prepare(`SELECT
      class_session.id AS classSessionId,
      slot.curriculum_lesson_id AS curriculumLessonId,
      slot.local_date AS localDate,
      slot.start_time AS startTime,
      slot.end_time AS endTime,
      offering.title AS offeringTitle,
      class_session.stage_code AS stageCode,
      COALESCE(meeting.weekly_weekday, class_session.weekday) AS classWeekday,
      class_session.capacity,
      (SELECT COUNT(*) FROM course_makeup_assignment AS target_assignment
        WHERE target_assignment.target_kind = 'normal_class'
          AND target_assignment.target_class_session_id = class_session.id
          AND target_assignment.target_curriculum_lesson_id = slot.curriculum_lesson_id
          AND target_assignment.status = 'active') AS makeupCount
    FROM class_calendar_slot AS slot
    INNER JOIN class_calendar_revision AS revision
      ON revision.id = slot.class_calendar_revision_id AND revision.status = 'published'
    INNER JOIN class_calendar AS calendar ON calendar.id = revision.class_calendar_id
    INNER JOIN class_session ON class_session.id = calendar.class_session_id
    INNER JOIN activity_offering AS offering ON offering.id = class_session.activity_offering_id
    LEFT JOIN class_meeting_rule AS meeting ON meeting.class_session_id = class_session.id
    WHERE slot.status = 'scheduled'
      AND slot.curriculum_lesson_id = ?
      AND class_session.id <> ?
      AND class_session.status IN ('available', 'full')
      AND offering.status = 'active'
      AND offering.kind IN ('annual_course', 'summer_course')
      AND (slot.local_date > ? OR (slot.local_date = ? AND slot.start_time > ?))
    ORDER BY slot.local_date, slot.start_time, offering.title, class_session.id`).bind(
    source.curriculumLessonId, source.classSessionId, local.date, local.date, local.time,
  ).all<NormalTargetRow>();
  const projections = new Map((await getClassCapacityProjections(
    env.DB,
    env.APP_ENV,
    at,
    result.results.map((target) => target.classSessionId),
  )).map((projection) => [projection.classSessionId, projection]));
  return result.results.map((target) => ({
    ...target,
    // Class capacity already accounts for enrolled students, active draft
    // holds, offered waitlist seats, and transfer reservations. A make-up
    // visitor is additional only for this target lesson.
    remainingCapacity: Math.max((projections.get(target.classSessionId)?.freeSeats ?? 0) - target.makeupCount, 0),
    classLabel: `${stageLabel(target.stageCode)} · ${target.classWeekday} ${target.startTime}–${target.endTime}`,
  })).filter((target) => target.remainingCapacity > 0);
}

async function specialTargets(
  env: WorkerEnv,
  lessonId: string,
  at = new Date(),
): Promise<Array<SpecialTargetRow & { remainingCapacity: number }>> {
  const local = localDateTime(at);
  const result = await env.DB.prepare(`SELECT special.id,
      special.curriculum_lesson_id AS curriculumLessonId,
      special.local_date AS localDate,
      special.start_time AS startTime,
      special.end_time AS endTime,
      special.capacity,
      special.note,
      (SELECT COUNT(*) FROM course_makeup_assignment AS assignment
        WHERE assignment.target_special_occurrence_id = special.id
          AND assignment.status = 'active') AS assignedCount
    FROM course_makeup_special_occurrence AS special
    WHERE special.status = 'active'
      AND special.curriculum_lesson_id = ?
      AND (special.local_date > ? OR (special.local_date = ? AND special.start_time > ?))
    ORDER BY special.local_date, special.start_time, special.id`).bind(
    lessonId, local.date, local.date, local.time,
  ).all<SpecialTargetRow>();
  return result.results.map((target) => ({
    ...target,
    remainingCapacity: target.capacity - target.assignedCount,
  })).filter((target) => target.remainingCapacity > 0);
}

async function assertSpecialAvailability(
  env: WorkerEnv,
  lessonId: string,
  localDate: string,
  startTime: string,
  endTime: string,
  excludeSpecialOccurrenceId = "",
): Promise<void> {
  const closed = await env.DB.prepare(`SELECT 1 AS value
    FROM curriculum_lesson AS lesson
    INNER JOIN curriculum_program AS program ON program.id = lesson.curriculum_program_id
    INNER JOIN academic_year_break AS school_break ON school_break.academic_year_id = program.academic_year_id
    WHERE lesson.id = ? AND school_break.status = 'active'
      AND school_break.starts_on <= ? AND school_break.ends_on >= ?
      AND school_break.excludes_habitual_slots = 1 AND school_break.exclude_from_generation = 1
    LIMIT 1`).bind(lessonId, localDate, localDate).first<{ value: number }>();
  if (closed) throw new CourseMakeupError("conflict");
  const conflict = await env.DB.prepare(`SELECT 1 AS value
    WHERE EXISTS (
      SELECT 1 FROM course_makeup_special_occurrence
      WHERE status = 'active' AND id <> ? AND local_date = ?
        AND start_time < ? AND end_time > ?
    ) OR EXISTS (
      SELECT 1 FROM class_calendar_slot AS slot
      INNER JOIN class_calendar_revision AS revision
        ON revision.id = slot.class_calendar_revision_id AND revision.status = 'published'
      WHERE slot.status = 'scheduled' AND slot.local_date = ?
        AND slot.start_time < ? AND slot.end_time > ?
    )`).bind(
      excludeSpecialOccurrenceId, localDate, endTime, startTime,
      localDate, endTime, startTime,
    ).first<{ value: number }>();
  if (conflict) throw new CourseMakeupError("conflict");
}

async function scheduledAssignments(
  env: WorkerEnv,
  at = new Date(),
): Promise<Array<AssignmentRow & { state: "scheduled" | "needs_reassignment" | "attendance_review" | "resolved" | "needs_action" | "reconciliation" }>> {
  const result = await env.DB.prepare(`SELECT assignment.id AS assignmentId,
      resolution.id AS resolutionId,
      makeup_case.id AS caseId, makeup_case.state AS caseState,
      assignment.target_kind AS targetKind,
      resolution.source_enrollment_id AS sourceEnrollmentId,
      resolution.source_class_session_id AS sourceClassSessionId,
      resolution.source_curriculum_lesson_id AS sourceCurriculumLessonId,
      source_slot.local_date AS sourceLocalDate,
      source_slot.start_time AS sourceStartTime,
      source_slot.end_time AS sourceEndTime,
      CASE source_class.stage_code
        WHEN 'stage_1' THEN '1-р шат'
        WHEN 'stage_2' THEN '2-р шат'
        WHEN 'stage_3' THEN '3-р шат'
        ELSE source_class.stage_code
      END || ' · ' || COALESCE(source_meeting.weekly_weekday, source_class.weekday)
        || ' ' || source_slot.start_time || '–' || source_slot.end_time AS sourceClassLabel,
      student.surname || ' ' || student.given_name AS studentName,
      lesson.sequence_number AS lessonSequence,
      lesson.title AS lessonTitle,
      assignment.target_class_session_id AS targetClassSessionId,
      assignment.target_special_occurrence_id AS targetSpecialOccurrenceId,
      target_slot.id AS targetSlotId,
      COALESCE(target_slot.local_date, special.local_date) AS targetLocalDate,
      COALESCE(target_slot.start_time, special.start_time) AS targetStartTime,
      COALESCE(target_slot.end_time, special.end_time) AS targetEndTime,
      target_offering.title AS targetOfferingTitle,
      target_class.stage_code AS targetStageCode,
      special.note AS specialNote,
      COALESCE(normal_attendance.attendance_status, special_attendance.attendance_status) AS destinationAttendanceStatus,
      assignment.is_test AS isTest,
      assignment.test_run_id AS testRunId
    FROM course_makeup_assignment AS assignment
    INNER JOIN course_makeup_resolution AS resolution
      ON resolution.id = assignment.resolution_id AND resolution.status = 'active'
    INNER JOIN course_makeup_case AS makeup_case
      ON makeup_case.current_resolution_id = resolution.id
    INNER JOIN enrollment ON enrollment.id = resolution.source_enrollment_id
    INNER JOIN student ON student.id = enrollment.student_id
    INNER JOIN curriculum_lesson AS lesson ON lesson.id = resolution.source_curriculum_lesson_id
    INNER JOIN class_session AS source_class ON source_class.id = resolution.source_class_session_id
    LEFT JOIN class_meeting_rule AS source_meeting ON source_meeting.class_session_id = source_class.id
    LEFT JOIN class_calendar AS source_calendar ON source_calendar.class_session_id = source_class.id
    LEFT JOIN class_calendar_revision AS source_revision
      ON source_revision.class_calendar_id = source_calendar.id AND source_revision.status = 'published'
    LEFT JOIN class_calendar_slot AS source_slot
      ON source_slot.class_calendar_revision_id = source_revision.id
      AND source_slot.curriculum_lesson_id = resolution.source_curriculum_lesson_id
      AND source_slot.status = 'scheduled'
    LEFT JOIN class_session AS target_class ON target_class.id = assignment.target_class_session_id
    LEFT JOIN activity_offering AS target_offering ON target_offering.id = target_class.activity_offering_id
    LEFT JOIN class_calendar AS target_calendar ON target_calendar.class_session_id = target_class.id
    LEFT JOIN class_calendar_revision AS target_revision
      ON target_revision.class_calendar_id = target_calendar.id AND target_revision.status = 'published'
    LEFT JOIN class_calendar_slot AS target_slot
      ON target_slot.class_calendar_revision_id = target_revision.id
      AND target_slot.curriculum_lesson_id = assignment.target_curriculum_lesson_id
      AND target_slot.status = 'scheduled'
    LEFT JOIN course_makeup_special_occurrence AS special
      ON special.id = assignment.target_special_occurrence_id AND special.status = 'active'
    LEFT JOIN course_makeup_attendance AS normal_attendance
      ON normal_attendance.course_makeup_assignment_id = assignment.id
    LEFT JOIN course_makeup_special_attendance AS special_attendance
      ON special_attendance.course_makeup_assignment_id = assignment.id
    WHERE assignment.status = 'active'
    ORDER BY targetLocalDate, targetStartTime, lesson.sequence_number, studentName`).all<AssignmentRow>();
  const local = localDateTime(at);
  return result.results.map((entry) => {
    const state = entry.caseState === "reconciliation" ? "reconciliation"
      : entry.destinationAttendanceStatus === "present" || entry.destinationAttendanceStatus === "late" ? "resolved"
      : entry.destinationAttendanceStatus === "absent" ? "needs_action"
      : !entry.targetLocalDate ? "needs_reassignment"
      : entry.targetLocalDate < local.date || (entry.targetLocalDate === local.date && (entry.targetEndTime ?? "") <= local.time)
        ? "attendance_review" : "scheduled";
    return { ...entry, state };
  });
}

async function historicalAttempts(env: WorkerEnv): Promise<Array<{
  caseId: string; caseState: string; resolutionId: string; assignmentId: string | null;
  decision: "no_makeup" | "assigned"; resolutionStatus: "active" | "invalidated";
  studentName: string; lessonSequence: number; lessonTitle: string;
  sourceLocalDate: string | null; sourceClassLabel: string | null;
  targetKind: "normal_class" | "special" | null; targetLocalDate: string | null;
  targetStartTime: string | null; targetEndTime: string | null;
  destinationAttendanceStatus: "present" | "late" | "absent" | null;
  isCurrent: number;
}>> {
  const result = await env.DB.prepare(`SELECT makeup_case.id AS caseId, makeup_case.state AS caseState,
      resolution.id AS resolutionId, assignment.id AS assignmentId, resolution.decision,
      resolution.status AS resolutionStatus,
      student.surname || ' ' || student.given_name AS studentName,
      lesson.sequence_number AS lessonSequence, lesson.title AS lessonTitle,
      source_slot.local_date AS sourceLocalDate,
      CASE source_class.stage_code
        WHEN 'stage_1' THEN '1-р шат'
        WHEN 'stage_2' THEN '2-р шат'
        WHEN 'stage_3' THEN '3-р шат'
        ELSE source_class.stage_code
      END || ' · ' || COALESCE(source_meeting.weekly_weekday, source_class.weekday)
        || ' ' || source_slot.start_time || '–' || source_slot.end_time AS sourceClassLabel,
      assignment.target_kind AS targetKind,
      COALESCE(target_slot.local_date, special.local_date) AS targetLocalDate,
      COALESCE(target_slot.start_time, special.start_time) AS targetStartTime,
      COALESCE(target_slot.end_time, special.end_time) AS targetEndTime,
      COALESCE(normal_attendance.attendance_status, special_attendance.attendance_status) AS destinationAttendanceStatus,
      CASE WHEN makeup_case.current_resolution_id = resolution.id THEN 1 ELSE 0 END AS isCurrent
    FROM course_makeup_case AS makeup_case
    INNER JOIN course_makeup_resolution AS resolution ON resolution.case_id = makeup_case.id
    INNER JOIN enrollment ON enrollment.id = resolution.source_enrollment_id
    INNER JOIN student ON student.id = enrollment.student_id
    INNER JOIN curriculum_lesson AS lesson ON lesson.id = resolution.source_curriculum_lesson_id
    INNER JOIN class_session AS source_class ON source_class.id = resolution.source_class_session_id
    LEFT JOIN class_meeting_rule AS source_meeting ON source_meeting.class_session_id = source_class.id
    LEFT JOIN class_calendar AS source_calendar ON source_calendar.class_session_id = source_class.id
    LEFT JOIN class_calendar_revision AS source_revision
      ON source_revision.class_calendar_id = source_calendar.id AND source_revision.status = 'published'
    LEFT JOIN class_calendar_slot AS source_slot
      ON source_slot.class_calendar_revision_id = source_revision.id
      AND source_slot.curriculum_lesson_id = resolution.source_curriculum_lesson_id AND source_slot.status = 'scheduled'
    LEFT JOIN course_makeup_assignment AS assignment ON assignment.resolution_id = resolution.id
    LEFT JOIN class_calendar AS target_calendar ON target_calendar.class_session_id = assignment.target_class_session_id
    LEFT JOIN class_calendar_revision AS target_revision
      ON target_revision.class_calendar_id = target_calendar.id AND target_revision.status = 'published'
    LEFT JOIN class_calendar_slot AS target_slot
      ON target_slot.class_calendar_revision_id = target_revision.id
      AND target_slot.curriculum_lesson_id = assignment.target_curriculum_lesson_id AND target_slot.status = 'scheduled'
    LEFT JOIN course_makeup_special_occurrence AS special ON special.id = assignment.target_special_occurrence_id
    LEFT JOIN course_makeup_attendance AS normal_attendance ON normal_attendance.course_makeup_assignment_id = assignment.id
    LEFT JOIN course_makeup_special_attendance AS special_attendance ON special_attendance.course_makeup_assignment_id = assignment.id
    WHERE resolution.id <> COALESCE(makeup_case.current_resolution_id, '')
      OR (makeup_case.state = 'closed' AND resolution.id = makeup_case.current_resolution_id)
    ORDER BY sourceLocalDate DESC, lesson.sequence_number, studentName, resolution.decided_at DESC`).all<{
      caseId: string; caseState: string; resolutionId: string; assignmentId: string | null;
      decision: "no_makeup" | "assigned"; resolutionStatus: "active" | "invalidated";
      studentName: string; lessonSequence: number; lessonTitle: string;
      sourceLocalDate: string | null; sourceClassLabel: string | null;
      targetKind: "normal_class" | "special" | null; targetLocalDate: string | null;
      targetStartTime: string | null; targetEndTime: string | null;
      destinationAttendanceStatus: "present" | "late" | "absent" | null; isCurrent: number;
    }>();
  return result.results;
}

async function noMakeupResolutions(env: WorkerEnv, at = new Date()): Promise<NoMakeupRow[]> {
  const local = localDateTime(at);
  const result = await env.DB.prepare(`SELECT resolution.id AS resolutionId,
      enrollment.id AS enrollmentId, class_session.id AS classSessionId,
      lesson.id AS curriculumLessonId, student.id AS studentId,
      student.surname, student.given_name AS givenName,
      slot.local_date AS sourceLocalDate, slot.start_time AS sourceStartTime,
      slot.end_time AS sourceEndTime, lesson.sequence_number AS lessonSequence,
      lesson.title AS lessonTitle, program.display_name AS programTitle,
      offering.title AS offeringTitle, class_session.stage_code AS stageCode,
      offering.default_class_duration_minutes AS defaultClassDurationMinutes,
      COALESCE(meeting.weekly_weekday, class_session.weekday) AS classWeekday,
      CASE WHEN notice.id IS NULL THEN 0 ELSE 1 END AS hasAbsenceNotice,
      MAX(enrollment.is_test, class_session.is_test, offering.is_test) AS isTest,
      COALESCE(enrollment.test_run_id, class_session.test_run_id, offering.test_run_id) AS testRunId
    FROM course_makeup_resolution AS resolution
    INNER JOIN enrollment ON enrollment.id = resolution.source_enrollment_id
    INNER JOIN student ON student.id = enrollment.student_id
    INNER JOIN class_session ON class_session.id = resolution.source_class_session_id
    INNER JOIN activity_offering AS offering ON offering.id = class_session.activity_offering_id
    INNER JOIN class_calendar AS calendar ON calendar.class_session_id = class_session.id
    INNER JOIN class_calendar_revision AS revision
      ON revision.class_calendar_id = calendar.id AND revision.status = 'published'
    INNER JOIN class_calendar_slot AS slot
      ON slot.class_calendar_revision_id = revision.id
      AND slot.curriculum_lesson_id = resolution.source_curriculum_lesson_id
      AND slot.status = 'scheduled'
    INNER JOIN curriculum_lesson AS lesson ON lesson.id = resolution.source_curriculum_lesson_id
    INNER JOIN curriculum_program AS program ON program.id = lesson.curriculum_program_id
    LEFT JOIN class_meeting_rule AS meeting ON meeting.class_session_id = class_session.id
    LEFT JOIN course_absence_notice AS notice
      ON notice.enrollment_id = enrollment.id
      AND notice.class_session_id = class_session.id
      AND notice.curriculum_lesson_id = lesson.id
      AND notice.status = 'active'
    INNER JOIN course_makeup_case AS makeup_case
      ON makeup_case.current_resolution_id = resolution.id
    WHERE resolution.status = 'active' AND resolution.decision = 'no_makeup'
      AND (slot.local_date < ? OR (slot.local_date = ? AND slot.end_time <= ?))
    ORDER BY slot.local_date DESC, slot.start_time, program.display_name,
      lesson.sequence_number, student.surname COLLATE NOCASE, student.given_name COLLATE NOCASE`)
    .bind(local.date, local.date, local.time).all<NoMakeupRow>();
  return result.results;
}

function serializeSource(source: SourceRow) {
  return {
    enrollmentId: source.enrollmentId,
    classSessionId: source.classSessionId,
    curriculumLessonId: source.curriculumLessonId,
    studentName: `${source.surname} ${source.givenName}`.trim(),
    sourceLocalDate: source.sourceLocalDate,
    sourceStartTime: source.sourceStartTime,
    sourceEndTime: source.sourceEndTime,
    lessonSequence: source.lessonSequence,
    lessonTitle: source.lessonTitle,
    programTitle: source.programTitle,
    offeringTitle: source.offeringTitle,
    classLabel: `${stageLabel(source.stageCode)} · ${source.classWeekday} ${source.sourceStartTime}–${source.sourceEndTime}`,
    hasAbsenceNotice: Boolean(source.hasAbsenceNotice),
  };
}

export async function getCourseMakeupOverview(
  env: WorkerEnv,
  actor: StaffPrincipal,
  selectedInput?: Record<string, unknown>,
  at = new Date(),
) {
  requireCapability(actor, "makeup.view");
  const unresolved = await unresolvedSources(env, at);
  const attempts = await scheduledAssignments(env, at);
  const history = await historicalAttempts(env);
  let selected = null;
  if (selectedInput?.enrollmentId || selectedInput?.classSessionId || selectedInput?.curriculumLessonId) {
    const source = await unresolvedSource(env, sourceIdentity(selectedInput), at);
    selected = {
      source: serializeSource(source),
      normalTargets: await normalTargets(env, source, at),
      specialTargets: await specialTargets(env, source.curriculumLessonId, at),
    };
  }
  return {
    unresolved: unresolved.map(serializeSource),
    scheduled: attempts.filter((entry) => entry.state === "scheduled" || entry.state === "needs_reassignment" || entry.state === "reconciliation"),
    attendanceReview: attempts.filter((entry) => entry.state === "attendance_review"),
    history: [...attempts.filter((entry) => entry.state === "resolved"), ...history],
    missed: attempts.filter((entry) => entry.state === "needs_action"),
    noMakeup: (await noMakeupResolutions(env, at)).map((entry) => ({
      ...serializeSource(entry), resolutionId: entry.resolutionId,
    })),
    selected,
  };
}

function resolutionInsert(
  env: WorkerEnv,
  actor: StaffPrincipal,
  source: SourceRow,
  caseId: string,
  resolutionId: string,
  decision: "no_makeup" | "assigned",
  note: string | null,
  time: string,
): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO course_makeup_resolution (
    id, source_enrollment_id, source_class_session_id, source_curriculum_lesson_id,
    case_id, decision, status, note, decided_by_staff_account_id, decided_at,
    is_test, test_run_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`).bind(
    resolutionId, source.enrollmentId, source.classSessionId, source.curriculumLessonId,
    caseId, decision, note, actor.staffAccountId, time, source.isTest, source.testRunId, time, time,
  );
}

function caseInsert(
  env: WorkerEnv,
  source: SourceRow,
  caseId: string,
  currentResolutionId: string | null,
  state: "open" | "closed" | "resolved" | "reconciliation",
  time: string,
): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO course_makeup_case (
    id, source_enrollment_id, source_class_session_id, source_curriculum_lesson_id,
    current_resolution_id, state, is_test, test_run_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    caseId, source.enrollmentId, source.classSessionId, source.curriculumLessonId,
    currentResolutionId, state, source.isTest, source.testRunId, time, time,
  );
}

function caseCurrentUpdate(
  env: WorkerEnv,
  caseId: string,
  currentResolutionId: string | null,
  state: "open" | "closed" | "resolved" | "reconciliation",
  time: string,
): D1PreparedStatement {
  return env.DB.prepare(`UPDATE course_makeup_case
    SET current_resolution_id = ?, state = ?, updated_at = ? WHERE id = ?`).bind(
    currentResolutionId, state, time, caseId,
  );
}

async function existingOrNewCase(env: WorkerEnv, source: SourceRow, proposedId: string): Promise<{ id: string; existing: boolean }> {
  const existing = await caseForSource(env, source);
  return existing ? { id: existing.id, existing: true } : { id: proposedId, existing: false };
}

async function activeCurrentResolution(env: WorkerEnv, caseId: string): Promise<{ id: string } | null> {
  return env.DB.prepare(`SELECT resolution.id
    FROM course_makeup_case AS makeup_case
    INNER JOIN course_makeup_resolution AS resolution
      ON resolution.id = makeup_case.current_resolution_id AND resolution.status = 'active'
    WHERE makeup_case.id = ?`).bind(caseId).first<{ id: string }>();
}

function retireCurrentAttempt(
  env: WorkerEnv,
  actor: StaffPrincipal,
  resolutionId: string | null,
  time: string,
): D1PreparedStatement[] {
  if (!resolutionId) return [];
  return [
    env.DB.prepare(`UPDATE course_makeup_assignment SET status = 'cancelled',
      cancelled_at = ?, cancelled_by_staff_account_id = ?, cancellation_reason = 'teacher_reopened',
      updated_at = ? WHERE resolution_id = ? AND status = 'active'`).bind(
      time, actor.staffAccountId, time, resolutionId,
    ),
    env.DB.prepare(`UPDATE course_makeup_resolution SET status = 'invalidated',
      invalidated_at = ?, invalidated_by_staff_account_id = ?, invalidation_reason = 'assignment_cancelled',
      updated_at = ? WHERE id = ? AND status = 'active'`).bind(
      time, actor.staffAccountId, time, resolutionId,
    ),
  ];
}

function assignmentInsert(
  env: WorkerEnv,
  actor: StaffPrincipal,
  source: SourceRow,
  resolutionId: string,
  assignmentId: string,
  target: { kind: "normal_class"; classSessionId: string } | { kind: "special"; specialOccurrenceId: string },
  time: string,
): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO course_makeup_assignment (
    id, resolution_id, target_kind, target_class_session_id,
    target_special_occurrence_id, target_curriculum_lesson_id, status,
    assigned_by_staff_account_id, assigned_at, is_test, test_run_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`).bind(
    assignmentId, resolutionId, target.kind,
    target.kind === "normal_class" ? target.classSessionId : null,
    target.kind === "special" ? target.specialOccurrenceId : null,
    source.curriculumLessonId, actor.staffAccountId, time,
    source.isTest, source.testRunId, time, time,
  );
}

async function safeBatch(env: WorkerEnv, statements: D1PreparedStatement[]): Promise<void> {
  try {
    await env.DB.batch(statements);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (/capacity is full/i.test(message)) throw new CourseMakeupError("capacity");
    if (/UNIQUE constraint|one active|room time conflicts|schedule changed/i.test(message)) throw new CourseMakeupError("conflict");
    if (/same-lesson target|make-up source/i.test(message)) throw new CourseMakeupError("invalid");
    throw caught;
  }
}

export async function resolveCourseMakeupAsNotNeeded(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: Record<string, unknown>,
  at = new Date(),
): Promise<{ resolutionId: string }> {
  requireCapability(actor, "makeup.manage");
  const source = await unresolvedSource(env, sourceIdentity(input), at);
  const resolutionId = id();
  const caseRef = await existingOrNewCase(env, source, id());
  const previous = caseRef.existing ? await activeCurrentResolution(env, caseRef.id) : null;
  const time = now();
  const note = optionalText(input.note);
  await safeBatch(env, [
    ...(!caseRef.existing ? [caseInsert(env, source, caseRef.id, null, "open", time)] : []),
    ...retireCurrentAttempt(env, actor, previous?.id ?? null, time),
    resolutionInsert(env, actor, source, caseRef.id, resolutionId, "no_makeup", note, time),
    caseCurrentUpdate(env, caseRef.id, resolutionId, "closed", time),
    audit(env, actor, "course_makeup_not_needed", "course_makeup_resolution", resolutionId, {
      sourceEnrollmentId: source.enrollmentId,
      sourceClassSessionId: source.classSessionId,
      curriculumLessonId: source.curriculumLessonId,
    }, source, time),
  ]);
  return { resolutionId };
}

export async function reopenCourseMakeupResolution(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: Record<string, unknown>,
): Promise<void> {
  requireCapability(actor, "makeup.manage");
  const resolutionId = clean(input.resolutionId);
  const resolution = await env.DB.prepare(`SELECT id, source_enrollment_id AS enrollmentId,
      source_class_session_id AS classSessionId, source_curriculum_lesson_id AS curriculumLessonId,
      is_test AS isTest, test_run_id AS testRunId
    FROM course_makeup_resolution
    WHERE id = ? AND decision = 'no_makeup' AND status = 'active'`).bind(resolutionId).first<{
      id: string; enrollmentId: string; classSessionId: string; curriculumLessonId: string;
      isTest: number; testRunId: string | null;
    }>();
  if (!resolution) throw new CourseMakeupError("not_found");
  const time = now();
  const caseRef = await caseForSource(env, resolution);
  if (!caseRef || caseRef.currentResolutionId !== resolution.id) throw new CourseMakeupError("not_found");
  await safeBatch(env, [
    env.DB.prepare(`UPDATE course_makeup_resolution SET status = 'invalidated',
      invalidated_at = ?, invalidated_by_staff_account_id = ?, invalidation_reason = 'assignment_cancelled',
      updated_at = ? WHERE id = ? AND status = 'active'`).bind(time, actor.staffAccountId, time, resolution.id),
    caseCurrentUpdate(env, caseRef.id, null, "open", time),
    audit(env, actor, "course_makeup_no_makeup_reopened", "course_makeup_resolution", resolution.id, {
      sourceEnrollmentId: resolution.enrollmentId,
      sourceClassSessionId: resolution.classSessionId,
      curriculumLessonId: resolution.curriculumLessonId,
    }, resolution, time),
  ]);
}

export async function assignCourseMakeupToNormalClass(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: Record<string, unknown>,
  at = new Date(),
): Promise<{ assignmentId: string }> {
  requireCapability(actor, "makeup.manage");
  const source = await unresolvedSource(env, sourceIdentity(input), at);
  const targetClassSessionId = clean(input.targetClassSessionId);
  const target = (await normalTargets(env, source, at)).find((entry) => entry.classSessionId === targetClassSessionId);
  if (!target) throw new CourseMakeupError("not_eligible");
  const resolutionId = id();
  const assignmentId = id();
  const caseRef = await existingOrNewCase(env, source, id());
  const previous = caseRef.existing ? await activeCurrentResolution(env, caseRef.id) : null;
  const time = now();
  await safeBatch(env, [
    ...(!caseRef.existing ? [caseInsert(env, source, caseRef.id, null, "open", time)] : []),
    ...retireCurrentAttempt(env, actor, previous?.id ?? null, time),
    resolutionInsert(env, actor, source, caseRef.id, resolutionId, "assigned", null, time),
    caseCurrentUpdate(env, caseRef.id, resolutionId, "open", time),
    assignmentInsert(env, actor, source, resolutionId, assignmentId, {
      kind: "normal_class", classSessionId: target.classSessionId,
    }, time),
    audit(env, actor, "course_makeup_assigned", "course_makeup_assignment", assignmentId, {
      sourceEnrollmentId: source.enrollmentId,
      targetClassSessionId: target.classSessionId,
      curriculumLessonId: source.curriculumLessonId,
    }, source, time),
  ]);
  return { assignmentId };
}

export async function assignCourseMakeupToSpecialOccurrence(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: Record<string, unknown>,
  at = new Date(),
): Promise<{ assignmentId: string }> {
  requireCapability(actor, "makeup.manage");
  const source = await unresolvedSource(env, sourceIdentity(input), at);
  const specialOccurrenceId = clean(input.specialOccurrenceId);
  const target = (await specialTargets(env, source.curriculumLessonId, at))
    .find((entry) => entry.id === specialOccurrenceId);
  if (!target) throw new CourseMakeupError("not_eligible");
  const resolutionId = id();
  const assignmentId = id();
  const caseRef = await existingOrNewCase(env, source, id());
  const previous = caseRef.existing ? await activeCurrentResolution(env, caseRef.id) : null;
  const time = now();
  await safeBatch(env, [
    ...(!caseRef.existing ? [caseInsert(env, source, caseRef.id, null, "open", time)] : []),
    ...retireCurrentAttempt(env, actor, previous?.id ?? null, time),
    resolutionInsert(env, actor, source, caseRef.id, resolutionId, "assigned", null, time),
    caseCurrentUpdate(env, caseRef.id, resolutionId, "open", time),
    assignmentInsert(env, actor, source, resolutionId, assignmentId, { kind: "special", specialOccurrenceId }, time),
    audit(env, actor, "course_makeup_assigned", "course_makeup_assignment", assignmentId, {
      sourceEnrollmentId: source.enrollmentId,
      specialOccurrenceId,
      curriculumLessonId: source.curriculumLessonId,
    }, source, time),
  ]);
  return { assignmentId };
}

export async function createSpecialCourseMakeupOccurrence(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: Record<string, unknown>,
  at = new Date(),
): Promise<{ specialOccurrenceId: string; assignmentCount: number }> {
  requireCapability(actor, "makeup.manage");
  if (!Array.isArray(input.sources) || input.sources.length < 1) throw new CourseMakeupError("invalid");
  const sources = await Promise.all(input.sources.map((entry) => {
    if (!entry || typeof entry !== "object") throw new CourseMakeupError("invalid");
    return unresolvedSource(env, sourceIdentity(entry as Record<string, unknown>), at);
  }));
  const lessonId = sources[0].curriculumLessonId;
  if (sources.some((source) => source.curriculumLessonId !== lessonId)) throw new CourseMakeupError("invalid");
  const localDate = clean(input.localDate, 10);
  const startTime = clean(input.startTime, 5);
  const endTime = clean(input.endTime, 5) || addMinutes(startTime, sources[0].defaultClassDurationMinutes ?? 80);
  const capacity = Number(input.capacity);
  const local = localDateTime(at);
  if (!validDate(localDate) || !validTime(startTime) || !validTime(endTime) || endTime <= startTime
    || !Number.isInteger(capacity) || capacity < sources.length || capacity > 100
    || localDate < local.date || (localDate === local.date && startTime <= local.time)) {
    throw new CourseMakeupError("invalid");
  }
  const provenance = sources[0];
  if (sources.some((source) => source.isTest !== provenance.isTest || source.testRunId !== provenance.testRunId)) {
    throw new CourseMakeupError("invalid");
  }
  await assertSpecialAvailability(env, lessonId, localDate, startTime, endTime);
  const specialOccurrenceId = id();
  const time = now();
  const caseRefs = await Promise.all(sources.map((source) => existingOrNewCase(env, source, id())));
  const previousResolutions = await Promise.all(caseRefs.map((caseRef) => caseRef.existing
    ? activeCurrentResolution(env, caseRef.id) : Promise.resolve(null)));
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`INSERT INTO course_makeup_special_occurrence (
      id, curriculum_lesson_id, local_date, start_time, end_time, capacity,
      status, note, created_by_staff_account_id, is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`).bind(
      specialOccurrenceId, lessonId, localDate, startTime, endTime, capacity,
      optionalText(input.note), actor.staffAccountId, provenance.isTest, provenance.testRunId, time, time,
    ),
  ];
  for (const [index, source] of sources.entries()) {
    const resolutionId = id();
    const assignmentId = id();
    const caseRef = caseRefs[index];
    statements.push(
      ...(!caseRef.existing ? [caseInsert(env, source, caseRef.id, null, "open", time)] : []),
      ...retireCurrentAttempt(env, actor, previousResolutions[index]?.id ?? null, time),
      resolutionInsert(env, actor, source, caseRef.id, resolutionId, "assigned", null, time),
      caseCurrentUpdate(env, caseRef.id, resolutionId, "open", time),
      assignmentInsert(env, actor, source, resolutionId, assignmentId, { kind: "special", specialOccurrenceId }, time),
    );
  }
  statements.push(audit(env, actor, "course_makeup_special_created", "course_makeup_special_occurrence", specialOccurrenceId, {
    curriculumLessonId: lessonId,
    localDate,
    assignmentCount: sources.length,
  }, provenance, time));
  await safeBatch(env, statements);
  return { specialOccurrenceId, assignmentCount: sources.length };
}

interface SpecialScheduleRow {
  id: string;
  curriculumLessonId: string;
  localDate: string;
  startTime: string;
  endTime: string;
  capacity: number;
  note: string | null;
  updatedAt: string;
  isTest: number;
  testRunId: string | null;
}

async function specialScheduleForChange(env: WorkerEnv, specialOccurrenceId: string, at = new Date()): Promise<SpecialScheduleRow> {
  const special = await env.DB.prepare(`SELECT id, curriculum_lesson_id AS curriculumLessonId,
      local_date AS localDate, start_time AS startTime, end_time AS endTime, capacity, note,
      updated_at AS updatedAt, is_test AS isTest, test_run_id AS testRunId
    FROM course_makeup_special_occurrence WHERE id = ? AND status = 'active'`).bind(
    specialOccurrenceId,
  ).first<SpecialScheduleRow>();
  if (!special) throw new CourseMakeupError("not_found");
  if (await hasRecordedSpecialAttendance(env, { specialOccurrenceId })) throw new CourseMakeupError("attendance_recorded");
  const local = localDateTime(at);
  if (special.localDate < local.date || (special.localDate === local.date && special.startTime <= local.time)) {
    throw new CourseMakeupError("conflict");
  }
  return special;
}

async function specialSchedulePreview(
  env: WorkerEnv,
  input: Record<string, unknown>,
  at = new Date(),
): Promise<{ special: SpecialScheduleRow; localDate: string; startTime: string; endTime: string; attendees: Array<{ assignmentId: string; studentName: string }> }> {
  const specialOccurrenceId = clean(input.specialOccurrenceId);
  const special = await specialScheduleForChange(env, specialOccurrenceId, at);
  const localDate = clean(input.localDate, 10);
  const startTime = clean(input.startTime, 5);
  const endTime = clean(input.endTime, 5) || addMinutes(startTime, durationMinutes(special.startTime, special.endTime));
  const local = localDateTime(at);
  if (!validDate(localDate) || !validTime(startTime) || !validTime(endTime) || endTime <= startTime
    || localDate < local.date || (localDate === local.date && startTime <= local.time)) {
    throw new CourseMakeupError("invalid");
  }
  if (clean(input.expectedUpdatedAt, 64) && clean(input.expectedUpdatedAt, 64) !== special.updatedAt) {
    throw new CourseMakeupError("stale");
  }
  await assertSpecialAvailability(env, special.curriculumLessonId, localDate, startTime, endTime, special.id);
  const attendees = await env.DB.prepare(`SELECT assignment.id AS assignmentId,
      student.surname || ' ' || student.given_name AS studentName
    FROM course_makeup_assignment AS assignment
    INNER JOIN course_makeup_resolution AS resolution ON resolution.id = assignment.resolution_id
    INNER JOIN enrollment ON enrollment.id = resolution.source_enrollment_id
    INNER JOIN student ON student.id = enrollment.student_id
    WHERE assignment.target_special_occurrence_id = ? AND assignment.status = 'active'
    ORDER BY student.surname COLLATE NOCASE, student.given_name COLLATE NOCASE, assignment.id`).bind(
    special.id,
  ).all<{ assignmentId: string; studentName: string }>();
  return { special, localDate, startTime, endTime, attendees: attendees.results };
}

export async function previewSpecialCourseMakeupReschedule(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: Record<string, unknown>,
  at = new Date(),
) {
  requireCapability(actor, "makeup.manage");
  const preview = await specialSchedulePreview(env, input, at);
  return {
    specialOccurrenceId: preview.special.id,
    expectedUpdatedAt: preview.special.updatedAt,
    old: { localDate: preview.special.localDate, startTime: preview.special.startTime, endTime: preview.special.endTime },
    next: { localDate: preview.localDate, startTime: preview.startTime, endTime: preview.endTime },
    attendees: preview.attendees,
  };
}

export async function rescheduleSpecialCourseMakeupOccurrence(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: Record<string, unknown>,
  at = new Date(),
): Promise<{ specialOccurrenceId: string; localDate: string; startTime: string; endTime: string; attendeeCount: number }> {
  requireCapability(actor, "makeup.manage");
  const idempotencyKey = operationId(input.operationId);
  if (!idempotencyKey) throw new CourseMakeupError("invalid");
  const existing = await env.DB.prepare(`SELECT request_fingerprint AS requestFingerprint, result_json AS resultJson
    FROM course_makeup_special_schedule_operation WHERE operation_id = ?`).bind(idempotencyKey).first<{
      requestFingerprint: string; resultJson: string;
    }>();
  const fingerprint = JSON.stringify({
    specialOccurrenceId: clean(input.specialOccurrenceId), expectedUpdatedAt: clean(input.expectedUpdatedAt, 64),
    localDate: clean(input.localDate, 10), startTime: clean(input.startTime, 5), endTime: clean(input.endTime, 5),
  });
  if (existing) {
    if (existing.requestFingerprint !== fingerprint) throw new CourseMakeupError("conflict");
    return JSON.parse(existing.resultJson) as { specialOccurrenceId: string; localDate: string; startTime: string; endTime: string; attendeeCount: number };
  }
  const preview = await specialSchedulePreview(env, input, at);
  const expectedUpdatedAt = clean(input.expectedUpdatedAt, 64);
  if (!expectedUpdatedAt || expectedUpdatedAt !== preview.special.updatedAt) throw new CourseMakeupError("stale");
  const result = {
    specialOccurrenceId: preview.special.id, localDate: preview.localDate,
    startTime: preview.startTime, endTime: preview.endTime, attendeeCount: preview.attendees.length,
  };
  const time = now();
  await safeBatch(env, [
    env.DB.prepare(`INSERT INTO course_makeup_special_schedule_operation (
      operation_id, special_occurrence_id, expected_updated_at, request_fingerprint, result_json,
      performed_by_staff_account_id, performed_at, is_test, test_run_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      idempotencyKey, preview.special.id, expectedUpdatedAt, fingerprint, JSON.stringify(result),
      actor.staffAccountId, time, preview.special.isTest, preview.special.testRunId, time,
    ),
    env.DB.prepare(`UPDATE course_makeup_special_occurrence
      SET local_date = ?, start_time = ?, end_time = ?, updated_at = ?
      WHERE id = ? AND status = 'active' AND updated_at = ?`).bind(
      preview.localDate, preview.startTime, preview.endTime, time, preview.special.id, expectedUpdatedAt,
    ),
    audit(env, actor, "course_makeup_special_rescheduled", "course_makeup_special_occurrence", preview.special.id, {
      operationId: idempotencyKey,
      old: { localDate: preview.special.localDate, startTime: preview.special.startTime, endTime: preview.special.endTime },
      next: { localDate: preview.localDate, startTime: preview.startTime, endTime: preview.endTime },
      attendeeCount: preview.attendees.length,
    }, preview.special, time),
  ]);
  return result;
}

async function activeAssignment(env: WorkerEnv, assignmentId: string): Promise<AssignmentRow> {
  const rows = await scheduledAssignments(env);
  const assignment = rows.find((entry) => entry.assignmentId === assignmentId);
  if (!assignment) throw new CourseMakeupError("not_found");
  return assignment;
}

async function caseHasCompletedOtherAttempt(env: WorkerEnv, caseId: string, resolutionId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS value
    FROM course_makeup_resolution AS resolution
    INNER JOIN course_makeup_assignment AS assignment ON assignment.resolution_id = resolution.id
    LEFT JOIN course_makeup_attendance AS normal_attendance
      ON normal_attendance.course_makeup_assignment_id = assignment.id
    LEFT JOIN course_makeup_special_attendance AS special_attendance
      ON special_attendance.course_makeup_assignment_id = assignment.id
    WHERE resolution.case_id = ? AND resolution.id <> ?
      AND COALESCE(normal_attendance.attendance_status, special_attendance.attendance_status) IN ('present', 'late')
    LIMIT 1`).bind(caseId, resolutionId).first<{ value: number }>();
  return Boolean(row?.value);
}

async function hasRecordedSpecialAttendance(
  env: WorkerEnv,
  input: { assignmentId?: string; specialOccurrenceId?: string },
): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS value
    FROM course_makeup_special_attendance AS attendance
    INNER JOIN course_makeup_assignment AS assignment
      ON assignment.id = attendance.course_makeup_assignment_id
    WHERE attendance.attendance_status IS NOT NULL
      AND (? = '' OR assignment.id = ?)
      AND (? = '' OR assignment.target_special_occurrence_id = ?)
    LIMIT 1`).bind(
    input.assignmentId ?? "", input.assignmentId ?? "",
    input.specialOccurrenceId ?? "", input.specialOccurrenceId ?? "",
  ).first<{ value: number }>();
  return Boolean(row?.value);
}

export async function cancelCourseMakeupAssignment(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: Record<string, unknown>,
  at = new Date(),
): Promise<void> {
  requireCapability(actor, "makeup.manage");
  const assignment = await activeAssignment(env, clean(input.assignmentId));
  if (assignment.targetKind === "special" && await hasRecordedSpecialAttendance(env, { assignmentId: assignment.assignmentId })) {
    throw new CourseMakeupError("attendance_recorded");
  }
  const local = localDateTime(at);
  if (assignment.targetLocalDate
    && (assignment.targetLocalDate < local.date
      || (assignment.targetLocalDate === local.date && (assignment.targetStartTime ?? "") <= local.time))) {
    throw new CourseMakeupError("conflict");
  }
  const time = now();
  const completedElsewhere = await caseHasCompletedOtherAttempt(env, assignment.caseId, assignment.resolutionId);
  await safeBatch(env, [
    env.DB.prepare(`UPDATE course_makeup_assignment SET status = 'cancelled',
      cancelled_at = ?, cancelled_by_staff_account_id = ?, cancellation_reason = 'teacher_reopened',
      updated_at = ? WHERE id = ? AND status = 'active'`).bind(time, actor.staffAccountId, time, assignment.assignmentId),
    env.DB.prepare(`UPDATE course_makeup_resolution SET status = 'invalidated',
      invalidated_at = ?, invalidated_by_staff_account_id = ?, invalidation_reason = 'assignment_cancelled',
      updated_at = ? WHERE id = ? AND status = 'active'`).bind(time, actor.staffAccountId, time, assignment.resolutionId),
    caseCurrentUpdate(env, assignment.caseId, null, completedElsewhere ? "resolved" : "open", time),
    audit(env, actor, "course_makeup_assignment_cancelled", "course_makeup_assignment", assignment.assignmentId, {
      sourceEnrollmentId: assignment.sourceEnrollmentId,
    }, assignment, time),
  ]);
}

export async function reconcileCourseMakeupCase(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: Record<string, unknown>,
): Promise<void> {
  requireCapability(actor, "makeup.manage");
  const caseId = clean(input.caseId);
  const note = optionalText(input.note);
  if (!note) throw new CourseMakeupError("invalid");
  const makeupCase = await env.DB.prepare(`SELECT id, current_resolution_id AS currentResolutionId,
      state, is_test AS isTest, test_run_id AS testRunId
    FROM course_makeup_case WHERE id = ? AND state = 'reconciliation'`).bind(caseId).first<CaseRow>();
  if (!makeupCase) throw new CourseMakeupError("not_found");
  const current = makeupCase.currentResolutionId ? await env.DB.prepare(`SELECT assignment.id AS assignmentId,
      COALESCE(normal_attendance.attendance_status, special_attendance.attendance_status) AS attendanceStatus
    FROM course_makeup_resolution AS resolution
    LEFT JOIN course_makeup_assignment AS assignment ON assignment.resolution_id = resolution.id AND assignment.status = 'active'
    LEFT JOIN course_makeup_attendance AS normal_attendance ON normal_attendance.course_makeup_assignment_id = assignment.id
    LEFT JOIN course_makeup_special_attendance AS special_attendance ON special_attendance.course_makeup_assignment_id = assignment.id
    WHERE resolution.id = ?`).bind(makeupCase.currentResolutionId).first<{
      assignmentId: string | null; attendanceStatus: "present" | "late" | "absent" | null;
    }>() : null;
  if (current?.assignmentId && !current.attendanceStatus) throw new CourseMakeupError("conflict");
  const time = now();
  await safeBatch(env, [
    caseCurrentUpdate(env, makeupCase.id, makeupCase.currentResolutionId, "resolved", time),
    audit(env, actor, "course_makeup_case_reconciled", "course_makeup_case", makeupCase.id, {
      note, currentResolutionId: makeupCase.currentResolutionId,
    }, makeupCase, time),
  ]);
}

export async function cancelSpecialCourseMakeupOccurrence(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: Record<string, unknown>,
  at = new Date(),
): Promise<void> {
  requireCapability(actor, "makeup.manage");
  const specialOccurrenceId = clean(input.specialOccurrenceId);
  const special = await env.DB.prepare(`SELECT id, curriculum_lesson_id AS curriculumLessonId,
    local_date AS localDate, start_time AS startTime, is_test AS isTest, test_run_id AS testRunId
    FROM course_makeup_special_occurrence WHERE id = ? AND status = 'active'`).bind(
    specialOccurrenceId,
  ).first<{ id: string; curriculumLessonId: string; localDate: string; startTime: string; isTest: number; testRunId: string | null }>();
  if (!special) throw new CourseMakeupError("not_found");
  if (await hasRecordedSpecialAttendance(env, { specialOccurrenceId })) {
    throw new CourseMakeupError("attendance_recorded");
  }
  const local = localDateTime(at);
  if (special.localDate < local.date || (special.localDate === local.date && special.startTime <= local.time)) {
    throw new CourseMakeupError("conflict");
  }
  const time = now();
  const affectedCases = await env.DB.prepare(`SELECT makeup_case.id AS caseId,
      makeup_case.current_resolution_id AS currentResolutionId, resolution.id AS resolutionId
    FROM course_makeup_case AS makeup_case
    INNER JOIN course_makeup_resolution AS resolution ON resolution.case_id = makeup_case.id
    INNER JOIN course_makeup_assignment AS assignment ON assignment.resolution_id = resolution.id
    WHERE assignment.target_special_occurrence_id = ? AND assignment.status = 'active'`).bind(
    specialOccurrenceId,
  ).all<{ caseId: string; currentResolutionId: string | null; resolutionId: string }>();
  const caseStatements = affectedCases.results
    .filter((entry) => entry.currentResolutionId === entry.resolutionId)
    .map((entry) => caseCurrentUpdate(env, entry.caseId, null, "open", time));
  await safeBatch(env, [
    env.DB.prepare(`UPDATE course_makeup_assignment SET status = 'cancelled',
      cancelled_at = ?, cancelled_by_staff_account_id = ?,
      cancellation_reason = 'special_occurrence_cancelled', updated_at = ?
      WHERE target_special_occurrence_id = ? AND status = 'active'`).bind(
      time, actor.staffAccountId, time, specialOccurrenceId,
    ),
    env.DB.prepare(`UPDATE course_makeup_resolution SET status = 'invalidated',
      invalidated_at = ?, invalidated_by_staff_account_id = ?,
      invalidation_reason = 'special_occurrence_cancelled', updated_at = ?
      WHERE status = 'active' AND id IN (
        SELECT resolution_id FROM course_makeup_assignment
        WHERE target_special_occurrence_id = ? AND status = 'cancelled'
          AND cancellation_reason = 'special_occurrence_cancelled'
          AND cancelled_at = ?
      )`).bind(time, actor.staffAccountId, time, specialOccurrenceId, time),
    env.DB.prepare(`UPDATE course_makeup_special_occurrence SET status = 'cancelled',
      cancelled_at = ?, cancelled_by_staff_account_id = ?, updated_at = ?
      WHERE id = ? AND status = 'active'`).bind(time, actor.staffAccountId, time, specialOccurrenceId),
    ...caseStatements,
    audit(env, actor, "course_makeup_special_cancelled", "course_makeup_special_occurrence", specialOccurrenceId, {
      curriculumLessonId: special.curriculumLessonId,
    }, special, time),
  ]);
}
