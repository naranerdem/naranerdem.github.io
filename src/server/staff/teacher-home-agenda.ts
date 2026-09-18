import type { WorkerEnv } from "../env";
import { hasStaffCapability, type StaffPrincipal } from "./authorization";

export class TeacherHomeAgendaError extends Error {
  constructor(public readonly code: "forbidden" | "invalid") {
    super("Teacher home agenda unavailable.");
  }
}

type AgendaKind = "lesson" | "cancelled" | "special_makeup";

interface AgendaRow {
  occurrenceId: string;
  kind: AgendaKind;
  localDate: string;
  startTime: string;
  endTime: string;
  classSessionId: string | null;
  classLabel: string;
  offeringTitle: string;
  lessonSequence: number | null;
  lessonTitle: string;
  ordinaryCount: number;
  makeupCount: number;
  cancelledLabel: string | null;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function localToday(at = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ulaanbaatar", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(at);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function mondayFor(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - mondayOffset);
  return date.toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function stageLabel(value: string): string {
  return ({ stage_1: "1-р шат", stage_2: "2-р шат", stage_3: "3-р шат" } as Record<string, string>)[value] ?? value;
}

function classLabel(stageCode: string, weekday: string, startTime: string, endTime: string): string {
  return `${stageLabel(stageCode)} · ${weekday} ${startTime}–${endTime}`;
}

function requireAgendaAccess(actor: StaffPrincipal): void {
  if (!hasStaffCapability(actor, "attendance.view")) throw new TeacherHomeAgendaError("forbidden");
}

export async function getTeacherHomeAgenda(
  env: WorkerEnv,
  actor: StaffPrincipal,
  requestedWeek = "",
  at = new Date(),
) {
  requireAgendaAccess(actor);
  if (requestedWeek && !validDate(requestedWeek)) throw new TeacherHomeAgendaError("invalid");
  const today = localToday(at);
  const weekStart = mondayFor(requestedWeek || today);
  const weekEnd = addDays(weekStart, 6);

  const lessons = await env.DB.prepare(`
    SELECT
      slot.id AS occurrenceId,
      CASE WHEN slot.status = 'cancelled' THEN 'cancelled' ELSE 'lesson' END AS kind,
      slot.local_date AS localDate,
      slot.start_time AS startTime,
      slot.end_time AS endTime,
      class_session.id AS classSessionId,
      class_session.stage_code AS stageCode,
      COALESCE(meeting.weekly_weekday, class_session.weekday) AS classWeekday,
      offering.title AS offeringTitle,
      lesson.sequence_number AS lessonSequence,
      lesson.title AS lessonTitle,
      slot.cancelled_lesson_title AS cancelledLabel,
      (
        SELECT COUNT(*)
        FROM enrollment AS ordinary
        WHERE ordinary.class_session_id = class_session.id
          AND ordinary.confirmed_at IS NOT NULL
          AND ordinary.confirmed_at <= (slot.local_date || 'T15:59:59.999Z')
          AND (ordinary.cancelled_at IS NULL OR ordinary.cancelled_at >= (slot.local_date || 'T16:00:00.000Z'))
          AND (ordinary.transferred_out_at IS NULL OR ordinary.transferred_out_at >= (slot.local_date || 'T16:00:00.000Z'))
          AND ordinary.status IN ('confirmed', 'completed', 'cancelled')
      ) AS ordinaryCount,
      (
        SELECT COUNT(*)
        FROM course_makeup_assignment AS assignment
        INNER JOIN course_makeup_resolution AS resolution
          ON resolution.id = assignment.resolution_id
          AND resolution.status = 'active' AND resolution.decision = 'assigned'
        INNER JOIN enrollment AS source_enrollment ON source_enrollment.id = resolution.source_enrollment_id
        WHERE assignment.status = 'active'
          AND assignment.target_kind = 'normal_class'
          AND assignment.target_class_session_id = class_session.id
          AND assignment.target_curriculum_lesson_id = slot.curriculum_lesson_id
          AND NOT EXISTS (
            SELECT 1 FROM enrollment AS ordinary
            WHERE ordinary.class_session_id = class_session.id
              AND ordinary.student_id = source_enrollment.student_id
              AND ordinary.confirmed_at IS NOT NULL
              AND ordinary.confirmed_at <= (slot.local_date || 'T15:59:59.999Z')
              AND (ordinary.cancelled_at IS NULL OR ordinary.cancelled_at >= (slot.local_date || 'T16:00:00.000Z'))
              AND (ordinary.transferred_out_at IS NULL OR ordinary.transferred_out_at >= (slot.local_date || 'T16:00:00.000Z'))
              AND ordinary.status IN ('confirmed', 'completed', 'cancelled')
          )
      ) AS makeupCount
    FROM class_calendar_slot AS slot
    INNER JOIN class_calendar_revision AS revision ON revision.id = slot.class_calendar_revision_id
    INNER JOIN class_calendar AS calendar ON calendar.id = revision.class_calendar_id
    INNER JOIN class_session ON class_session.id = calendar.class_session_id
    INNER JOIN activity_offering AS offering ON offering.id = class_session.activity_offering_id
    LEFT JOIN class_meeting_rule AS meeting ON meeting.class_session_id = class_session.id
    LEFT JOIN curriculum_lesson AS lesson ON lesson.id = slot.curriculum_lesson_id
    WHERE revision.status = 'published'
      AND slot.local_date BETWEEN ? AND ?
      AND slot.status IN ('scheduled', 'cancelled')
      AND offering.kind IN ('annual_course', 'summer_course')
    ORDER BY slot.local_date, slot.start_time, offering.title, class_session.id, slot.id
  `).bind(weekStart, weekEnd).all<AgendaRow & { stageCode: string; classWeekday: string }>();

  const specials = await env.DB.prepare(`
    SELECT special.id AS occurrenceId,
      'special_makeup' AS kind,
      special.local_date AS localDate,
      special.start_time AS startTime,
      special.end_time AS endTime,
      NULL AS classSessionId,
      '' AS stageCode,
      '' AS classWeekday,
      'Тусгай нөхөх хичээл' AS offeringTitle,
      lesson.sequence_number AS lessonSequence,
      lesson.title AS lessonTitle,
      special.note AS cancelledLabel,
      0 AS ordinaryCount,
      (SELECT COUNT(*) FROM course_makeup_assignment WHERE target_special_occurrence_id = special.id AND status = 'active') AS makeupCount
    FROM course_makeup_special_occurrence AS special
    INNER JOIN curriculum_lesson AS lesson ON lesson.id = special.curriculum_lesson_id
    WHERE special.status = 'active' AND special.local_date BETWEEN ? AND ?
    ORDER BY special.local_date, special.start_time, special.id
  `).bind(weekStart, weekEnd).all<AgendaRow & { stageCode: string; classWeekday: string }>();

  const entries = [...lessons.results, ...specials.results].map((entry) => ({
    occurrenceId: entry.occurrenceId,
    kind: entry.kind,
    localDate: entry.localDate,
    startTime: entry.startTime,
    endTime: entry.endTime,
    classSessionId: entry.classSessionId,
    classLabel: entry.kind === "special_makeup" ? "Тусгай нөхөх" : classLabel(entry.stageCode, entry.classWeekday, entry.startTime, entry.endTime),
    offeringTitle: entry.offeringTitle,
    lessonSequence: entry.lessonSequence,
    lessonTitle: entry.kind === "cancelled" ? entry.cancelledLabel || "Цуцалсан хичээл" : entry.lessonTitle,
    ordinaryCount: Number(entry.ordinaryCount),
    makeupCount: Number(entry.makeupCount),
    cancelledLabel: entry.kind === "cancelled" ? entry.cancelledLabel : null,
  })).sort((left, right) => `${left.localDate}\u0000${left.startTime}\u0000${left.occurrenceId}`.localeCompare(`${right.localDate}\u0000${right.startTime}\u0000${right.occurrenceId}`));

  return { today, weekStart, weekEnd, entries };
}
