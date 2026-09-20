import type { D1PreparedStatement, WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

export const COURSE_ATTENDANCE_STATUSES = ["present", "late", "absent"] as const;
export type CourseAttendanceStatus = typeof COURSE_ATTENDANCE_STATUSES[number];

export class CourseAttendanceError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "invalid" | "future_occurrence" | "not_enrolled" | "makeup_attendance_recorded") {
    super("Course attendance operation failed.");
    this.name = "CourseAttendanceError";
  }
}

interface OccurrenceRow {
  occurrenceKind: "normal" | "special";
  slotId: string;
  specialOccurrenceId: string | null;
  classSessionId: string | null;
  curriculumLessonId: string;
  localDate: string;
  startTime: string;
  endTime: string;
  lessonSequence: number;
  lessonTitle: string;
  stageCode: string;
  offeringKind: "annual_course" | "summer_course" | "special_makeup";
  offeringTitle: string;
  classWeekday: string;
  holidayLabel: string | null;
  isTest: number;
  testRunId: string | null;
}

interface AttendanceRow {
  id: string;
  attendanceStatus: CourseAttendanceStatus | null;
  updatedAt: string;
}

interface AbsenceNoticeRow {
  id: string;
  status: "active" | "cancelled";
  note: string | null;
}

interface RosterRow {
  enrollmentId: string;
  studentId: string;
  surname: string;
  givenName: string;
  rosterKind: "ordinary" | "makeup";
  makeupAssignmentId: string | null;
  attendanceId: string | null;
  attendanceStatus: CourseAttendanceStatus | null;
  absenceNoticeId: string | null;
  absenceNoticeNote: string | null;
  sourceSlotId: string | null;
  sourceLocalDate: string | null;
  sourceStartTime: string | null;
  sourceEndTime: string | null;
  sourceLessonSequence: number | null;
  sourceLessonTitle: string | null;
  sourceStageCode: string | null;
  sourceWeekday: string | null;
}

interface AttendanceOccurrence extends OccurrenceRow {
  roster: RosterRow[];
}

function id(): string { return crypto.randomUUID(); }
function now(): string { return new Date().toISOString(); }

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function text(value: unknown, max = 600): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function optionalText(value: unknown, max = 600): string | null {
  return text(value, max) || null;
}

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
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

function localToday(at = new Date()): string {
  return localDateTime(at).date;
}

export function courseOccurrenceHasEnded(localDate: string, endTime: string, at = new Date()): boolean {
  const current = localDateTime(at);
  return localDate < current.date || (localDate === current.date && endTime <= current.time);
}

export function effectiveCourseAttendanceStatus(
  recordedStatus: CourseAttendanceStatus | null,
  occurrenceEnded: boolean,
): CourseAttendanceStatus | null {
  return recordedStatus ?? (occurrenceEnded ? "absent" : null);
}

function localDateBounds(value: string): { startsAt: string; endsAt: string } {
  // Mongolia no longer observes DST; course dates are explicitly Ulaanbaatar dates.
  return {
    startsAt: new Date(`${value}T00:00:00+08:00`).toISOString(),
    endsAt: new Date(`${value}T23:59:59.999+08:00`).toISOString(),
  };
}

function stageLabel(value: string): string {
  return ({ stage_1: "1-р шат", stage_2: "2-р шат", stage_3: "3-р шат" } as Record<string, string>)[value] ?? value;
}

function classLabel(occurrence: Pick<OccurrenceRow, "stageCode" | "offeringKind" | "offeringTitle" | "classWeekday" | "startTime" | "endTime">): string {
  if (occurrence.offeringKind === "special_makeup") return "Тусгай нөхөх хичээл";
  return occurrence.offeringKind === "annual_course"
    ? `${stageLabel(occurrence.stageCode)} · ${occurrence.classWeekday} ${occurrence.startTime}–${occurrence.endTime}`
    : `${occurrence.offeringTitle} · ${occurrence.startTime}–${occurrence.endTime}`;
}

function flags(source: Pick<OccurrenceRow, "isTest" | "testRunId">) {
  return { isTest: source.isTest, testRunId: source.testRunId };
}

function requireCapability(actor: StaffPrincipal, capability: "attendance.view" | "attendance.manage"): void {
  if (!hasStaffCapability(actor, capability)) throw new CourseAttendanceError("forbidden");
}

function audit(
  env: WorkerEnv,
  actor: StaffPrincipal,
  action: string,
  subjectType: string,
  subjectId: string,
  metadata: Record<string, unknown>,
  occurrence: Pick<OccurrenceRow, "isTest" | "testRunId">,
  occurredAt: string,
): D1PreparedStatement {
  const provenance = flags(occurrence);
  return env.DB.prepare(`INSERT INTO audit_event (
    id, occurred_at, actor_type, actor_ref, action, subject_type, subject_id,
    metadata_json, environment, is_test, test_run_id, created_at
  ) VALUES (?, ?, 'staff', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    id(), occurredAt, actor.staffAccountId, action, subjectType, subjectId,
    JSON.stringify(metadata), env.APP_ENV, provenance.isTest, provenance.testRunId, occurredAt,
  );
}

const OCCURRENCE_SELECT = `
  SELECT
    'normal' AS occurrenceKind,
    slot.id AS slotId,
    NULL AS specialOccurrenceId,
    class_session.id AS classSessionId,
    slot.curriculum_lesson_id AS curriculumLessonId,
    slot.local_date AS localDate,
    slot.start_time AS startTime,
    slot.end_time AS endTime,
    lesson.sequence_number AS lessonSequence,
    lesson.title AS lessonTitle,
    class_session.stage_code AS stageCode,
    offering.kind AS offeringKind,
    offering.title AS offeringTitle,
    COALESCE(class_meeting_rule.weekly_weekday, class_session.weekday) AS classWeekday,
    school_break.label AS holidayLabel,
    MAX(slot.is_test, class_session.is_test, offering.is_test) AS isTest,
    CASE WHEN slot.test_run_id IS NOT NULL THEN slot.test_run_id
      WHEN class_session.test_run_id IS NOT NULL THEN class_session.test_run_id
      ELSE offering.test_run_id END AS testRunId
  FROM class_calendar_slot AS slot
  INNER JOIN class_calendar_revision AS revision ON revision.id = slot.class_calendar_revision_id
  INNER JOIN class_calendar ON class_calendar.id = revision.class_calendar_id
  INNER JOIN class_session ON class_session.id = class_calendar.class_session_id
  INNER JOIN activity_offering AS offering ON offering.id = class_session.activity_offering_id
  INNER JOIN curriculum_lesson AS lesson ON lesson.id = slot.curriculum_lesson_id
  LEFT JOIN class_meeting_rule ON class_meeting_rule.class_session_id = class_session.id
  LEFT JOIN academic_year_break AS school_break
    ON school_break.academic_year_id = class_session.academic_year_id
    AND school_break.status = 'active'
    AND school_break.warn_on_overlap = 1
    AND offering.kind = 'annual_course'
    AND slot.local_date BETWEEN school_break.starts_on AND school_break.ends_on
  WHERE revision.status = 'published'
    AND slot.status = 'scheduled'
    AND offering.kind IN ('annual_course', 'summer_course')`;

const SPECIAL_OCCURRENCE_SELECT = `
  SELECT
    'special' AS occurrenceKind,
    special.id AS slotId,
    special.id AS specialOccurrenceId,
    NULL AS classSessionId,
    special.curriculum_lesson_id AS curriculumLessonId,
    special.local_date AS localDate,
    special.start_time AS startTime,
    special.end_time AS endTime,
    lesson.sequence_number AS lessonSequence,
    lesson.title AS lessonTitle,
    '' AS stageCode,
    'special_makeup' AS offeringKind,
    'Тусгай нөхөх хичээл' AS offeringTitle,
    '' AS classWeekday,
    NULL AS holidayLabel,
    special.is_test AS isTest,
    special.test_run_id AS testRunId
  FROM course_makeup_special_occurrence AS special
  INNER JOIN curriculum_lesson AS lesson ON lesson.id = special.curriculum_lesson_id
  WHERE special.status = 'active'`;

async function occurrenceForSlot(env: WorkerEnv, slotId: string): Promise<OccurrenceRow> {
  const normal = await env.DB.prepare(`${OCCURRENCE_SELECT} AND slot.id = ?
    GROUP BY slot.id`).bind(slotId).first<OccurrenceRow>();
  if (normal) return normal;
  const special = await env.DB.prepare(`${SPECIAL_OCCURRENCE_SELECT} AND special.id = ?`).bind(slotId).first<OccurrenceRow>();
  if (!special) throw new CourseAttendanceError("not_found");
  return special;
}

async function rosterForSpecialOccurrence(env: WorkerEnv, occurrence: OccurrenceRow): Promise<RosterRow[]> {
  if (!occurrence.specialOccurrenceId) throw new CourseAttendanceError("not_found");
  const rows = await env.DB.prepare(`
    SELECT source_enrollment.id AS enrollmentId, student.id AS studentId,
      student.surname AS surname, student.given_name AS givenName,
      'makeup' AS rosterKind, assignment.id AS makeupAssignmentId,
      special_attendance.id AS attendanceId,
      special_attendance.attendance_status AS attendanceStatus,
      NULL AS absenceNoticeId, NULL AS absenceNoticeNote,
      source_slot.id AS sourceSlotId,
      source_slot.local_date AS sourceLocalDate,
      source_slot.start_time AS sourceStartTime, source_slot.end_time AS sourceEndTime,
      source_lesson.sequence_number AS sourceLessonSequence,
      source_lesson.title AS sourceLessonTitle,
      source_class.stage_code AS sourceStageCode,
      COALESCE(source_meeting.weekly_weekday, source_class.weekday) AS sourceWeekday
    FROM course_makeup_assignment AS assignment
    INNER JOIN course_makeup_resolution AS resolution
      ON resolution.id = assignment.resolution_id
      AND resolution.status = 'active' AND resolution.decision = 'assigned'
    INNER JOIN enrollment AS source_enrollment ON source_enrollment.id = resolution.source_enrollment_id
    INNER JOIN student ON student.id = source_enrollment.student_id
    INNER JOIN class_session AS source_class ON source_class.id = resolution.source_class_session_id
    INNER JOIN curriculum_lesson AS source_lesson ON source_lesson.id = resolution.source_curriculum_lesson_id
    LEFT JOIN class_meeting_rule AS source_meeting ON source_meeting.class_session_id = source_class.id
    LEFT JOIN class_calendar AS source_calendar ON source_calendar.class_session_id = source_class.id
    LEFT JOIN class_calendar_revision AS source_revision
      ON source_revision.class_calendar_id = source_calendar.id AND source_revision.status = 'published'
    LEFT JOIN class_calendar_slot AS source_slot
      ON source_slot.class_calendar_revision_id = source_revision.id
      AND source_slot.curriculum_lesson_id = resolution.source_curriculum_lesson_id
      AND source_slot.status = 'scheduled'
    LEFT JOIN course_makeup_special_attendance AS special_attendance
      ON special_attendance.course_makeup_assignment_id = assignment.id
    WHERE assignment.status = 'active'
      AND assignment.target_kind = 'special'
      AND assignment.target_special_occurrence_id = ?
    ORDER BY student.surname COLLATE NOCASE, student.given_name COLLATE NOCASE, source_enrollment.id, assignment.id
  `).bind(occurrence.specialOccurrenceId).all<RosterRow>();
  const seenStudents = new Set<string>();
  return rows.results.filter((entry) => {
    if (seenStudents.has(entry.studentId)) return false;
    seenStudents.add(entry.studentId);
    return true;
  });
}

async function rosterForOccurrence(env: WorkerEnv, occurrence: OccurrenceRow): Promise<RosterRow[]> {
  if (occurrence.occurrenceKind === "special") return rosterForSpecialOccurrence(env, occurrence);
  if (!occurrence.classSessionId) throw new CourseAttendanceError("not_found");
  const { startsAt, endsAt } = localDateBounds(occurrence.localDate);
  const ordinary = await env.DB.prepare(`
    SELECT enrollment.id AS enrollmentId, student.id AS studentId,
      student.surname AS surname, student.given_name AS givenName,
      'ordinary' AS rosterKind, NULL AS makeupAssignmentId,
      attendance.id AS attendanceId, attendance.attendance_status AS attendanceStatus,
      absence_notice.id AS absenceNoticeId, absence_notice.note AS absenceNoticeNote,
      NULL AS sourceSlotId,
      NULL AS sourceLocalDate, NULL AS sourceStartTime, NULL AS sourceEndTime,
      NULL AS sourceLessonSequence, NULL AS sourceLessonTitle,
      NULL AS sourceStageCode, NULL AS sourceWeekday
    FROM enrollment
    INNER JOIN student ON student.id = enrollment.student_id
    LEFT JOIN course_attendance AS attendance
      ON attendance.enrollment_id = enrollment.id
      AND attendance.class_session_id = ?
      AND attendance.curriculum_lesson_id = ?
    LEFT JOIN course_absence_notice AS absence_notice
      ON absence_notice.enrollment_id = enrollment.id
      AND absence_notice.class_session_id = ?
      AND absence_notice.curriculum_lesson_id = ?
      AND absence_notice.status = 'active'
    WHERE enrollment.class_session_id = ?
      AND (
        (
          enrollment.confirmed_at IS NOT NULL
          AND enrollment.confirmed_at <= ?
          AND (enrollment.cancelled_at IS NULL OR enrollment.cancelled_at >= ?)
          AND (enrollment.transferred_out_at IS NULL OR enrollment.transferred_out_at >= ?)
          AND enrollment.status IN ('confirmed', 'completed', 'cancelled')
        )
        OR attendance.id IS NOT NULL
        OR absence_notice.id IS NOT NULL
      )
    ORDER BY student.surname COLLATE NOCASE, student.given_name COLLATE NOCASE, enrollment.id
  `).bind(
    occurrence.classSessionId, occurrence.curriculumLessonId,
    occurrence.classSessionId, occurrence.curriculumLessonId,
    occurrence.classSessionId, endsAt, startsAt, startsAt,
  ).all<RosterRow>();
  const makeup = await env.DB.prepare(`
    SELECT source_enrollment.id AS enrollmentId, student.id AS studentId,
      student.surname AS surname, student.given_name AS givenName,
      'makeup' AS rosterKind, assignment.id AS makeupAssignmentId,
      makeup_attendance.id AS attendanceId,
      makeup_attendance.attendance_status AS attendanceStatus,
      NULL AS absenceNoticeId, NULL AS absenceNoticeNote,
      source_slot.id AS sourceSlotId,
      source_slot.local_date AS sourceLocalDate,
      source_slot.start_time AS sourceStartTime, source_slot.end_time AS sourceEndTime,
      source_lesson.sequence_number AS sourceLessonSequence,
      source_lesson.title AS sourceLessonTitle,
      source_class.stage_code AS sourceStageCode,
      COALESCE(source_meeting.weekly_weekday, source_class.weekday) AS sourceWeekday
    FROM course_makeup_assignment AS assignment
    INNER JOIN course_makeup_resolution AS resolution
      ON resolution.id = assignment.resolution_id
      AND resolution.status = 'active' AND resolution.decision = 'assigned'
    INNER JOIN enrollment AS source_enrollment ON source_enrollment.id = resolution.source_enrollment_id
    INNER JOIN student ON student.id = source_enrollment.student_id
    INNER JOIN class_session AS source_class ON source_class.id = resolution.source_class_session_id
    INNER JOIN curriculum_lesson AS source_lesson ON source_lesson.id = resolution.source_curriculum_lesson_id
    LEFT JOIN class_meeting_rule AS source_meeting ON source_meeting.class_session_id = source_class.id
    LEFT JOIN class_calendar AS source_calendar ON source_calendar.class_session_id = source_class.id
    LEFT JOIN class_calendar_revision AS source_revision
      ON source_revision.class_calendar_id = source_calendar.id AND source_revision.status = 'published'
    LEFT JOIN class_calendar_slot AS source_slot
      ON source_slot.class_calendar_revision_id = source_revision.id
      AND source_slot.curriculum_lesson_id = resolution.source_curriculum_lesson_id
      AND source_slot.status = 'scheduled'
    LEFT JOIN course_makeup_attendance AS makeup_attendance
      ON makeup_attendance.course_makeup_assignment_id = assignment.id
    WHERE assignment.status = 'active'
      AND assignment.target_kind = 'normal_class'
      AND assignment.target_class_session_id = ?
      AND assignment.target_curriculum_lesson_id = ?
    ORDER BY student.surname COLLATE NOCASE, student.given_name COLLATE NOCASE, source_enrollment.id
  `).bind(occurrence.classSessionId, occurrence.curriculumLessonId).all<RosterRow>();
  const ordinaryStudentIds = new Set(ordinary.results.map((entry) => entry.studentId));
  return [...ordinary.results, ...makeup.results.filter((entry) => !ordinaryStudentIds.has(entry.studentId))]
    .sort((left, right) => `${left.surname}\u0000${left.givenName}\u0000${left.enrollmentId}`.localeCompare(`${right.surname}\u0000${right.givenName}\u0000${right.enrollmentId}`));
}

function serializeOccurrence(occurrence: AttendanceOccurrence, at: Date) {
  const occurrenceEnded = courseOccurrenceHasEnded(occurrence.localDate, occurrence.endTime, at);
  const roster = occurrence.roster.map((entry) => ({
    enrollmentId: entry.enrollmentId,
    studentId: entry.studentId,
    displayName: `${entry.surname} ${entry.givenName}`.trim(),
    attendanceKind: entry.rosterKind,
    makeupAssignmentId: entry.makeupAssignmentId,
    makeupSource: entry.rosterKind === "makeup" ? {
      slotId: entry.sourceSlotId,
      localDate: entry.sourceLocalDate,
      startTime: entry.sourceStartTime,
      endTime: entry.sourceEndTime,
      lessonSequence: entry.sourceLessonSequence,
      lessonTitle: entry.sourceLessonTitle,
      classLabel: `${entry.sourceStageCode ? stageLabel(entry.sourceStageCode) : ""}${entry.sourceWeekday ? ` · ${entry.sourceWeekday}` : ""}${entry.sourceStartTime && entry.sourceEndTime ? ` ${entry.sourceStartTime}–${entry.sourceEndTime}` : ""}`.trim(),
    } : null,
    recordedAttendanceStatus: entry.attendanceStatus,
    effectiveAttendanceStatus: effectiveCourseAttendanceStatus(entry.attendanceStatus, occurrenceEnded),
    hasAbsenceNotice: Boolean(entry.absenceNoticeId),
    absenceNoticeNote: entry.absenceNoticeNote,
  }));
  const markedCount = roster.filter((entry) => entry.recordedAttendanceStatus !== null).length;
  const attendanceComplete = roster.length > 0 && markedCount === roster.length;
  return {
    slotId: occurrence.slotId,
    occurrenceKind: occurrence.occurrenceKind,
    specialOccurrenceId: occurrence.specialOccurrenceId,
    classSessionId: occurrence.classSessionId,
    localDate: occurrence.localDate,
    startTime: occurrence.startTime,
    endTime: occurrence.endTime,
    classLabel: classLabel(occurrence),
    offeringTitle: occurrence.offeringTitle,
    lessonSequence: occurrence.lessonSequence,
    lessonTitle: occurrence.lessonTitle,
    holidayLabel: occurrence.holidayLabel,
    roster,
    markedCount,
    progressCount: markedCount,
    rosterCount: roster.length,
    attendanceComplete,
    occurrenceEnded,
  };
}

async function selectedOccurrenceWithRoster(env: WorkerEnv, slotId: string): Promise<AttendanceOccurrence> {
  const occurrence = await occurrenceForSlot(env, slotId);
  return { ...occurrence, roster: await rosterForOccurrence(env, occurrence) };
}

async function occurrenceSummary(env: WorkerEnv, occurrence: OccurrenceRow, at: Date) {
  const roster = await rosterForOccurrence(env, occurrence);
  const markedCount = roster.filter((entry) => entry.attendanceStatus !== null).length;
  const occurrenceEnded = courseOccurrenceHasEnded(occurrence.localDate, occurrence.endTime, at);
  return {
    rosterCount: roster.length,
    markedCount,
    progressCount: markedCount,
    attendanceComplete: roster.length > 0 && markedCount === roster.length,
    occurrenceEnded,
  };
}

export async function getCourseAttendanceDay(
  env: WorkerEnv,
  actor: StaffPrincipal,
  localDate = localToday(),
  selectedSlotId = "",
  at = new Date(),
) {
  requireCapability(actor, "attendance.view");
  if (!validDate(localDate)) throw new CourseAttendanceError("invalid");
  const result = await env.DB.prepare(`${OCCURRENCE_SELECT} AND slot.local_date = ?
    GROUP BY slot.id
    ORDER BY slot.start_time, offering.title, class_session.stage_code, slot.id`).bind(localDate).all<OccurrenceRow>();
  const specials = await env.DB.prepare(`${SPECIAL_OCCURRENCE_SELECT} AND special.local_date = ?
    ORDER BY special.start_time, special.id`).bind(localDate).all<OccurrenceRow>();
  const rows = [...result.results, ...specials.results]
    .sort((left, right) => `${left.startTime}\u0000${left.occurrenceKind}\u0000${left.slotId}`.localeCompare(`${right.startTime}\u0000${right.occurrenceKind}\u0000${right.slotId}`));
  const occurrences = await Promise.all(rows.map(async (occurrence) => ({
    slotId: occurrence.slotId,
    occurrenceKind: occurrence.occurrenceKind,
    classSessionId: occurrence.classSessionId,
    startTime: occurrence.startTime,
    endTime: occurrence.endTime,
    classLabel: classLabel(occurrence),
    offeringTitle: occurrence.offeringTitle,
    lessonSequence: occurrence.lessonSequence,
    lessonTitle: occurrence.lessonTitle,
    holidayLabel: occurrence.holidayLabel,
    ...await occurrenceSummary(env, occurrence, at),
  })));
  const resolvedSlotId = selectedSlotId || rows[0]?.slotId || "";
  const selected = resolvedSlotId && rows.some((occurrence) => occurrence.slotId === resolvedSlotId)
    ? await selectedOccurrenceWithRoster(env, resolvedSlotId)
    : null;
  return {
    localDate,
    today: localToday(at),
    occurrences,
    selected: selected ? serializeOccurrence(selected, at) : null,
  };
}

function assertAttendanceStatus(value: unknown): asserts value is CourseAttendanceStatus {
  if (!COURSE_ATTENDANCE_STATUSES.includes(value as CourseAttendanceStatus)) throw new CourseAttendanceError("invalid");
}

function assertNotFuture(occurrence: OccurrenceRow): void {
  if (occurrence.localDate > localToday()) throw new CourseAttendanceError("future_occurrence");
}

async function rosterEntryForEnrollment(
  env: WorkerEnv,
  occurrence: OccurrenceRow,
  enrollmentId: string,
  makeupAssignmentId = "",
): Promise<RosterRow> {
  const roster = await rosterForOccurrence(env, occurrence);
  const entry = roster.find((candidate) => candidate.enrollmentId === enrollmentId
    && (makeupAssignmentId ? candidate.makeupAssignmentId === makeupAssignmentId : candidate.rosterKind === "ordinary"));
  if (!entry) throw new CourseAttendanceError("not_enrolled");
  return entry;
}

async function attendanceForOccurrence(env: WorkerEnv, occurrence: OccurrenceRow, enrollmentId: string): Promise<AttendanceRow | null> {
  if (!occurrence.classSessionId) throw new CourseAttendanceError("not_found");
  return env.DB.prepare(`SELECT id, attendance_status AS attendanceStatus, updated_at AS updatedAt
    FROM course_attendance
    WHERE enrollment_id = ? AND class_session_id = ? AND curriculum_lesson_id = ?`).bind(
    enrollmentId, occurrence.classSessionId, occurrence.curriculumLessonId,
  ).first<AttendanceRow>();
}

async function makeupAttendanceForAssignment(
  env: WorkerEnv,
  assignmentId: string,
  occurrence: OccurrenceRow,
): Promise<AttendanceRow | null> {
  const table = occurrence.occurrenceKind === "special"
    ? "course_makeup_special_attendance"
    : "course_makeup_attendance";
  return env.DB.prepare(`SELECT id, attendance_status AS attendanceStatus, updated_at AS updatedAt
    FROM ${table} WHERE course_makeup_assignment_id = ?`).bind(assignmentId).first<AttendanceRow>();
}

function makeupAttendanceStatements(
  env: WorkerEnv,
  actor: StaffPrincipal,
  occurrence: OccurrenceRow,
  entry: RosterRow,
  status: CourseAttendanceStatus | null,
  existing: AttendanceRow | null,
  time: string,
): D1PreparedStatement[] {
  if (!entry.makeupAssignmentId) throw new CourseAttendanceError("not_enrolled");
  if (occurrence.occurrenceKind === "special") {
    if (!occurrence.specialOccurrenceId) throw new CourseAttendanceError("not_found");
    const attendanceId = existing?.id ?? id();
    const provenance = flags(occurrence);
    const statements: D1PreparedStatement[] = [];
    if (existing) {
      statements.push(env.DB.prepare(`UPDATE course_makeup_special_attendance
        SET attendance_status = ?, special_occurrence_id = ?, scheduled_local_date = ?,
          updated_at = ?, updated_by_staff_account_id = ?
        WHERE id = ?`).bind(
        status, occurrence.specialOccurrenceId, occurrence.localDate, time, actor.staffAccountId, attendanceId,
      ));
    } else {
      statements.push(env.DB.prepare(`INSERT INTO course_makeup_special_attendance (
        id, course_makeup_assignment_id, special_occurrence_id, attendance_status,
        scheduled_local_date, first_recorded_at, updated_at, recorded_by_staff_account_id,
        updated_by_staff_account_id, is_test, test_run_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        attendanceId, entry.makeupAssignmentId, occurrence.specialOccurrenceId, status,
        occurrence.localDate, time, time, actor.staffAccountId, actor.staffAccountId,
        provenance.isTest, provenance.testRunId, time,
      ));
    }
    statements.push(
      env.DB.prepare(`INSERT INTO course_makeup_special_attendance_change (
        id, course_makeup_special_attendance_id, previous_status, new_status,
        changed_by_staff_account_id, changed_at, is_test, test_run_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        id(), attendanceId, existing?.attendanceStatus ?? null, status,
        actor.staffAccountId, time, provenance.isTest, provenance.testRunId, time,
      ),
      audit(env, actor, existing?.attendanceStatus != null
        ? "course_makeup_special_attendance_corrected" : "course_makeup_special_attendance_recorded",
      "course_makeup_special_attendance", attendanceId, {
        assignmentId: entry.makeupAssignmentId,
        sourceEnrollmentId: entry.enrollmentId,
        specialOccurrenceId: occurrence.specialOccurrenceId,
        curriculumLessonId: occurrence.curriculumLessonId,
        from: existing?.attendanceStatus ?? null,
        to: status,
      }, occurrence, time),
    );
    return statements;
  }
  const attendanceId = existing?.id ?? id();
  const provenance = flags(occurrence);
  const statements: D1PreparedStatement[] = [];
  if (existing) {
    statements.push(env.DB.prepare(`UPDATE course_makeup_attendance
      SET attendance_status = ?, recorded_calendar_slot_id = ?, scheduled_local_date = ?,
        updated_at = ?, updated_by_staff_account_id = ?
      WHERE id = ?`).bind(
      status, occurrence.slotId, occurrence.localDate, time, actor.staffAccountId, attendanceId,
    ));
  } else {
    statements.push(env.DB.prepare(`INSERT INTO course_makeup_attendance (
      id, course_makeup_assignment_id, attendance_status, recorded_calendar_slot_id,
      scheduled_local_date, first_recorded_at, updated_at, recorded_by_staff_account_id,
      updated_by_staff_account_id, is_test, test_run_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      attendanceId, entry.makeupAssignmentId, status, occurrence.slotId,
      occurrence.localDate, time, time, actor.staffAccountId, actor.staffAccountId,
      provenance.isTest, provenance.testRunId, time,
    ));
  }
  statements.push(
    env.DB.prepare(`INSERT INTO course_makeup_attendance_change (
      id, course_makeup_attendance_id, previous_status, new_status,
      changed_by_staff_account_id, changed_at, is_test, test_run_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      id(), attendanceId, existing?.attendanceStatus ?? null, status,
      actor.staffAccountId, time, provenance.isTest, provenance.testRunId, time,
    ),
    audit(env, actor, existing?.attendanceStatus != null
      ? "course_makeup_attendance_corrected" : "course_makeup_attendance_recorded",
    "course_makeup_attendance", attendanceId, {
      assignmentId: entry.makeupAssignmentId,
      sourceEnrollmentId: entry.enrollmentId,
      targetClassSessionId: occurrence.classSessionId,
      curriculumLessonId: occurrence.curriculumLessonId,
      from: existing?.attendanceStatus ?? null,
      to: status,
    }, occurrence, time),
  );
  return statements;
}

function invalidateActiveMakeupStatements(
  env: WorkerEnv,
  actor: StaffPrincipal,
  occurrence: OccurrenceRow,
  enrollmentId: string,
  time: string,
): D1PreparedStatement[] {
  if (!occurrence.classSessionId) throw new CourseAttendanceError("not_found");
  return [
    env.DB.prepare(`UPDATE course_makeup_assignment
      SET status = 'cancelled', cancelled_at = ?, cancelled_by_staff_account_id = ?,
        cancellation_reason = 'source_attendance_corrected', updated_at = ?
      WHERE status = 'active' AND resolution_id IN (
        SELECT id FROM course_makeup_resolution
        WHERE source_enrollment_id = ? AND source_class_session_id = ?
          AND source_curriculum_lesson_id = ? AND status = 'active'
      )`).bind(
      time, actor.staffAccountId, time,
      enrollmentId, occurrence.classSessionId, occurrence.curriculumLessonId,
    ),
    env.DB.prepare(`UPDATE course_makeup_resolution
      SET status = 'invalidated', invalidated_at = ?, invalidated_by_staff_account_id = ?,
        invalidation_reason = 'source_attendance_corrected', updated_at = ?
      WHERE source_enrollment_id = ? AND source_class_session_id = ?
        AND source_curriculum_lesson_id = ? AND status = 'active'`).bind(
      time, actor.staffAccountId, time,
      enrollmentId, occurrence.classSessionId, occurrence.curriculumLessonId,
    ),
  ];
}

async function assertSourceMakeupMayBeInvalidated(
  env: WorkerEnv,
  occurrence: OccurrenceRow,
  enrollmentId: string,
): Promise<void> {
  if (!occurrence.classSessionId) throw new CourseAttendanceError("not_found");
  const protectedSpecial = await env.DB.prepare(`SELECT 1 AS value
    FROM course_makeup_special_attendance AS attendance
    INNER JOIN course_makeup_assignment AS assignment
      ON assignment.id = attendance.course_makeup_assignment_id
    INNER JOIN course_makeup_resolution AS resolution
      ON resolution.id = assignment.resolution_id
    WHERE assignment.status = 'active'
      AND assignment.target_kind = 'special'
      AND resolution.status = 'active'
      AND resolution.source_enrollment_id = ?
      AND resolution.source_class_session_id = ?
      AND resolution.source_curriculum_lesson_id = ?
      AND attendance.attendance_status IS NOT NULL
    LIMIT 1`).bind(
    enrollmentId, occurrence.classSessionId, occurrence.curriculumLessonId,
  ).first<{ value: number }>();
  if (protectedSpecial) throw new CourseAttendanceError("makeup_attendance_recorded");
}

export async function recordCourseAttendance(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { slotId: string; enrollmentId: string; makeupAssignmentId?: unknown; status: unknown },
): Promise<{ changed: boolean; recordedAttendanceStatus: CourseAttendanceStatus }> {
  requireCapability(actor, "attendance.manage");
  assertAttendanceStatus(input.status);
  const occurrence = await occurrenceForSlot(env, text(input.slotId, 120));
  assertNotFuture(occurrence);
  const entry = await rosterEntryForEnrollment(env, occurrence, text(input.enrollmentId, 120), text(input.makeupAssignmentId, 120));
  if (entry.rosterKind === "makeup") {
    const existing = await makeupAttendanceForAssignment(env, entry.makeupAssignmentId!, occurrence);
    if (existing?.attendanceStatus === input.status) return { changed: false, recordedAttendanceStatus: input.status };
    const time = now();
    await env.DB.batch(makeupAttendanceStatements(env, actor, occurrence, entry, input.status, existing, time));
    return { changed: true, recordedAttendanceStatus: input.status };
  }
  const existing = await attendanceForOccurrence(env, occurrence, input.enrollmentId);
  if (existing?.attendanceStatus === input.status) return { changed: false, recordedAttendanceStatus: input.status };
  if (input.status === "present" || input.status === "late") {
    await assertSourceMakeupMayBeInvalidated(env, occurrence, input.enrollmentId);
  }
  const time = now();
  const provenance = flags(occurrence);
  const attendanceId = existing?.id ?? id();
  const statements: D1PreparedStatement[] = [];
  if (existing) {
    statements.push(env.DB.prepare(`UPDATE course_attendance
      SET attendance_status = ?, recorded_calendar_slot_id = ?, scheduled_local_date = ?,
        updated_at = ?, updated_by_staff_account_id = ?
      WHERE id = ?`).bind(input.status, occurrence.slotId, occurrence.localDate, time, actor.staffAccountId, attendanceId));
  } else {
    statements.push(env.DB.prepare(`INSERT INTO course_attendance (
      id, enrollment_id, class_session_id, curriculum_lesson_id, attendance_status,
      recorded_calendar_slot_id, scheduled_local_date, first_recorded_at, updated_at,
      recorded_by_staff_account_id, updated_by_staff_account_id, is_test, test_run_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      attendanceId, input.enrollmentId, occurrence.classSessionId, occurrence.curriculumLessonId, input.status,
      occurrence.slotId, occurrence.localDate, time, time, actor.staffAccountId, actor.staffAccountId,
      provenance.isTest, provenance.testRunId, time,
    ));
  }
  statements.push(
    env.DB.prepare(`INSERT INTO course_attendance_change (
      id, course_attendance_id, previous_status, new_status, changed_by_staff_account_id,
      changed_at, is_test, test_run_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      id(), attendanceId, existing?.attendanceStatus ?? null, input.status, actor.staffAccountId,
      time, provenance.isTest, provenance.testRunId, time,
    ),
  );
  if (input.status === "present" || input.status === "late") {
    statements.push(...invalidateActiveMakeupStatements(env, actor, occurrence, input.enrollmentId, time));
  }
  statements.push(
    audit(env, actor, existing?.attendanceStatus ? "course_attendance_corrected" : "course_attendance_recorded", "course_attendance", attendanceId, {
      classSessionId: occurrence.classSessionId, curriculumLessonId: occurrence.curriculumLessonId,
      from: existing?.attendanceStatus ?? null, to: input.status,
    }, occurrence, time),
  );
  await env.DB.batch(statements);
  return { changed: true, recordedAttendanceStatus: input.status };
}

export async function clearCourseAttendance(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { slotId: string; enrollmentId: string; makeupAssignmentId?: unknown },
): Promise<{ changed: boolean; recordedAttendanceStatus: null }> {
  requireCapability(actor, "attendance.manage");
  const occurrence = await occurrenceForSlot(env, text(input.slotId, 120));
  assertNotFuture(occurrence);
  const entry = await rosterEntryForEnrollment(env, occurrence, text(input.enrollmentId, 120), text(input.makeupAssignmentId, 120));
  if (entry.rosterKind === "makeup") {
    const existing = await makeupAttendanceForAssignment(env, entry.makeupAssignmentId!, occurrence);
    if (!existing?.attendanceStatus) return { changed: false, recordedAttendanceStatus: null };
    const time = now();
    await env.DB.batch(makeupAttendanceStatements(env, actor, occurrence, entry, null, existing, time));
    return { changed: true, recordedAttendanceStatus: null };
  }
  const existing = await attendanceForOccurrence(env, occurrence, input.enrollmentId);
  if (!existing?.attendanceStatus) return { changed: false, recordedAttendanceStatus: null };
  const time = now();
  const provenance = flags(occurrence);
  await env.DB.batch([
    env.DB.prepare(`UPDATE course_attendance
      SET attendance_status = NULL, recorded_calendar_slot_id = ?, scheduled_local_date = ?,
        updated_at = ?, updated_by_staff_account_id = ? WHERE id = ?`).bind(
      occurrence.slotId, occurrence.localDate, time, actor.staffAccountId, existing.id,
    ),
    env.DB.prepare(`INSERT INTO course_attendance_change (
      id, course_attendance_id, previous_status, new_status, changed_by_staff_account_id,
      changed_at, is_test, test_run_id, created_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`).bind(
      id(), existing.id, existing.attendanceStatus, actor.staffAccountId, time,
      provenance.isTest, provenance.testRunId, time,
    ),
    audit(env, actor, "course_attendance_cleared", "course_attendance", existing.id, {
      classSessionId: occurrence.classSessionId, curriculumLessonId: occurrence.curriculumLessonId,
      from: existing.attendanceStatus,
    }, occurrence, time),
  ]);
  return { changed: true, recordedAttendanceStatus: null };
}

export async function markUnmarkedRosterPresent(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { slotId: string },
): Promise<{ markedCount: number }> {
  requireCapability(actor, "attendance.manage");
  const occurrence = await occurrenceForSlot(env, text(input.slotId, 120));
  assertNotFuture(occurrence);
  const roster = await rosterForOccurrence(env, occurrence);
  const unmarked = roster.filter((entry) => entry.attendanceStatus === null);
  if (!unmarked.length) return { markedCount: 0 };
  const time = now();
  const provenance = flags(occurrence);
  const statements: D1PreparedStatement[] = [];
  for (const entry of unmarked) {
    if (entry.rosterKind === "makeup") {
      const existing = await makeupAttendanceForAssignment(env, entry.makeupAssignmentId!, occurrence);
      statements.push(...makeupAttendanceStatements(env, actor, occurrence, entry, "present", existing, time));
      continue;
    }
    await assertSourceMakeupMayBeInvalidated(env, occurrence, entry.enrollmentId);
    const attendanceId = entry.attendanceId ?? id();
    if (entry.attendanceId) {
      statements.push(env.DB.prepare(`UPDATE course_attendance
        SET attendance_status = 'present', recorded_calendar_slot_id = ?, scheduled_local_date = ?,
          updated_at = ?, updated_by_staff_account_id = ?
        WHERE id = ? AND attendance_status IS NULL`).bind(
        occurrence.slotId, occurrence.localDate, time, actor.staffAccountId, attendanceId,
      ));
    } else {
      statements.push(env.DB.prepare(`INSERT INTO course_attendance (
        id, enrollment_id, class_session_id, curriculum_lesson_id, attendance_status,
        recorded_calendar_slot_id, scheduled_local_date, first_recorded_at, updated_at,
        recorded_by_staff_account_id, updated_by_staff_account_id, is_test, test_run_id, created_at
      ) VALUES (?, ?, ?, ?, 'present', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        attendanceId, entry.enrollmentId, occurrence.classSessionId, occurrence.curriculumLessonId,
        occurrence.slotId, occurrence.localDate, time, time, actor.staffAccountId, actor.staffAccountId,
        provenance.isTest, provenance.testRunId, time,
      ));
    }
    statements.push(env.DB.prepare(`INSERT INTO course_attendance_change (
      id, course_attendance_id, previous_status, new_status, changed_by_staff_account_id,
      changed_at, is_test, test_run_id, created_at
    ) VALUES (?, ?, NULL, 'present', ?, ?, ?, ?, ?)`).bind(
      id(), attendanceId, actor.staffAccountId, time, provenance.isTest, provenance.testRunId, time,
    ));
    statements.push(...invalidateActiveMakeupStatements(env, actor, occurrence, entry.enrollmentId, time));
  }
  statements.push(audit(env, actor, "course_attendance_bulk_present", "class_calendar_slot", occurrence.slotId, {
    classSessionId: occurrence.classSessionId,
    curriculumLessonId: occurrence.curriculumLessonId,
    markedCount: unmarked.length,
  }, occurrence, time));
  await env.DB.batch(statements);
  return { markedCount: unmarked.length };
}

async function absenceNoticeForOccurrence(env: WorkerEnv, occurrence: OccurrenceRow, enrollmentId: string): Promise<AbsenceNoticeRow | null> {
  if (!occurrence.classSessionId) throw new CourseAttendanceError("not_found");
  return env.DB.prepare(`SELECT id, status, note FROM course_absence_notice
    WHERE enrollment_id = ? AND class_session_id = ? AND curriculum_lesson_id = ?`).bind(
    enrollmentId, occurrence.classSessionId, occurrence.curriculumLessonId,
  ).first<AbsenceNoticeRow>();
}

function assertNoticeDate(occurrence: OccurrenceRow): void {
  if (occurrence.localDate < localToday()) throw new CourseAttendanceError("invalid");
}

export async function saveCourseAbsenceNotice(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { slotId: string; enrollmentId: string; note?: unknown },
): Promise<{ changed: boolean }> {
  requireCapability(actor, "attendance.manage");
  const occurrence = await occurrenceForSlot(env, text(input.slotId, 120));
  assertNoticeDate(occurrence);
  await rosterEntryForEnrollment(env, occurrence, text(input.enrollmentId, 120));
  const note = optionalText(input.note);
  const existing = await absenceNoticeForOccurrence(env, occurrence, input.enrollmentId);
  if (existing?.status === "active" && existing.note === note) return { changed: false };
  const time = now();
  const provenance = flags(occurrence);
  const noticeId = existing?.id ?? id();
  const statements: D1PreparedStatement[] = [];
  if (existing) {
    statements.push(env.DB.prepare(`UPDATE course_absence_notice
      SET status = 'active', note = ?, recorded_calendar_slot_id = ?, scheduled_local_date = ?,
        updated_by_staff_account_id = ?, updated_at = ?, cancelled_at = NULL,
        cancelled_by_staff_account_id = NULL
      WHERE id = ?`).bind(note, occurrence.slotId, occurrence.localDate, actor.staffAccountId, time, noticeId));
  } else {
    statements.push(env.DB.prepare(`INSERT INTO course_absence_notice (
      id, enrollment_id, class_session_id, curriculum_lesson_id, notice_source, status, note,
      recorded_calendar_slot_id, scheduled_local_date, created_by_staff_account_id,
      updated_by_staff_account_id, created_at, updated_at, is_test, test_run_id
    ) VALUES (?, ?, ?, ?, 'staff_manual', 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      noticeId, input.enrollmentId, occurrence.classSessionId, occurrence.curriculumLessonId, note,
      occurrence.slotId, occurrence.localDate, actor.staffAccountId, actor.staffAccountId,
      time, time, provenance.isTest, provenance.testRunId,
    ));
  }
  statements.push(
    env.DB.prepare(`INSERT INTO course_absence_notice_change (
      id, course_absence_notice_id, previous_status, new_status, previous_note, new_note,
      changed_by_staff_account_id, changed_at, is_test, test_run_id, created_at
    ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`).bind(
      id(), noticeId, existing?.status ?? null, existing?.note ?? null, note,
      actor.staffAccountId, time, provenance.isTest, provenance.testRunId, time,
    ),
    audit(env, actor, existing ? "course_absence_notice_updated" : "course_absence_notice_recorded", "course_absence_notice", noticeId, {
      classSessionId: occurrence.classSessionId, curriculumLessonId: occurrence.curriculumLessonId,
    }, occurrence, time),
  );
  await env.DB.batch(statements);
  return { changed: true };
}

export async function cancelCourseAbsenceNotice(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { slotId: string; enrollmentId: string },
): Promise<{ changed: boolean }> {
  requireCapability(actor, "attendance.manage");
  const occurrence = await occurrenceForSlot(env, text(input.slotId, 120));
  assertNoticeDate(occurrence);
  await rosterEntryForEnrollment(env, occurrence, text(input.enrollmentId, 120));
  const existing = await absenceNoticeForOccurrence(env, occurrence, input.enrollmentId);
  if (!existing || existing.status !== "active") return { changed: false };
  const time = now();
  const provenance = flags(occurrence);
  await env.DB.batch([
    env.DB.prepare(`UPDATE course_absence_notice
      SET status = 'cancelled', updated_by_staff_account_id = ?, updated_at = ?,
        cancelled_at = ?, cancelled_by_staff_account_id = ? WHERE id = ?`).bind(
      actor.staffAccountId, time, time, actor.staffAccountId, existing.id,
    ),
    env.DB.prepare(`INSERT INTO course_absence_notice_change (
      id, course_absence_notice_id, previous_status, new_status, previous_note, new_note,
      changed_by_staff_account_id, changed_at, is_test, test_run_id, created_at
    ) VALUES (?, ?, 'active', 'cancelled', ?, ?, ?, ?, ?, ?, ?)`).bind(
      id(), existing.id, existing.note, existing.note, actor.staffAccountId, time,
      provenance.isTest, provenance.testRunId, time,
    ),
    audit(env, actor, "course_absence_notice_cancelled", "course_absence_notice", existing.id, {
      classSessionId: occurrence.classSessionId, curriculumLessonId: occurrence.curriculumLessonId,
    }, occurrence, time),
  ]);
  return { changed: true };
}

export async function attendanceProtectedThroughSequence(env: WorkerEnv, classSessionId: string, programId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COALESCE(MAX(sequence_number), 0) AS value FROM (
    SELECT lesson.sequence_number
    FROM course_attendance AS attendance
    INNER JOIN curriculum_lesson AS lesson ON lesson.id = attendance.curriculum_lesson_id
    WHERE attendance.class_session_id = ?
      AND attendance.attendance_status IS NOT NULL
      AND lesson.curriculum_program_id = ?
    UNION ALL
    SELECT lesson.sequence_number
    FROM course_makeup_attendance AS attendance
    INNER JOIN course_makeup_assignment AS assignment
      ON assignment.id = attendance.course_makeup_assignment_id
    INNER JOIN course_makeup_resolution AS resolution
      ON resolution.id = assignment.resolution_id
    INNER JOIN curriculum_lesson AS lesson ON lesson.id = assignment.target_curriculum_lesson_id
    WHERE assignment.target_kind = 'normal_class'
      AND assignment.status = 'active'
      AND resolution.status = 'active'
      AND assignment.target_class_session_id = ?
      AND attendance.attendance_status IS NOT NULL
      AND lesson.curriculum_program_id = ?
  )`).bind(classSessionId, programId, classSessionId, programId).first<{ value: number }>();
  return row?.value ?? 0;
}
