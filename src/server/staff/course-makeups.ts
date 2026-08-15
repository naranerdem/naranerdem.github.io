import type { D1PreparedStatement, WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

export class CourseMakeupError extends Error {
  constructor(public readonly code: "forbidden" | "invalid" | "not_found" | "not_eligible" | "capacity" | "conflict") {
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
  normalCount: number;
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
  targetKind: "normal_class" | "special";
  sourceEnrollmentId: string;
  sourceClassSessionId: string;
  sourceCurriculumLessonId: string;
  studentName: string;
  lessonSequence: number;
  lessonTitle: string;
  targetClassSessionId: string | null;
  targetSpecialOccurrenceId: string | null;
  targetLocalDate: string | null;
  targetStartTime: string | null;
  targetEndTime: string | null;
  targetOfferingTitle: string | null;
  targetStageCode: string | null;
  specialNote: string | null;
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
  LEFT JOIN course_makeup_resolution AS active_resolution
    ON active_resolution.source_enrollment_id = enrollment.id
    AND active_resolution.source_class_session_id = class_session.id
    AND active_resolution.source_curriculum_lesson_id = lesson.id
    AND active_resolution.status = 'active'
  WHERE slot.status = 'scheduled'
    AND offering.kind IN ('annual_course', 'summer_course')
    AND enrollment.confirmed_at IS NOT NULL
    AND julianday(enrollment.confirmed_at) <= julianday(slot.local_date || ' 23:59:59', '-8 hours')
    AND (enrollment.cancelled_at IS NULL
      OR julianday(enrollment.cancelled_at) >= julianday(slot.local_date || ' 00:00:00', '-8 hours'))
    AND (attendance.attendance_status IS NULL OR attendance.attendance_status = 'absent')
    AND active_resolution.id IS NULL`;

async function unresolvedSources(env: WorkerEnv, at = new Date()): Promise<SourceRow[]> {
  const local = localDateTime(at);
  const result = await env.DB.prepare(`${SOURCE_SELECT}
    AND (slot.local_date < ? OR (slot.local_date = ? AND slot.end_time <= ?))
    GROUP BY enrollment.id, class_session.id, lesson.id
    ORDER BY slot.local_date DESC, slot.start_time, program.display_name,
      lesson.sequence_number, student.surname COLLATE NOCASE, student.given_name COLLATE NOCASE`)
    .bind(local.date, local.date, local.time).all<SourceRow>();
  return result.results;
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
  if (!row) throw new CourseMakeupError("not_eligible");
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
      (SELECT COUNT(*) FROM enrollment AS target_enrollment
        WHERE target_enrollment.class_session_id = class_session.id
          AND target_enrollment.status IN ('confirmed', 'completed')) AS normalCount,
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
  return result.results.map((target) => ({
    ...target,
    remainingCapacity: target.capacity - target.normalCount - target.makeupCount,
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

async function scheduledAssignments(env: WorkerEnv): Promise<Array<AssignmentRow & { state: "scheduled" | "needs_reassignment" }>> {
  const result = await env.DB.prepare(`SELECT assignment.id AS assignmentId,
      resolution.id AS resolutionId,
      assignment.target_kind AS targetKind,
      resolution.source_enrollment_id AS sourceEnrollmentId,
      resolution.source_class_session_id AS sourceClassSessionId,
      resolution.source_curriculum_lesson_id AS sourceCurriculumLessonId,
      student.surname || ' ' || student.given_name AS studentName,
      lesson.sequence_number AS lessonSequence,
      lesson.title AS lessonTitle,
      assignment.target_class_session_id AS targetClassSessionId,
      assignment.target_special_occurrence_id AS targetSpecialOccurrenceId,
      COALESCE(target_slot.local_date, special.local_date) AS targetLocalDate,
      COALESCE(target_slot.start_time, special.start_time) AS targetStartTime,
      COALESCE(target_slot.end_time, special.end_time) AS targetEndTime,
      target_offering.title AS targetOfferingTitle,
      target_class.stage_code AS targetStageCode,
      special.note AS specialNote,
      assignment.is_test AS isTest,
      assignment.test_run_id AS testRunId
    FROM course_makeup_assignment AS assignment
    INNER JOIN course_makeup_resolution AS resolution
      ON resolution.id = assignment.resolution_id AND resolution.status = 'active'
    INNER JOIN enrollment ON enrollment.id = resolution.source_enrollment_id
    INNER JOIN student ON student.id = enrollment.student_id
    INNER JOIN curriculum_lesson AS lesson ON lesson.id = resolution.source_curriculum_lesson_id
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
    WHERE assignment.status = 'active'
    ORDER BY targetLocalDate, targetStartTime, lesson.sequence_number, studentName`).all<AssignmentRow>();
  return result.results.map((entry) => ({
    ...entry,
    state: entry.targetLocalDate ? "scheduled" as const : "needs_reassignment" as const,
  }));
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
    scheduled: await scheduledAssignments(env),
    selected,
  };
}

function resolutionInsert(
  env: WorkerEnv,
  actor: StaffPrincipal,
  source: SourceRow,
  resolutionId: string,
  decision: "no_makeup" | "assigned",
  note: string | null,
  time: string,
): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO course_makeup_resolution (
    id, source_enrollment_id, source_class_session_id, source_curriculum_lesson_id,
    decision, status, note, decided_by_staff_account_id, decided_at,
    is_test, test_run_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`).bind(
    resolutionId, source.enrollmentId, source.classSessionId, source.curriculumLessonId,
    decision, note, actor.staffAccountId, time, source.isTest, source.testRunId, time, time,
  );
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
    if (/UNIQUE constraint|one active/i.test(message)) throw new CourseMakeupError("conflict");
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
  const time = now();
  const note = optionalText(input.note);
  await safeBatch(env, [
    resolutionInsert(env, actor, source, resolutionId, "no_makeup", note, time),
    audit(env, actor, "course_makeup_not_needed", "course_makeup_resolution", resolutionId, {
      sourceEnrollmentId: source.enrollmentId,
      sourceClassSessionId: source.classSessionId,
      curriculumLessonId: source.curriculumLessonId,
    }, source, time),
  ]);
  return { resolutionId };
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
  const time = now();
  await safeBatch(env, [
    resolutionInsert(env, actor, source, resolutionId, "assigned", null, time),
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
  const time = now();
  await safeBatch(env, [
    resolutionInsert(env, actor, source, resolutionId, "assigned", null, time),
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
  const endTime = clean(input.endTime, 5);
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
  const specialOccurrenceId = id();
  const time = now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`INSERT INTO course_makeup_special_occurrence (
      id, curriculum_lesson_id, local_date, start_time, end_time, capacity,
      status, note, created_by_staff_account_id, is_test, test_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`).bind(
      specialOccurrenceId, lessonId, localDate, startTime, endTime, capacity,
      optionalText(input.note), actor.staffAccountId, provenance.isTest, provenance.testRunId, time, time,
    ),
  ];
  for (const source of sources) {
    const resolutionId = id();
    const assignmentId = id();
    statements.push(
      resolutionInsert(env, actor, source, resolutionId, "assigned", null, time),
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

async function activeAssignment(env: WorkerEnv, assignmentId: string): Promise<AssignmentRow> {
  const rows = await scheduledAssignments(env);
  const assignment = rows.find((entry) => entry.assignmentId === assignmentId);
  if (!assignment) throw new CourseMakeupError("not_found");
  return assignment;
}

export async function cancelCourseMakeupAssignment(
  env: WorkerEnv,
  actor: StaffPrincipal,
  input: Record<string, unknown>,
  at = new Date(),
): Promise<void> {
  requireCapability(actor, "makeup.manage");
  const assignment = await activeAssignment(env, clean(input.assignmentId));
  const local = localDateTime(at);
  if (assignment.targetLocalDate
    && (assignment.targetLocalDate < local.date
      || (assignment.targetLocalDate === local.date && (assignment.targetStartTime ?? "") <= local.time))) {
    throw new CourseMakeupError("conflict");
  }
  const time = now();
  await safeBatch(env, [
    env.DB.prepare(`UPDATE course_makeup_assignment SET status = 'cancelled',
      cancelled_at = ?, cancelled_by_staff_account_id = ?, cancellation_reason = 'teacher_reopened',
      updated_at = ? WHERE id = ? AND status = 'active'`).bind(time, actor.staffAccountId, time, assignment.assignmentId),
    env.DB.prepare(`UPDATE course_makeup_resolution SET status = 'invalidated',
      invalidated_at = ?, invalidated_by_staff_account_id = ?, invalidation_reason = 'assignment_cancelled',
      updated_at = ? WHERE id = ? AND status = 'active'`).bind(time, actor.staffAccountId, time, assignment.resolutionId),
    audit(env, actor, "course_makeup_assignment_cancelled", "course_makeup_assignment", assignment.assignmentId, {
      sourceEnrollmentId: assignment.sourceEnrollmentId,
    }, assignment, time),
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
  const local = localDateTime(at);
  if (special.localDate < local.date || (special.localDate === local.date && special.startTime <= local.time)) {
    throw new CourseMakeupError("conflict");
  }
  const time = now();
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
    audit(env, actor, "course_makeup_special_cancelled", "course_makeup_special_occurrence", specialOccurrenceId, {
      curriculumLessonId: special.curriculumLessonId,
    }, special, time),
  ]);
}
