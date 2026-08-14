import type { D1PreparedStatement, WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

export const COURSE_ATTENDANCE_STATUSES = ["present", "late", "absent"] as const;
export type CourseAttendanceStatus = typeof COURSE_ATTENDANCE_STATUSES[number];

export class CourseAttendanceError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "invalid" | "future_occurrence" | "not_enrolled") {
    super("Course attendance operation failed.");
    this.name = "CourseAttendanceError";
  }
}

interface OccurrenceRow {
  slotId: string;
  classSessionId: string;
  curriculumLessonId: string;
  localDate: string;
  startTime: string;
  endTime: string;
  lessonSequence: number;
  lessonTitle: string;
  stageCode: string;
  offeringKind: "annual_course" | "summer_course";
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
  attendanceId: string | null;
  attendanceStatus: CourseAttendanceStatus | null;
  absenceNoticeId: string | null;
  absenceNoticeNote: string | null;
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
    slot.id AS slotId,
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

async function occurrenceForSlot(env: WorkerEnv, slotId: string): Promise<OccurrenceRow> {
  const row = await env.DB.prepare(`${OCCURRENCE_SELECT} AND slot.id = ?
    GROUP BY slot.id`).bind(slotId).first<OccurrenceRow>();
  if (!row) throw new CourseAttendanceError("not_found");
  return row;
}

async function rosterForOccurrence(env: WorkerEnv, occurrence: OccurrenceRow): Promise<RosterRow[]> {
  const { startsAt, endsAt } = localDateBounds(occurrence.localDate);
  const result = await env.DB.prepare(`
    SELECT enrollment.id AS enrollmentId, student.id AS studentId,
      student.surname AS surname, student.given_name AS givenName,
      attendance.id AS attendanceId, attendance.attendance_status AS attendanceStatus,
      absence_notice.id AS absenceNoticeId, absence_notice.note AS absenceNoticeNote
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
          AND enrollment.status IN ('confirmed', 'completed', 'cancelled')
        )
        OR attendance.id IS NOT NULL
        OR absence_notice.id IS NOT NULL
      )
    ORDER BY student.surname COLLATE NOCASE, student.given_name COLLATE NOCASE, enrollment.id
  `).bind(
    occurrence.classSessionId, occurrence.curriculumLessonId,
    occurrence.classSessionId, occurrence.curriculumLessonId,
    occurrence.classSessionId, endsAt, startsAt,
  ).all<RosterRow>();
  return result.results;
}

function serializeOccurrence(occurrence: AttendanceOccurrence, at: Date) {
  const occurrenceEnded = courseOccurrenceHasEnded(occurrence.localDate, occurrence.endTime, at);
  const roster = occurrence.roster.map((entry) => ({
    enrollmentId: entry.enrollmentId,
    studentId: entry.studentId,
    displayName: `${entry.surname} ${entry.givenName}`.trim(),
    recordedAttendanceStatus: entry.attendanceStatus,
    effectiveAttendanceStatus: effectiveCourseAttendanceStatus(entry.attendanceStatus, occurrenceEnded),
    hasAbsenceNotice: Boolean(entry.absenceNoticeId),
    absenceNoticeNote: entry.absenceNoticeNote,
  }));
  const markedCount = roster.filter((entry) => entry.recordedAttendanceStatus !== null).length;
  return {
    slotId: occurrence.slotId,
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
    progressCount: occurrenceEnded ? roster.length : markedCount,
    rosterCount: roster.length,
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
    progressCount: occurrenceEnded ? roster.length : markedCount,
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
  const occurrences = await Promise.all(result.results.map(async (occurrence) => ({
    slotId: occurrence.slotId,
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
  const selected = selectedSlotId && result.results.some((occurrence) => occurrence.slotId === selectedSlotId)
    ? await selectedOccurrenceWithRoster(env, selectedSlotId)
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

async function rosterEntryForEnrollment(env: WorkerEnv, occurrence: OccurrenceRow, enrollmentId: string): Promise<RosterRow> {
  const roster = await rosterForOccurrence(env, occurrence);
  const entry = roster.find((candidate) => candidate.enrollmentId === enrollmentId);
  if (!entry) throw new CourseAttendanceError("not_enrolled");
  return entry;
}

async function attendanceForOccurrence(env: WorkerEnv, occurrence: OccurrenceRow, enrollmentId: string): Promise<AttendanceRow | null> {
  return env.DB.prepare(`SELECT id, attendance_status AS attendanceStatus, updated_at AS updatedAt
    FROM course_attendance
    WHERE enrollment_id = ? AND class_session_id = ? AND curriculum_lesson_id = ?`).bind(
    enrollmentId, occurrence.classSessionId, occurrence.curriculumLessonId,
  ).first<AttendanceRow>();
}

export async function recordCourseAttendance(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: { slotId: string; enrollmentId: string; status: unknown },
): Promise<{ changed: boolean; recordedAttendanceStatus: CourseAttendanceStatus }> {
  requireCapability(actor, "attendance.manage");
  assertAttendanceStatus(input.status);
  const occurrence = await occurrenceForSlot(env, text(input.slotId, 120));
  assertNotFuture(occurrence);
  await rosterEntryForEnrollment(env, occurrence, text(input.enrollmentId, 120));
  const existing = await attendanceForOccurrence(env, occurrence, input.enrollmentId);
  if (existing?.attendanceStatus === input.status) return { changed: false, recordedAttendanceStatus: input.status };
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
  input: { slotId: string; enrollmentId: string },
): Promise<{ changed: boolean; recordedAttendanceStatus: null }> {
  requireCapability(actor, "attendance.manage");
  const occurrence = await occurrenceForSlot(env, text(input.slotId, 120));
  assertNotFuture(occurrence);
  await rosterEntryForEnrollment(env, occurrence, text(input.enrollmentId, 120));
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
  const row = await env.DB.prepare(`SELECT COALESCE(MAX(lesson.sequence_number), 0) AS value
    FROM course_attendance AS attendance
    INNER JOIN curriculum_lesson AS lesson ON lesson.id = attendance.curriculum_lesson_id
    WHERE attendance.class_session_id = ?
      AND attendance.attendance_status IS NOT NULL
      AND lesson.curriculum_program_id = ?`).bind(classSessionId, programId).first<{ value: number }>();
  return row?.value ?? 0;
}
